import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { basename } from "node:path";
import { readProviderLaunch, type ProviderLaunch } from "../shared/agents";
import { withDeadline } from "./run";

/**
 * The daemon settings this plugin reads, through the config API only
 * (`config.json` is never touched). One read serves every caller for a few
 * seconds; a read is cached only while no write has started since it began,
 * so an answer read before a write is never served after it. Pattern from
 * paseo-mcp 0.11.0 `server/paseo-tools.ts:41-75`.
 */

export type Paseo = PluginHandlerContext["paseo"];

export type DaemonRead = { appendSystemPrompt: string; launch: ProviderLaunch; providerIds: string[] };

const CACHE_MS = 5_000;

let generation = 0;
let cached: ({ at: number } & DaemonRead) | null = null;
let inFlight: { generation: number; read: Promise<DaemonRead> } | null = null;

export function readDaemonConfig(config: unknown): DaemonRead {
  const root = (config && typeof config === "object" ? config : {}) as { appendSystemPrompt?: unknown };
  const launch = readProviderLaunch(config);
  return {
    appendSystemPrompt: typeof root.appendSystemPrompt === "string" ? root.appendSystemPrompt : "",
    launch,
    providerIds: Object.keys(launch),
  };
}

async function readFresh(paseo: Paseo): Promise<DaemonRead> {
  const startedAt = generation;
  const { config } = await withDeadline(paseo.config.get(), "its daemon settings");
  const read = readDaemonConfig(config);
  if (startedAt === generation) cached = { at: Date.now(), ...read };
  return read;
}

export function readDaemon(paseo: Paseo, fresh = false): Promise<DaemonRead> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached);
  if (!fresh && inFlight?.generation === generation) return inFlight.read;
  const entry = { generation, read: readFresh(paseo) };
  inFlight = entry;
  void entry.read
    .finally(() => {
      if (inFlight === entry) inFlight = null;
    })
    .catch(() => undefined);
  return entry.read;
}

/** The daemon config, or null when there is no daemon to ask (smoke script) or it does not answer. */
export async function readDaemonOrNull(paseo: Paseo | null): Promise<DaemonRead | null> {
  if (!paseo) return null;
  try {
    return await readDaemon(paseo);
  } catch {
    return null;
  }
}

/** A write is starting: whatever was read before it is out of date. */
export function startWrite(): void {
  generation += 1;
  cached = null;
}

/** For tests. */
export function resetDaemonCache(): void {
  generation += 1;
  cached = null;
  inFlight = null;
}

type WorkspaceEntry = { id: string; name: string; workspaceDirectory?: string; projectRootPath: string };

/** The directory an agent in this workspace starts in (paseo-mcp `enabled.ts:54-68`). */
export async function workspaceDirectory(paseo: Paseo, workspaceId: string): Promise<string> {
  return (await workspaceEntry(paseo, workspaceId)).directory;
}

/** A workspace's name and starting directory. */
export async function workspaceEntry(paseo: Paseo, workspaceId: string): Promise<{ name: string; directory: string }> {
  const result = await withDeadline(paseo.workspaces.list(), "its workspace list");
  const workspace = (result as unknown as { entries: WorkspaceEntry[] }).entries.find((entry) => entry.id === workspaceId);
  if (!workspace) throw new Error("This Paseo workspace no longer exists.");
  const directory = workspace.workspaceDirectory || workspace.projectRootPath;
  return { name: workspace.name || basename(directory), directory };
}

/**
 * Every project Paseo knows (projects, then workspace folders). Empty when
 * there is no daemon or it does not answer; callers fall back to Claude's own
 * list of folders.
 */
export async function paseoProjects(paseo: Paseo | null): Promise<Array<{ name: string; path: string }>> {
  if (!paseo) return [];
  const out: Array<{ name: string; path: string }> = [];
  const projectApi = (paseo as unknown as { projects?: { list(): Promise<unknown> } }).projects;
  if (projectApi) {
    try {
      const result = (await withDeadline(projectApi.list(), "its project list")) as { entries?: Array<{ name?: string; path?: string }> } | Array<{ name?: string; path?: string }>;
      const entries = Array.isArray(result) ? result : result.entries ?? [];
      for (const entry of entries) if (entry.path) out.push({ name: entry.name || basename(entry.path), path: entry.path });
    } catch {
      // fall through to workspaces
    }
  }
  try {
    const result = (await withDeadline(paseo.workspaces.list(), "its workspace list")) as unknown as { entries?: WorkspaceEntry[] };
    for (const entry of result.entries ?? []) {
      for (const path of [entry.projectRootPath, entry.workspaceDirectory]) if (path) out.push({ name: entry.name || basename(path), path });
    }
  } catch {
    // no workspaces known
  }
  const seen = new Set<string>();
  return out.filter((entry) => (seen.has(entry.path) ? false : (seen.add(entry.path), true)));
}
