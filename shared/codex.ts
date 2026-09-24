/** Codex pending-consolidation wording, shared by the host and the app. Pure. */

export type PendingInfo = {
  /** When Codex's working diff was last written (ISO). */
  asOf: string;
  /** Deleted inputs counted in that diff; undefined while the count is still running. */
  deletions?: number;
  /** When the last consolidation failed (ISO), if it did. */
  failedOn?: string;
};

function day(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 10);
}

/** The warning a Codex memory save must be confirmed past. */
export function pendingMessage(info: PendingInfo): string {
  const failed = info.failedOn ? ` (it failed on ${day(info.failedOn)})` : "";
  const backed =
    info.deletions === undefined
      ? "memory backed by deleted inputs (still counting them)"
      : `memory backed by ${info.deletions.toLocaleString("en-US")} deleted input${info.deletions === 1 ? "" : "s"}`;
  return `Codex hasn't finished its last clean-up${failed}. When it next runs it may remove ${backed}, and it will fold in your edit at the same time. (As of ${day(info.asOf)}.)`;
}
