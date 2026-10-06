import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { pluginDataDir } from "./env";

/**
 * Where a background scan keeps its place between plugin loads
 * (`$PASEO_HOME/plugin-data/paseo-memories/state/<name>.json`), so an update
 * or a restart carries on where it left off instead of reading everything
 * again. Only counts, names and file positions go in: never a file's text.
 *
 * Reading never fails: a missing, too-big, unreadable or unknown file gives
 * null and the scan starts fresh. Writing goes to a temp file, synced, then
 * renamed over the old one, so a crash mid-write leaves the last good copy;
 * temp files a crash left behind are removed at the next start.
 */

/** Both sides measure bytes (UTF-8), never characters. Tests may lower it. */
export const STATE_LIMITS = { maxBytes: 8 * 1024 * 1024 };
const TEMP_SUFFIX = ".tmp";

function stateDir(): string {
  return join(pluginDataDir(), "state");
}

export function statePath(name: string): string {
  return join(stateDir(), `${name}.json`);
}

/** The parsed JSON, or null (missing, over the cap, unreadable, not JSON). Callers validate it. */
export async function readStateJson(name: string): Promise<unknown> {
  try {
    const path = statePath(name);
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size > STATE_LIMITS.maxBytes) return null;
    return JSON.parse(await fs.readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Atomic: temp file, fsync, rename. False (nothing written) when the text is over the cap or the write failed. */
export async function writeStateText(name: string, text: string): Promise<boolean> {
  if (Buffer.byteLength(text) > STATE_LIMITS.maxBytes) return false;
  const tmp = `${statePath(name)}.${randomBytes(6).toString("hex")}${TEMP_SUFFIX}`;
  try {
    await fs.mkdir(stateDir(), { recursive: true });
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, statePath(name));
    return true;
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    return false;
  }
}

export async function removeState(name: string): Promise<void> {
  await fs.rm(statePath(name), { force: true }).catch(() => undefined);
}

/** Temp files left by a save that never finished (a crash between write and rename). Ones under a minute old may be another load's save in flight. */
export async function sweepStateTemps(olderThanMs = 60_000, now = Date.now()): Promise<number> {
  let removed = 0;
  try {
    for (const name of await fs.readdir(stateDir())) {
      if (!name.endsWith(TEMP_SUFFIX)) continue;
      const path = join(stateDir(), name);
      const stat = await fs.stat(path).catch(() => null);
      if (!stat?.isFile() || now - stat.mtimeMs < olderThanMs) continue;
      await fs.rm(path, { force: true });
      removed += 1;
    }
  } catch {
    // No state folder yet.
  }
  return removed;
}

/** Lets other work in: building a saved copy of thousands of entries never holds the loop. */
export function yieldNow(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Builds the saved text from entries already serialised one by one (each
 * checked by the caller), keeping them in the order given (most useful
 * first) until the byte cap. Returns the text and how many were left out.
 */
export function fitEntries(head: Record<string, unknown>, key: string, entries: readonly string[], maxBytes = STATE_LIMITS.maxBytes): { text: string; dropped: number } {
  const open = `${JSON.stringify(head).slice(0, -1)}${Object.keys(head).length ? "," : ""}${JSON.stringify(key)}:[`;
  let bytes = Buffer.byteLength(open) + 2;
  let kept = 0;
  for (const entry of entries) {
    const size = Buffer.byteLength(entry) + 1;
    if (bytes + size > maxBytes) break;
    bytes += size;
    kept += 1;
  }
  return { text: `${open}${entries.slice(0, kept).join(",")}]}`, dropped: entries.length - kept };
}

/**
 * Saves at most once per `delayMs`, a little after the work that changed
 * something. `close()` (counting turned off) removes the file and refuses
 * every save until `open()`; `stop()` (shutdown) makes a due save and then
 * refuses the rest, so an old plugin load never writes over a new one.
 */
export class StateSaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private saving: Promise<void> = Promise.resolve();
  private closed = false;
  private stopped = false;

  constructor(
    private readonly name: string,
    /** The text to save, or null to save nothing this time. */
    private readonly snapshot: () => Promise<string | null>,
    private readonly delayMs = 60_000,
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  /** Something changed: save within `delayMs`. */
  soon(): void {
    if (this.timer || this.closed || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.now();
    }, this.delayMs);
    this.timer.unref?.();
  }

  /** Save now (a due save at shutdown; tests). */
  now(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.closed || this.stopped) return this.saving;
    const generation = this.generation;
    this.saving = this.saving.then(async () => {
      if (generation !== this.generation) return;
      const text = await this.snapshot().catch(() => null);
      if (text === null || generation !== this.generation) return;
      await writeStateText(this.name, text);
      if (generation !== this.generation) await removeState(this.name);
    });
    return this.saving;
  }

  /** A save that was due is made now; none is started otherwise. */
  flush(): Promise<void> {
    return this.timer ? this.now() : this.saving;
  }

  /** Shutdown: make a due save, then save nothing more. */
  stop(): Promise<void> {
    const done = this.flush();
    this.stopped = true;
    return done;
  }

  /** Forget: no save now or later (until `open`), and the file removed. */
  close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.closed = true;
    this.generation += 1;
    this.saving = this.saving.then(() => removeState(this.name));
    return this.saving;
  }

  open(): void {
    this.closed = false;
  }

  /** For tests: a new plugin load's saver. */
  reset(): void {
    this.closed = false;
    this.stopped = false;
  }
}
