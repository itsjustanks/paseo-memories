import fs from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import { backoffMs } from "../shared/schedule";
import { onShutdown, onStart } from "./lifecycle";
import { Pacer } from "./pace";
import { clientSeenWithin, pageOpen } from "./presence";
import { readMemoriesSettings } from "./settings";
import { sha256, statSafe } from "./files";
import { fitEntries, readStateJson, StateSaver, sweepStateTemps, yieldNow } from "./state-file";

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
 *
 * CPU stays small too: a read of the findings starts a pass only when the
 * names asked about changed (otherwise the timer runs one every 10 minutes
 * while a page is open, backing off to an hour while nothing changes), and a
 * pass works at most 4% of one core (server/pace.ts). `symbolsVersion()`
 * changes only when an answer changes, so the cached findings are worked out
 * again only then.
 *
 * The per-file findings are saved (state/code-names.json: paths, stamps and
 * which of the asked-for names appear, never a file's text), so after a
 * reload a pass only looks at file dates and reads what changed.
 */

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "vendor", "target", ".venv", "venv", "__pycache__", ".turbo", "coverage", ".cache", "out", ".output", "Pods"]);
const CODE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".py", ".go", ".rs", ".rb", ".java", ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".sql", ".sh", ".json", ".toml", ".yaml", ".yml", ".graphql", ".proto", ".css", ".scss", ".html"]);

export const SCAN_LIMITS = { files: 4000, fileBytes: 512 * 1024, totalBytes: 64 * 1024 * 1024, depth: 10 };
/** Across every project in one pass: bytes read from disk (cache misses), and files remembered. */
export const PASS_LIMITS = { readBytes: 128 * 1024 * 1024, cachedFiles: 60_000 };
const INTERVAL_MS = 10 * 60_000;
/** While passes find nothing new, the next one waits longer, up to this. */
const IDLE_MAX_MS = 60 * 60_000;
/** A pass cut short by the read budget carries on this soon, not in ten minutes. */
const CARRY_ON_MS = 60_000;
const IDENT = /[A-Za-z_$][\w$]{3,}/g;
const NONE: readonly string[] = Object.freeze([]);

type FileHits = { stamp: string; hits: readonly string[] };
/** `key`: a hash of the names asked about; findings for other names don't count. */
type ProjectCache = { key: string; files: Map<string, FileHits> };
export type ProjectIndex = { names: ReadonlySet<string>; found: ReadonlySet<string>; asOf: string; files: number; capped: boolean };
type Budget = { readBytes: number; cachedFiles: number };

const caches = new Map<string, ProjectCache>();
const projects = new Map<string, ProjectIndex>();
/** Requested roots that are not folders on this machine: never scanned, so never "still being scanned". */
const missing = new Set<string>();
/** Project root → the names its memories mention (sorted, own strings). Replaced by every request. */
let wanted = new Map<string, string[]>();
let wantedKey = "";
let running: Promise<void> | null = null;
let again = false;
let version = 0;
let quietPasses = 0;
let lastPassAt = 0;
let lastFinished: string | null = null;
let failures = 0;
let unfinished = false;
let cursor = 0;
/** Bytes of source read by the last pass (tests and diagnostics). */
let lastPassBytes = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let loading: Promise<void> | null = null;
let forgets = 0;

const STATE_NAME = "code-names";
const SavedProject = z.object({ root: z.string().min(1).max(4096), key: z.string().regex(/^[0-9a-f]{64}$/) });
/** One file: its project (an index into `projects`), path, stamp, and which asked-for names it holds. */
const SavedFile = z.tuple([z.number().int().nonnegative(), z.string().min(1).max(4096), z.string().max(128), z.array(z.string().max(512)).max(5000)]);
/** The file as a whole; each project and file is checked on its own, so one bad entry costs only that entry. */
const SavedScan = z.object({ version: z.literal(1), projects: z.array(z.unknown()).max(1000), files: z.array(z.unknown()).max(PASS_LIMITS.cachedFiles) });

/** Per-file findings, checked one by one, up to the byte cap; files left out are read again after the next load. Built in slices. */
async function snapshotText(): Promise<string> {
  const projectList: Array<z.infer<typeof SavedProject>> = [];
  const parts: string[] = [];
  let invalid = 0;
  for (const [root, cache] of caches) {
    const project = SavedProject.safeParse({ root, key: cache.key });
    if (!project.success) {
      invalid += cache.files.size;
      continue;
    }
    const index = projectList.push(project.data) - 1;
    for (const [path, hit] of cache.files) {
      const file = SavedFile.safeParse([index, path, hit.stamp, [...hit.hits]]);
      if (file.success) parts.push(JSON.stringify(file.data));
      else invalid += 1;
      if (parts.length % 512 === 511) await yieldNow();
    }
  }
  const { text, dropped } = fitEntries({ version: 1, projects: projectList }, "files", parts);
  if (dropped + invalid) console.warn(`[paseo-memories] code-name state: ${dropped + invalid} of ${parts.length + invalid} files not saved (${dropped} over the size cap, ${invalid} invalid); they are read again after a restart`);
  return text;
}

const saver = new StateSaver(STATE_NAME, snapshotText, 60_000);

/** Once per plugin load, before the first pass. A bad or unknown file means starting fresh; a bad entry, only that entry. */
function loadSaved(): Promise<void> {
  if (!loading) {
    const before = forgets;
    loading = readStateJson(STATE_NAME)
      .then(async (raw) => {
        const saved = SavedScan.safeParse(raw);
        if (!saved.success || before !== forgets || caches.size) return;
        const roots = saved.data.projects.map((project) => SavedProject.safeParse(project));
        const restored = new Map<string, ProjectCache>();
        for (const [index, entry] of saved.data.files.entries()) {
          const file = SavedFile.safeParse(entry);
          if (index % 512 === 511) await yieldNow();
          if (!file.success) continue;
          const [at, path, stamp, hits] = file.data;
          const project = roots[at];
          if (!project?.success) continue;
          let cache = restored.get(project.data.root);
          if (!cache) restored.set(project.data.root, (cache = { key: project.data.key, files: new Map() }));
          cache.files.set(path, { stamp, hits: hits.length ? hits : NONE });
        }
        if (before !== forgets || caches.size) return;
        for (const [root, cache] of restored) caches.set(root, cache);
      })
      .catch(() => undefined);
  }
  return loading;
}

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
  const key = sha256(list.join("\u0000"));
  const old = caches.get(root);
  const previous = old?.key === key ? old.files : null;
  const names = new Map(list.map((name) => [name, name]));
  const seen = new Map<string, FileHits>();
  const found = new Set<string>();
  let count = 0;
  let bytes = 0;
  let capped = false;
  let cut = false;
  const pacer = new Pacer();
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
      // Rest now and then so a big repo never holds the event loop or a core.
      if (count % 50 === 0) await pacer.step();
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

function sameAnswer(a: ProjectIndex | undefined, b: ProjectIndex): boolean {
  if (!a || a.capped !== b.capped || a.names.size !== b.names.size || a.found.size !== b.found.size) return false;
  for (const name of b.names) if (!a.names.has(name)) return false;
  for (const name of b.found) if (!a.found.has(name)) return false;
  return true;
}

async function runPass(): Promise<void> {
  const settings = await readMemoriesSettings();
  if (!settings.staleChecks) {
    if (projects.size) version += 1;
    forgets += 1;
    loading = Promise.resolve();
    void saver.close();
    caches.clear();
    projects.clear();
    missing.clear();
    unfinished = false;
    return;
  }
  saver.open();
  await loadSaved();
  const request = wanted;
  const before = version;
  const readBefore = PASS_LIMITS.readBytes;
  let dropped = false;
  for (const root of [...caches.keys()]) if (!request.has(root)) dropped = caches.delete(root) || dropped;
  for (const root of [...projects.keys()]) if (!request.has(root) && projects.delete(root)) version += 1;
  for (const root of [...missing]) if (!request.has(root)) missing.delete(root);
  // Start where the last cut-short pass stopped, so no project waits forever behind the others.
  const roots = [...request.keys()];
  const start = roots.length ? cursor % roots.length : 0;
  const order = [...roots.slice(start), ...roots.slice(0, start)];
  const budget: Budget = { ...PASS_LIMITS };
  let forgotten = 0;
  let firstCut = -1;
  for (const [i, root] of order.entries()) {
    if (!(await statSafe(root))?.isDirectory) {
      if (caches.delete(root)) dropped = true;
      if (projects.delete(root)) version += 1;
      if (!missing.has(root)) version += 1;
      missing.add(root);
      continue;
    }
    if (missing.delete(root)) version += 1;
    const kept = caches.get(root)?.files.size ?? 0;
    const index = await scanProject(root, request.get(root)!, budget);
    forgotten += Math.max(0, kept - (caches.get(root)?.files.size ?? 0));
    // An unchanged answer keeps its first time: nothing that reads it has to be worked out again.
    if (index && !sameAnswer(projects.get(root), index)) {
      projects.set(root, index);
      version += 1;
    } else if (!index && firstCut < 0) firstCut = i;
  }
  unfinished = firstCut >= 0;
  cursor = unfinished ? start + firstCut : 0;
  quietPasses = version === before && !unfinished ? quietPasses + 1 : 0;
  lastPassAt = Date.now();
  lastFinished = new Date().toISOString();
  lastPassBytes = readBefore - budget.readBytes;
  if (lastPassBytes > 0 || dropped || forgotten > 0) saver.soon();
}

/** Changes whenever an answer changes (the findings cache keys on it). */
export function symbolsVersion(): number {
  return version;
}

/**
 * Start a pass now if none is running. Only while an app is connected.
 * `queries` (project root → the code names its memories mention) replaces
 * the last request; without it the last request runs again.
 */
export function requestScan(queries?: Map<string, Iterable<string>>, force = false): void {
  let changed = false;
  if (queries) {
    const next = new Map([...queries].map(([root, names]) => [own(root), [...new Set([...names].map(own))].sort()]));
    const key = JSON.stringify([...next].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    changed = key !== wantedKey;
    if (changed) {
      wanted = next;
      wantedKey = key;
      quietPasses = 0;
    }
  }
  if (running) {
    // Asked about other names mid-pass: one more pass right after.
    if (changed || force) again = true;
    return;
  }
  if (!wanted.size) {
    if (projects.size || missing.size) version += 1;
    caches.clear();
    projects.clear();
    missing.clear();
    return;
  }
  if (!force && !clientSeenWithin()) return;
  // The same names as last time: the timer's next pass is soon enough.
  if (!force && !changed && lastPassAt > 0) return;
  again = false;
  running = runPass()
    .then(() => {
      failures = 0;
    })
    .catch(() => {
      failures += 1;
    })
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        requestScan(undefined, true);
      }
    });
}

export function symbolIndex(root: string): ProjectIndex | null {
  return projects.get(root) ?? null;
}

export function scanState(): { state: string; asOf?: string } {
  if (running) return { state: "running" };
  return projects.size && lastFinished ? { state: "done", asOf: lastFinished } : { state: "waiting" };
}

/** Of these project roots, how many have an answer, out of those that exist here (or are not known to be missing). */
export function scanProgress(roots: Iterable<string>): { checked: number; total: number } {
  let checked = 0;
  let total = 0;
  for (const root of roots) {
    if (missing.has(root)) continue;
    total += 1;
    if (projects.has(root)) checked += 1;
  }
  return { checked, total };
}

/** For tests: wait for the pass in flight. */
export async function scanSettled(): Promise<void> {
  await running;
}

/** For tests and diagnostics: how much the scan keeps between passes. */
export function scanStats(): { files: number; projects: number; wanted: number; unfinished: boolean; readBytes: number } {
  let files = 0;
  for (const cache of caches.values()) files += cache.files.size;
  return { files, projects: projects.size, wanted: wanted.size, unfinished, readBytes: lastPassBytes };
}

/** For tests: write the saved copy now. */
export function saveScansNow(): Promise<void> {
  return saver.now();
}

/** For tests: what a new plugin load starts with (the saved copy is read before the next pass). */
export async function reloadScans(): Promise<void> {
  await running;
  await saver.flush();
  caches.clear();
  projects.clear();
  missing.clear();
  wanted = new Map();
  wantedKey = "";
  unfinished = false;
  cursor = 0;
  quietPasses = 0;
  lastPassAt = 0;
  lastPassBytes = 0;
  lastFinished = null;
  failures = 0;
  loading = null;
  saver.reset();
  version += 1;
}

export function forgetScans(): void {
  forgets += 1;
  loading = Promise.resolve();
  void saver.close();
  caches.clear();
  projects.clear();
  missing.clear();
  wanted = new Map();
  wantedKey = "";
  unfinished = false;
  cursor = 0;
  quietPasses = 0;
  lastPassAt = 0;
  lastFinished = null;
  version += 1;
}

function schedule(): void {
  const delay = unfinished && failures === 0 ? CARRY_ON_MS : failures ? backoffMs(failures, INTERVAL_MS, IDLE_MAX_MS) : Math.min(IDLE_MAX_MS, INTERVAL_MS * 2 ** Math.min(quietPasses, 3));
  timer = setTimeout(() => {
    if (timerScanDue()) requestScan(undefined, true);
    schedule();
  }, delay);
  timer.unref?.();
}

/** The timer's next pass: finishing a cut-short scan while an app is connected; a routine re-check only while a page is open. */
export function timerScanDue(): boolean {
  return unfinished ? clientSeenWithin() : pageOpen();
}

onStart(() => {
  void sweepStateTemps();
  schedule();
});
onShutdown(() => {
  if (timer) clearTimeout(timer);
  timer = null;
  void saver.stop();
});
