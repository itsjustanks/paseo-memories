import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DIR_AGENTS, type DirAgent } from "../shared/agents";
import type { output as ZodOutput } from "zod";
import type { Entry, FileStamp, LoadPlan, Source, sourceDetail } from "../shared/contracts";
import { parseMemoryFile, readFields } from "../shared/frontmatter";
import { claudeIndexLoad, lineCount, tokensFor } from "../shared/limits";
import { importRefs, sectionText, splitSections } from "../shared/markdown";
import { parseIndex } from "../shared/memory-index";
import { findSecrets, maskSecrets } from "../shared/secrets";
import { accountForProvider, providerDir } from "./accounts";
import { codexState } from "./codex-state";
import { workspaceDirectory, type Paseo } from "./daemon";
import { discover, groupSources, memoryFileCount, type Discovery } from "./discover";
import { daemonEnv, userHome } from "./env";
import { MAX_READ_BYTES, Probe, sha256, statSafe } from "./files";
import { planFor, toLoadPlan, type PlanCtx, type PlanItem } from "./plans";
import { applyWritable } from "./writable";

/**
 * The read RPCs. Async fs only, no processes. Memory text leaves this module
 * only in `entryBody`, masked unless the caller asks to reveal it.
 */

function sourceFromItem(item: PlanItem): Source {
  const loadedBytes = item.when === "launch" ? item.loadedBytes : 0;
  return {
    id: item.path!,
    agent: item.owner,
    scope: item.scope,
    kind: item.kind,
    path: item.path!,
    ...(item.projectPath ? { projectPath: item.projectPath } : {}),
    exists: item.when !== "missing",
    isDirectory: Boolean(item.isDirectory),
    bytes: item.bytes,
    lines: item.lines ?? 0,
    ...(item.files !== undefined ? { files: item.files } : {}),
    modifiedAt: item.mtimeMs ? new Date(item.mtimeMs).toISOString() : "",
    loaded: { bytes: loadedBytes, tokens: tokensFor(loadedBytes), note: item.note ?? "" },
    access: item.access,
    ...(item.reason ? { reason: item.reason } : {}),
    readBy: [],
    ...(item.sourceLabel ? { label: item.sourceLabel } : {}),
    ...(item.slug ? { slug: item.slug } : {}),
  };
}

/** Plans for every agent in a folder, with the agents' default accounts. */
export async function workspacePlans(discovery: Discovery, directory: string, probe = new Probe()): Promise<Array<{ agent: string; raw: Awaited<ReturnType<typeof planFor>>; accountId?: string }>> {
  const out = [];
  const agents = discovery.settings.showOtherAgents ? DIR_AGENTS : (["claude", "codex"] as const);
  for (const agent of agents) {
    const account = discovery.accounts.accounts.find((entry) => entry.agent === agent && entry.origin === "default");
    const providerIds = Object.entries(discovery.accounts.byProvider).filter(([, value]) => value.agent === agent);
    const env = providerIds.find(([id]) => id === agent)?.[1].env ?? { daemonEnv: daemonEnv() };
    const dir = providerIds.find(([id]) => id === agent) ? providerDir(agent as DirAgent, env) : account?.dir ?? providerDir(agent as DirAgent, env);
    const ctx: PlanCtx = { probe, home: userHome(), env, prompt: discovery.prompt, codexEdits: discovery.settings.codexEdits };
    const raw = await planFor(agent, ctx, dir, directory);
    out.push({ agent, raw, accountId: discovery.accounts.accounts.find((entry) => entry.agent === agent && entry.dir === dir)?.id });
  }
  return out;
}

/**
 * A source by id: from the inventory, else (with a workspace) from that
 * workspace's plans, which include files the inventory does not list
 * (ancestors, subfolders, files the user may create).
 */
export async function findSource(paseo: Paseo | null, sourceId: string, workspaceId?: string): Promise<{ source: Source; item?: PlanItem; discovery: Discovery } | null> {
  const discovery = await discover(paseo);
  const hit = discovery.sources.find((source) => source.id === sourceId);
  if (hit) return { source: hit, item: discovery.items.get(sourceId), discovery };
  if (workspaceId && paseo) {
    const directory = await workspaceDirectory(paseo, workspaceId);
    for (const { raw, agent } of await workspacePlans(discovery, directory)) {
      // Prefer a direct entry over the same file reached through an @import.
      const item = raw.items.find((entry) => entry.path === sourceId && entry.kind !== "claude-import") ?? raw.items.find((entry) => entry.path === sourceId);
      if (item) {
        const source = await applyWritable(sourceFromItem(item));
        if (item.when === "launch" || item.when === "on-demand") source.readBy = [agent];
        return { source, item, discovery };
      }
    }
  }
  return null;
}

/**
 * The known source that is this file on disk, compared by real path on both
 * sides: HOME or a project reached through a symlinked folder lists files
 * under the link, while a link target always resolves to the real folder.
 */
export async function findSourceByRealPath(paseo: Paseo | null, path: string, workspaceId?: string): Promise<{ source: Source; item?: PlanItem; discovery: Discovery } | null> {
  const direct = await findSource(paseo, path, workspaceId);
  if (direct) return direct;
  const real = await fs.realpath(path).catch(() => null);
  if (!real) return null;
  const discovery = await discover(paseo);
  const candidates = discovery.sources.map((source) => source.path);
  if (workspaceId && paseo) {
    const directory = await workspaceDirectory(paseo, workspaceId);
    for (const { raw } of await workspacePlans(discovery, directory)) for (const item of raw.items) if (item.path) candidates.push(item.path);
  }
  for (const candidate of new Set(candidates)) {
    if (!candidate.startsWith("/") || candidate === path) continue;
    if ((await fs.realpath(candidate).catch(() => null)) === real) return findSource(paseo, candidate, workspaceId);
  }
  return null;
}

export async function handleInventory({ refresh }: { refresh?: boolean }, { paseo }: PluginHandlerContext) {
  return inventoryFor(paseo, Boolean(refresh));
}

export async function inventoryFor(paseo: Paseo | null, refresh = false) {
  const discovery = await discover(paseo, { refresh });
  const folders = discovery.sources.filter((source) => source.kind === "claude-auto-memory");
  return {
    checkedAt: new Date(discovery.at).toISOString(),
    accounts: discovery.accounts.accounts,
    sources: discovery.sources,
    groups: groupSources(discovery.sources),
    counts: {
      claudeMemoryFolders: folders.length,
      claudeMemoryFiles: memoryFileCount(discovery),
      codexHomes: discovery.accounts.accounts.filter((account) => account.agent === "codex" && account.exists).length,
      projects: discovery.projects.length,
      sources: discovery.sources.filter((source) => source.exists).length,
      bytes: discovery.sources.reduce((sum, source) => sum + (source.exists ? source.bytes : 0), 0),
    },
    findings: [],
    checked: discovery.checked,
    notes: discovery.notes,
  };
}

async function stampOf(path: string): Promise<FileStamp | undefined> {
  const stat = await statSafe(path);
  if (!stat?.isFile) return undefined;
  if (stat.size > MAX_READ_BYTES) return { size: stat.size, mtimeMs: stat.mtimeMs };
  return { size: stat.size, mtimeMs: stat.mtimeMs, hash: sha256(await fs.readFile(path)) };
}

async function memoryEntries(dir: string): Promise<{ entries: Entry[]; index: ReturnType<typeof indexState> | undefined }> {
  const probe = new Probe();
  const indexText = await probe.text(join(dir, "MEMORY.md"));
  const lines = indexText === null ? [] : parseIndex(indexText);
  const names = new Set<string>();
  const entries: Entry[] = [];
  for (const dirent of (await probe.list(dir)).slice().sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isFile() || !dirent.name.endsWith(".md") || dirent.name === "MEMORY.md" || dirent.name.startsWith(".")) continue;
    names.add(dirent.name);
    const path = join(dir, dirent.name);
    const stat = await probe.stat(path);
    const text = await probe.text(path);
    const fields = text === null ? { shape: "none" as const, extra: {} } : readFields(parseMemoryFile(text));
    const line = lines.find((entry) => entry.file === dirent.name);
    entries.push({
      key: dirent.name,
      title: fields.name ?? line?.title ?? dirent.name.replace(/\.md$/, ""),
      ...(fields.description !== undefined ? { description: fields.description } : {}),
      ...(fields.type !== undefined ? { type: fields.type } : {}),
      indexed: Boolean(line),
      ...(line?.hook ? { hook: line.hook } : {}),
      shape: fields.shape,
      extra: fields.extra,
      path,
      bytes: stat?.size ?? 0,
      lines: text === null ? 0 : lineCount(text),
      ...(stat ? { modifiedAt: new Date(stat.mtimeMs).toISOString() } : {}),
      secrets: text === null ? 0 : findSecrets(text).length,
    });
  }
  return { entries, index: indexText === null ? undefined : indexState(indexText, lines, names) };
}

function indexState(text: string, lines: ReturnType<typeof parseIndex>, names: Set<string>) {
  const load = claudeIndexLoad(text);
  const named = new Set(lines.map((line) => line.file));
  return {
    lines: lines.map((line) => ({ line: line.line, title: line.title, file: line.file, hook: line.hook, exists: names.has(line.file) })),
    missingFiles: lines.filter((line) => !names.has(line.file)).map((line) => line.file),
    unindexedFiles: [...names].filter((name) => !named.has(name)),
    loadedLines: load.lines,
    loadedBytes: load.bytes,
    truncated: load.truncated,
  };
}

function sectionEntries(text: string): Entry[] {
  return splitSections(text).map((section) => {
    const body = sectionText(text, section);
    return { key: section.key, title: section.title, extra: {}, bytes: new TextEncoder().encode(body).length, lines: section.end - section.start, secrets: findSecrets(body).length };
  });
}

async function importsOf(path: string, home: string) {
  const probe = new Probe();
  const text = await probe.text(path);
  if (!text) return [];
  const out = [];
  for (const ref of importRefs(text)) {
    const target = ref.startsWith("~/") ? join(home, ref.slice(2)) : isAbsolute(ref) ? ref : resolve(dirname(path), ref);
    out.push({ ref, path: target, exists: await probe.isFile(target), depth: 1 });
  }
  return out;
}

export type SourceDetail = ZodOutput<(typeof sourceDetail)["output"]>;

export async function handleSourceDetail({ sourceId, workspaceId }: { sourceId: string; workspaceId?: string }, { paseo }: PluginHandlerContext): Promise<SourceDetail> {
  const found = await findSource(paseo, sourceId, workspaceId);
  if (!found) throw new Error("That memory source is no longer there. Refresh the list.");
  const { source } = found;
  const warnings: string[] = [];
  if (source.kind === "claude-auto-memory") {
    const { entries, index } = await memoryEntries(source.path);
    if (index?.truncated) warnings.push(`MEMORY.md is over Claude's limit: only the first ${index.loadedLines} lines (${index.loadedBytes.toLocaleString("en-US")} B) load.`);
    if (index?.missingFiles.length) warnings.push(`${index.missingFiles.length} MEMORY.md line${index.missingFiles.length === 1 ? " points" : "s point"} to a file that does not exist.`);
    if (index?.unindexedFiles.length) warnings.push(`${index.unindexedFiles.length} memory file${index.unindexedFiles.length === 1 ? " is" : "s are"} not named in MEMORY.md.`);
    return { source, stamp: await stampOf(join(source.path, "MEMORY.md")), entries, ...(index ? { index } : {}), imports: [], warnings };
  }
  if (source.isDirectory) {
    const entries: Entry[] = [];
    const walk = async (folder: string, depth: number) => {
      if (depth > 4 || entries.length >= 500) return;
      for (const dirent of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
        const path = join(folder, dirent.name);
        if (dirent.isDirectory()) await walk(path, depth + 1);
        else if (dirent.isFile()) {
          const stat = await statSafe(path);
          entries.push({ key: relative(source.path, path), title: relative(source.path, path), extra: {}, bytes: stat?.size ?? 0, lines: 0, secrets: 0, path, ...(stat ? { modifiedAt: new Date(stat.mtimeMs).toISOString() } : {}) });
        }
      }
    };
    await walk(source.path, 0);
    return { source, entries, imports: [], warnings };
  }
  if (source.path.startsWith("paseo:") || source.path.startsWith("copilot:")) return { source, entries: [], imports: [], warnings };
  const stat = await statSafe(source.path);
  if (!stat) return { source, entries: [], imports: [], warnings: ["The file does not exist yet."] };
  if (stat.size > MAX_READ_BYTES || source.path.endsWith(".sqlite")) {
    return { source, stamp: { size: stat.size, mtimeMs: stat.mtimeMs }, entries: [], imports: [], warnings: ["Too large or not text; not opened here."] };
  }
  const text = await fs.readFile(source.path, "utf8");
  const imports = source.kind.startsWith("claude") ? await importsOf(source.path, userHome()) : [];
  if (source.kind === "claude-md" && lineCount(text) > 200) warnings.push(`${lineCount(text)} lines; Claude's docs suggest keeping CLAUDE.md under 200.`);
  if (source.versionControlled) warnings.push("In a git repository: a change here shows up in git.");
  if (basename(source.path) === "SYSTEM.md" && source.kind === "pi-md") warnings.push("SYSTEM.md replaces pi's whole base prompt.");
  return {
    source,
    stamp: { size: stat.size, mtimeMs: stat.mtimeMs, hash: sha256(Buffer.from(text, "utf8")) },
    entries: sectionEntries(text),
    imports,
    // Only the Codex memory detail view opens Codex's database (even a read-only open touches -shm).
    ...(source.kind === "codex-memory" ? { codex: await codexState(source.path) } : {}),
    warnings,
  };
}

export async function handleEntryBody(
  { sourceId, key, reveal, workspaceId }: { sourceId: string; key?: string; reveal?: boolean; workspaceId?: string },
  { paseo }: PluginHandlerContext,
) {
  const found = await findSource(paseo, sourceId, workspaceId);
  if (!found) throw new Error("That memory source is no longer there. Refresh the list.");
  const { source, discovery } = found;
  let path = source.path;
  let pick: ((text: string) => { body: string; fields?: { name?: string; description?: string; type?: string } }) | null = null;
  if (source.isDirectory) {
    if (!key) throw new Error("Pick a file in this folder.");
    const target = resolve(source.path, key);
    if (!target.startsWith(`${source.path}/`)) throw new Error("That file is not in this folder.");
    path = target;
    if (source.kind === "claude-auto-memory" && key !== "MEMORY.md") {
      pick = (text) => {
        const file = parseMemoryFile(text);
        const fields = readFields(file);
        return { body: file.body, fields: { ...(fields.name !== undefined ? { name: fields.name } : {}), ...(fields.description !== undefined ? { description: fields.description } : {}), ...(fields.type !== undefined ? { type: fields.type } : {}) } };
      };
    }
  } else if (key) {
    pick = (text) => {
      const section = splitSections(text).find((entry) => entry.key === key);
      if (!section) throw new Error("That section is no longer in the file. Reload it.");
      return { body: sectionText(text, section) };
    };
  }
  if (path.startsWith("paseo:") || path.startsWith("copilot:")) throw new Error("This source has no file to show.");
  const stat = await statSafe(path);
  if (!stat?.isFile) throw new Error("That file does not exist.");
  if (stat.size > MAX_READ_BYTES || path.endsWith(".sqlite")) throw new Error("That file is too large or not text, so it is not shown here.");
  const buffer = await fs.readFile(path);
  const text = buffer.toString("utf8");
  const picked = pick ? pick(text) : { body: text };
  const shouldMask = discovery.settings.maskSecrets && !reveal;
  // Secrets can sit in the frontmatter too; they count, and hide, like the body's.
  const fields = picked.fields ?? {};
  const secretsFound = [picked.body, fields.name ?? "", fields.description ?? "", fields.type ?? ""].flatMap((text) => findSecrets(text));
  const hide = (text: string) => (shouldMask ? maskSecrets(text).text : text);
  return {
    body: hide(picked.body),
    ...(picked.fields
      ? { fields: Object.fromEntries(Object.entries(picked.fields).map(([key, value]) => [key, typeof value === "string" ? hide(value) : value])) as typeof picked.fields }
      : {}),
    masked: shouldMask && secretsFound.length > 0,
    secrets: secretsFound.length,
    secretKinds: [...new Set(secretsFound.map((match) => match.kind))],
    stamp: { size: stat.size, mtimeMs: stat.mtimeMs, hash: sha256(buffer) },
    path,
  };
}

export async function handleWorkspacePlan({ workspaceId }: { workspaceId: string }, { paseo }: PluginHandlerContext) {
  const directory = await workspaceDirectory(paseo, workspaceId);
  const discovery = await discover(paseo);
  const plans: LoadPlan[] = [];
  for (const { raw, accountId, agent } of await workspacePlans(discovery, directory)) plans.push(toLoadPlan(raw, { providerId: agent, ...(accountId ? { accountId } : {}) }));
  return { directory, plans, checkedAt: new Date().toISOString() };
}

export async function handleAgentPlan({ workspaceId, providerId }: { workspaceId: string; providerId: string; agentId?: string }, { paseo }: PluginHandlerContext) {
  const directory = await workspaceDirectory(paseo, workspaceId);
  const discovery = await discover(paseo);
  const { agent, account, env } = accountForProvider(discovery.accounts, providerId);
  const dir = account?.dir ?? ((DIR_AGENTS as readonly string[]).includes(agent) ? providerDir(agent as DirAgent, env) : "");
  const ctx: PlanCtx = { probe: new Probe(), home: userHome(), env, prompt: discovery.prompt, codexEdits: discovery.settings.codexEdits };
  const raw = await planFor(agent, ctx, dir, directory);
  if (!account && !(DIR_AGENTS as readonly string[]).includes(agent)) raw.unsure.push(`Provider ${providerId} is not one this plugin can read.`);
  return { directory, plan: toLoadPlan(raw, { providerId, ...(account ? { accountId: account.id } : {}) }), checkedAt: new Date().toISOString() };
}
