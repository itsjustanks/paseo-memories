import fs from "node:fs/promises";
import { extname, join } from "node:path";
import { backoffMs } from "../shared/schedule";
import { onShutdown, onStart } from "./lifecycle";
import { clientSeenWithin } from "./presence";
import { readMemoriesSettings } from "./settings";
import { statSafe } from "./files";

/**
 * Does a code name a memory mentions still exist in its project? Answered
 * from a background scan of the project's source files: bounded (files,
 * bytes, depth), skipping build output, cached per file by stat, and run
 * only while an app is connected, backing off after failures. The findings
 * RPC never waits for it; it reads the last answer and asks for a new one.
 *
 * Memory stays small: the scan looks only for the names memories mention.
 * Per file it keeps which of those names appear (never the file's text or
 * its identifiers), forgets files and projects it no longer sees, and reads
 * at most PASS_LIMITS.readBytes per pass across all projects.
 */

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "vendor", "target", ".venv", "venv", "__pycache__", ".turbo", "coverage", ".cache", "out", ".output", "Pods"]);
const CODE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".py", ".go", ".rs", ".rb", ".java", ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".sql", ".sh", ".json", ".toml", ".yaml", ".yml", ".graphql", ".proto", ".css", ".scss", ".html"]);

export const SCAN_LIMITS = { files: 4000, fileBytes: 512 * 1024, totalBytes: 64 * 1024 * 1024, depth: 10 };
/** Across every project in one pass: bytes read from disk (cache misses), and files remembered. */
export const PASS_LIMITS = { readBytes: 128 * 1024 * 1024, cachedFiles: 60_000 };
const INTERVAL_MS = 10 * 60_000;
/** A pass cut short by the read budget carries on this soon, not in ten minutes. */
const CARRY_ON_MS = 60_000;
const IDENT = /[A-Za-z_$][\w$]{3,}/g;
const NONE: readonly string[] = Object.freeze([]);

type FileHits = { stamp: string; hits: readonly string[] };
type ProjectCache = { key: string; files: Map<string, FileHits> };
export type ProjectIndex = { names: ReadonlySet<string>; found: ReadonlySet<string>; asOf: string; files: number; capped: boolean };
type Budget = { readBytes: number; cachedFiles: number };

const caches = new Map<string, ProjectCache>();
const projects = new Map<string, ProjectIndex>();
/** Project root → the names its memories mention (sorted, own strings). Replaced by every request. */
let wanted = new Map<string, string[]>();
let running: Promise<void> | null = null;
let failures = 0;
let unfinished = false;
let cursor = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * A copy that shares no memory with its source. A name cut out of a memory
 * file (or an identifier cut out of a source file) can otherwise keep that
 * whole file's text alive for as long as the name is kept.
 */
function own(text: string): string {
  return Buffer.from(text, "utf8").toString("utf8");
}

/** Which of the wanted names appear as whole identifiers in `text`, as the canonical strings from `names`. */
function namesIn(text: string, names: Map<string, string>): readonly string[] {
  const hits = new Set<string>();
  for (const match of text.matchAll(IDENT)) {
    const name = names.get(match[0]);
    if (name !== undefined) hits.add(name);
  }
  return hits.size ? [...hits] : NONE;
}

/**
 * One project. Returns null when the read budget ran out before every file
 * was checked: the last answer stays, and what was read is kept for the next
 * pass. Either way the cache ends up holding only files seen in this pass.
 */
async function scanProject(root: string, list: string[], budget: Budget): Promise<ProjectIndex | null> {
  const key = list.join("\u0000");
  const old = caches.get(root);
  const previous = old?.key === key ? old.files : null;
  const names = new Map(list.map((name) => [name, name]));
  const seen = new Map<string, FileHits>();
  const found = new Set<string>();
  let count = 0;
  let bytes = 0;
  let capped = false;
  let cut = false;
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > SCAN_LIMITS.depth || capped) return;
    let entries;
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (capped) return;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith(".")) await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !CODE.has(extname(entry.name).toLowerCase())) continue;
      if (count >= SCAN_LIMITS.files || bytes >= SCAN_LIMITS.totalBytes) {
        capped = true;
        return;
      }
      const stat = await statSafe(path);
      if (!stat || stat.size > SCAN_LIMITS.fileBytes) continue;
      count += 1;
      bytes += stat.size;
      // Yield now and then so a big repo never holds the event loop.
      if (count % 200 === 0) await new Promise((resolve) => setImmediate(resolve));
      const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
      let hit = previous?.get(path);
      if (hit?.stamp !== stamp) {
        if (stat.size > budget.readBytes) {
          cut = true;
          continue;
        }
        budget.readBytes -= stat.size;
        try {
          hit = { stamp, hits: namesIn(await fs.readFile(path, "utf8"), names) };
        } catch {
          continue;
        }
      }
      if (budget.cachedFiles > 0) {
        budget.cachedFiles -= 1;
        seen.set(path, hit);
      }
      for (const name of hit.hits) found.add(name);
    }
  };
  await walk(root, 0);
  caches.set(root, { key, files: seen });
  if (cut) return null;
  return { names: new Set(list), found, asOf: new Date().toISOString(), files: count, capped };
}

async function runPass(): Promise<void> {
  const settings = await readMemoriesSettings();
  if (!settings.staleChecks) {
    caches.clear();
    projects.clear();
    unfinished = false;
    return;
  }
  const request = wanted;
  for (const root of [...caches.keys()]) if (!request.has(root)) caches.delete(root);
  for (const root of [...projects.keys()]) if (!request.has(root)) projects.delete(root);
  // Start where the last cut-short pass stopped, so no project waits forever behind the others.
  const roots = [...request.keys()];
  const start = roots.length ? cursor % roots.length : 0;
  const order = [...roots.slice(start), ...roots.slice(0, start)];
  const budget: Budget = { ...PASS_LIMITS };
  let firstCut = -1;
  for (const [i, root] of order.entries()) {
    if (!(await statSafe(root))?.isDirectory) {
      caches.delete(root);
      projects.delete(root);
      continue;
    }
    const index = await scanProject(root, request.get(root)!, budget);
    if (index) projects.set(root, index);
    else if (firstCut < 0) firstCut = i;
  }
  unfinished = firstCut >= 0;
  cursor = unfinished ? start + firstCut : 0;
}

/**
 * Start a pass now if none is running. Only while an app is connected.
 * `queries` (project root → the code names its memories mention) replaces
 * the last request; without it the last request runs again.
 */
export function requestScan(queries?: Map<string, Iterable<string>>, force = false): void {
  if (queries) wanted = new Map([...queries].map(([root, names]) => [own(root), [...new Set([...names].map(own))].sort()]));
  if (running) return;
  if (!wanted.size) {
    caches.clear();
    projects.clear();
    return;
  }
  if (!force && !clientSeenWithin()) return;
  running = runPass()
    .then(() => {
      failures = 0;
    })
    .catch(() => {
      failures += 1;
    })
    .finally(() => {
      running = null;
    });
}

export function symbolIndex(root: string): ProjectIndex | null {
  return projects.get(root) ?? null;
}

export function scanState(): { state: string; asOf?: string } {
  if (running) return { state: "running" };
  const times = [...projects.values()].map((entry) => entry.asOf).sort();
  return times.length ? { state: "done", asOf: times[times.length - 1] } : { state: "waiting" };
}

/** For tests: wait for the pass in flight. */
export async function scanSettled(): Promise<void> {
  await running;
}

/** For tests and diagnostics: how much the scan keeps between passes. */
export function scanStats(): { files: number; projects: number; wanted: number; unfinished: boolean } {
  let files = 0;
  for (const cache of caches.values()) files += cache.files.size;
  return { files, projects: projects.size, wanted: wanted.size, unfinished };
}

export function forgetScans(): void {
  caches.clear();
  projects.clear();
  wanted = new Map();
  unfinished = false;
  cursor = 0;
}

function schedule(): void {
  const delay = unfinished && failures === 0 ? CARRY_ON_MS : backoffMs(failures, INTERVAL_MS, 60 * 60_000);
  timer = setTimeout(() => {
    if (clientSeenWithin()) requestScan();
    schedule();
  }, delay);
  timer.unref?.();
}

onStart(schedule);
onShutdown(() => {
  if (timer) clearTimeout(timer);
  timer = null;
});
