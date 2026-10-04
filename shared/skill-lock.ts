/**
 * `npx skills`' global lock file (`~/.agents/.skill-lock.json`, or
 * `$XDG_STATE_HOME/skills/.skill-lock.json`), version 3 (vercel-labs/skills
 * `src/skill-lock.ts`): `{ version, skills: { <name>: entry }, dismissed?,
 * lastSelectedAgents? }`, written as `JSON.stringify(lock, null, 2)`.
 *
 * Kept compatible on purpose: every key this plugin does not set is carried
 * over untouched, and a file in another version is never rewritten (the tool
 * wipes a lock older than v3 on its next read, so writing one would lose the
 * user's records). Pure.
 */

export const LOCK_VERSION = 3;

export type LockEntry = {
  source: string;
  sourceType: string;
  sourceUrl: string;
  ref?: string;
  skillPath?: string;
  /** GitHub's tree id for the skill folder at the installed commit. */
  skillFolderHash: string;
  installedAt: string;
  updatedAt: string;
  [key: string]: unknown;
};

export type LockFile = { version: number; skills: Record<string, LockEntry>; [key: string]: unknown };

export type LockRead = { ok: true; lock: LockFile; exists: boolean } | { ok: false; reason: string };

/** Read the lock's text (null when there is none). Anything this plugin should not rewrite comes back as a reason. */
export function readLock(text: string | null): LockRead {
  if (text === null) return { ok: true, exists: false, lock: { version: LOCK_VERSION, skills: {} } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "The skills record kept by npx skills can't be read, so it was left as it is." };
  }
  const lock = parsed as LockFile;
  if (!lock || typeof lock !== "object" || Array.isArray(lock) || typeof lock.version !== "number" || !lock.skills || typeof lock.skills !== "object" || Array.isArray(lock.skills)) {
    return { ok: false, reason: "The skills record kept by npx skills is not in the shape it expects, so it was left as it is." };
  }
  if (lock.version !== LOCK_VERSION) {
    return { ok: false, reason: `The skills record kept by npx skills is version ${lock.version}; this plugin only updates version ${LOCK_VERSION}, so it was left as it is.` };
  }
  return { ok: true, exists: true, lock };
}

export function serializeLock(lock: LockFile): string {
  return JSON.stringify(lock, null, 2);
}

/** A copy with `name` set to `entry` (an existing entry's `installedAt` kept). */
export function withEntry(lock: LockFile, name: string, entry: LockEntry): LockFile {
  const before = lock.skills[name];
  const next: LockEntry = before ? { ...before, ...entry, installedAt: before.installedAt ?? entry.installedAt } : entry;
  return { ...lock, skills: { ...lock.skills, [name]: next } };
}

/** A copy without `name`. */
export function withoutEntry(lock: LockFile, name: string): LockFile {
  if (!(name in lock.skills)) return lock;
  const skills = { ...lock.skills };
  delete skills[name];
  return { ...lock, skills };
}

/** True when `text` is a lock this plugin could have written: v3 with a skills map. */
export function lockLooksValid(text: string): boolean {
  const read = readLock(text);
  return read.ok;
}

/** `owner/repo` from a lock entry, for the "where it came from" label. */
export function lockSourceLabel(entry: Pick<LockEntry, "source" | "sourceType">): string {
  return entry.sourceType === "github" ? entry.source : `${entry.source} (${entry.sourceType})`;
}
