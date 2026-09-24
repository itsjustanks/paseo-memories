import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
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

/** A file that fails to parse right after a good read is most likely mid-write; keep the good copy this long. */
export const PARSE_GRACE_MS = 60_000;

/** Text over this is never read whole on the read path (Codex's working diff runs to megabytes). */
export const MAX_READ_BYTES = 8 * 1024 * 1024;

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function statSafe(path: string): Promise<Stat | null> {
  try {
    const stat = await fs.stat(path);
    return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, mode: stat.mode, isFile: stat.isFile(), isDirectory: stat.isDirectory() };
  } catch {
    return null;
  }
}

function stampOf(stat: Stat | null): string {
  return stat ? `${stat.size}:${stat.mtimeMs}:${stat.ino}` : "missing";
}

export async function fileStamp(path: string): Promise<string> {
  return stampOf(await statSafe(path));
}

/** File text, or null when it is missing, not a file, unreadable or larger than `maxBytes`. */
export async function readTextCached(path: string, maxBytes = MAX_READ_BYTES): Promise<string | null> {
  const stat = await statSafe(path);
  if (!stat || !stat.isFile || stat.size > maxBytes) {
    texts.delete(path);
    return null;
  }
  const stamp = stampOf(stat);
  const hit = texts.get(path);
  if (hit && hit.stamp === stamp) return hit.text;
  try {
    const text = await fs.readFile(path, "utf8");
    texts.set(path, { stamp, text });
    return text;
  } catch {
    texts.delete(path);
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
    jsons.set(path, { stamp, value, parsedAt: now });
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
  texts.delete(path);
  jsons.delete(path);
}

/** For tests. */
export function forgetAllFiles(): void {
  texts.clear();
  jsons.clear();
}

/**
 * One stat, text and listing per path per request, shared by every rule that
 * asks. Load plans for six agents walk the same ancestors; this makes that one
 * walk.
 */
export class Probe {
  private stats = new Map<string, Promise<Stat | null>>();
  private reads = new Map<string, Promise<string | null>>();
  private lists = new Map<string, Promise<Dirent[]>>();

  stat(path: string): Promise<Stat | null> {
    let hit = this.stats.get(path);
    if (!hit) this.stats.set(path, (hit = statSafe(path)));
    return hit;
  }

  async isFile(path: string): Promise<boolean> {
    return Boolean((await this.stat(path))?.isFile);
  }

  async isDir(path: string): Promise<boolean> {
    return Boolean((await this.stat(path))?.isDirectory);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
  }

  text(path: string): Promise<string | null> {
    let hit = this.reads.get(path);
    if (!hit) this.reads.set(path, (hit = readTextCached(path)));
    return hit;
  }

  list(path: string): Promise<Dirent[]> {
    let hit = this.lists.get(path);
    if (!hit) this.lists.set(path, (hit = listDir(path)));
    return hit;
  }
}
