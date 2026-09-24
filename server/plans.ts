import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { launchValue, tilde, type LaunchEnv } from "../shared/agents";
import type { Access, LoadItem, LoadPlan } from "../shared/contracts";
import { frontmatterKeys } from "../shared/frontmatter";
import {
  CLAUDE_IMPORT_HOPS,
  CLAUDE_MD_MAX_BYTES,
  CODEX_MEMORY_SUMMARY_TOKENS,
  CODEX_PROJECT_DOC_MAX_BYTES,
  byteLength,
  claudeIndexLoad,
  lineCount,
  tokensFor,
} from "../shared/limits";
import { importRefs } from "../shared/markdown";
import { claudeSlug } from "../shared/slug";
import { parseToml, type TomlTables } from "../shared/toml";
import { claudeManagedDir, truthyEnv } from "./env";
import type { Probe } from "./files";
import { ancestors, canonicalRoot, findUpMarker, gitRoot } from "./git";

/**
 * "What an agent started here loads", per agent, by that agent's own rules
 * (SPEC "Load estimates"; memories-research/*.md). Every rule reads the
 * filesystem through one shared Probe and starts no process.
 *
 * Items carry what the source registry needs (scope, access, owner) beside
 * the wire fields; `toLoadPlan` strips those.
 */

export type When = "launch" | "on-demand" | "skipped" | "missing";

export type PlanItem = {
  label: string;
  kind: string;
  path?: string;
  when: When;
  bytes: number;
  loadedBytes: number;
  truncated?: boolean;
  note?: string;
  via?: string;
  scope: string;
  access: Access;
  reason?: string;
  owner: string;
  isDirectory?: boolean;
  files?: number;
  lines?: number;
  mtimeMs?: number;
  projectPath?: string;
  slug?: string;
  sourceLabel?: string;
};

export type PlanCtx = {
  probe: Probe;
  home: string;
  env: LaunchEnv;
  /** Paseo's appendSystemPrompt; null when the daemon could not be asked. */
  prompt: string | null;
  codexEdits?: boolean;
  /** Walk below the folder for subfolder CLAUDE.md files (on for plans, off for the inventory). */
  subfolders?: boolean;
};

export type RawPlan = { agent: string; configDir?: string; directory: string; items: PlanItem[]; notes: string[]; unsure: string[] };

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "vendor", "target", ".venv", "__pycache__", ".turbo", "coverage"]);

// ------------------------------------------------------------------ helpers

type FileOpts = Omit<PlanItem, "bytes" | "loadedBytes" | "when" | "path" | "label"> & {
  label?: string;
  when?: When;
  /** List it as "missing" when absent (a file the user could create). */
  showMissing?: boolean;
  loaded?: (text: string | null, size: number) => { bytes: number; truncated?: boolean; note?: string };
};

async function fileItem(ctx: PlanCtx, path: string, opts: FileOpts): Promise<PlanItem | null> {
  const stat = await ctx.probe.stat(path);
  const label = opts.label ?? tilde(path, ctx.home);
  const { showMissing, loaded, when, ...rest } = opts;
  if (!stat || !stat.isFile) {
    if (!showMissing) return null;
    return { ...rest, label, path, when: "missing", bytes: 0, loadedBytes: 0, note: opts.note ?? "Not present." };
  }
  const text = stat.size <= CLAUDE_MD_MAX_BYTES ? await ctx.probe.text(path) : null;
  const base: PlanItem = { ...rest, label, path, when: when ?? "launch", bytes: stat.size, loadedBytes: 0, lines: text === null ? undefined : lineCount(text), mtimeMs: stat.mtimeMs };
  if (base.when !== "launch") return base;
  const result = loaded ? loaded(text, stat.size) : { bytes: stat.size };
  return { ...base, loadedBytes: result.bytes, truncated: result.truncated ?? false, note: result.note ?? rest.note };
}

/** Markdown files under a folder, recursively, bounded. */
async function markdownUnder(ctx: PlanCtx, dir: string, suffix = ".md", maxDepth = 6, maxFiles = 300): Promise<string[]> {
  const out: string[] = [];
  const walk = async (folder: string, depth: number) => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    const entries = (await ctx.probe.list(folder)).slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.name.endsWith(suffix) && out.length < maxFiles) out.push(path);
    }
  };
  await walk(dir, 0);
  return out;
}

/** Named files in folders below `directory` (not in it), bounded and skipping build output. */
async function filesBelow(ctx: PlanCtx, directory: string, names: string[], maxDepth = 3, maxDirs = 300): Promise<string[]> {
  const out: string[] = [];
  let visited = 0;
  const walk = async (folder: string, depth: number) => {
    if (depth > maxDepth || visited >= maxDirs) return;
    visited += 1;
    for (const entry of await ctx.probe.list(folder)) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const child = join(folder, entry.name);
      for (const name of names) if (await ctx.probe.isFile(join(child, name))) out.push(join(child, name));
      await walk(child, depth + 1);
    }
  };
  await walk(directory, 1);
  return out;
}

async function nonEmpty(ctx: PlanCtx, path: string): Promise<boolean> {
  const stat = await ctx.probe.stat(path);
  if (!stat?.isFile || stat.size === 0) return false;
  const text = await ctx.probe.text(path);
  return text === null ? true : text.trim() !== "";
}

function promptItem(ctx: PlanCtx, agent: string): PlanItem | null {
  if (ctx.prompt === null) return null;
  const bytes = byteLength(ctx.prompt);
  const how: Record<string, string> = {
    claude: "Appended to Claude's system prompt.",
    codex: "Sent as Codex developer instructions.",
    opencode: "Sent as OpenCode's per-prompt system text.",
    pi: "Added through a temporary pi extension.",
    omp: "Passed as --append-system-prompt.",
  };
  return {
    label: "Paseo: append to system prompt",
    kind: "paseo-prompt",
    path: "paseo:appendSystemPrompt",
    when: bytes > 0 ? "launch" : "skipped",
    bytes,
    loadedBytes: bytes,
    note: bytes > 0 ? `${how[agent] ?? ""} New and relaunched agents only.` : "Empty.",
    scope: "host",
    access: "editable",
    owner: "paseo",
  };
}

async function readJson(ctx: PlanCtx, path: string): Promise<Record<string, unknown> | null> {
  const text = await ctx.probe.text(path);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ Claude

export const CLAUDE_INSTRUCTION_MODES = ["claude-md", "claude-md-or-agents-md", "claude-md-and-agents-md", "managed-only"] as const;
export type ClaudeInstructionMode = (typeof CLAUDE_INSTRUCTION_MODES)[number];
/** Older spellings the CLI still maps (2.1.280 `ve`). */
const LEGACY_MODES: Record<string, ClaudeInstructionMode> = {
  none: "managed-only",
  claude: "claude-md",
  "agents-fallback": "claude-md-or-agents-md",
  both: "claude-md-and-agents-md",
};

/** `pluginConfigs["agents-md@builtin"].options.instructionFiles`, default `claude-md-or-agents-md`. */
export function claudeInstructionMode(settings: Record<string, unknown> | null): { mode: ClaudeInstructionMode; unsure?: string } {
  const raw = ((settings?.pluginConfigs as Record<string, { options?: { instructionFiles?: unknown } }> | undefined)?.["agents-md@builtin"])?.options?.instructionFiles;
  if (raw === undefined) return { mode: "claude-md-or-agents-md" };
  if (typeof raw === "string" && (CLAUDE_INSTRUCTION_MODES as readonly string[]).includes(raw)) return { mode: raw as ClaudeInstructionMode };
  if (typeof raw === "string" && LEGACY_MODES[raw]) return { mode: LEGACY_MODES[raw]! };
  return { mode: "claude-md-or-agents-md", unsure: `settings.json asks for AGENTS.md mode "${String(raw)}", which this plugin does not know; shown as the default.` };
}

function claudeCapped(text: string | null, size: number): { bytes: number; truncated?: boolean; note?: string } {
  if (size > CLAUDE_MD_MAX_BYTES) return { bytes: 0, note: "Over 4 MiB: Claude skips it." };
  return { bytes: text === null ? size : byteLength(text) };
}

async function expandImports(ctx: PlanCtx, importer: string, depth: number, seen: Set<string>, scope: string, out: PlanItem[]): Promise<void> {
  if (depth > CLAUDE_IMPORT_HOPS) return;
  const text = await ctx.probe.text(importer);
  if (!text) return;
  for (const ref of importRefs(text)) {
    const path = ref.startsWith("~/") ? join(ctx.home, ref.slice(2)) : isAbsolute(ref) ? ref : resolve(dirname(importer), ref);
    if (seen.has(path) || !(await ctx.probe.isFile(path))) continue;
    seen.add(path);
    // Read-only: an @import can name any file (~/.zshrc, .env). It becomes
    // editable only where it is also a file an agent reads directly.
    const item = await fileItem(ctx, path, {
      kind: "claude-import",
      scope,
      access: "read-only",
      reason: "Reached only through an @import, so it is read-only here. Open the file that imports it, or edit it where it lives.",
      owner: "claude",
      via: importer,
      note: `Imported by ${tilde(importer, ctx.home)} (hop ${depth}).`,
      loaded: claudeCapped,
    });
    if (item) out.push(item);
    await expandImports(ctx, path, depth + 1, seen, scope, out);
  }
}

async function claudeRules(ctx: PlanCtx, rulesDir: string, scope: string, access: Access, owner = "claude"): Promise<PlanItem[]> {
  const out: PlanItem[] = [];
  for (const path of await markdownUnder(ctx, rulesDir)) {
    const text = await ctx.probe.text(path);
    const scoped = text !== null && frontmatterKeys(text).paths !== undefined;
    const item = await fileItem(ctx, path, {
      kind: scope === "managed" ? "claude-managed" : "claude-rule",
      scope,
      access,
      owner,
      when: scoped ? "on-demand" : "launch",
      note: scoped ? "Path-scoped: loads when Claude reads a matching file." : undefined,
      loaded: claudeCapped,
      reason: access === "read-only" ? "Managed by your organisation." : undefined,
    });
    if (item) out.push(item);
  }
  return out;
}

export type AutoMemoryFolder = {
  dir: string;
  exists: boolean;
  files: Array<{ name: string; size: number; mtimeMs: number }>;
  bytes: number;
  index: { exists: boolean; size: number; text: string | null };
  mtimeMs: number;
};

export async function readAutoMemoryFolder(probe: Probe, dir: string): Promise<AutoMemoryFolder> {
  const stat = await probe.stat(dir);
  const files: AutoMemoryFolder["files"] = [];
  let bytes = 0;
  let mtimeMs = stat?.mtimeMs ?? 0;
  for (const entry of await probe.list(dir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
    const fileStat = await probe.stat(join(dir, entry.name));
    if (!fileStat) continue;
    bytes += fileStat.size;
    mtimeMs = Math.max(mtimeMs, fileStat.mtimeMs);
    if (entry.name !== "MEMORY.md") files.push({ name: entry.name, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
  }
  const indexPath = join(dir, "MEMORY.md");
  const indexStat = await probe.stat(indexPath);
  const text = indexStat?.isFile ? await probe.text(indexPath) : null;
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, exists: Boolean(stat?.isDirectory), files, bytes, index: { exists: Boolean(indexStat?.isFile), size: indexStat?.size ?? 0, text }, mtimeMs };
}

export function autoMemoryItem(folder: AutoMemoryFolder, home: string, extra: Partial<PlanItem> = {}): PlanItem {
  const load = folder.index.text !== null ? claudeIndexLoad(folder.index.text) : { bytes: 0, lines: 0, truncated: false };
  const topics = folder.files.length;
  const cut = load.truncated ? ` MEMORY.md is cut at ${load.lines} lines / ${load.bytes.toLocaleString("en-US")} B (limit 200 lines or 25,000 B).` : "";
  return {
    label: `Auto memory (${tilde(folder.dir, home)})`,
    kind: "claude-auto-memory",
    path: folder.dir,
    when: folder.exists ? "launch" : "missing",
    bytes: folder.bytes,
    loadedBytes: load.bytes,
    truncated: load.truncated,
    note: folder.exists
      ? `MEMORY.md at launch; ${topics} memory file${topics === 1 ? "" : "s"} read on demand.${cut}`
      : "No auto memory for this project yet.",
    scope: "project",
    access: "editable",
    owner: "claude",
    isDirectory: true,
    files: topics,
    lines: folder.index.text === null ? 0 : lineCount(folder.index.text),
    mtimeMs: folder.mtimeMs,
    ...extra,
  };
}

/** Where Claude keeps auto memory for `directory`, and whether it is on. */
export async function claudeAutoMemoryDir(
  ctx: PlanCtx,
  cfg: string,
  directory: string,
  settings: Record<string, unknown> | null,
): Promise<{ dir: string; enabled: boolean; why?: string; unsure?: string; slug: string; root: string }> {
  const root = (await canonicalRoot(ctx.probe, directory)) ?? directory;
  const slug = claudeSlug(root);
  const cowork = launchValue("CLAUDE_COWORK_MEMORY_PATH_OVERRIDE", ctx.env);
  const configured = typeof settings?.autoMemoryDirectory === "string" ? (settings.autoMemoryDirectory as string) : undefined;
  const dir = cowork
    ? cowork.startsWith("~/") ? join(ctx.home, cowork.slice(2)) : cowork
    : configured
      ? configured.startsWith("~/") ? join(ctx.home, configured.slice(2)) : configured
      : join(cfg, "projects", slug, "memory");
  const envFlag = launchValue("CLAUDE_CODE_DISABLE_AUTO_MEMORY", ctx.env);
  if (envFlag === "1") return { dir, enabled: false, why: "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 turns auto memory off.", slug, root };
  if (envFlag !== "0" && settings?.autoMemoryEnabled === false) return { dir, enabled: false, why: "settings.json has autoMemoryEnabled: false.", slug, root };
  return { dir, enabled: true, slug, root, unsure: configured ? "autoMemoryDirectory is set; whether Claude keeps one folder per project inside it is not confirmed." : undefined };
}

export async function claudeUserItems(ctx: PlanCtx, cfg: string): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  const user = await fileItem(ctx, join(cfg, "CLAUDE.md"), { kind: "claude-md", scope: "user", access: "editable", owner: "claude", showMissing: true, loaded: claudeCapped });
  if (user) items.push(user);
  if (user && user.when === "launch") await expandImports(ctx, join(cfg, "CLAUDE.md"), 1, new Set([join(cfg, "CLAUDE.md")]), "user", items);
  items.push(...(await claudeRules(ctx, join(cfg, "rules"), "user", "editable")));
  return items;
}

export async function claudeManagedItems(ctx: PlanCtx): Promise<PlanItem[]> {
  const dir = claudeManagedDir();
  const items: PlanItem[] = [];
  const file = await fileItem(ctx, join(dir, "CLAUDE.md"), {
    kind: "claude-managed",
    scope: "managed",
    access: "read-only",
    owner: "claude",
    reason: "Managed by your organisation; Claude Code cannot exclude it.",
    loaded: claudeCapped,
  });
  if (file) items.push(file);
  items.push(...(await claudeRules(ctx, join(dir, ".claude", "rules"), "managed", "read-only")));
  return items;
}

/** Claude project files per folder, root → directory, by the AGENTS.md mode. */
export async function claudeProjectItems(ctx: PlanCtx, cfg: string, directory: string, mode: ClaudeInstructionMode): Promise<{ items: PlanItem[]; notes: string[] }> {
  const notes: string[] = [];
  if (mode === "managed-only") return { items: [], notes: ["AGENTS.md mode is managed-only: project and user files are dropped."] };
  const userFile = join(cfg, "CLAUDE.md");
  const userRules = join(cfg, "rules");
  const claudeFiles: PlanItem[] = [];
  const agentsFiles: PlanItem[] = [];
  for (const folder of ancestors(directory)) {
    const inProject = folder === directory;
    for (const name of ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"]) {
      const path = join(folder, name);
      if (path === userFile) continue;
      const local = name === "CLAUDE.local.md";
      const item = await fileItem(ctx, path, {
        kind: local ? "claude-local" : "claude-md",
        scope: "project",
        access: "editable",
        owner: "claude",
        projectPath: folder,
        showMissing: inProject && name !== join(".claude", "CLAUDE.md"),
        loaded: claudeCapped,
      });
      if (item) claudeFiles.push(item);
    }
    const rulesDir = join(folder, ".claude", "rules");
    if (rulesDir !== userRules) {
      for (const rule of await claudeRules(ctx, rulesDir, "project", "editable")) claudeFiles.push({ ...rule, projectPath: folder });
    }
    for (const name of ["AGENTS.md", join(".claude", "AGENTS.md")]) {
      const item = await fileItem(ctx, join(folder, name), { kind: "agents-md", scope: "project", access: "editable", owner: "codex", projectPath: folder, loaded: claudeCapped });
      if (item) agentsFiles.push(item);
    }
  }
  const hasClaude = claudeFiles.some((item) => item.when !== "missing" && item.kind !== "claude-rule");
  const items = [...claudeFiles];
  if (mode === "claude-md-and-agents-md") items.push(...agentsFiles);
  else if (mode === "claude-md-or-agents-md") {
    if (!hasClaude) {
      items.push(...agentsFiles.map((item) => ({ ...item, note: "No project CLAUDE.md here, so Claude reads AGENTS.md in its place." })));
    } else if (agentsFiles.length) {
      items.push(...agentsFiles.map((item) => ({ ...item, when: "skipped" as const, loadedBytes: 0, note: "A project CLAUDE.md exists, so Claude does not read AGENTS.md (default mode)." })));
    }
  } else if (agentsFiles.length) {
    items.push(...agentsFiles.map((item) => ({ ...item, when: "skipped" as const, loadedBytes: 0, note: "AGENTS.md mode is claude-md." })));
  }
  const seen = new Set<string>(items.map((item) => item.path!));
  const imports: PlanItem[] = [];
  for (const item of items) if (item.when === "launch" && item.path) await expandImports(ctx, item.path, 1, seen, "project", imports);
  items.push(...imports);
  // Subfolder files load when Claude reads a file there.
  for (const path of ctx.subfolders === false ? [] : await filesBelow(ctx, directory, ["CLAUDE.md"])) {
    const item = await fileItem(ctx, path, { kind: "claude-md", scope: "project", access: "editable", owner: "claude", projectPath: dirname(path), when: "on-demand", note: "Subfolder file: loads when Claude reads a file there." });
    if (item) items.push(item);
  }
  return { items, notes };
}

export async function planClaude(ctx: PlanCtx, cfg: string, directory: string): Promise<RawPlan> {
  const plan: RawPlan = { agent: "claude", configDir: cfg, directory, items: [], notes: [], unsure: [] };
  const userSettings = await readJson(ctx, join(cfg, "settings.json"));
  const projectSettings = await readJson(ctx, join(directory, ".claude", "settings.json"));
  const localSettings = await readJson(ctx, join(directory, ".claude", "settings.local.json"));
  const merged: Record<string, unknown> = { ...(userSettings ?? {}) };
  for (const layer of [projectSettings, localSettings]) {
    if (layer && "autoMemoryEnabled" in layer) merged.autoMemoryEnabled = layer.autoMemoryEnabled;
    if (layer && "autoMemoryDirectory" in layer) plan.unsure.push("A project settings file sets autoMemoryDirectory; Claude uses it only in trusted folders, so the default folder is shown.");
  }
  if (truthyEnv(launchValue("CLAUDE_CODE_DISABLE_CLAUDE_MDS", ctx.env))) {
    plan.notes.push("CLAUDE_CODE_DISABLE_CLAUDE_MDS=1: Claude loads no memory files at all.");
    const prompt = promptItem(ctx, "claude");
    if (prompt) plan.items.push(prompt);
    return plan;
  }
  const { mode, unsure } = claudeInstructionMode(userSettings);
  if (unsure) plan.unsure.push(unsure);
  plan.items.push(...(await claudeManagedItems(ctx)));
  if (mode !== "managed-only") plan.items.push(...(await claudeUserItems(ctx, cfg)));
  const project = await claudeProjectItems(ctx, cfg, directory, mode);
  plan.items.push(...project.items);
  plan.notes.push(...project.notes);
  const auto = await claudeAutoMemoryDir(ctx, cfg, directory, merged);
  if (auto.unsure) plan.unsure.push(auto.unsure);
  const folder = await readAutoMemoryFolder(ctx.probe, auto.dir);
  const item = autoMemoryItem(folder, ctx.home, { projectPath: auto.root, slug: basename(dirname(auto.dir)) });
  if (!auto.enabled) plan.items.push({ ...item, when: "skipped", loadedBytes: 0, note: auto.why });
  else plan.items.push(item);
  const prompt = promptItem(ctx, "claude");
  if (prompt) plan.items.push(prompt);
  if (ctx.prompt === null) plan.unsure.push("Paseo's own appended prompt could not be read.");
  return plan;
}

// ------------------------------------------------------------------ Codex

export type CodexConfig = {
  tables: TomlTables;
  projectDocMaxBytes: number;
  fallbacks: string[];
  rootMarkers: string[];
  developerInstructions?: string;
  modelInstructionsFile?: string;
  memoriesOn: boolean;
  memoriesFeature: boolean;
};

export async function readCodexConfig(probe: Probe, home: string): Promise<CodexConfig> {
  const text = await probe.text(join(home, "config.toml"));
  const tables = text ? parseToml(text) : { "": {} };
  const root = tables[""] ?? {};
  const features = tables.features ?? {};
  const memories = tables.memories ?? {};
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);
  const feature = features.memories ?? root["features.memories"];
  const use = memories.use_memories ?? root["memories.use_memories"];
  return {
    tables,
    projectDocMaxBytes: typeof root.project_doc_max_bytes === "number" ? root.project_doc_max_bytes : CODEX_PROJECT_DOC_MAX_BYTES,
    fallbacks: strings(root.project_doc_fallback_filenames) ?? [],
    rootMarkers: strings(root.project_root_markers) ?? [".git"],
    developerInstructions: typeof root.developer_instructions === "string" ? root.developer_instructions : undefined,
    modelInstructionsFile: typeof root.model_instructions_file === "string" ? root.model_instructions_file : undefined,
    memoriesFeature: feature === true,
    memoriesOn: feature === true && use !== false,
  };
}

/** `$CODEX_HOME/AGENTS.override.md`, else `AGENTS.md`; the first that is not empty. */
export async function codexUserItems(ctx: PlanCtx, home: string): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  const override = join(home, "AGENTS.override.md");
  const main = join(home, "AGENTS.md");
  const overrideOn = await nonEmpty(ctx, override);
  const mainOn = await nonEmpty(ctx, main);
  const a = await fileItem(ctx, override, { kind: "agents-md", scope: "user", access: "editable", owner: "codex", when: overrideOn ? "launch" : "skipped", note: overrideOn ? "Wins over AGENTS.md." : "Empty, so Codex ignores it." });
  if (a) items.push(a);
  const b = await fileItem(ctx, main, {
    kind: "agents-md",
    scope: "user",
    access: "editable",
    owner: "codex",
    showMissing: true,
    when: !overrideOn && mainOn ? "launch" : "skipped",
    note: overrideOn ? "AGENTS.override.md wins, so this is not read." : mainOn ? undefined : "Empty, so Codex ignores it.",
  });
  if (b) items.push(b);
  return items;
}

const CODEX_MEMORY_LABEL = "Codex folds this in at its next run; wording may change.";

export async function codexMemoryItems(ctx: PlanCtx, home: string, config: CodexConfig): Promise<PlanItem[]> {
  const dir = join(home, "memories");
  const items: PlanItem[] = [];
  const guarded = ctx.codexEdits === false ? { access: "read-only" as const, reason: "Codex edits are turned off in this plugin's settings." } : { access: "editable" as const };
  const summaryMax = CODEX_MEMORY_SUMMARY_TOKENS * 4;
  const summary = await fileItem(ctx, join(dir, "memory_summary.md"), {
    kind: "codex-memory",
    scope: "user",
    owner: "codex",
    ...guarded,
    sourceLabel: CODEX_MEMORY_LABEL,
    when: config.memoriesOn ? "launch" : "skipped",
    note: config.memoriesOn ? undefined : "Codex memories are off in config.toml.",
    loaded: (_text, size) => ({ bytes: Math.min(size, summaryMax), truncated: size > summaryMax, note: size > summaryMax ? "Cut to ≈2,500 tokens." : undefined }),
  });
  if (summary) items.push(summary);
  const index = await fileItem(ctx, join(dir, "MEMORY.md"), { kind: "codex-memory", scope: "user", owner: "codex", ...guarded, sourceLabel: CODEX_MEMORY_LABEL, when: "on-demand", note: "Searched on demand, never injected." });
  if (index) items.push(index);
  const generated = [
    ["raw_memories.md", "Rebuilt from Codex's database at each run; edits here are lost."],
    ["phase2_workspace_diff.md", "Codex's working diff for the next consolidation."],
  ] as const;
  for (const [name, reason] of generated) {
    const item = await fileItem(ctx, join(dir, name), { kind: "codex-generated", scope: "user", access: "read-only", owner: "codex", reason, when: "skipped", note: "Not loaded into a session." });
    if (item) items.push(item);
  }
  for (const [name, reason] of [
    ["rollout_summaries", "Rebuilt by Codex at each run."],
    ["extensions", "Codex prunes resources after 7 days, and consolidation then drops what they supported."],
  ] as const) {
    const folder = join(dir, name);
    if (!(await ctx.probe.isDir(folder))) continue;
    const files = await markdownUnder(ctx, folder, "", 4, 2000);
    let bytes = 0;
    let mtimeMs = 0;
    for (const file of files) {
      const stat = await ctx.probe.stat(file);
      bytes += stat?.size ?? 0;
      mtimeMs = Math.max(mtimeMs, stat?.mtimeMs ?? 0);
    }
    items.push({ label: tilde(folder, ctx.home), kind: "codex-generated", path: folder, when: "skipped", bytes, loadedBytes: 0, scope: "user", access: "read-only", reason, owner: "codex", isDirectory: true, files: files.length, mtimeMs, note: "Not loaded into a session." });
  }
  for (const entry of await ctx.probe.list(home)) {
    if (!/^memories_\d+\.sqlite$/.test(entry.name)) continue;
    const item = await fileItem(ctx, join(home, entry.name), { kind: "codex-generated", scope: "user", access: "read-only", owner: "codex", reason: "Codex's memory database; only Codex writes it.", when: "skipped", note: "Not loaded into a session." });
    if (item) items.push({ ...item, lines: undefined });
  }
  return items;
}

export async function planCodex(ctx: PlanCtx, home: string, directory: string): Promise<RawPlan> {
  const plan: RawPlan = { agent: "codex", configDir: home, directory, items: [], notes: [], unsure: [] };
  const config = await readCodexConfig(ctx.probe, home);
  plan.items.push(...(await codexUserItems(ctx, home)));
  const root = await findUpMarker(ctx.probe, directory, config.rootMarkers);
  const folders = root ? ancestors(directory).filter((folder) => folder === root || folder.startsWith(`${root}/`)) : [directory];
  if (!root) plan.notes.push(`No ${config.rootMarkers.join(" / ") || "root marker"} found above this folder, so Codex reads project docs from this folder only.`);
  let budget = config.projectDocMaxBytes;
  const names = ["AGENTS.override.md", "AGENTS.md", ...config.fallbacks];
  for (const folder of folders) {
    for (const name of names) {
      const path = join(folder, name);
      if (!(await nonEmpty(ctx, path))) continue;
      const stat = (await ctx.probe.stat(path))!;
      const loaded = Math.min(stat.size, Math.max(0, budget));
      const item = await fileItem(ctx, path, {
        kind: "agents-md",
        scope: "project",
        access: "editable",
        owner: "codex",
        projectPath: folder,
        when: budget > 0 ? "launch" : "skipped",
        note: budget <= 0 ? `Past project_doc_max_bytes (${config.projectDocMaxBytes.toLocaleString("en-US")} B), so not read.` : undefined,
        loaded: () => ({ bytes: loaded, truncated: loaded < stat.size, note: loaded < stat.size ? `Cut at project_doc_max_bytes (${config.projectDocMaxBytes.toLocaleString("en-US")} B for all project docs).` : undefined }),
      });
      if (item) plan.items.push(item);
      budget -= stat.size;
      break;
    }
  }
  if (!plan.items.some((item) => item.scope === "project")) {
    const missing = await fileItem(ctx, join(directory, "AGENTS.md"), { kind: "agents-md", scope: "project", access: "editable", owner: "codex", projectPath: directory, showMissing: true });
    if (missing) plan.items.push(missing);
  }
  if (config.developerInstructions) {
    const bytes = byteLength(config.developerInstructions);
    plan.items.push({ label: "developer_instructions (config.toml)", kind: "codex-config", path: join(home, "config.toml"), when: "launch", bytes, loadedBytes: bytes, scope: "user", access: "read-only", reason: "Set in Codex's config.toml.", owner: "codex" });
  }
  if (config.modelInstructionsFile) plan.notes.push("config.toml sets model_instructions_file, which replaces Codex's built-in instructions.");
  plan.items.push(...(await codexMemoryItems(ctx, home, config)));
  if (!config.memoriesFeature) plan.notes.push("Codex memories are off ([features] memories).");
  const prompt = promptItem(ctx, "codex");
  if (prompt) plan.items.push(prompt);
  return plan;
}

// ------------------------------------------------------------------ OpenCode

export async function opencodeUserItems(ctx: PlanCtx, dir: string): Promise<{ items: PlanItem[]; fallback: boolean }> {
  const items: PlanItem[] = [];
  const own = await fileItem(ctx, join(dir, "AGENTS.md"), { kind: "opencode-md", scope: "user", access: "editable", owner: "opencode", showMissing: await ctx.probe.isDir(dir) });
  if (own) items.push(own);
  const disabled = truthyEnv(launchValue("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT", ctx.env)) || truthyEnv(launchValue("OPENCODE_DISABLE_CLAUDE_CODE", ctx.env));
  if (own?.when === "launch" || disabled) return { items, fallback: false };
  const claude = await fileItem(ctx, join(ctx.home, ".claude", "CLAUDE.md"), { kind: "claude-md", scope: "user", access: "editable", owner: "claude", note: "OpenCode has no AGENTS.md of its own, so it reads Claude's." });
  if (claude) items.push(claude);
  return { items, fallback: Boolean(claude) };
}

async function opencodeConfigItems(ctx: PlanCtx, configPath: string, base: string): Promise<PlanItem[]> {
  const config = await readJson(ctx, configPath);
  const list = Array.isArray(config?.instructions) ? (config!.instructions as unknown[]).filter((item): item is string => typeof item === "string") : [];
  const items: PlanItem[] = [];
  for (const entry of list) {
    if (/^https?:\/\//.test(entry) || /[*?[{]/.test(entry)) {
      items.push({ label: `${entry} (opencode.json)`, kind: "opencode-config", when: "launch", bytes: 0, loadedBytes: 0, scope: "project", access: "read-only", reason: "Listed in opencode.json instructions[]; edit opencode.json.", owner: "opencode", note: "A URL or glob; not measured." });
      continue;
    }
    const path = entry.startsWith("~/") ? join(ctx.home, entry.slice(2)) : isAbsolute(entry) ? entry : resolve(base, entry);
    // SPEC: entries of opencode.json instructions[] are read-only here; edit them where they live.
    const item = await fileItem(ctx, path, { kind: "opencode-md", scope: "project", access: "read-only", reason: `Listed in ${tilde(configPath, ctx.home)} instructions[]; it is read-only here.`, owner: "opencode", note: `Listed in ${tilde(configPath, ctx.home)} instructions[].` });
    if (item) items.push(item);
  }
  return items;
}

export async function planOpenCode(ctx: PlanCtx, dir: string, directory: string): Promise<RawPlan> {
  const plan: RawPlan = { agent: "opencode", configDir: dir, directory, items: [], notes: [], unsure: [] };
  const user = await opencodeUserItems(ctx, dir);
  plan.items.push(...user.items);
  const worktree = (await gitRoot(ctx.probe, directory)) ?? directory;
  const folders = ancestors(directory).filter((folder) => folder === worktree || folder.startsWith(`${worktree}/`)).reverse();
  const disabledClaude = truthyEnv(launchValue("OPENCODE_DISABLE_CLAUDE_CODE", ctx.env));
  for (const name of ["AGENTS.md", ...(disabledClaude ? [] : ["CLAUDE.md"]), "CONTEXT.md"]) {
    const found: PlanItem[] = [];
    for (const folder of folders) {
      const item = await fileItem(ctx, join(folder, name), { kind: name === "CONTEXT.md" ? "opencode-md" : name === "CLAUDE.md" ? "claude-md" : "agents-md", scope: "project", access: "editable", owner: name === "CLAUDE.md" ? "claude" : name === "AGENTS.md" ? "codex" : "opencode", projectPath: folder });
      if (item) found.push(item);
    }
    if (found.length) {
      plan.items.push(...found.reverse());
      break;
    }
  }
  for (const configName of ["opencode.json", "opencode.jsonc"]) {
    plan.items.push(...(await opencodeConfigItems(ctx, join(dir, configName), dir)));
    plan.items.push(...(await opencodeConfigItems(ctx, join(worktree, configName), worktree)));
  }
  plan.notes.push("Nested AGENTS.md files load when OpenCode reads a file in their folder.");
  const prompt = promptItem(ctx, "opencode");
  if (prompt) plan.items.push(prompt);
  return plan;
}

// ------------------------------------------------------------------ pi

const PI_NAMES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];

export async function piUserItems(ctx: PlanCtx, dir: string): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  let found = false;
  for (const name of PI_NAMES) {
    const item = await fileItem(ctx, join(dir, name), { kind: "pi-md", scope: "user", access: "editable", owner: "pi", when: found ? "skipped" : "launch", note: found ? "An earlier file in pi's order wins." : undefined });
    if (item) {
      items.push(item);
      found = true;
    }
  }
  if (!found && (await ctx.probe.isDir(dir))) {
    const missing = await fileItem(ctx, join(dir, "AGENTS.md"), { kind: "pi-md", scope: "user", access: "editable", owner: "pi", showMissing: true });
    if (missing) items.push(missing);
  }
  const system = await fileItem(ctx, join(dir, "SYSTEM.md"), { kind: "pi-md", scope: "user", access: "editable", owner: "pi", note: "Replaces pi's whole base prompt." });
  if (system) items.push(system);
  const append = await fileItem(ctx, join(dir, "APPEND_SYSTEM.md"), { kind: "pi-md", scope: "user", access: "editable", owner: "pi", note: "Appended to pi's system prompt." });
  if (append) items.push(append);
  return items;
}

export async function planPi(ctx: PlanCtx, dir: string, directory: string): Promise<RawPlan> {
  const plan: RawPlan = { agent: "pi", configDir: dir, directory, items: await piUserItems(ctx, dir), notes: [], unsure: [] };
  for (const folder of ancestors(directory)) {
    if (folder === dir) continue;
    for (const name of PI_NAMES) {
      const item = await fileItem(ctx, join(folder, name), { kind: name === "CLAUDE.md" ? "claude-md" : "agents-md", scope: "project", access: "editable", owner: name === "CLAUDE.md" ? "claude" : "codex", projectPath: folder });
      if (item) {
        plan.items.push(item);
        break;
      }
    }
  }
  for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md"]) {
    if (await ctx.probe.isFile(join(directory, ".pi", name))) plan.unsure.push(`.pi/${name} in this project is used only when pi trusts the project.`);
  }
  const prompt = promptItem(ctx, "pi");
  if (prompt) plan.items.push(prompt);
  return plan;
}

// ------------------------------------------------------------------ omp (Oh My Pi)

/** omp's user file: the highest-priority one of several tools' (oh-my-pi docs/context-files.md). */
export async function ompUserItems(ctx: PlanCtx, dir: string): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  const candidates: Array<[string, string, string]> = [
    [join(dir, "AGENTS.md"), "omp-md", "omp"],
    [join(ctx.home, ".claude", "CLAUDE.md"), "claude-md", "claude"],
    [join(ctx.home, ".agents", "AGENTS.md"), "agents-md", "codex"],
    [join(ctx.home, ".codex", "AGENTS.md"), "agents-md", "codex"],
    [join(ctx.home, ".gemini", "GEMINI.md"), "agents-md", "omp"],
    [join(ctx.home, ".config", "opencode", "AGENTS.md"), "opencode-md", "opencode"],
    [join(ctx.home, ".copilot", "copilot-instructions.md"), "copilot-md", "copilot"],
  ];
  for (const [path, kind, owner] of candidates) {
    if (!(await nonEmpty(ctx, path))) continue;
    const item = await fileItem(ctx, path, { kind, scope: "user", access: "editable", owner, note: owner === "omp" ? undefined : "omp's user file: it keeps one, and this one wins." });
    if (item) items.push(item);
    break;
  }
  if (!items.length && (await ctx.probe.isDir(dir))) {
    const missing = await fileItem(ctx, join(dir, "AGENTS.md"), { kind: "omp-md", scope: "user", access: "editable", owner: "omp", showMissing: true });
    if (missing) items.push(missing);
  }
  const rules = await fileItem(ctx, join(dir, "RULES.md"), { kind: "omp-md", scope: "user", access: "editable", owner: "omp", note: "Sticky: carried on every request." });
  if (rules) items.push(rules);
  const memories = join(dir, "memories");
  if (await ctx.probe.isDir(memories)) {
    const files = await markdownUnder(ctx, memories, "", 3, 500);
    let bytes = 0;
    for (const file of files) bytes += (await ctx.probe.stat(file))?.size ?? 0;
    items.push({ label: tilde(memories, ctx.home), kind: "omp-generated", path: memories, when: "skipped", bytes, loadedBytes: 0, scope: "user", access: "read-only", reason: "omp regenerates these.", owner: "omp", isDirectory: true, files: files.length, note: "omp's generated memory (off by default)." });
  }
  return items;
}

export async function planOmp(ctx: PlanCtx, dir: string, directory: string): Promise<RawPlan> {
  const plan: RawPlan = { agent: "omp", configDir: dir, directory, items: [], notes: [], unsure: ["omp also collapses byte-identical files and reads plugin providers; those are not shown."] };
  const repo = (await gitRoot(ctx.probe, directory)) ?? directory;
  const folders = ancestors(directory).filter((folder) => folder === repo || folder.startsWith(`${repo}/`)).reverse(); // cwd first
  // Native: the nearest non-empty .omp/ owns AGENTS.md and RULES.md.
  let nativeDepth = -1;
  const project: PlanItem[] = [];
  for (let depth = 0; depth < folders.length; depth += 1) {
    const omp = join(folders[depth]!, ".omp");
    if ((await ctx.probe.list(omp)).length === 0) continue;
    for (const name of ["AGENTS.md", "RULES.md"]) {
      const item = await fileItem(ctx, join(omp, name), { kind: "omp-md", scope: "project", access: "editable", owner: "omp", projectPath: folders[depth], note: name === "RULES.md" ? "Sticky: carried on every request." : undefined });
      if (item) project.push(item);
    }
    nativeDepth = depth;
    break;
  }
  const perDepth: PlanItem[][] = [];
  for (let depth = 0; depth < folders.length; depth += 1) {
    if (depth === nativeDepth && project.some((item) => item.path?.endsWith("AGENTS.md"))) continue;
    const folder = folders[depth]!;
    const candidates: Array<[string, string, string]> = [
      ...(depth === 0 ? ([[join(folder, ".claude", "CLAUDE.md"), "claude-md", "claude"]] as Array<[string, string, string]>) : []),
      [join(folder, ".agent", "AGENTS.md"), "agents-md", "codex"],
      [join(folder, ".agents", "AGENTS.md"), "agents-md", "codex"],
      ...(depth === 0 ? ([[join(folder, ".github", "copilot-instructions.md"), "copilot-md", "copilot"]] as Array<[string, string, string]>) : []),
      [join(folder, "AGENTS.md"), "agents-md", "codex"],
      [join(folder, "CLAUDE.md"), "claude-md", "claude"],
    ];
    for (const [path, kind, owner] of candidates) {
      if (!(await nonEmpty(ctx, path))) continue;
      const item = await fileItem(ctx, path, { kind, scope: "project", access: "editable", owner, projectPath: folder });
      if (item) perDepth.push([item]);
      break;
    }
  }
  // Farther ancestors first, then closer, then the user file.
  plan.items.push(...perDepth.flat().reverse(), ...project, ...(await ompUserItems(ctx, dir)));
  const prompt = promptItem(ctx, "omp");
  if (prompt) plan.items.push(prompt);
  return plan;
}

// ------------------------------------------------------------------ Copilot

async function copilotInstructionFiles(ctx: PlanCtx, dir: string, scope: string, projectPath?: string): Promise<PlanItem[]> {
  const out: PlanItem[] = [];
  for (const path of await markdownUnder(ctx, dir, ".instructions.md")) {
    const text = await ctx.probe.text(path);
    const applyTo = text === null ? undefined : frontmatterKeys(text).applyTo;
    const always = applyTo === undefined || ["*", "**", "**/*"].includes(String(applyTo).trim());
    const item = await fileItem(ctx, path, { kind: "copilot-md", scope, access: "editable", owner: "copilot", projectPath, when: always ? "launch" : "on-demand", note: always ? undefined : `applyTo: ${String(applyTo)}` });
    if (item) out.push(item);
  }
  return out;
}

export async function copilotUserItems(ctx: PlanCtx, dir: string): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  const main = await fileItem(ctx, join(dir, "copilot-instructions.md"), { kind: "copilot-md", scope: "user", access: "editable", owner: "copilot", showMissing: await ctx.probe.isDir(dir) });
  if (main) items.push(main);
  items.push(...(await copilotInstructionFiles(ctx, join(dir, "instructions"), "user")));
  if (await ctx.probe.isDir(dir)) {
    items.push({ label: "Copilot Memory (stored online)", kind: "copilot-memory", path: "copilot:memory", when: "skipped", bytes: 0, loadedBytes: 0, scope: "user", access: "online", reason: "Stored by GitHub, not on this machine. Use /memory in Copilot CLI.", owner: "copilot", note: "Not shown here." });
  }
  return items;
}

export async function planCopilot(ctx: PlanCtx, dir: string, directory: string): Promise<RawPlan> {
  const plan: RawPlan = { agent: "copilot", configDir: dir, directory, items: await copilotUserItems(ctx, dir), notes: [], unsure: [] };
  const repo = (await gitRoot(ctx.probe, directory)) ?? directory;
  const main = await fileItem(ctx, join(repo, ".github", "copilot-instructions.md"), { kind: "copilot-md", scope: "project", access: "editable", owner: "copilot", projectPath: repo });
  if (main) plan.items.push(main);
  plan.items.push(...(await copilotInstructionFiles(ctx, join(repo, ".github", "instructions"), "project", repo)));
  for (const folder of ancestors(directory).filter((folder) => folder === repo || folder.startsWith(`${repo}/`))) {
    for (const [name, kind, owner] of [["AGENTS.md", "agents-md", "codex"], ["CLAUDE.md", "claude-md", "claude"], [join(".claude", "CLAUDE.md"), "claude-md", "claude"], ["GEMINI.md", "agents-md", "copilot"]] as const) {
      const item = await fileItem(ctx, join(folder, name), { kind, scope: "project", access: "editable", owner, projectPath: folder });
      if (item) plan.items.push(item);
    }
  }
  if (launchValue("COPILOT_CUSTOM_INSTRUCTIONS_DIRS", ctx.env)) plan.unsure.push("COPILOT_CUSTOM_INSTRUCTIONS_DIRS adds folders that are not listed here.");
  plan.notes.push("Copilot merges every file and drops duplicates; there is no precedence order.");
  plan.notes.push("Paseo's appended prompt does not reach Copilot (an ACP provider).");
  return plan;
}

// ------------------------------------------------------------------ output

export function toLoadPlan(raw: RawPlan, extra: { providerId?: string; accountId?: string } = {}): LoadPlan {
  const seen = new Set<string>();
  const items: LoadItem[] = [];
  for (const item of raw.items) {
    const key = item.path ?? item.label;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      order: items.length,
      label: item.label,
      kind: item.kind,
      ...(item.path ? { path: item.path } : {}),
      ...(item.path && item.when !== "missing" && !item.path.startsWith("copilot:") ? { sourceId: item.path } : {}),
      when: item.when,
      bytes: item.bytes,
      loadedBytes: item.when === "launch" ? item.loadedBytes : 0,
      tokens: tokensFor(item.when === "launch" ? item.loadedBytes : 0),
      truncated: item.truncated ?? false,
      note: item.note ?? "",
      ...(item.via ? { via: item.via } : {}),
      scope: item.scope,
    });
  }
  const bytes = items.reduce((sum, item) => sum + item.loadedBytes, 0);
  return {
    agent: raw.agent,
    ...(extra.providerId ? { providerId: extra.providerId } : {}),
    ...(extra.accountId ? { accountId: extra.accountId } : {}),
    ...(raw.configDir ? { configDir: raw.configDir } : {}),
    directory: raw.directory,
    items,
    total: { bytes, tokens: tokensFor(bytes) },
    notes: raw.notes,
    unsure: raw.unsure,
  };
}

export async function planFor(agent: string, ctx: PlanCtx, dir: string, directory: string): Promise<RawPlan> {
  switch (agent) {
    case "claude":
      return planClaude(ctx, dir, directory);
    case "codex":
      return planCodex(ctx, dir, directory);
    case "opencode":
      return planOpenCode(ctx, dir, directory);
    case "pi":
      return planPi(ctx, dir, directory);
    case "omp":
      return planOmp(ctx, dir, directory);
    case "copilot":
      return planCopilot(ctx, dir, directory);
    default:
      return { agent, directory, items: [], notes: [], unsure: [`This plugin does not know what ${agent} loads.`] };
  }
}
