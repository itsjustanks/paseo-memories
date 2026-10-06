import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { WriteReport, WriteResult } from "../shared/contracts";
import { canFixAll, memoryGroupKey } from "../shared/finding-groups";
import { claudeIndexFix } from "./claude-memory";
import type { Paseo } from "./daemon";
import { readMemoriesSettings } from "./settings";
import { findingsFor } from "./tidy";
import { newSession } from "./write";

/**
 * "Fix all" for a group of things worth a look in Memories (0.5.1). Only
 * groups whose fixes are safe and undoable: Claude's list missing notes that
 * are there, or naming notes that are gone. The findings are checked again
 * first, so only what is still true is fixed; `findingIds` (what the page
 * showed) narrows it further. One write per folder, old lists in the backups.
 */
export async function tidyFixAll(paseo: Paseo | null, input: { group: string; findingIds?: string[] | undefined }): Promise<WriteResult> {
  if (!canFixAll("memories", input.group)) return { ok: false, message: "Those need a look one at a time. Nothing was changed.", reports: [], warnings: [] };
  const { findings } = await findingsFor(paseo, true);
  const wanted = input.findingIds ? new Set(input.findingIds) : null;
  const perFolder = new Map<string, string[]>();
  for (const finding of findings) {
    if (memoryGroupKey(finding) !== input.group || (wanted && !wanted.has(finding.id))) continue;
    const sourceId = finding.sourceIds?.[0];
    const file = finding.entryKeys?.[0];
    if (!sourceId || !file) continue;
    perFolder.set(sourceId, [...(perFolder.get(sourceId) ?? []), file]);
  }
  if (perFolder.size === 0) return { ok: true, message: "That's already sorted. Nothing needed changing.", reports: [], warnings: [] };
  const session = newSession((await readMemoriesSettings()).backupsToKeep);
  const reports: WriteReport[] = [];
  const errors: string[] = [];
  let changed = 0;
  let overLimit = 0;
  for (const [sourceId, files] of perFolder) {
    const done = await claudeIndexFix(paseo, { sourceId, add: input.group === "index-missing" ? files : [], remove: input.group === "index-gone" ? files : [] }, session);
    if (done.report) reports.push(done.report);
    if (done.error) errors.push(done.error);
    changed += done.added + done.removed;
    if (done.overLimit) overLimit += 1;
  }
  const lists = perFolder.size === 1 ? "Claude's list" : `Claude's lists in ${perFolder.size} projects`;
  const what = input.group === "index-missing" ? `Added ${plural(changed, "note")} to ${lists}.` : `Took ${plural(changed, "line")} for gone notes off ${lists}.`;
  const warnings = overLimit ? [`${overLimit === 1 ? "One list is" : `${overLimit} lists are`} now longer than Claude reads at the start (200 lines). Shortening it helps Claude see every note.`] : [];
  if (errors.length) return { ok: false, message: `${changed ? `${what} ` : ""}Not everything could be changed: ${[...new Set(errors)].join(" ")}`, reports, warnings };
  return { ok: true, message: `${what} The old ${perFolder.size === 1 ? "list is" : "lists are"} in the backups.`, reports, warnings };
}

function plural(count: number, word: string): string {
  return `${count.toLocaleString("en-AU")} ${count === 1 ? word : `${word}s`}`;
}

export const handleTidyFixAll = (input: { group: string; findingIds?: string[] | undefined }, { paseo }: PluginHandlerContext) => tidyFixAll(paseo, input);
