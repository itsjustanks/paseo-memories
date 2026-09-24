import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import fs from "node:fs/promises";
import { join } from "node:path";
import type { FileStamp, WriteReport, WriteResult } from "../shared/contracts";
import {
  newMemoryFile,
  parseMemoryFile,
  readFields,
  serializeMemoryFile,
  setBody,
  setField,
  type FrontmatterShape,
} from "../shared/frontmatter";
import { parseIndex, removeIndexLine, renameIndexLine, upsertIndexLine } from "../shared/memory-index";
import { hasNewMask, MASK_FILL, maskSecrets } from "../shared/secrets";
import type { Paseo } from "./daemon";
import { forgetDiscovery } from "./discover";
import { listDir } from "./files";
import { logWrite } from "./log";
import { findSource } from "./read";
import { readMemoriesSettings } from "./settings";
import { fsError, newSession, readCurrent, removeFile, renameInPlace, safeDelete, safeWrite, sameFile, staleReason, type Session } from "./write";

/**
 * Claude auto memory: one file per memory in `<cfg>/projects/<slug>/memory/`,
 * each named by one `MEMORY.md` line. Create, edit and delete keep that line
 * in step and keep each file's frontmatter shape and unknown keys as they are.
 */

const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/;

function refuse(message: string): WriteResult {
  return { ok: false, message, reports: [], warnings: [] };
}

/** A file name from a memory's name: `webhook_retries.md`. */
export function fileNameFor(name: string): string {
  // A secret in the name must not end up in a file name (paths are never masked).
  const base = maskSecrets(name).text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return `${base || "memory"}.md`;
}

function validName(fileName: string): string | null {
  if (!NAME_OK.test(fileName) || fileName === "MEMORY.md") return "A memory file name must end in .md, use letters, digits, dots, dashes or underscores, and not be MEMORY.md.";
  return null;
}

/** MEMORY.md under any case: on macOS and Windows `memory.md` IS the index. */
export function isIndexName(fileName: string): boolean {
  return fileName.toLowerCase() === "memory.md";
}

/**
 * A new file name that is free in the folder, compared without case (the
 * default macOS disk ignores it): never the index, never an existing file.
 * `exact` (a name the user typed): that name or an error; otherwise the
 * first free `name_2.md`, `name_3.md`, ….
 */
export async function freeName(dir: string, wanted: string, exact = false): Promise<{ name: string } | { error: string }> {
  const bad = validName(wanted);
  if (bad) return { error: bad };
  const taken = new Set((await listDir(dir)).map((entry) => entry.name.toLowerCase()));
  taken.add("memory.md");
  if (exact) {
    if (isIndexName(wanted)) return { error: `${wanted} is the name of the index (MEMORY.md) on this disk. Pick another name.` };
    return taken.has(wanted.toLowerCase()) ? { error: `${wanted} already exists in this folder (names are compared without case). Pick another name.` } : { name: wanted };
  }
  let name = wanted;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = wanted.replace(/\.md$/, `_${n}.md`);
  return { name };
}

/** The folder, if it is a Claude auto-memory folder this plugin may write. */
async function memoryFolder(paseo: Paseo | null, sourceId: string, workspaceId?: string): Promise<{ dir: string } | { error: string }> {
  const found = await findSource(paseo, sourceId, workspaceId);
  if (!found || found.source.kind !== "claude-auto-memory") return { error: "That is not a Claude auto-memory folder." };
  if (found.source.access !== "editable") return { error: found.source.reason ?? "That folder is read-only." };
  return { dir: found.source.path };
}

/** The shape most files in the folder use, so a new one matches its neighbours. */
export async function usualShape(dir: string): Promise<FrontmatterShape> {
  const counts = new Map<FrontmatterShape, number>();
  for (const entry of await listDir(dir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "MEMORY.md") continue;
    try {
      const shape = readFields(parseMemoryFile(await fs.readFile(join(dir, entry.name), "utf8"))).shape;
      if (shape === "nested" || shape === "flat" || shape === "flat-session") counts.set(shape, (counts.get(shape) ?? 0) + 1);
    } catch {
      // unreadable file: no vote
    }
  }
  let best: FrontmatterShape = "nested";
  let most = 0;
  for (const [shape, count] of counts) if (count > most) [best, most] = [shape, count];
  return best === "flat-session" ? "flat" : best;
}

function memoryParses(expectName: string | undefined) {
  return (text: string) => {
    const fields = readFields(parseMemoryFile(text));
    return expectName === undefined || fields.name === expectName;
  };
}

function indexHas(file: string, present: boolean) {
  return (text: string) => parseIndex(text).some((line) => line.file === file) === present;
}

async function writeIndex(session: Session, dir: string, change: (text: string) => string, check: (text: string) => boolean): Promise<WriteReport | null> {
  const path = join(dir, "MEMORY.md");
  const current = await readCurrent(path);
  const next = change(current.text);
  if (current.exists && next === current.text) return null;
  // No index before, and nothing to put in one: do not create an empty MEMORY.md.
  if (!current.exists && next.trim() === "") return null;
  return safeWrite(session, path, next, { newMode: 0o600, current, check });
}

function result(reports: WriteReport[], done: string): WriteResult {
  const ok = reports.every((report) => report.ok);
  const failed = reports.filter((report) => !report.ok);
  return {
    ok,
    message: ok ? done : `Not everything was saved: ${failed.map((report) => report.error ?? "read-back did not match").join(" ")} Backups are listed in the report.`,
    reports,
    warnings: [],
  };
}

export async function claudeCreate(
  paseo: Paseo | null,
  input: { sourceId: string; workspaceId?: string; fileName?: string; name: string; description: string; type?: string; body: string; hook?: string },
  /** Imports may carry masked values on purpose (the secrets were never exported); the caller warns. */
  { allowMasked = false } = {},
): Promise<WriteResult> {
  const folder = await memoryFolder(paseo, input.sourceId, input.workspaceId);
  if ("error" in folder) return refuse(folder.error);
  if (!allowMasked && [input.body, input.name, input.description].some((text) => text.includes(MASK_FILL))) return refuse("The text has hidden (masked) values in it; reveal them first. Nothing was saved.");
  const picked = await freeName(folder.dir, input.fileName ?? fileNameFor(input.name), Boolean(input.fileName));
  if ("error" in picked) return refuse(picked.error);
  const fileName = picked.name;
  const settings = await readMemoriesSettings();
  await fs.mkdir(folder.dir, { recursive: true, mode: 0o700 });
  const session = newSession(settings.backupsToKeep);
  const text = newMemoryFile({ name: input.name, description: input.description, ...(input.type ? { type: input.type } : {}) }, input.body, await usualShape(folder.dir));
  const path = join(folder.dir, fileName);
  const reports = [await safeWrite(session, path, text, { newMode: 0o600, check: memoryParses(input.name) })];
  if (reports[0]!.ok) {
    let line: WriteReport | null;
    try {
      line = await writeIndex(session, folder.dir, (index) => upsertIndexLine(index, fileName, input.name, input.hook ?? input.description), indexHas(fileName, true));
    } catch (error) {
      line = { target: join(folder.dir, "MEMORY.md"), ok: false, action: "refused", readBack: "skipped", error: fsError(error, join(folder.dir, "MEMORY.md")) };
    }
    if (line) reports.push(line);
    if (line && !line.ok) {
      // Not in MEMORY.md, Claude never finds it: take the new file back out, as a failed rename does.
      try {
        await removeFile(path);
        reports.push({ target: path, ok: true, action: "rolled back", readBack: "skipped" });
      } catch (error) {
        reports.push({ target: path, ok: false, action: "rolled back", readBack: "skipped", error: `Could not remove the new file: ${fsError(error, path)} Delete it by hand.` });
      }
      forgetDiscovery();
      logWrite("claude-create", path, "rolled back");
      return { ok: false, message: `${fileName} was not kept: MEMORY.md could not be updated, so Claude would never find it. The new file was taken back out.`, reports, warnings: [] };
    }
  }
  forgetDiscovery();
  logWrite("claude-create", path, reports.every((report) => report.ok) ? "created" : "failed");
  return result(reports, `Saved ${fileName} and added its line to MEMORY.md.`);
}

export async function claudeUpdate(
  paseo: Paseo | null,
  input: { sourceId: string; workspaceId?: string; key: string; expected: FileStamp; name?: string; description?: string; type?: string; body?: string; hook?: string; rename?: string },
): Promise<WriteResult> {
  const folder = await memoryFolder(paseo, input.sourceId, input.workspaceId);
  if ("error" in folder) return refuse(folder.error);
  const bad = validName(input.key);
  if (bad) return refuse(bad);
  const path = join(folder.dir, input.key);
  const current = await readCurrent(path);
  const stale = staleReason(current, input.expected);
  if (stale) return refuse(stale);
  let file = parseMemoryFile(current.text);
  if (input.body !== undefined && hasNewMask(input.body, file.body)) return refuse("The text still has hidden (masked) values in it. Reveal them before editing, so they are not replaced by dots. Nothing was saved.");
  if ([input.name, input.description].some((text) => text?.includes(MASK_FILL))) return refuse("The text has hidden (masked) values in it; reveal them first. Nothing was saved.");
  if (input.name !== undefined) file = setField(file, "name", input.name);
  if (input.description !== undefined) file = setField(file, "description", input.description);
  if (input.type !== undefined) file = setField(file, "type", input.type);
  if (input.body !== undefined) file = setBody(file, input.body);
  const text = serializeMemoryFile(file);
  const fields = readFields(file);
  const settings = await readMemoriesSettings();
  const session = newSession(settings.backupsToKeep);
  const reports: WriteReport[] = [];
  const indexText = (await readCurrent(join(folder.dir, "MEMORY.md"))).text;
  const line = parseIndex(indexText).find((entry) => entry.file === input.key);
  const title = input.name ?? line?.title ?? fields.name ?? input.key.replace(/\.md$/, "");
  const hook = input.hook ?? line?.hook ?? fields.description ?? "";
  const touchIndex = Boolean(line) || input.name !== undefined || input.hook !== undefined;

  if (input.rename && input.rename !== input.key) {
    const badNew = validName(input.rename);
    if (badNew) return refuse(badNew);
    // Renaming only changes case? Allowed; otherwise the new name must be free without case.
    const sameIgnoringCase = input.rename.toLowerCase() === input.key.toLowerCase();
    if (!sameIgnoringCase || isIndexName(input.rename)) {
      const picked = await freeName(folder.dir, input.rename, true);
      if ("error" in picked) return refuse(picked.error);
    }
    const target = join(folder.dir, input.rename);
    // The same file under another spelling (a case-only rename on macOS, or a hard link): rename in place,
    // never write-then-delete, which would copy the file onto itself and delete the only copy.
    if (sameIgnoringCase || (await sameFile(path, target))) {
      if (text !== current.text) {
        const edited = await safeWrite(session, path, text, { newMode: current.mode ?? 0o600, current, check: memoryParses(fields.name) });
        reports.push(edited);
        if (!edited.ok) return result(reports, "");
      }
      const renamed = await renameInPlace(session, path, target, text !== current.text ? await readCurrent(path) : current);
      reports.push(renamed);
      if (renamed.ok) {
        const index = await writeIndex(session, folder.dir, (old) => renameIndexLine(old, input.key, input.rename!, title, hook), indexHas(input.rename, true));
        if (index) reports.push(index);
        if (index && !index.ok) {
          // The index still names the old spelling: put the file back under it, so the line is not left dangling.
          const back = await renameInPlace(session, target, path, await readCurrent(target));
          reports.push({ ...back, action: "rolled back", ...(back.ok ? {} : { error: `Could not rename it back: ${back.error ?? "read-back did not match"} Rename ${input.rename} to ${input.key} by hand.` }) });
          forgetDiscovery();
          logWrite("claude-update", path, "rename rolled back");
          const edited = text !== current.text ? " Your other changes to it were saved." : "";
          return { ok: false, message: `The rename to ${input.rename} was undone: MEMORY.md could not be updated, so the file keeps the name ${input.key}.${edited}`, reports, warnings: [] };
        }
      }
      forgetDiscovery();
      logWrite("claude-update", path, reports.every((report) => report.ok) ? `renamed to ${input.rename}` : "failed");
      return result(reports, `Renamed to ${input.rename} and updated its MEMORY.md line.`);
    }
    const created = await safeWrite(session, target, text, { newMode: current.mode ?? 0o600, check: memoryParses(fields.name) });
    reports.push(created);
    if (created.ok) {
      const index = await writeIndex(session, folder.dir, (old) => renameIndexLine(old, input.key, input.rename!, title, hook), indexHas(input.rename, true));
      if (index) reports.push(index);
      if (!index || index.ok) reports.push(await safeDelete(session, path, current));
      else {
        // The index did not take the new name: take the new file back out, so there is no unindexed duplicate.
        try {
          await removeFile(target);
          reports.push({ target, ok: true, action: "rolled back", readBack: "skipped" });
        } catch (error) {
          reports.push({ target, ok: false, action: "rolled back", readBack: "skipped", error: `Could not remove the new copy: ${fsError(error, target)} Delete it by hand.` });
        }
        forgetDiscovery();
        logWrite("claude-update", path, "rename rolled back");
        return { ok: false, message: `The rename to ${input.rename} was undone: MEMORY.md could not be updated, so ${input.key} stays as it was.`, reports, warnings: [] };
      }
    }
    forgetDiscovery();
    logWrite("claude-update", path, reports.every((report) => report.ok) ? `renamed to ${input.rename}` : "failed");
    return result(reports, `Renamed to ${input.rename} and updated its MEMORY.md line.`);
  }

  reports.push(await safeWrite(session, path, text, { newMode: 0o600, current, check: memoryParses(fields.name) }));
  if (reports[0]!.ok && touchIndex && (!line || line.title !== title || line.hook !== hook)) {
    const index = await writeIndex(session, folder.dir, (old) => upsertIndexLine(old, input.key, title, hook), indexHas(input.key, true));
    if (index) reports.push(index);
  }
  forgetDiscovery();
  logWrite("claude-update", path, reports.every((report) => report.ok) ? reports[0]!.action : "failed");
  return result(reports, reports[0]!.action === "unchanged" && reports.length === 1 ? "No change; nothing was written." : `Saved ${input.key}.`);
}

export async function claudeDelete(paseo: Paseo | null, input: { sourceId: string; workspaceId?: string; key: string; expected: FileStamp }): Promise<WriteResult> {
  const folder = await memoryFolder(paseo, input.sourceId, input.workspaceId);
  if ("error" in folder) return refuse(folder.error);
  const bad = validName(input.key);
  if (bad) return refuse(bad);
  const path = join(folder.dir, input.key);
  const current = await readCurrent(path);
  const stale = staleReason(current, input.expected);
  if (stale) return refuse(stale);
  const settings = await readMemoriesSettings();
  const session = newSession(settings.backupsToKeep);
  const reports = [await safeDelete(session, path, current)];
  if (reports[0]!.ok) {
    const index = await writeIndex(session, folder.dir, (old) => removeIndexLine(old, input.key), indexHas(input.key, false));
    if (index) reports.push(index);
  }
  forgetDiscovery();
  logWrite("claude-delete", path, reports.every((report) => report.ok) ? "deleted" : "failed");
  return result(reports, `Deleted ${input.key} and its MEMORY.md line. A backup was kept.`);
}

type Ctx = PluginHandlerContext;
// The RPC never passes allowMasked: only imports do.
export const handleClaudeCreate = (input: Parameters<typeof claudeCreate>[1], { paseo }: Ctx) => claudeCreate(paseo, input);
export const handleClaudeUpdate = (input: Parameters<typeof claudeUpdate>[1], { paseo }: Ctx) => claudeUpdate(paseo, input);
export const handleClaudeDelete = (input: Parameters<typeof claudeDelete>[1], { paseo }: Ctx) => claudeDelete(paseo, input);
