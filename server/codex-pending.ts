import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { statSafe } from "./files";

/**
 * Codex's pending consolidation, from `memories/phase2_workspace_diff.md`
 * alone (never the sqlite). The diff can run to megabytes, so deleted inputs
 * are counted in the background by streaming it, cached by the file's stat;
 * a read gets the last count, labelled with the file's time, or "counting".
 */

type Count = { stamp: string; deletions: number };

const counts = new Map<string, Count>();
const running = new Map<string, Promise<void>>();

export function diffPath(memoriesDir: string): string {
  return join(memoriesDir, "phase2_workspace_diff.md");
}

async function count(path: string, stamp: string): Promise<void> {
  let deletions = 0;
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) if (line.startsWith("deleted file mode")) deletions += 1;
    counts.set(path, { stamp, deletions });
  } catch {
    // unreadable: no count, the message says "still counting"
  } finally {
    lines.close();
  }
}

/** Present or not, when, and the deleted-input count if it has been counted for this version of the file. */
export async function pendingDiff(memoriesDir: string): Promise<{ asOf: string; deletions?: number } | null> {
  const path = diffPath(memoriesDir);
  const stat = await statSafe(path);
  if (!stat?.isFile) return null;
  const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
  const hit = counts.get(path);
  if (hit?.stamp !== stamp && !running.has(path)) {
    const job = count(path, stamp).finally(() => running.delete(path));
    running.set(path, job);
  }
  const asOf = new Date(stat.mtimeMs).toISOString();
  return hit?.stamp === stamp ? { asOf, deletions: hit.deletions } : { asOf };
}

/** For tests: wait for background counts. */
export async function pendingSettled(): Promise<void> {
  await Promise.all([...running.values()]);
}

export function forgetPendingCounts(): void {
  counts.clear();
}
