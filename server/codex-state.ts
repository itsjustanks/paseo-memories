import { basename, dirname, join } from "node:path";
import { codexLockState } from "./codex-lock";
import { pluginDataDir } from "./env";
import { pendingMessage } from "../shared/codex";
import { pendingDiff } from "./codex-pending";
import { readFresh, sha256 } from "./files";

/**
 * Codex generated-memory state for the source detail: the consolidation lock,
 * whether a consolidation is pending, and whether Codex kept an edit made
 * here (compared with the copy this plugin saved when it wrote).
 */

export const CODEX_EDITABLE = new Set(["MEMORY.md", "memory_summary.md"]);

/** A path Codex lets us edit: `<home>/memories/<MEMORY.md|memory_summary.md>`. */
export function isCodexEditable(path: string): boolean {
  return CODEX_EDITABLE.has(basename(path)) && basename(dirname(path)) === "memories";
}

/** Where this plugin keeps its record of an edit: under plugin-data, never in Codex's folder. */
export function editRecordPath(path: string): string {
  return join(pluginDataDir(), "codex-edits", `${path.replace(/^[A-Za-z]:/, (drive) => drive[0]!).replace(/^[/\\]+/, "")}.json`);
}

export type EditRecord = { editedAt: string; writtenHash: string; beforeHash: string; addedLines: number };

async function readRecord(path: string): Promise<{ record: EditRecord; written: string; before: string } | null> {
  const recordText = await readFresh(editRecordPath(path));
  if (!recordText) return null;
  try {
    const record = JSON.parse(recordText) as EditRecord;
    const written = (await readFresh(`${editRecordPath(path)}.written`)) ?? "";
    const before = (await readFresh(`${editRecordPath(path)}.before`)) ?? "";
    return { record, written, before };
  } catch {
    return null;
  }
}

/** After Codex's next run: did it keep the lines we added? */
export async function keptAfterRun(path: string): Promise<{ status: string; detail: string; editedAt?: string }> {
  const saved = await readRecord(path);
  if (!saved) return { status: "none", detail: "No edit from this plugin." };
  const now = await readFresh(path);
  const editedAt = saved.record.editedAt;
  if (now === null) return { status: "changed", detail: "Codex removed the file since your edit.", editedAt };
  if (sha256(now) === saved.record.writtenHash) return { status: "unchanged", detail: "Unchanged since your edit: Codex has not run yet.", editedAt };
  const before = new Set(saved.before.split("\n"));
  const added = saved.written.split("\n").filter((line) => line.trim() && !before.has(line));
  if (added.length === 0) return { status: "changed", detail: "Codex has rewritten the file since your edit (your edit only removed lines).", editedAt };
  const current = new Set(now.split("\n"));
  const kept = added.filter((line) => current.has(line)).length;
  if (kept === added.length) return { status: "kept", detail: `Codex ran and kept all ${added.length} line${added.length === 1 ? "" : "s"} you added.`, editedAt };
  return { status: "changed", detail: `Codex ran and kept ${kept} of the ${added.length} line${added.length === 1 ? "" : "s"} you added word for word; it may have reworded the rest.`, editedAt };
}

/** Lock, pending consolidation and "kept?" for a file under a Codex home. */
export async function codexState(path: string) {
  const inMemories = basename(dirname(path)) === "memories";
  const memories = inMemories ? dirname(path) : join(dirname(path), "memories");
  const home = dirname(memories);
  const lock = await codexLockState(home);
  const diff = await pendingDiff(memories);
  const info = diff ? { ...diff, ...(lock.lastJob?.error && lock.lastJob.finishedAt ? { failedOn: lock.lastJob.finishedAt } : {}) } : null;
  return {
    lock: lock.lock,
    lockReason: lock.reason,
    ...(info ? { pending: pendingMessage(info), pendingInfo: info } : {}),
    ...(lock.lastJob ? { lastJob: lock.lastJob } : {}),
    ...(isCodexEditable(path) ? { kept: await keptAfterRun(path) } : {}),
  };
}

