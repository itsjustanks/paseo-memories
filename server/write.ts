import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { FileStamp, WriteReport } from "../shared/contracts";
import { keepTextTraits } from "../shared/text";
import { tilde } from "../shared/agents";
import { pluginDataDir, userHome } from "./env";
import { currentInstance, sign, signatureMatches, type Instance } from "./instance";
import { logWrite } from "./log";
import { forgetFile, sha256, statSafe } from "./files";
import { skillFolderReason, skillParentReason, writableReason } from "./writable";

export { sha256 };

/**
 * Every change to a user's file goes through here (SPEC "Safety"; 0.6.0):
 *
 * 1. Replacing or removing: `swapFile`, "set aside, verify, create-exclusive".
 *    The entry is renamed into a FRESH backup folder beside it
 *    (`.memories-backup/<time>-<random>/<name>.bak`, made with mkdtemp, so
 *    nothing can be there), checked against what the caller saw, put back
 *    no-replace if it differs, and the new version put in place no-replace
 *    (a hard link, or an exclusive copy). Nothing is overwritten or unlinked.
 * 2. Creating: `createExclusive` (exclusive mkdir, no-replace file, or a
 *    symlink), recorded by identity; taking back only what one operation
 *    made: `removeOwned` (moved aside first, removed only if still the same
 *    entry, never recursively).
 * 3. Read back and check; one WriteReport per target, built from what is
 *    actually on disk afterwards.
 * 4/6. Refused here, whatever the caller did: paths that are not memory or
 *    instruction files by name, hard-linked files, files that are not UTF-8,
 *    and a file that changed since the caller's read.
 * 5. Nothing here logs file text: paths and counts only.
 * The old plugin-data backups (`backupsRoot`) remain only for Paseo's
 * appended prompt and backups made before 0.6.0.
 */

export const TEMP_PREFIX = ".paseo-memories-tmp-";

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function backupsRoot(): string {
  return join(pluginDataDir(), "backups");
}

/** The absolute path as a relative one under a backup folder. */
export function mirrored(path: string): string {
  return path.replace(/^[A-Za-z]:/, (drive) => drive[0]!).replace(/^[/\\]+/, "");
}

export type Session = { stamp: string; keep: number };

/** One user action = one backup folder, so a memory and its index line are restored together. */
export function newSession(keep: number): Session {
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  return { stamp, keep };
}

// ------------------------------------------------------------------ what may be written

export { writableReason };

// ------------------------------------------------------------------ reading

export type Current = {
  exists: boolean;
  /** Decoded text, BOM kept. Lossy when `utf8` is false; never saved back then. */
  text: string;
  bytes?: Buffer;
  stamp?: FileStamp;
  mode?: number;
  /** Which file it is on disk: a replace-by-rename shows up here even with the same size and time. */
  ino?: number;
  /** The file itself: the symlink's target when `path` is a link. */
  realPath: string;
  /** When `path` is a link: what it points to, as written in the link. */
  linkTarget?: string;
  symlink: boolean;
  nlink: number;
  utf8: boolean;
  /** Why saving over this file is refused, when it is. */
  blocked?: string;
};

function stampFrom(bytes: Buffer, stat: { size: number; mtimeMs: number }): FileStamp {
  return { size: stat.size, mtimeMs: stat.mtimeMs, hash: sha256(bytes) };
}

/** The file as it is now, read fresh as raw bytes (never from the cache), links followed. */
export async function readCurrent(path: string): Promise<Current> {
  let link;
  try {
    link = await fs.lstat(path);
  } catch {
    return { exists: false, text: "", realPath: path, symlink: false, nlink: 0, utf8: true };
  }
  const symlink = link.isSymbolicLink();
  const linkTarget = symlink ? await fs.readlink(path).catch(() => undefined) : undefined;
  let realPath = path;
  if (symlink) {
    try {
      realPath = await fs.realpath(path);
    } catch {
      return { exists: false, text: "", realPath: path, symlink: true, nlink: 0, utf8: true, blocked: `${basename(path)} is a link to a file that does not exist.` };
    }
  }
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw new Error(`${path} is not a file.`);
  const bytes = await fs.readFile(realPath);
  let text: string;
  let utf8 = true;
  try {
    text = UTF8.decode(bytes);
  } catch {
    utf8 = false;
    text = bytes.toString("utf8");
  }
  const name = basename(path);
  const blocked = !utf8
    ? `${name} is not UTF-8 text, so saving it here could damage it. Edit it in an editor that knows its encoding.`
    : stat.nlink > 1
      ? `${name} has other hard links; saving would split them into separate files. Edit it directly.`
      : undefined;
  return { exists: true, text, bytes, stamp: stampFrom(bytes, stat), mode: stat.mode & 0o777, ino: stat.ino, realPath, symlink, ...(linkTarget !== undefined ? { linkTarget } : {}), nlink: stat.nlink, utf8, ...(blocked ? { blocked } : {}) };
}

/** Why a save must be refused because the file changed since the user saw it; null when it is safe. */
export function staleReason(current: Current, expected: FileStamp | null): string | null {
  if (expected === null) return current.exists ? "That file already exists; open it and edit it instead." : null;
  if (!current.exists) return "That file was deleted since you opened it. Nothing was saved.";
  const stamp = current.stamp!;
  const changed = expected.hash ? expected.hash !== stamp.hash : expected.size !== stamp.size || Math.trunc(expected.mtimeMs) !== Math.trunc(stamp.mtimeMs);
  return changed ? "That file changed since you opened it (another agent or editor wrote it). Reload it and make your change again; nothing was saved." : null;
}

// ------------------------------------------------------------------ backups

async function prune(path: string, keep: number): Promise<void> {
  const root = backupsRoot();
  let stamps: string[];
  try {
    stamps = (await fs.readdir(root)).sort().reverse();
  } catch {
    return;
  }
  const rel = mirrored(path);
  let kept = 0;
  for (const stamp of stamps) {
    const copy = join(root, stamp, rel);
    if (!(await statSafe(copy))) continue;
    kept += 1;
    if (kept <= keep) continue;
    await fs.rm(copy, { force: true });
    // Remove folders left empty, up to the stamp folder.
    let folder = dirname(copy);
    while (folder.startsWith(join(root, stamp))) {
      try {
        await fs.rmdir(folder);
      } catch {
        break;
      }
      if (folder === join(root, stamp)) break;
      folder = dirname(folder);
    }
  }
}

/** Keep the last N copies per file. Run after a rename, never between the last check and it. */
export async function pruneBackups(session: Session, path: string): Promise<void> {
  try {
    await prune(path, session.keep);
  } catch {
    // Pruning is best-effort; never fail a write on it.
  }
}

/** Copy raw bytes into this session's backup folder. A second copy of one file in one action keeps the first. */
export async function writeBackup(session: Session, path: string, bytes: Buffer): Promise<string> {
  const target = join(backupsRoot(), session.stamp, mirrored(path));
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (await statSafe(target)) return target;
  await fs.writeFile(target, bytes, { mode: 0o600, flag: "wx" });
  return target;
}

/** Back up whatever is at `path` now (raw bytes). Undefined when there is nothing there. */
export async function backup(session: Session, path: string): Promise<string | undefined> {
  const now = await readCurrent(path);
  if (!now.exists || !now.bytes) return undefined;
  const target = await writeBackup(session, now.realPath, now.bytes);
  await pruneBackups(session, now.realPath);
  return target;
}

// ------------------------------------------------------------------ writing

async function syncFolder(folder: string): Promise<void> {
  try {
    const handle = await fs.open(folder, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not every platform can fsync a folder; the rename already happened.
  }
}

async function writeTemp(beside: string, text: string | Buffer, mode: number): Promise<string> {
  const tmp = join(dirname(beside), `${TEMP_PREFIX}${randomBytes(6).toString("hex")}`);
  const handle = await fs.open(tmp, "wx", mode);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.rm(tmp, { force: true });
    throw error;
  }
  await handle.close();
  // An umask can narrow the create mode; set it exactly.
  await fs.chmod(tmp, mode);
  return tmp;
}

/** Temp file beside the target, fsync, rename; the target's mode kept, else `newMode`. No checks: tests and callers that own the file only. */
export async function atomicWrite(path: string, text: string, newMode: number): Promise<void> {
  const stat = await statSafe(path);
  const tmp = await writeTemp(path, text, stat ? stat.mode & 0o777 : newMode);
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
  forgetFile(path);
  await syncFolder(dirname(path));
}


/** Read the file back and compare with what was written; `check` adds a parse test. */
export async function readBack(path: string, expected: string | null, check?: (text: string) => boolean): Promise<{ readBack: "ok" | "mismatch"; stamp?: FileStamp }> {
  try {
    const now = await readCurrent(path);
    if (expected === null) return { readBack: now.exists ? "mismatch" : "ok" };
    if (!now.exists || now.text !== expected) return { readBack: "mismatch" };
    if (check && !check(now.text)) return { readBack: "mismatch", stamp: now.stamp };
    return { readBack: "ok", stamp: now.stamp };
  } catch {
    return { readBack: "mismatch" };
  }
}

export type WriteOpts = {
  newMode: number;
  /** The read the caller checked for staleness; the write aborts if the file moved on since. */
  current?: Current;
  check?: (text: string) => boolean;
  versionControlled?: boolean;
  /**
   * For a symlink whose target has another name: may that file be written?
   * A link to a file of the same name (a dotfiles repo) is allowed by default.
   */
  allowLinkTarget?: (realPath: string) => boolean | Promise<boolean>;
};

const CHANGED_WHILE_SAVING = "That file changed while it was being saved (another agent or editor wrote it). Nothing was saved; reload it and make your change again.";
const CHANGED_WHILE_REMOVING = "That file changed while it was being removed (another agent or editor wrote it), so nothing was removed.";

/** Refusals shared by write and delete; null when the target may be touched. */
async function refusal(path: string, current: Current, opts: Pick<WriteOpts, "allowLinkTarget">): Promise<string | null> {
  const byName = (await writableReason(path)) ?? (current.realPath !== path ? await writableReason(current.realPath) : null);
  if (byName) return byName;
  if (current.blocked) return current.blocked;
  if (current.symlink && current.exists && basename(current.realPath) !== basename(path)) {
    const allowed = opts.allowLinkTarget ? await opts.allowLinkTarget(current.realPath) : false;
    if (!allowed) return `${basename(path)} is a link to ${current.realPath}, which this plugin does not treat as the same file. Edit that file directly.`;
  }
  return null;
}

// ------------------------------------------------------------------ the one way files change (0.6.0)

/** The backup folder beside the files it holds (0.6.0): `<dir>/.memories-backup/<time>-<random>/`. Visible, and on the same disk as what it backs up. */
export const LOCAL_BACKUP_DIR = ".memories-backup";
/** The ownership marker inside each backup folder this plugin makes (see `sealBackupFolder`). */
export const BACKUP_MARKER = ".paseo-memories-backup.json";
/** A set-aside folder with more entries than this is kept unsealed (so never pruned) rather than walked forever. */
const MAX_SEALED_ENTRIES = 5000;

/**
 * The name a set-aside entry gets in its backup folder: `<name>.bak`
 * (`CLAUDE.md.bak`, `note.md.bak`, `my-skill.bak`), so no agent loads a
 * backed-up file as instructions or a note. Only that top-level entry is
 * named; nothing inside a set-aside folder is ever renamed.
 */
export function backupName(path: string): string {
  return `${basename(path)}.bak`;
}

/**
 * A FRESH backup folder for one operation, beside `dir`: made with mkdtemp
 * inside `.memories-backup/`, so it is new, private (0700) and empty, and
 * nothing set aside into it can collide with anything. A `.gitignore` of "*"
 * keeps a repo's backups out of git. Throws when it can't be made.
 */
export async function localBackupFolder(dir: string): Promise<string> {
  const root = join(dir, LOCAL_BACKUP_DIR);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(root, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }).catch(() => undefined);
  return fs.mkdtemp(join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}-`));
}

type MarkerEntry = { path: string; dev: number; ino: number; type: "file" | "dir" | "link" };
type Marker = { version: 2; instance: string; folder: string; self: { dev: number; ino: number }; created: string; entries: MarkerEntry[]; signature: string };
const MarkerSchemaShape = (value: unknown): value is Marker => {
  const marker = value as Record<string, unknown> | null;
  const self = marker?.self as Record<string, unknown> | undefined;
  return Boolean(marker && marker.version === 2 && typeof marker.instance === "string" && typeof marker.folder === "string" && self && typeof self.dev === "number" && typeof self.ino === "number" && typeof marker.created === "string" && typeof marker.signature === "string" && Array.isArray(marker.entries) && (marker.entries as unknown[]).every((entry) => {
    const item = entry as Record<string, unknown> | null;
    return Boolean(item && typeof item.path === "string" && !item.path.startsWith("/") && !item.path.split("/").includes("..") && typeof item.dev === "number" && typeof item.ino === "number" && ["file", "dir", "link"].includes(item.type as string));
  }));
};

/** Every entry under `path` (itself first, then what's inside a folder), by identity, relative to `folder`. False when there are too many. */
async function recordEntries(folder: string, path: string, out: MarkerEntry[]): Promise<boolean> {
  if (out.length >= MAX_SEALED_ENTRIES) return false;
  const stat = await fs.lstat(path);
  const type = stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : "file";
  out.push({ path: relative(folder, path), dev: stat.dev, ino: stat.ino, type });
  if (type === "dir") for (const name of (await fs.readdir(path)).sort()) if (!(await recordEntries(folder, join(path, name), out))) return false;
  return true;
}

/**
 * Seals a backup folder once an operation is done with it (0.6.0): an
 * EXCLUSIVE marker file listing every entry this plugin put there (the
 * set-aside `.bak`, a `.paseo-new`, and everything inside a set-aside
 * folder) by path, device, inode and type, signed with this instance's
 * secret over the folder's name, time and entries. Only a sealed folder is
 * ever pruned, and only those entries. A folder the operation left empty is
 * removed at once (rmdir: only if empty). A folder that can't be sealed is
 * simply kept. Never throws.
 */
async function sealBackupFolder(folder: string, tops: ReadonlyArray<string | undefined>): Promise<void> {
  try {
    const entries: MarkerEntry[] = [];
    let complete = true;
    for (const top of tops) if (top && dirname(top) === folder && (await present(top))) complete = (await recordEntries(folder, top, entries)) && complete;
    if (!entries.length) {
      await fs.rmdir(folder).catch(() => undefined);
      return;
    }
    const instance = await currentInstance();
    if (!complete || !instance) return;
    const self = await fs.lstat(folder);
    const body = { version: 2 as const, instance: instance.id, folder: basename(folder), self: { dev: self.dev, ino: self.ino }, created: new Date().toISOString(), entries };
    await fs.writeFile(join(folder, BACKUP_MARKER), JSON.stringify({ ...body, signature: sign(instance.secret, JSON.stringify(body)) }), { flag: "wx", mode: 0o600 });
  } catch {
    // Unsealed: kept, never pruned.
  }
}

/** A backup folder's marker, only if it is a regular file this instance signed for this very folder (a real folder, not a link, with the recorded identity). */
async function verifiedMarker(folder: string, instance: Instance): Promise<{ created: string; self: { dev: number; ino: number }; entries: MarkerEntry[] } | null> {
  try {
    const own = await fs.lstat(folder);
    if (!own.isDirectory()) return null;
    const path = join(folder, BACKUP_MARKER);
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return null;
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
    if (!MarkerSchemaShape(parsed)) return null;
    const { signature, ...body } = parsed;
    if (body.instance !== instance.id || body.folder !== basename(folder) || body.self.dev !== own.dev || body.self.ino !== own.ino) return null;
    return signatureMatches(instance.secret, JSON.stringify(body), signature) ? { created: body.created, self: body.self, entries: body.entries } : null;
  } catch {
    return null;
  }
}

/**
 * Is `entry` (inside `root`) exactly what the marker recorded, reached only
 * through real folders that are themselves what it recorded? Every path
 * component from `root` down is lstat'ed (links are never followed): each
 * ancestor must be a real folder whose device and inode match its record,
 * and the entry itself must match its own.
 */
async function entryIntact(root: string, entry: MarkerEntry, byPath: ReadonlyMap<string, MarkerEntry>): Promise<boolean> {
  const parts = entry.path.split("/");
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const rel = parts.slice(0, depth).join("/");
    const record = byPath.get(rel);
    if (!record) return false;
    const stat = await fs.lstat(join(root, rel)).catch(() => null);
    if (!stat || stat.dev !== record.dev || stat.ino !== record.ino) return false;
    const type = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : "file";
    if (type !== record.type) return false;
    if (depth < parts.length && type !== "dir") return false;
  }
  return true;
}

/**
 * Takes one verified backup folder away, safely (0.6.0 final gate):
 *   1. it is RENAMED into a fresh private trash folder inside
 *      `.memories-backup/` (mkdtemp), out of everyone's way, and must still
 *      be the folder the marker recorded;
 *   2. EVERY listed entry is checked top-down (`entryIntact`: each ancestor
 *      a real folder with the recorded identity, never through a link), and
 *      nothing unlisted may be in it. Any mismatch: it is moved back where it
 *      was, untouched, and logged;
 *   3. only then are the entries removed bottom-up (each re-checked right
 *      before: unlink, or rmdir which only takes an empty folder), then the
 *      marker, the folder and the trash folder. Never recursive.
 * Returns false when it left the folder.
 */
async function pruneFolder(root: string, folder: string, self: { dev: number; ino: number }, entries: readonly MarkerEntry[]): Promise<boolean> {
  const trash = await fs.mkdtemp(join(root, ".trash-"));
  const moved = join(trash, basename(folder));
  const leave = async (why: string) => {
    if (await present(moved)) await placeNoReplace(moved, folder).catch(() => false);
    await fs.rmdir(trash).catch(() => undefined);
    logWrite("prune", folder, `kept: ${why}`);
    return false;
  };
  try {
    await fs.rename(folder, moved);
  } catch {
    return leave("it couldn't be moved aside");
  }
  const own = await fs.lstat(moved).catch(() => null);
  if (!own || !own.isDirectory() || own.dev !== self.dev || own.ino !== self.ino) return leave("it isn't the folder this plugin made");
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) if (!(await entryIntact(moved, entry, byPath))) return leave(`${entry.path} isn't what was backed up (replaced, moved or linked elsewhere)`);
  // Nothing unlisted anywhere inside: every listed folder holds only listed entries (and the marker at the top).
  for (const dir of ["", ...entries.filter((entry) => entry.type === "dir").map((entry) => entry.path)]) {
    for (const name of await fs.readdir(join(moved, dir)).catch(() => [] as string[])) {
      const rel = dir ? `${dir}/${name}` : name;
      if (!(rel === BACKUP_MARKER || byPath.has(rel))) return leave(`it holds ${rel}, which this plugin didn't put there`);
    }
  }
  for (const entry of [...entries].reverse()) {
    if (!(await entryIntact(moved, entry, byPath))) return leave(`${entry.path} changed while it was being removed`);
    const path = join(moved, entry.path);
    const done = entry.type === "dir" ? await fs.rmdir(path).then(() => true, () => false) : await fs.unlink(path).then(() => true, () => false);
    if (!done) return leave(`${entry.path} couldn't be removed`);
  }
  const marker = await fs.lstat(join(moved, BACKUP_MARKER)).catch(() => null);
  if (marker?.isFile()) await fs.unlink(join(moved, BACKUP_MARKER)).catch(() => undefined);
  if (!(await fs.rmdir(moved).then(() => true, () => false))) return leave("it wasn't empty at the end");
  await fs.rmdir(trash).catch(() => undefined);
  return true;
}

/**
 * Keeps the newest `keep` backup folders beside `dir` (the "Backups kept"
 * setting). Only folders whose marker this instance signed count; each older
 * one goes through `pruneFolder` (moved aside, every entry and ancestor
 * checked top-down, removed bottom-up, never recursive), which leaves it
 * whole on any doubt. A folder without a valid marker is never touched.
 * Never throws.
 */
async function pruneLocal(dir: string, keep: number): Promise<void> {
  try {
    const instance = await currentInstance();
    if (!instance) return;
    const root = join(dir, LOCAL_BACKUP_DIR);
    const sealed: Array<{ folder: string; created: string; self: { dev: number; ino: number }; entries: MarkerEntry[] }> = [];
    for (const name of await fs.readdir(root)) {
      if (name.startsWith(".")) continue;
      const folder = join(root, name);
      const marker = await verifiedMarker(folder, instance);
      if (marker) sealed.push({ folder, ...marker });
    }
    sealed.sort((a, b) => b.created.localeCompare(a.created));
    for (const old of sealed.slice(Math.max(1, keep))) await pruneFolder(root, old.folder, old.self, old.entries);
  } catch {
    // Nothing to prune.
  }
}

/** For tests: run at each step of a change, to play an editor writing at the worst moment. */
export const swapHooks: { beforeSetAside?: (path: string) => unknown; afterSetAside?: (path: string) => unknown; beforeInstall?: (path: string) => unknown } = {};

/**
 * Puts `from` at `to` only if NOTHING is at `to` (no-replace): a hard link,
 * which fails with EEXIST if anything is there, then `from`'s name goes (the
 * file itself now lives at `to`). Where hard links aren't supported, an
 * exclusive copy, which also fails if anything is there. A symlink is
 * re-made as a link to the same place (also exclusive). A folder is renamed
 * only into a place that doesn't exist (rename can't replace a folder that
 * holds anything). False when `to` was taken; `from` then stays where it is.
 */
export async function placeNoReplace(from: string, to: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(from);
    if (stat.isDirectory()) {
      if (await present(to)) return false;
      await fs.rename(from, to);
      forgetFile(to);
      return true;
    }
    if (stat.isSymbolicLink()) await fs.symlink(await fs.readlink(from), to);
    else {
      try {
        await fs.link(from, to);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EXDEV" && code !== "EMLINK") throw error;
        await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
      }
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    // A folder's rename can't replace anything that holds data: onto a non-empty folder it fails (ENOTEMPTY), onto a file too (ENOTDIR/EISDIR).
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR" || code === "EISDIR") return false;
    throw error;
  }
  await fs.unlink(from);
  forgetFile(to);
  return true;
}

/** True when anything (even a broken link) is at `path`. */
async function present(path: string): Promise<boolean> {
  return fs.lstat(path).then(() => true, () => false);
}

/** What a change expects to find: these bytes (by hash), this link (by where it points), or nothing at all. */
export type Expect = { hash: string } | { link: string } | null;

/** Why a swap didn't finish: no backup folder, the file was gone, it had changed, a file took its name, or something failed. */
export type SwapWhy = "nobackup" | "gone" | "changed" | "collision" | "failed";
type Swap = { ok: true; backupPath?: string } | { ok: false; nothingChanged: boolean; error: string; kept: string[]; why: SwapWhy; detail?: string };

const friendly = (path: string) => tilde(path, userHome());

/**
 * The answer for a change that didn't finish, built from what is ACTUALLY on
 * disk afterwards: only versions that exist are named (the one set aside, as
 * `.bak`; this change, as `.paseo-new`), each to copy. None left aside means
 * nothing changed.
 */
async function unfinished(reason: string, candidates: ReadonlyArray<string | undefined>, why: SwapWhy = "failed", detail?: string): Promise<Swap & { ok: false }> {
  const kept: string[] = [];
  for (const path of candidates) if (path && (await present(path))) kept.push(path);
  const base = { ok: false as const, why, ...(detail ? { detail } : {}) };
  if (!kept.length) return { ...base, nothingChanged: true, kept, error: `${reason} Nothing was changed.` };
  const parts = kept.map((path) => (!path.includes(`/${LOCAL_BACKUP_DIR}/`) ? `what's now at ${friendly(path)}` : path.endsWith(".paseo-new") ? `this change in ${friendly(path)}` : `the version found in ${friendly(path)}`));
  return { ...base, nothingChanged: false, kept, error: `${reason} Kept: ${parts.join(", and ")}.` };
}

/**
 * The ONE way this plugin replaces or removes a file it doesn't own (0.6.0
 * data-safety review): set aside, verify, create-exclusive. No step checks a
 * name and then acts on it, so there is no window to lose an edit in.
 *   1. The entry at `path` (file or link) is RENAMED into a FRESH backup
 *      folder beside it (mkdtemp: nothing can be there), as `<name>.bak`.
 *      That captures whatever is there at that instant, late edits included.
 *      If the folder can't be made or the rename fails, nothing changed.
 *   2. What was set aside is checked against `expect`. If it isn't that (an
 *      editor wrote it, or a link now points elsewhere or became a file), it
 *      goes back NO-REPLACE and nothing changes; if its name was taken
 *      meanwhile, it stays in the backup folder and the answer says where.
 *   3. `next` (if any) is written to a temp file and installed NO-REPLACE.
 *      If a file appeared at the name meanwhile, theirs is kept, and this
 *      version goes into the backup folder as `<name>.paseo-new`. Any other
 *      failure puts the old file back, so it is never left missing.
 * Every unfinished answer is built from what is on disk afterwards.
 * Nothing is ever overwritten or unlinked: names move, files stay.
 */
export async function swapFile(path: string, expect: Expect, next: string | null, mode: number, verb: "saved" | "removed" = "saved"): Promise<Swap> {
  const name = basename(path);
  let folder: string | null = null;
  const backupFolder = async () => (folder ??= await localBackupFolder(dirname(path)));
  const state: { aside?: string; newAt?: string } = {};
  try {
    return await swapSteps(path, name, expect, next, mode, verb, backupFolder, state);
  } finally {
    // Signed as this plugin's (or removed, if nothing was kept there), whatever happened.
    if (folder) await sealBackupFolder(folder, [state.aside, state.newAt]);
  }
}

async function swapSteps(path: string, name: string, expect: Expect, next: string | null, mode: number, verb: "saved" | "removed", backupFolder: () => Promise<string>, state: { aside?: string; newAt?: string }): Promise<Swap> {
  if (expect !== null) {
    let folder: string;
    try {
      folder = await backupFolder();
    } catch (error) {
      return unfinished(`Couldn't make a backup folder beside ${name} (${fsError(error, join(dirname(path), LOCAL_BACKUP_DIR))}), so it wasn't ${verb}.`, [], "nobackup", fsError(error, join(dirname(path), LOCAL_BACKUP_DIR)));
    }
    const aside = join(folder, backupName(path));
    await swapHooks.beforeSetAside?.(path);
    try {
      await fs.rename(path, aside);
    } catch (error) {
      const gone = (error as { code?: string }).code === "ENOENT";
      return unfinished(gone ? `${name} was removed or moved by something else, so it wasn't ${verb}.` : `${name} couldn't be set aside into its backup folder (${fsError(error, path)}), so it wasn't ${verb}.`, [], gone ? "gone" : "failed", fsError(error, path));
    }
    state.aside = aside;
    forgetFile(path);
  }
  try {
    if (state.aside && expect !== null) {
      await swapHooks.afterSetAside?.(path);
      if (!(await matches(state.aside, expect))) {
        const back = await placeNoReplace(state.aside, path).catch(() => false);
        return unfinished(back ? `${name} changed while it was being ${verb} (another agent or editor wrote it).` : `${name} changed while it was being ${verb}, and a new ${name} appeared at its place meanwhile; that new one is where it was.`, [state.aside], "changed");
      }
    }
    if (next === null) return { ok: true, ...(state.aside ? { backupPath: state.aside } : {}) };
    await swapHooks.beforeInstall?.(path);
    const tmp = await writeTemp(path, next, mode);
    if (await placeNoReplace(tmp, path).catch(async (error) => (await fs.rm(tmp, { force: true }).catch(() => undefined), Promise.reject(error)))) {
      return { ok: true, ...(state.aside ? { backupPath: state.aside } : {}) };
    }
    // Something appeared at the name meanwhile: theirs stays; this version is kept in the backup folder.
    const candidate = join(await backupFolder(), `${name}.paseo-new`);
    if (await placeNoReplace(tmp, candidate).catch(() => false)) state.newAt = candidate;
    else await fs.rm(tmp, { force: true }).catch(() => undefined);
    return unfinished(`Someone saved ${name} while this was saving. Theirs is kept.`, [state.newAt, state.aside], "collision");
  } catch (error) {
    // Anything unexpected after the set-aside: the original goes back (no-replace), so it is never left only in the backups.
    if (state.aside) await placeNoReplace(state.aside, path).catch(() => false);
    return unfinished(`${name} couldn't be ${verb} (${fsError(error, path)}).`, [state.newAt, state.aside], "failed", fsError(error, path));
  }
}

/** Is what was set aside what the caller expected? Bytes by hash; a link by where it points (and still a link). */
async function matches(aside: string, expect: Exclude<Expect, null>): Promise<boolean> {
  try {
    const stat = await fs.lstat(aside);
    if ("link" in expect) return stat.isSymbolicLink() && (await fs.readlink(aside)) === expect.link;
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    return sha256(await fs.readFile(aside)) === expect.hash;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ entries this plugin makes (0.6.0)

/** Something one operation made, by identity (path, device, inode), so it can be taken back only if it is still that. */
export type Owned = { path: string; dev: number; ino: number; kind: "file" | "dir" | "link" };

async function owned(path: string): Promise<Owned> {
  const stat = await fs.lstat(path);
  return { path, dev: stat.dev, ino: stat.ino, kind: stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : "file" };
}

/**
 * Creates a folder, a file or a link where NOTHING is (exclusive): mkdir (no
 * recursion), a temp file put in place with a no-replace link, or a symlink.
 * Records it in `made`. False when something is already there (nothing then
 * changes); throws on other errors.
 */
export async function createExclusive(path: string, what: { dir: true; mode: number } | { bytes: Buffer | string; mode: number } | { linkTo: string; type?: "dir" | "file" }, made: Owned[]): Promise<boolean> {
  try {
    if ("dir" in what) await fs.mkdir(path, { mode: what.mode });
    else if ("linkTo" in what) await fs.symlink(what.linkTo, path, what.type ?? "file");
    else {
      const tmp = await writeTemp(path, what.bytes, what.mode);
      if (!(await placeNoReplace(tmp, path).catch(async (error) => (await fs.rm(tmp, { force: true }).catch(() => undefined), Promise.reject(error))))) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        return false;
      }
    }
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return false;
    throw error;
  }
  made.push(await owned(path));
  forgetFile(path);
  return true;
}

/**
 * Takes back ONLY what one operation made (`made`), newest first, never
 * recursively. Each entry is moved by one rename into a fresh temp folder
 * beside it, and only if what was moved is still that entry (same device and
 * inode; a folder also empty) is it removed. Anything else (an entry someone
 * replaced, or a folder someone put files in) goes back no-replace, or stays
 * where it was moved, and is listed in what this returns. Never throws.
 */
export async function removeOwned(made: readonly Owned[]): Promise<string[]> {
  const left: string[] = [];
  for (const entry of [...made].reverse()) {
    let box: string | undefined;
    try {
      box = await fs.mkdtemp(join(dirname(entry.path), TEMP_PREFIX));
      const moved = join(box, basename(entry.path));
      try {
        await fs.rename(entry.path, moved);
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") left.push(entry.path);
        continue;
      }
      const now = await fs.lstat(moved);
      const same = now.dev === entry.dev && now.ino === entry.ino;
      let removed = false;
      if (same && entry.kind === "dir") removed = await fs.rmdir(moved).then(() => true, () => false);
      else if (same) removed = await fs.unlink(moved).then(() => true, () => false);
      if (!removed) {
        // Not ours any more, or a folder holding something we didn't make: back where it was, never over anything.
        const back = await placeNoReplace(moved, entry.path).catch(() => false);
        left.push(back ? entry.path : moved);
      }
      forgetFile(entry.path);
    } catch {
      left.push(entry.path);
    } finally {
      if (box) await fs.rmdir(box).catch(() => undefined);
    }
  }
  return left;
}

/**
 * Write a file the caller checked (`opts.current`): refusals first, then
 * the one way files change (`swapFile`): the old version set aside into a
 * fresh `.memories-backup` folder beside it, verified, then the new one put
 * in place without ever replacing anything. Read back afterwards. Never throws.
 */
export async function safeWrite(session: Session, path: string, text: string, opts: WriteOpts): Promise<WriteReport> {
  const report: WriteReport = { target: path, ok: false, action: "updated", readBack: "skipped", ...(opts.versionControlled !== undefined ? { versionControlled: opts.versionControlled } : {}) };
  try {
    const current = opts.current ?? (await readCurrent(path));
    const refused = await refusal(path, current, opts);
    if (refused) return { ...report, action: "refused", error: refused };
    const real = current.realPath;
    if (real !== path) report.target = real;
    report.action = current.exists ? "updated" : "created";
    const next = current.exists ? keepTextTraits(current.text, text) : text;
    if (current.exists && current.text === next) return { ...report, ok: true, action: "unchanged", readBack: "ok", stamp: current.stamp };
    const swap = await swapFile(real, current.exists ? { hash: current.stamp!.hash! } : null, next, current.exists ? current.mode ?? opts.newMode : opts.newMode);
    if (!swap.ok) return { ...report, action: swap.nothingChanged ? "refused" : "kept-both", error: swap.error, ...keptFields(swap.kept) };
    if (swap.backupPath) report.backupPath = swap.backupPath;
    forgetFile(path);
    await syncFolder(dirname(real));
    await pruneLocal(dirname(real), session.keep);
    const back = await readBack(real, next, opts.check);
    return { ...report, ok: back.readBack === "ok", readBack: back.readBack, ...(back.stamp ? { stamp: back.stamp } : {}), ...(back.readBack === "ok" ? {} : { error: "The file read back differently from what was written." }) };
  } catch (error) {
    return { ...report, ok: false, error: fsError(error, path) };
  }
}

/** A report's kept versions: every one that exists, and the first as `keptAt` (for older readers). */
function keptFields(kept: readonly string[]): Pick<WriteReport, "keptAt" | "kept"> {
  return kept.length ? { keptAt: kept[0]!, kept: [...kept] } : {};
}

/**
 * Remove a file the caller checked (`current`), through the same one way:
 * ONE rename sets it aside into a fresh `.memories-backup` folder beside it
 * (that is both the removal and the backup), then it's verified; if it isn't
 * what was checked, it goes back no-replace (or, if its name was taken
 * meanwhile, stays there, said exactly). A symlink is removed as a link (its
 * target stays) and must still point where it did. Never throws.
 */
export async function safeDelete(session: Session, path: string, current?: Current): Promise<WriteReport> {
  const report: WriteReport = { target: path, ok: false, action: "deleted", readBack: "skipped" };
  try {
    const seen = current ?? (await readCurrent(path));
    const byName = await writableReason(path);
    if (byName) return { ...report, action: "refused", error: byName };
    if (!seen.exists) return { ...report, action: "refused", error: CHANGED_WHILE_REMOVING };
    const expect: Expect = seen.symlink ? { link: seen.linkTarget ?? "" } : { hash: seen.stamp!.hash! };
    const swap = await swapFile(path, expect, null, 0o600, "removed");
    if (!swap.ok) return { ...report, action: "refused", error: swap.error, ...keptFields(swap.kept) };
    await syncFolder(dirname(path));
    await pruneLocal(dirname(path), session.keep);
    return { ...report, ok: true, readBack: "ok", ...(swap.backupPath ? { backupPath: swap.backupPath } : {}) };
  } catch (error) {
    return { ...report, error: fsError(error, path) };
  }
}

/** An fs error as a sentence that names the file, never its contents. */
export function fsError(error: unknown, path: string): string {
  const code = (error as { code?: string } | null)?.code;
  const name = basename(path);
  if (code === "EACCES" || code === "EPERM") return `No permission to write ${name}.`;
  if (code === "ENOENT") return `The folder for ${name} does not exist.`;
  if (code === "EEXIST") return `${name} already exists.`;
  if (code === "ENOSPC") return "The disk is full.";
  if (code === "EROFS") return `${name} is on a read-only disk.`;
  if (code === "EBUSY") return `${name} changed while it was being moved, so it was left where it is.`;
  if (code === "EIO") return `The disk reported an error writing ${name}.`;
  return `Could not write ${name}${code ? ` (${code})` : ""}.`;
}

/** Two paths naming one file (same device and inode): a case-only rename on macOS, or a hard link. */
export async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [one, two] = await Promise.all([fs.stat(a), fs.stat(b)]);
    return one.dev === two.dev && one.ino === two.ino;
  } catch {
    return false;
  }
}

/**
 * Rename a file to another spelling of itself (`flat.md` → `Flat.md`). A copy
 * then delete would copy the file onto itself and delete the only copy, so
 * this is two renames through a temp name, which works on disks that ignore
 * case and on disks that do not. Backed up first; refused if the file changed.
 */
export async function renameInPlace(session: Session, from: string, to: string, current: Current): Promise<WriteReport> {
  const report: WriteReport = { target: to, ok: false, action: "renamed", readBack: "skipped" };
  try {
    const refused = (await writableReason(from)) ?? (await writableReason(to));
    if (refused) return { ...report, action: "refused", error: refused };
    if (!current.exists || !current.utf8) return { ...report, action: "refused", error: CHANGED_WHILE_SAVING };
    // 1. The old name, set aside into a fresh backup folder beside it and verified (the one way files change).
    const removed = await swapFile(from, { hash: current.stamp!.hash! }, null, current.mode ?? 0o600, "removed");
    if (!removed.ok) return { ...report, action: "refused", error: removed.error, ...keptFields(removed.kept) };
    report.backupPath = removed.backupPath!;
    // 2. The new name, created no-replace with the same bytes. If something took that name meanwhile, the old name comes back (no-replace too).
    const placed = await swapFile(to, null, current.text, current.mode ?? 0o600);
    if (!placed.ok) {
      // The old name comes back (no-replace); the answer is then built from what is ACTUALLY on disk (0.6.0).
      // Presence isn't proof: only the original's own bytes at its name count as "where it was".
      await placeNoReplace(removed.backupPath!, from).catch(() => false);
      const atName = await fs.lstat(from).then((stat) => (stat.isFile() ? fs.readFile(from).then(sha256) : null), () => null);
      const original = atName !== null && atName === current.stamp!.hash;
      const backupStill = await present(removed.backupPath!);
      const why = placed.why === "collision" ? `${basename(to)} appeared in that folder meanwhile` : `${basename(to)} couldn't be made${placed.detail ? ` (${placed.detail})` : ""}`;
      const where = original
        ? ` ${basename(from)} is where it was.`
        : backupStill
          ? ` Your original is kept at ${friendly(removed.backupPath!)}${(await present(from)) ? `; ${basename(from)} now holds a different version` : ""}.`
          : ` ${basename(from)} couldn't be put back.`;
      // Every version that exists, each to copy: the original (wherever it is), what's at its name if that's something else, and this change.
      const candidates = [backupStill ? removed.backupPath : undefined, !original && (await present(from)) ? from : undefined, ...placed.kept];
      const out = await unfinished(`${why}, so nothing was renamed.${where}`, candidates, placed.why);
      const { backupPath: _stale, ...rest } = report;
      return { ...rest, target: from, action: "refused", error: out.error, ...keptFields(out.kept), ...(backupStill ? { backupPath: removed.backupPath! } : {}) };
    }
    forgetFile(from);
    forgetFile(to);
    await syncFolder(dirname(to));
    await pruneLocal(dirname(to), session.keep);
    const back = await readBack(to, current.text);
    const names = await fs.readdir(dirname(to));
    const spelled = names.includes(basename(to));
    return { ...report, ok: back.readBack === "ok" && spelled, readBack: back.readBack, ...(back.stamp ? { stamp: back.stamp } : {}), ...(spelled ? {} : { error: "The file is there but its name did not change." }) };
  } catch (error) {
    return { ...report, error: fsError(error, to) };
  }
}

// ------------------------------------------------------------------ skill folders (0.4.0)

export type SkillFile = { path: string; bytes: Buffer; executable: boolean };

const SAFE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function safeRel(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * A new skill folder `<parent>/<name>`, made so no agent ever reads half of
 * it: the folder is claimed with one mkdir (which fails if anything has that
 * name: never an overwrite), every other file is written, and SKILL.md
 * arrives last by rename. Until then agents see a folder without
 * instructions and skip it. On failure, only what this call made is taken
 * away again. Never throws.
 */
/** For tests: run before each file of a new skill is put in place. */
export const installHooks: { beforePlace?: (path: string) => unknown } = {};

export async function installSkillFolder(parent: string, name: string, files: SkillFile[], made: Owned[] = []): Promise<WriteReport> {
  const target = join(parent, name);
  const report: WriteReport = { target, ok: false, action: "created", readBack: "skipped" };
  const mine: Owned[] = [];
  /** Takes back only what this install made; anything someone else put there stays, and is said. */
  const takeBack = async (why: string, readBack: string): Promise<WriteReport> => {
    const left = await removeOwned(mine);
    const others = left.length ? ` Something else was put in ${name} meanwhile, so it was left as it is (${left.map(friendly).join(", ")}).` : "";
    return { ...report, ok: false, readBack, error: `${why}${others}`, ...keptFields(left) };
  };
  try {
    const refused = (await skillParentReason(parent, "install")) ?? (SAFE_NAME.test(name) && name.length <= 64 ? null : `${name} is not a name this plugin will create.`);
    if (refused) return { ...report, action: "refused", error: refused };
    if (!files.some((file) => file.path === "SKILL.md")) return { ...report, action: "refused", error: "A skill needs an instructions file (SKILL.md)." };
    const bad = files.find((file) => !safeRel(file.path));
    if (bad) return { ...report, action: "refused", error: "A file in that skill has a name that would land outside its folder." };
    await fs.mkdir(parent, { recursive: true, mode: 0o755 });
    // Claimed with one exclusive mkdir: never into anything that's there.
    if (!(await createExclusive(target, { dir: true, mode: 0o755 }, mine))) return { ...report, action: "refused", error: `${name} is already there.` };
    const ordered = [...files.filter((file) => file.path !== "SKILL.md"), ...files.filter((file) => file.path === "SKILL.md")];
    for (const file of ordered) {
      const path = join(target, file.path);
      if (!resolve(path).startsWith(`${resolve(target)}/`)) throw Object.assign(new Error("outside"), { code: "EPERM" });
      // Each folder inside, one level at a time and exclusive; one that's already there isn't ours, so it is never taken back.
      const parts = file.path.split("/").slice(0, -1);
      for (let depth = 1; depth <= parts.length; depth += 1) await createExclusive(join(target, ...parts.slice(0, depth)), { dir: true, mode: 0o755 }, mine);
      await installHooks.beforePlace?.(path);
      if (!(await createExclusive(path, { bytes: file.bytes, mode: file.executable ? 0o755 : 0o644 }, mine))) {
        return await takeBack(`${file.path} appeared in the new folder before this could write it, so nothing was added.`, "skipped");
      }
    }
    await syncFolder(target);
    await syncFolder(parent);
    // Read back: every file there, byte for byte.
    for (const file of files) {
      const back = await fs.readFile(join(target, file.path));
      if (!back.equals(file.bytes)) return await takeBack("A file read back differently from what was written, so nothing was added.", "mismatch");
    }
    made.push(...mine);
    return { ...report, ok: true, readBack: "ok" };
  } catch (error) {
    return mine.length ? await takeBack(`${fsError(error, target)} Nothing was added.`, "skipped") : { ...report, ok: false, error: fsError(error, target) };
  }
}

/**
 * A link `<parent>/<name>` → `target`, relative like `npx skills` makes them
 * (from the real parent, so a linked parent folder still resolves). Never
 * replaces anything: an existing entry of that name is refused. Never throws.
 */
export async function createSkillLink(parent: string, name: string, target: string, made: Owned[] = []): Promise<WriteReport> {
  const link = join(parent, name);
  const report: WriteReport = { target: link, ok: false, action: "created", readBack: "skipped" };
  try {
    const refused = await skillParentReason(parent, "link");
    if (refused) return { ...report, action: "refused", error: refused };
    await fs.mkdir(parent, { recursive: true, mode: 0o755 });
    const realParent = await fs.realpath(parent);
    const realTarget = await fs.realpath(target);
    if (!(await createExclusive(link, { linkTo: relative(realParent, realTarget) || ".", type: "dir" }, made))) return { ...report, action: "refused", error: `${name} is already there.` };
    const back = await fs.realpath(link).catch(() => "");
    return { ...report, ok: back === realTarget, readBack: back === realTarget ? "ok" : "mismatch", ...(back === realTarget ? {} : { error: "The link does not lead to the skill." }) };
  } catch (error) {
    return { ...report, ok: false, error: fsError(error, link) };
  }
}

/**
 * Take a skill folder, a link, an empty folder or a stray file out of a
 * skills folder (0.6.0: the one way files change): ONE rename sets it aside
 * into a FRESH backup folder beside it (mkdtemp, so the target can't exist),
 * as `<name>.bak`, on the same disk: nothing is copied, nothing deleted, and
 * nothing inside a set-aside folder is renamed. A link must still point where
 * it did once set aside, else it goes back (or stays, said exactly). Only
 * direct children of the user's own skills folders; never Paseo's,
 * claude.ai's or Codex's own (unless `paseoOrphan`: Paseo no longer ships
 * it). Never throws.
 */
/** Why `moveToBackup` would refuse `path`, without touching anything; null when it would go ahead. */
export async function moveRefusal(path: string, { paseoOrphan = false } = {}): Promise<string | null> {
  return (await skillParentReason(dirname(path), "remove")) ?? (paseoOrphan ? null : await skillFolderReason(path));
}

export async function moveToBackup(session: Session, path: string, { paseoOrphan = false } = {}): Promise<WriteReport> {
  const report: WriteReport = { target: path, ok: false, action: "deleted", readBack: "skipped" };
  try {
    const refused = await moveRefusal(path, { paseoOrphan });
    if (refused) return { ...report, action: "refused", error: refused };
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink()) {
      // A link: set aside, and only if it still points where it did is it gone; anything else goes back, or stays and is said.
      const swap = await swapFile(path, { link: await fs.readlink(path) }, null, 0o600, "removed");
      if (!swap.ok) return { ...report, action: "refused", error: swap.error, ...keptFields(swap.kept) };
      report.backupPath = swap.backupPath!;
    } else {
      // A folder or a file: ONE rename into a FRESH backup folder beside it (nothing can be there) captures all of it, as it is at that instant.
      let folder: string;
      try {
        folder = await localBackupFolder(dirname(path));
      } catch (error) {
        return { ...report, action: "refused", error: `Couldn't make a backup folder beside ${basename(path)} (${fsError(error, path)}), so nothing was removed.` };
      }
      const aside = join(folder, backupName(path));
      await swapHooks.beforeSetAside?.(path);
      try {
        await fs.rename(path, aside);
      } finally {
        await sealBackupFolder(folder, [aside]);
      }
      report.action = "moved";
      report.backupPath = aside;
    }
    forgetFile(path);
    await syncFolder(dirname(path));
    await pruneLocal(dirname(path), session.keep);
    return { ...report, ok: true, readBack: "ok" };
  } catch (error) {
    return { ...report, ok: false, error: fsError(error, path) };
  }
}
