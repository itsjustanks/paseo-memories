import { createHash } from "node:crypto";
import { stat as statCallback, type Dirent } from "node:fs";
import fs from "node:fs/promises";

/**
 * Read-only views of files, re-read only when the file changes. The pattern
 * is paseo-mcp 0.11.0 `server/files.ts`, made async: nothing on the RPC path
 * may block the plugin's event loop.
 *
 * A file is read and parsed once per change, judged by size, mtime and inode
 * (an atomic rename always changes the inode). Writers must not use these:
 * `server/write.ts` reads fresh. Credential files (`auth.json`) are never
 * cached; callers read those with `readFresh`.
 *
 * Parsed values are shared between callers; treat them as read-only.
 */

export type Stat = { size: number; mtimeMs: number; ino: number; mode: number; isFile: boolean; isDirectory: boolean };

type TextEntry = { stamp: string; text: string };
type JsonEntry = { stamp: string; value: unknown; parsedAt: number };

const texts = new Map<string, TextEntry>();
const jsons = new Map<string, JsonEntry>();
let textBytes = 0;

/**
 * Both caches keep the most recently used files and drop the oldest past
 * these caps, so a host with thousands of notes (or a long-running daemon
 * that has seen many folders come and go) holds a bounded amount.
 */
export const FILE_CACHE_LIMITS = { files: 4_000, textBytes: 48 * 1024 * 1024, jsons: 500 };

function keepText(path: string, entry: TextEntry): void {
  dropText(path);
  texts.set(path, entry);
  textBytes += entry.text.length;
  trimTexts();
}

function trimTexts(): void {
  while (texts.size > FILE_CACHE_LIMITS.files || textBytes > FILE_CACHE_LIMITS.textBytes) {
    const oldest = texts.keys().next().value;
    if (oldest === undefined) break;
    dropText(oldest);
  }
}

function dropText(path: string): void {
  const hit = texts.get(path);
  if (!hit) return;
  textBytes -= hit.text.length;
  texts.delete(path);
}

function keepJson(path: string, entry: JsonEntry): void {
  jsons.delete(path);
  jsons.set(path, entry);
  while (jsons.size > FILE_CACHE_LIMITS.jsons) jsons.delete(jsons.keys().next().value!);
}

/** For tests and diagnostics: what the caches hold. */
export function fileCacheSizes(): { texts: number; textBytes: number; jsons: number } {
  return { texts: texts.size, textBytes, jsons: jsons.size };
}

/** A file that fails to parse right after a good read is most likely mid-write; keep the good copy this long. */
export const PARSE_GRACE_MS = 60_000;

/** Text over this is never read whole on the read path (Codex's working diff runs to megabytes). */
export const MAX_READ_BYTES = 8 * 1024 * 1024;

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * One stat, null when the path isn't there (or can't be looked at). The
 * callback form, still async: a missing path is the common answer here
 * (thousands per check), and the promise form builds and rethrows an error
 * with a stack for each, about twice the CPU.
 */
export function statSafe(path: string): Promise<Stat | null> {
  return new Promise((resolve) => {
    try {
      statCallback(path, (error, stat) => resolve(error ? null : { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, mode: stat.mode, isFile: stat.isFile(), isDirectory: stat.isDirectory() }));
    } catch {
      // An invalid path (a NUL byte): nothing there.
      resolve(null);
    }
  });
}

function stampOf(stat: Stat | null): string {
  return stat ? `${stat.size}:${stat.mtimeMs}:${stat.ino}` : "missing";
}

export async function fileStamp(path: string): Promise<string> {
  return stampOf(await statSafe(path));
}

/** File text, or null when it is missing, not a file, unreadable or larger than `maxBytes`. */
export async function readTextCached(path: string, maxBytes = MAX_READ_BYTES): Promise<string | null> {
  return textFor(path, await statSafe(path), maxBytes);
}

/** File text for a stat already taken. */
async function textFor(path: string, stat: Stat | null, maxBytes = MAX_READ_BYTES): Promise<string | null> {
  if (!stat || !stat.isFile || stat.size > maxBytes) {
    dropText(path);
    return null;
  }
  const stamp = stampOf(stat);
  const hit = texts.get(path);
  if (hit && hit.stamp === stamp) {
    texts.delete(path);
    texts.set(path, hit);
    trimTexts();
    return hit.text;
  }
  try {
    const text = await fs.readFile(path, "utf8");
    keepText(path, { stamp, text });
    return text;
  } catch {
    dropText(path);
    return null;
  }
}

/** Parsed JSON, or null. A parse failure within PARSE_GRACE_MS of a good parse returns the good copy. */
export async function readJsonCached(path: string, now = Date.now()): Promise<unknown> {
  const stamp = await fileStamp(path);
  const hit = jsons.get(path);
  if (hit && hit.stamp === stamp) return hit.value;
  const text = await readTextCached(path);
  if (text === null) {
    jsons.delete(path);
    return null;
  }
  try {
    const value = JSON.parse(text) as unknown;
    keepJson(path, { stamp, value, parsedAt: now });
    return value;
  } catch {
    // Never pass the parser's message on: it quotes the file.
    if (hit && now - hit.parsedAt < PARSE_GRACE_MS) return hit.value;
    jsons.delete(path);
    return null;
  }
}

/** For credential files: read now, keep nothing. */
export async function readFresh(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function listDir(path: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Drop what is known about a file; called after this plugin writes it. */
export function forgetFile(path: string): void {
  dropText(path);
  jsons.delete(path);
}

/** For tests. */
export function forgetAllFiles(): void {
  texts.clear();
  jsons.clear();
  textBytes = 0;
}

// ------------------------------------------------------------------ has anything changed?

/** What a path looked like: kind, size, mtime and inode, or missing. A folder's mtime changes when an entry is added, removed or renamed. */
export function signature(stat: Stat | null): string {
  return stat ? `${stat.isDirectory ? "d" : stat.isFile ? "f" : "o"}:${stat.size}:${stat.mtimeMs}:${stat.ino}` : "-";
}

/** Only what kind of thing is at a path (folder, file, other, missing): all an "is it there?" answer depends on. */
export function kindOf(stat: Stat | null): string {
  return stat ? (stat.isDirectory ? "d" : stat.isFile ? "f" : "o") : "-";
}

/** Paths to how they looked when first looked at: a full `signature`, or only their `kindOf` when that was all that was asked. */
export type Seen = ReadonlyMap<string, string>;

function looksSame(stat: Stat | null, was: string): boolean {
  return (was.length === 1 ? kindOf(stat) : signature(stat)) === was;
}

/**
 * Whether any path looks different now: one stat each, `limit` at a time,
 * stopping at the first change, and letting other work in after every
 * `batch` stats (a page polling must never hold the loop). About 25 ms of
 * CPU for 4,500 paths, in many small pieces.
 */
export async function changedSince(seen: Seen, limit = 4, batch = 16): Promise<boolean> {
  const paths = [...seen.keys()];
  let next = 0;
  let changed = false;
  const worker = async () => {
    while (!changed && next < paths.length) {
      const index = next++;
      const path = paths[index]!;
      if (!looksSame(await statSafe(path), seen.get(path)!)) changed = true;
      if (index % batch === batch - 1) await new Promise((resolve) => setImmediate(resolve));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, paths.length) }, worker));
  return changed;
}

/** Runs `fn` over `items`, `limit` at a time. */
export async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * One stat, text and listing per path per request, shared by every rule that
 * asks. Load plans for six agents walk the same ancestors; this makes that one
 * walk.
 */
export class Probe {
  private stats = new Map<string, Promise<Stat | null>>();
  private fulls = new Map<string, Promise<Stat | null>>();
  private kinds = new Map<string, Promise<Stat | null>>();
  private reads = new Map<string, Promise<string | null>>();
  private lists = new Map<string, Promise<Dirent[]>>();
  /**
   * Every path this probe looked at, as it looked then: what a cached answer
   * built with it depends on (`changedSince`). A path only asked "is it
   * there?" keeps only its kind, so a folder that merely exists (/tmp, HOME,
   * a project) changing inside does not count as a change.
   */
  readonly seen = new Map<string, string>();

  private look(path: string): Promise<Stat | null> {
    let hit = this.stats.get(path);
    if (!hit) this.stats.set(path, (hit = statSafe(path)));
    return hit;
  }

  /** The stat, size and times included: the answer depends on all of it. */
  stat(path: string): Promise<Stat | null> {
    let hit = this.fulls.get(path);
    if (!hit) {
      hit = this.look(path).then((stat) => {
        this.seen.set(path, signature(stat));
        return stat;
      });
      this.fulls.set(path, hit);
    }
    return hit;
  }

  /** The stat for an "is it there?" question: only its kind is noted (unless the full stat was asked for too). */
  private kind(path: string): Promise<Stat | null> {
    let hit = this.kinds.get(path);
    if (!hit) {
      hit = this.look(path).then((stat) => {
        if (!this.seen.has(path)) this.seen.set(path, kindOf(stat));
        return stat;
      });
      this.kinds.set(path, hit);
    }
    return hit;
  }

  async isFile(path: string): Promise<boolean> {
    return Boolean((await this.kind(path))?.isFile);
  }

  async isDir(path: string): Promise<boolean> {
    return Boolean((await this.kind(path))?.isDirectory);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.kind(path)) !== null;
  }

  text(path: string): Promise<string | null> {
    let hit = this.reads.get(path);
    if (!hit) this.reads.set(path, (hit = this.stat(path).then((stat) => textFor(path, stat))));
    return hit;
  }

  list(path: string): Promise<Dirent[]> {
    let hit = this.lists.get(path);
    if (!hit) this.lists.set(path, (hit = this.stat(path).then(() => listDir(path))));
    return hit;
  }
}
