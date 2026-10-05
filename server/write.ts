import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { FileStamp, WriteReport } from "../shared/contracts";
import { keepTextTraits } from "../shared/text";
import { pluginDataDir } from "./env";
import { forgetFile, sha256, statSafe } from "./files";
import { skillFolderReason, skillParentReason, writableReason } from "./writable";

export { sha256 };

/**
 * Every write in the plugin goes through here (SPEC "Safety"):
 *
 * 1. Back up to `$PASEO_HOME/plugin-data/paseo-memories/backups/<stamp>/<mirrored path>`,
 *    never next to the file (a `.bak` in a memory folder becomes a memory).
 *    The backup is the raw bytes on disk just before the rename.
 * 2. Write a temp file beside the REAL file (a symlink is followed, never
 *    replaced), fsync, re-check the file did not change, rename; keep the
 *    mode (new files as the caller says).
 * 3. Read back and check; one WriteReport per target.
 * 4/6. Refused here, whatever the caller did: paths that are not memory or
 *    instruction files by name, hard-linked files, files that are not UTF-8,
 *    and a file that changed since the caller's read.
 * 5. Nothing here logs file text: paths and counts only.
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
  /** The file itself: the symlink's target when `path` is a link. */
  realPath: string;
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
  return { exists: true, text, bytes, stamp: stampFrom(bytes, stat), mode: stat.mode & 0o777, realPath, symlink, nlink: stat.nlink, utf8, ...(blocked ? { blocked } : {}) };
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

async function writeTemp(beside: string, text: string, mode: number): Promise<string> {
  const tmp = join(dirname(beside), `${TEMP_PREFIX}${randomBytes(6).toString("hex")}`);
  const handle = await fs.open(tmp, "wx", mode);
  try {
    await handle.writeFile(text, "utf8");
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

export async function removeFile(path: string): Promise<void> {
  await fs.unlink(path);
  forgetFile(path);
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

/**
 * A full write with backup and read-back, reported. Never throws.
 *
 * Ordering keeps the window for a lost concurrent write as small as the
 * filesystem allows: temp written and synced first, then the bytes on disk
 * are read again and compared with the caller's read, backed up as they are,
 * stat'ed once more, and only then renamed over. What is left: a write that
 * lands between that last stat and the rename (one syscall apart) is
 * overwritten and is not in the backup. Only a lock both sides honour could
 * close it, and agents take none.
 */
export async function safeWrite(session: Session, path: string, text: string, opts: WriteOpts): Promise<WriteReport> {
  const report: WriteReport = { target: path, ok: false, action: "updated", readBack: "skipped", ...(opts.versionControlled !== undefined ? { versionControlled: opts.versionControlled } : {}) };
  let tmp: string | null = null;
  try {
    const current = opts.current ?? (await readCurrent(path));
    const refused = await refusal(path, current, opts);
    if (refused) return { ...report, action: "refused", error: refused };
    const real = current.realPath;
    if (real !== path) report.target = real;
    report.action = current.exists ? "updated" : "created";
    const next = current.exists ? keepTextTraits(current.text, text) : text;
    if (current.exists && current.text === next) return { ...report, ok: true, action: "unchanged", readBack: "ok", stamp: current.stamp };

    tmp = await writeTemp(real, next, current.exists ? current.mode ?? opts.newMode : opts.newMode);
    // The last look: the bytes on disk now must be the ones the caller checked.
    const latest = await readCurrent(real);
    if (current.exists ? !latest.exists || latest.stamp!.hash !== current.stamp!.hash : latest.exists) {
      return { ...report, action: "refused", error: CHANGED_WHILE_SAVING };
    }
    if (latest.exists && latest.bytes) report.backupPath = await writeBackup(session, real, latest.bytes);
    const still = await statSafe(real);
    if (latest.exists ? !still || still.size !== latest.stamp!.size || still.mtimeMs !== latest.stamp!.mtimeMs : still) {
      return { ...report, action: "refused", error: CHANGED_WHILE_SAVING };
    }
    await fs.rename(tmp, real);
    tmp = null;
    forgetFile(path);
    forgetFile(real);
    await syncFolder(dirname(real));
    await pruneBackups(session, real);
    const back = await readBack(real, next, opts.check);
    return { ...report, ok: back.readBack === "ok", readBack: back.readBack, ...(back.stamp ? { stamp: back.stamp } : {}), ...(back.readBack === "ok" ? {} : { error: "The file read back differently from what was written." }) };
  } catch (error) {
    return { ...report, ok: false, error: fsError(error, path) };
  } finally {
    if (tmp) await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Backup, then delete; reported. Never throws. A symlink is removed as a link; its target stays. */
export async function safeDelete(session: Session, path: string, current?: Current): Promise<WriteReport> {
  const report: WriteReport = { target: path, ok: false, action: "deleted", readBack: "skipped" };
  try {
    const seen = current ?? (await readCurrent(path));
    const byName = await writableReason(path);
    if (byName) return { ...report, action: "refused", error: byName };
    const latest = await readCurrent(path);
    if (seen.exists && (!latest.exists || latest.stamp?.hash !== seen.stamp?.hash)) return { ...report, action: "refused", error: CHANGED_WHILE_SAVING };
    if (latest.exists && latest.bytes) report.backupPath = await writeBackup(session, latest.realPath, latest.bytes);
    await removeFile(path);
    await pruneBackups(session, latest.realPath);
    const back = await readBack(path, null);
    return { ...report, ok: back.readBack === "ok", readBack: back.readBack };
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
  if (code === "EIO") return `The copy of ${name} in the backups didn't match it, so it was left where it is.`;
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
    const latest = await readCurrent(from);
    if (!latest.exists || latest.stamp?.hash !== current.stamp?.hash) return { ...report, action: "refused", error: CHANGED_WHILE_SAVING };
    const other = await fs.lstat(to).then(() => true, () => false);
    if (other && !(await sameFile(from, to))) return { ...report, action: "refused", error: `${basename(to)} is already a different file in that folder. Nothing was renamed.` };
    report.backupPath = await writeBackup(session, from, latest.bytes!);
    const tmp = join(dirname(from), `${TEMP_PREFIX}${randomBytes(6).toString("hex")}`);
    await fs.rename(from, tmp);
    try {
      await fs.rename(tmp, to);
    } catch (error) {
      await fs.rename(tmp, from).catch(() => undefined);
      throw error;
    }
    forgetFile(from);
    forgetFile(to);
    await syncFolder(dirname(to));
    await pruneBackups(session, from);
    const back = await readBack(to, latest.text);
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
export async function installSkillFolder(parent: string, name: string, files: SkillFile[]): Promise<WriteReport> {
  const target = join(parent, name);
  const report: WriteReport = { target, ok: false, action: "created", readBack: "skipped" };
  let claimed = false;
  try {
    const refused = (await skillParentReason(parent, "install")) ?? (SAFE_NAME.test(name) && name.length <= 64 ? null : `${name} is not a name this plugin will create.`);
    if (refused) return { ...report, action: "refused", error: refused };
    if (!files.some((file) => file.path === "SKILL.md")) return { ...report, action: "refused", error: "A skill needs an instructions file (SKILL.md)." };
    const bad = files.find((file) => !safeRel(file.path));
    if (bad) return { ...report, action: "refused", error: "A file in that skill has a name that would land outside its folder." };
    await fs.mkdir(parent, { recursive: true, mode: 0o755 });
    await fs.mkdir(target, { mode: 0o755 });
    claimed = true;
    const ordered = [...files.filter((file) => file.path !== "SKILL.md"), ...files.filter((file) => file.path === "SKILL.md")];
    for (const file of ordered) {
      const path = join(target, file.path);
      if (!resolve(path).startsWith(`${resolve(target)}/`)) throw Object.assign(new Error("outside"), { code: "EPERM" });
      await fs.mkdir(dirname(path), { recursive: true, mode: 0o755 });
      const mode = file.executable ? 0o755 : 0o644;
      const tmp = join(dirname(path), `${TEMP_PREFIX}${randomBytes(6).toString("hex")}`);
      const handle = await fs.open(tmp, "wx", mode);
      try {
        await handle.writeFile(file.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.chmod(tmp, mode);
      await fs.rename(tmp, path);
    }
    await syncFolder(target);
    await syncFolder(parent);
    // Read back: every file there, byte for byte.
    for (const file of files) {
      const back = await fs.readFile(join(target, file.path));
      if (!back.equals(file.bytes)) {
        // Never leave a skill whose files aren't what was previewed (review-040 #3): take back what this call made.
        await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
        return { ...report, ok: false, readBack: "mismatch", error: "A file read back differently from what was written, so nothing was added." };
      }
    }
    return { ...report, ok: true, readBack: "ok" };
  } catch (error) {
    if (claimed) await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    return { ...report, ok: false, error: fsError(error, target) };
  }
}

/**
 * A link `<parent>/<name>` → `target`, relative like `npx skills` makes them
 * (from the real parent, so a linked parent folder still resolves). Never
 * replaces anything: an existing entry of that name is refused. Never throws.
 */
export async function createSkillLink(parent: string, name: string, target: string): Promise<WriteReport> {
  const link = join(parent, name);
  const report: WriteReport = { target: link, ok: false, action: "created", readBack: "skipped" };
  try {
    const refused = await skillParentReason(parent, "link");
    if (refused) return { ...report, action: "refused", error: refused };
    await fs.mkdir(parent, { recursive: true, mode: 0o755 });
    const realParent = await fs.realpath(parent);
    const realTarget = await fs.realpath(target);
    await fs.symlink(relative(realParent, realTarget) || ".", link, "dir");
    const back = await fs.realpath(link).catch(() => "");
    return { ...report, ok: back === realTarget, readBack: back === realTarget ? "ok" : "mismatch", ...(back === realTarget ? {} : { error: "The link does not lead to the skill." }) };
  } catch (error) {
    return { ...report, ok: false, error: fsError(error, link) };
  }
}

/** Every file and link under `path` (or `path` itself), by relative path, with a hash of its bytes or the link's target. */
async function treeDigest(path: string, prefix = ""): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink()) out.set(prefix || ".", `link:${await fs.readlink(path)}`);
  else if (stat.isDirectory()) {
    for (const entry of (await fs.readdir(path)).sort()) for (const [key, value] of await treeDigest(join(path, entry), prefix ? `${prefix}/${entry}` : entry)) out.set(key, value);
  } else out.set(prefix || ".", `file:${stat.size}:${sha256(await fs.readFile(path))}`);
  return out;
}

function sameTree(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * The move into the backups when the backups are on another disk: copy, then
 * check the copy file for file (same count, same bytes by hash), and only
 * then take the original away. A copy that doesn't match is taken back out
 * of the backups and the original stays. The original is first renamed out
 * of the agents' sight and its SKILL.md goes first, so no half a skill is
 * ever left where agents look.
 */
async function copyThenDelete(path: string, backupPath: string): Promise<void> {
  await fs.cp(path, backupPath, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  const [original, copy] = await Promise.all([treeDigest(path), treeDigest(backupPath)]);
  if (!sameTree(original, copy)) {
    await fs.rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
    throw Object.assign(new Error("copy differs"), { code: "EIO" });
  }
  const aside = join(dirname(path), `${TEMP_PREFIX}${randomBytes(6).toString("hex")}`);
  await fs.rename(path, aside);
  // Checked again once it is out of the agents' sight: an edit that landed between the copy and the set-aside (review-040 #10) puts it all back.
  if (!sameTree(await treeDigest(aside), copy)) {
    await fs.rename(aside, path).catch(() => undefined);
    await fs.rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
    throw Object.assign(new Error("changed meanwhile"), { code: "EBUSY" });
  }
  await fs.rm(join(aside, "SKILL.md"), { force: true }).catch(() => undefined);
  await fs.rm(aside, { recursive: true });
}

/**
 * Take a skill folder, a link, an empty folder or a stray file out of a
 * skills folder by moving it into this action's backup folder: nothing is
 * deleted outright. A link is removed as a link (what it pointed to is
 * written down in the backup). Across disks the move is a copy, checked
 * file for file (count and bytes), then the original goes. Only direct children of the user's
 * own skills folders; never Paseo's, claude.ai's or Codex's own (unless
 * `paseoOrphan`: Paseo no longer ships it). Never throws.
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
    const backupPath = join(backupsRoot(), session.stamp, mirrored(path));
    await fs.mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    if (stat.isSymbolicLink()) {
      const pointsTo = await fs.readlink(path);
      await fs.writeFile(`${backupPath}.link.json`, `${JSON.stringify({ link: path, pointsTo }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await fs.unlink(path);
      report.backupPath = `${backupPath}.link.json`;
    } else {
      if (await statSafe(backupPath)) return { ...report, action: "refused", error: "This action already backed up something at that place." };
      try {
        await fs.rename(path, backupPath);
        report.action = "moved";
      } catch (error) {
        if ((error as { code?: string }).code !== "EXDEV") throw error;
        await copyThenDelete(path, backupPath);
        report.action = "copied-and-deleted";
      }
      report.backupPath = backupPath;
    }
    forgetFile(path);
    await syncFolder(dirname(path));
    const gone = !(await fs.lstat(path).then(() => true, () => false));
    return { ...report, ok: gone, readBack: gone ? "ok" : "mismatch", ...(gone ? {} : { error: "It is still there." }) };
  } catch (error) {
    return { ...report, ok: false, error: fsError(error, path) };
  }
}
