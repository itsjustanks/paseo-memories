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
 */

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "vendor", "target", ".venv", "venv", "__pycache__", ".turbo", "coverage", ".cache", "out", ".output", "Pods"]);
const CODE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".py", ".go", ".rs", ".rb", ".java", ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".sql", ".sh", ".json", ".toml", ".yaml", ".yml", ".graphql", ".proto", ".css", ".scss", ".html"]);

export const SCAN_LIMITS = { files: 4000, fileBytes: 512 * 1024, totalBytes: 64 * 1024 * 1024, depth: 10 };
const INTERVAL_MS = 10 * 60_000;
const IDENT = /[A-Za-z_$][\w$]{3,}/g;

type FileTokens = { stamp: string; tokens: string[] };
type ProjectIndex = { tokens: Set<string>; asOf: string; files: number; capped: boolean };

const files = new Map<string, FileTokens>();
const projects = new Map<string, ProjectIndex>();
const wanted = new Set<string>();
let running: Promise<void> | null = null;
let failures = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

async function scanProject(root: string): Promise<ProjectIndex> {
  const tokens = new Set<string>();
  let count = 0;
  let bytes = 0;
  let capped = false;
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
      const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
      let hit = files.get(path);
      if (hit?.stamp !== stamp) {
        try {
          const text = await fs.readFile(path, "utf8");
          hit = { stamp, tokens: [...new Set(text.match(IDENT) ?? [])] };
          files.set(path, hit);
        } catch {
          continue;
        }
      }
      for (const token of hit.tokens) tokens.add(token);
      // Yield now and then so a big repo never holds the event loop.
      if (count % 200 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  };
  await walk(root, 0);
  return { tokens, asOf: new Date().toISOString(), files: count, capped };
}

async function runPass(): Promise<void> {
  const settings = await readMemoriesSettings();
  if (!settings.staleChecks) return;
  for (const root of [...wanted]) {
    if (!(await statSafe(root))?.isDirectory) {
      projects.delete(root);
      continue;
    }
    projects.set(root, await scanProject(root));
  }
}

/** Start a pass now if none is running. Only while an app is connected. */
export function requestScan(roots: Iterable<string>, force = false): void {
  for (const root of roots) wanted.add(root);
  if (running || (!force && !clientSeenWithin())) return;
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

export function forgetScans(): void {
  files.clear();
  projects.clear();
  wanted.clear();
}

function schedule(): void {
  timer = setTimeout(() => {
    if (clientSeenWithin() && wanted.size) requestScan([]);
    schedule();
  }, backoffMs(failures, INTERVAL_MS, 60 * 60_000));
  timer.unref?.();
}

onStart(schedule);
onShutdown(() => {
  if (timer) clearTimeout(timer);
  timer = null;
});
