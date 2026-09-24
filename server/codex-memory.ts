import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import fs from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { FileStamp, WriteResult } from "../shared/contracts";
import { CODEX_SUMMARY_FIRST_LINE } from "../shared/limits";
import { hasNewMask } from "../shared/secrets";
import { pendingMessage } from "../shared/codex";
import { codexLockState } from "./codex-lock";
import { pendingDiff } from "./codex-pending";
import { editRecordPath, isCodexEditable, type EditRecord } from "./codex-state";
import type { Paseo } from "./daemon";
import { forgetDiscovery } from "./discover";
import { logWrite } from "./log";
import { findSource } from "./read";
import { readMemoriesSettings } from "./settings";
import { newSession, readCurrent, safeWrite, sha256, staleReason } from "./write";

/**
 * Edits to Codex's generated memories, with every guardrail in the SPEC:
 * only `memories/MEMORY.md` and `memories/memory_summary.md`; never `.git`,
 * the sqlite, `raw_memories.md`, `rollout_summaries/` or `extensions/`;
 * refused while a consolidation holds the lock or when that is unclear;
 * `memory_summary.md` keeps `v1` as line 1. Codex treats a hand edit as
 * authoritative signal and merges it with a model, so wording may change.
 */

export const CODEX_EDIT_WARNINGS = [
  "Codex folds this in at its next run; wording may change.",
  "This edit makes Codex run a consolidation (a model call) at its next session.",
];

async function writePrivate(path: string, text: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, text, { mode: 0o600 });
}

/** Remember what we wrote, outside every agent folder, to tell later whether Codex kept it. */
async function recordEdit(path: string, before: string, written: string): Promise<void> {
  const beforeLines = new Set(before.split("\n"));
  const added = written.split("\n").filter((line) => line.trim() && !beforeLines.has(line)).length;
  const record: EditRecord = { editedAt: new Date().toISOString(), writtenHash: sha256(written), beforeHash: sha256(before), addedLines: added };
  await writePrivate(`${editRecordPath(path)}.written`, written);
  await writePrivate(`${editRecordPath(path)}.before`, before);
  await writePrivate(editRecordPath(path), JSON.stringify(record));
}

function refuse(message: string): WriteResult {
  return { ok: false, message, reports: [], warnings: [] };
}

export async function handleCodexWrite(
  input: { sourceId: string; text: string; expected: FileStamp; confirmPending?: boolean },
  { paseo }: PluginHandlerContext,
): Promise<WriteResult> {
  return codexWrite(paseo, input);
}

export async function codexWrite(paseo: Paseo | null, { sourceId, text, expected, confirmPending }: { sourceId: string; text: string; expected: FileStamp; confirmPending?: boolean }): Promise<WriteResult> {
  const found = await findSource(paseo, sourceId);
  if (!found || found.source.kind !== "codex-memory" || !isCodexEditable(found.source.path)) {
    logWrite("codex-write", sourceId, "refused: not an editable Codex memory file");
    return refuse("Only Codex's memories/MEMORY.md and memories/memory_summary.md can be edited here.");
  }
  const path = found.source.path;
  const settings = await readMemoriesSettings();
  if (!settings.codexEdits || found.source.access !== "editable") return refuse("Edits to Codex's generated memories are turned off in this plugin's settings.");
  if (basename(path) === "memory_summary.md" && text.split(/\r?\n/)[0] !== CODEX_SUMMARY_FIRST_LINE) {
    return refuse(`memory_summary.md must keep "${CODEX_SUMMARY_FIRST_LINE}" as its first line, or Codex rebuilds it from scratch. Nothing was saved.`);
  }
  const current = await readCurrent(path);
  const stale = staleReason(current, expected);
  if (stale) return refuse(stale);
  if (hasNewMask(text, current.text)) return refuse("The text still has hidden (masked) values in it. Reveal them before editing, so they are not replaced by dots. Nothing was saved.");
  const lock = await codexLockState(dirname(dirname(path)));
  if (lock.lock !== "free") {
    logWrite("codex-write", path, `refused: lock ${lock.lock}`);
    return refuse(`${lock.reason} Nothing was saved.`);
  }
  // A consolidation still pending: warn, and save only once the user confirms.
  const pending = await pendingDiff(dirname(path));
  if (pending && !confirmPending) {
    const failedOn = lock.lastJob?.error ? lock.lastJob.finishedAt : undefined;
    return { ok: false, needsConfirm: true, message: pendingMessage({ ...pending, ...(failedOn ? { failedOn } : {}) }), reports: [], warnings: [] };
  }
  const session = newSession(settings.backupsToKeep);
  const report = await safeWrite(session, path, text, { newMode: 0o600, current });
  forgetDiscovery();
  if (report.ok && report.action !== "unchanged") {
    try {
      await recordEdit(path, current.text, text);
    } catch {
      // The edit is saved; only the "kept?" check will be missing.
    }
  }
  logWrite("codex-write", path, report.ok ? report.action : "failed");
  return {
    ok: report.ok,
    message: report.ok ? (report.action === "unchanged" ? "No change; nothing was written." : "Saved. Codex folds this in at its next run; wording may change.") : report.error ?? "The save failed.",
    reports: [report],
    warnings: report.ok && report.action !== "unchanged" ? CODEX_EDIT_WARNINGS : [],
  };
}
