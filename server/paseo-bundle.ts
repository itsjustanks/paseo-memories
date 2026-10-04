import fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * The skills the running Paseo ships, read from its own package: a plugin
 * runs in `<server package>/dist/server/server/plugins/plugin-process.js`,
 * and Paseo keeps its bundle in `<server package>/dist/server/skills/<name>/`
 * (@getpaseo/server 0.11 `orchestration-skills/internal/paths.js`: "the
 * bundle directory is the catalog"). Read once per plugin process (a new
 * Paseo restarts its plugins), async, nothing started. Null when it can't be
 * found or read, and then no skill is called an orphan: no guesses.
 * `PASEO_MEMORIES_PASEO_BUNDLE_DIR` points it elsewhere (tests only).
 */

let cached: Promise<ReadonlySet<string> | null> | null = null;

async function isBundle(dir: string): Promise<boolean> {
  return fs.stat(join(dir, "paseo", "SKILL.md")).then(
    (stat) => stat.isFile(),
    () => false,
  );
}

async function names(dir: string): Promise<ReadonlySet<string> | null> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out = new Set(entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name));
    return out.size ? out : null;
  } catch {
    return null;
  }
}

async function find(): Promise<ReadonlySet<string> | null> {
  const override = process.env.PASEO_MEMORIES_PASEO_BUNDLE_DIR?.trim();
  if (override !== undefined) return override && (await isBundle(override)) ? names(override) : null;
  const entry = process.argv[1];
  if (!entry || !/^plugin-process\.[cm]?[jt]s$/.test(basename(entry))) return null;
  let dir = dirname(await fs.realpath(entry).catch(() => entry));
  for (let up = 0; up < 5; up += 1) {
    const candidate = join(dir, "skills");
    if (await isBundle(candidate)) return names(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function paseoBundle(): Promise<ReadonlySet<string> | null> {
  if (!cached) cached = find().catch(() => null);
  return cached;
}

/** For tests. */
export function forgetPaseoBundle(): void {
  cached = null;
}
