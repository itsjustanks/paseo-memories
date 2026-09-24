import { join } from "node:path";
import { DIR_AGENTS, type DirAgent } from "../shared/agents";
import type { Account, Source } from "../shared/contracts";
import { tokensFor } from "../shared/limits";
import type { MemoriesSettings } from "../shared/settings";
import { claudeSlug } from "../shared/slug";
import { discoverAccounts, type Accounts } from "./accounts";
import { paseoProjects, readDaemonOrNull, type Paseo } from "./daemon";
import { daemonEnv, userHome } from "./env";
import { Probe } from "./files";
import { canonicalRoot, versionControlled } from "./git";
import {
  autoMemoryItem,
  claudeManagedItems,
  claudeUserItems,
  codexMemoryItems,
  codexUserItems,
  copilotUserItems,
  ompUserItems,
  opencodeUserItems,
  piUserItems,
  planFor,
  readAutoMemoryFolder,
  readCodexConfig,
  type PlanCtx,
  type PlanItem,
} from "./plans";
import { readMemoriesSettings } from "./settings";
import { applyWritable } from "./writable";

/**
 * Everything this host's agents remember, as sources. A file read by several
 * agents is ONE source whose `readBy` lists them. Built from each account's
 * user files, every Claude auto-memory folder, and each known project's
 * root by the same rules the load plans use.
 */

export type Discovery = {
  at: number;
  settings: MemoriesSettings;
  accounts: Accounts;
  prompt: string | null;
  sources: Source[];
  items: Map<string, PlanItem>;
  projects: string[];
  checked: string[];
  notes: string[];
};

const MAX_PROJECTS = 200;
const REUSE_MS = 2_000;

let last: Discovery | null = null;
let lastGeneration = 0;
let generation = 0;

/** A write happened: the next read discovers again. */
export function forgetDiscovery(): void {
  generation += 1;
  last = null;
}

function iso(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString() : "";
}

class Registry {
  readonly sources = new Map<string, Source>();
  readonly items = new Map<string, PlanItem>();

  add(item: PlanItem, reader: string | null, accountId?: string): void {
    if (!item.path) return;
    const reads = reader !== null && (item.when === "launch" || item.when === "on-demand");
    const existing = this.sources.get(item.path);
    // A file first seen through an @import that is also read directly takes the direct entry's kind and access.
    if (existing && existing.kind === "claude-import" && item.kind !== "claude-import" && item.when !== "missing") {
      this.sources.delete(item.path);
      this.items.delete(item.path);
      this.add(item, reader, accountId);
      const replaced = this.sources.get(item.path)!;
      for (const agent of existing.readBy) if (!replaced.readBy.includes(agent)) replaced.readBy.push(agent);
      return;
    }
    if (existing) {
      if (reads && !existing.readBy.includes(reader!)) existing.readBy.push(reader!);
      if (item.when === "launch" && item.loadedBytes > existing.loaded.bytes) {
        existing.loaded = { bytes: item.loadedBytes, tokens: tokensFor(item.loadedBytes), note: item.note ?? "" };
      }
      if (!existing.accountId && accountId) existing.accountId = accountId;
      return;
    }
    this.items.set(item.path, item);
    const loadedBytes = item.when === "launch" ? item.loadedBytes : 0;
    this.sources.set(item.path, {
      id: item.path,
      agent: item.owner,
      ...(accountId ? { accountId } : {}),
      scope: item.scope,
      kind: item.kind,
      path: item.path,
      ...(item.projectPath ? { projectPath: item.projectPath } : {}),
      exists: item.when !== "missing",
      isDirectory: Boolean(item.isDirectory),
      bytes: item.bytes,
      lines: item.lines ?? 0,
      ...(item.files !== undefined ? { files: item.files } : {}),
      modifiedAt: iso(item.mtimeMs),
      loaded: { bytes: loadedBytes, tokens: tokensFor(loadedBytes), note: item.note ?? "" },
      access: item.access,
      ...(item.reason ? { reason: item.reason } : {}),
      readBy: reads ? [reader!] : [],
      ...(item.sourceLabel ? { label: item.sourceLabel } : {}),
      ...(item.slug ? { slug: item.slug } : {}),
    });
  }
}

/** Known project folders: Paseo's, else the folders Claude Code has recorded in ~/.claude.json. */
async function knownProjects(paseo: Paseo | null, probe: Probe, home: string): Promise<string[]> {
  const fromPaseo = (await paseoProjects(paseo)).map((entry) => entry.path);
  let paths = fromPaseo;
  if (paths.length === 0) {
    const text = await probe.text(join(home, ".claude.json"));
    try {
      const projects = text ? ((JSON.parse(text) as { projects?: Record<string, unknown> }).projects ?? {}) : {};
      paths = Object.keys(projects);
    } catch {
      paths = [];
    }
  }
  const out: string[] = [];
  for (const path of paths) {
    if (out.length >= MAX_PROJECTS) break;
    if (!out.includes(path) && path !== home && (await probe.isDir(path))) out.push(path);
  }
  return out;
}

/** Slug → project folder, mapped forward from every path we know (the slug is lossy). */
async function slugMap(probe: Probe, home: string, projects: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const text = await probe.text(join(home, ".claude.json"));
  let claudePaths: string[] = [];
  try {
    claudePaths = text ? Object.keys((JSON.parse(text) as { projects?: Record<string, unknown> }).projects ?? {}) : [];
  } catch {
    claudePaths = [];
  }
  for (const path of [...projects, ...claudePaths]) {
    if (!map.has(claudeSlug(path))) map.set(claudeSlug(path), path);
    const root = (await probe.isDir(path)) ? await canonicalRoot(probe, path) : null;
    if (root && !map.has(claudeSlug(root))) map.set(claudeSlug(root), root);
  }
  return map;
}

async function userItemsFor(agent: DirAgent, ctx: PlanCtx, dir: string): Promise<PlanItem[]> {
  switch (agent) {
    case "claude":
      return claudeUserItems(ctx, dir);
    case "codex":
      return [...(await codexUserItems(ctx, dir)), ...(await codexMemoryItems(ctx, dir, await readCodexConfig(ctx.probe, dir)))];
    case "opencode":
      return (await opencodeUserItems(ctx, dir)).items;
    case "pi":
      return piUserItems(ctx, dir);
    case "omp":
      return ompUserItems(ctx, dir);
    case "copilot":
      return copilotUserItems(ctx, dir);
  }
}

function defaultAccount(accounts: Account[], agent: string): Account | undefined {
  return accounts.find((account) => account.agent === agent && account.origin === "default");
}

export async function discover(paseo: Paseo | null, { refresh = false } = {}): Promise<Discovery> {
  if (!refresh && last && lastGeneration === generation && Date.now() - last.at < REUSE_MS) return last;
  const startedAt = generation;
  const home = userHome();
  const settings = await readMemoriesSettings();
  const daemon = await readDaemonOrNull(paseo);
  const accounts = await discoverAccounts(daemon?.launch ?? {});
  const probe = new Probe();
  const ctx: PlanCtx = { probe, home, env: { daemonEnv: daemonEnv() }, prompt: daemon ? daemon.appendSystemPrompt : null, codexEdits: settings.codexEdits, subfolders: false };
  const registry = new Registry();
  const notes: string[] = [];
  const agents = settings.showOtherAgents ? DIR_AGENTS : (["claude", "codex"] as const);

  for (const item of await claudeManagedItems(ctx)) registry.add(item, "claude");
  for (const account of accounts.accounts) {
    if (!(agents as readonly string[]).includes(account.agent)) continue;
    if (!account.exists && account.origin !== "default") continue;
    for (const item of await userItemsFor(account.agent as DirAgent, ctx, account.dir)) {
      if (item.when === "missing" && !account.exists) continue;
      registry.add(item, account.agent, item.owner === account.agent ? account.id : undefined);
    }
  }
  if (daemon) {
    const bytes = new TextEncoder().encode(daemon.appendSystemPrompt).length;
    registry.add({ label: "Paseo: append to system prompt", kind: "paseo-prompt", path: "paseo:appendSystemPrompt", when: bytes ? "launch" : "skipped", bytes, loadedBytes: bytes, scope: "host", access: "editable", owner: "paseo", note: "Reaches Claude, Codex, OpenCode, pi and Oh My Pi agents started or relaunched after a change; not Copilot." }, null);
    const source = registry.sources.get("paseo:appendSystemPrompt");
    if (source) source.readBy = ["claude", "codex", "opencode", "pi", "omp"];
  } else if (paseo) {
    notes.push("Paseo's settings could not be read, so its appended prompt is not shown.");
  }

  // Claude auto memory: every folder under each Claude account's projects/.
  const projects = await knownProjects(paseo, probe, home);
  const slugs = await slugMap(probe, home, projects);
  let claudeDirs = 0;
  for (const account of accounts.accounts.filter((entry) => entry.agent === "claude" && entry.exists)) {
    claudeDirs += 1;
    const root = join(account.dir, "projects");
    for (const entry of await probe.list(root)) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name, "memory");
      if (!(await probe.isDir(dir))) continue;
      const folder = await readAutoMemoryFolder(probe, dir);
      const projectPath = slugs.get(entry.name);
      const item = autoMemoryItem(folder, home, { slug: entry.name, ...(projectPath ? { projectPath } : {}) });
      registry.add(item, "claude", account.id);
    }
  }

  // Project files, by each agent's own rules at the project's root.
  for (const project of projects) {
    for (const agent of agents) {
      const account = defaultAccount(accounts.accounts, agent);
      if (!account) continue;
      const plan = await planFor(agent, ctx, account.dir, project);
      for (const item of plan.items) {
        if (item.scope !== "project" || item.when === "missing" || item.kind === "claude-auto-memory") continue;
        registry.add(item, agent);
      }
    }
  }

  // One rule for "editable": the write module's (server/writable.ts).
  const sources = await Promise.all([...registry.sources.values()].map((source) => applyWritable(source)));
  for (const source of sources) {
    if (source.scope === "project" && source.exists && !source.isDirectory && source.kind !== "claude-local") {
      source.versionControlled = await versionControlled(probe, source.path);
      if (source.versionControlled && source.access === "editable" && !source.reason) source.reason = "In a git repository: a change here shows up in git.";
    }
  }
  const folders = sources.filter((source) => source.kind === "claude-auto-memory");
  const codexHomes = accounts.accounts.filter((account) => account.agent === "codex" && account.exists).length;
  const unknown = folders.filter((source) => !source.projectPath).length;
  const checked = [
    `Checked ${folders.length} Claude memory folder${folders.length === 1 ? "" : "s"} in ${claudeDirs} Claude config folder${claudeDirs === 1 ? "" : "s"}, ${codexHomes} Codex home${codexHomes === 1 ? "" : "s"} and ${projects.length} project${projects.length === 1 ? "" : "s"}.`,
  ];
  if (unknown) notes.push(`${unknown} Claude memory folder${unknown === 1 ? " is" : "s are"} for projects whose path is not known here ("other projects").`);
  const result: Discovery = {
    at: Date.now(),
    settings,
    accounts,
    prompt: daemon ? daemon.appendSystemPrompt : null,
    sources,
    items: registry.items,
    projects,
    checked,
    notes,
  };
  // Keep it only if no write started meanwhile.
  if (startedAt === generation) {
    last = result;
    lastGeneration = generation;
  }
  return result;
}

export function memoryFileCount(discovery: Discovery): number {
  let count = 0;
  for (const source of discovery.sources) {
    if (source.kind !== "claude-auto-memory") continue;
    count += source.files ?? 0;
    if (source.lines > 0 || source.loaded.bytes > 0) count += 1;
  }
  return count;
}

export function groupSources(sources: Source[]) {
  const groups = new Map<string, { key: string; agent: string; accountId?: string; scope: string; sourceIds: string[]; bytes: number; files: number; loadedTokens: number; lastChanged: string }>();
  for (const source of sources) {
    const key = `${source.agent}|${source.accountId ?? ""}|${source.scope}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, agent: source.agent, ...(source.accountId ? { accountId: source.accountId } : {}), scope: source.scope, sourceIds: [], bytes: 0, files: 0, loadedTokens: 0, lastChanged: "" };
      groups.set(key, group);
    }
    group.sourceIds.push(source.id);
    group.bytes += source.bytes;
    group.files += source.isDirectory ? source.files ?? 0 : source.exists ? 1 : 0;
    group.loadedTokens += source.loaded.tokens;
    if (source.modifiedAt > group.lastChanged) group.lastChanged = source.modifiedAt;
  }
  return [...groups.values()];
}
