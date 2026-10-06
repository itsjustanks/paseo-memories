import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import type { ZodType, output as ZodOutput } from "zod";
import { pluginDataDir } from "./env";

/**
 * Where a background scan keeps its place between plugin loads
 * (`$PASEO_HOME/plugin-data/paseo-memories/state/<name>.json`), so an update
 * or a restart carries on where it left off instead of reading everything
 * again. Only counts, names and file positions go in: never a file's text.
 *
 * Reading never fails: a missing, too-big, unreadable or unknown file gives
 * null and the scan starts fresh. Writing goes to a temp file renamed over
 * the old one, so a crash mid-write leaves the last good copy.
 */

export const STATE_MAX_BYTES = 8 * 1024 * 1024;

export function statePath(name: string): string {
  return join(pluginDataDir(), "state", `${name}.json`);
}

export async function readState<S extends ZodType>(name: string, schema: S): Promise<ZodOutput<S> | null> {
  try {
    const path = statePath(name);
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size > STATE_MAX_BYTES) return null;
    const parsed = schema.safeParse(JSON.parse(await fs.readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Atomic: temp file, then rename. False (and nothing written) when the text is over the cap or the write failed. */
export async function writeState(name: string, value: unknown): Promise<boolean> {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > STATE_MAX_BYTES) return false;
  const path = statePath(name);
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.mkdir(join(pluginDataDir(), "state"), { recursive: true });
    await fs.writeFile(tmp, text, { mode: 0o600 });
    await fs.rename(tmp, path);
    return true;
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    return false;
  }
}

export async function removeState(name: string): Promise<void> {
  await fs.rm(statePath(name), { force: true }).catch(() => undefined);
}

/**
 * Saves at most once per `delayMs`, a little after the work that changed
 * something, and never after `cancel()` (counting turned off: the file is
 * removed and must not come back from a save already under way).
 */
export class StateSaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly name: string,
    private readonly snapshot: () => unknown,
    private readonly delayMs = 5_000,
  ) {}

  /** Something changed: save soon. */
  soon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.now();
    }, this.delayMs);
    this.timer.unref?.();
  }

  /** Shutdown: a save that was due is made now. */
  flush(): Promise<void> {
    return this.timer ? this.now() : this.saving;
  }

  /** Save now (tests). */
  now(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const generation = this.generation;
    this.saving = this.saving.then(async () => {
      if (generation !== this.generation) return;
      await writeState(this.name, this.snapshot());
      if (generation !== this.generation) await removeState(this.name);
    });
    return this.saving;
  }

  /** Forget: no pending save, and the file removed. */
  cancel(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.generation += 1;
    this.saving = this.saving.then(() => removeState(this.name));
    return this.saving;
  }
}
