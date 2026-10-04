import { join } from "node:path";
import { pluginDataDir } from "./env";
import { readJsonCached, statSafe } from "./files";
import { atomicWrite } from "./write";
import fs from "node:fs/promises";

/**
 * The skills this plugin added, by real folder path: how "added here" is
 * told apart from `npx skills` and hand-made folders. Kept in the plugin's
 * own data folder (never in a skills folder, where it would be read as part
 * of a skill). Only paths, names, sources and times; no skill text.
 */

export type AddedRecord = { name: string; source: string; commit: string; addedAt: string };
type RecordFile = { version: 1; skills: Record<string, AddedRecord> };

function recordPath(): string {
  return join(pluginDataDir(), "skills-added.json");
}

export async function readAdded(): Promise<Record<string, AddedRecord>> {
  const value = (await readJsonCached(recordPath())) as RecordFile | null;
  return value && value.version === 1 && value.skills && typeof value.skills === "object" ? value.skills : {};
}

async function save(skills: Record<string, AddedRecord>): Promise<void> {
  const path = recordPath();
  if (!(await statSafe(pluginDataDir()))) await fs.mkdir(pluginDataDir(), { recursive: true, mode: 0o700 });
  await atomicWrite(path, `${JSON.stringify({ version: 1, skills } satisfies RecordFile, null, 2)}\n`, 0o600);
}

export async function recordAdded(realPath: string, record: AddedRecord): Promise<void> {
  await save({ ...(await readAdded()), [realPath]: record });
}

export async function forgetAdded(realPath: string): Promise<void> {
  const skills = { ...(await readAdded()) };
  if (!(realPath in skills)) return;
  delete skills[realPath];
  await save(skills);
}
