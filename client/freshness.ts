import type { QueryClient } from "@tanstack/react-query";
import { PLAIN, plainFindings } from "../shared/plain";

/**
 * Keeping the page header honest. The header shows the findings the Overview
 * last read; after a save, a remove, an import or Refresh those may be out of
 * date even when the Overview isn't open. So every write fetches the findings
 * again, and until they arrive the header says "Checking…", never "tidy".
 */

export const KEY = "paseo-memories";

export const findingsKey = (hostId: string) => [KEY, hostId, "findings"] as const;
/** When this host's notes last changed (or Refresh was pressed). Outside the `[KEY, hostId]` tree, so invalidating that leaves it alone. */
export const writeKey = (hostId: string) => [`${KEY}:last-write`, hostId] as const;

/** After a write or Refresh: everything that shows files is out of date, and the header's findings are fetched again whichever tab is open. */
export async function refreshAfterWrite(client: QueryClient, hostId: string, fetchFindings: () => Promise<unknown>, now = Date.now()): Promise<void> {
  client.setQueryData(writeKey(hostId), now);
  // Started together: when the Overview is open its refetch is in flight and fetchQuery joins it.
  await Promise.all([
    client.invalidateQueries({ queryKey: [KEY, hostId] }),
    client.fetchQuery({ queryKey: findingsKey(hostId), queryFn: fetchFindings, staleTime: 0 }).catch(() => undefined),
  ]);
}

export type HeaderStatus = { status: "ok" | "attention" | "error" | "neutral" | "busy"; caption: string; /** Offer Try again: the last check failed. */ retry?: boolean };

type Finding = { kind: string; severity: string; sourceIds: string[] };
type Source = { id: string; kind: string; path?: string };

/**
 * The header's one line: which computer, and how its notes are doing.
 * Findings read before the last write don't count: "Checking…" while the
 * check runs, "Couldn't check just now" (with Try again) when it failed.
 */
export function headerStatus(input: {
  hostLabel: string;
  plain: boolean;
  inventory: { sources: Source[]; counts: { sources: number } } | undefined;
  inventoryError: boolean;
  findings: { findings: Finding[] } | undefined;
  findingsAt: number;
  lastWrite: number;
  /** When fetching the findings last failed (0: never). */
  findingsErrorAt?: number;
}): HeaderStatus {
  const S = PLAIN.status;
  const { inventory, hostLabel } = input;
  if (!inventory) return input.inventoryError ? { status: "error", caption: S.cantRead(hostLabel) } : { status: "busy", caption: S.checking(hostLabel) };
  if (inventory.counts.sources === 0) return { status: "neutral", caption: `${S.on(hostLabel)} · ${S.none}` };
  if (!input.findings) return { status: "neutral", caption: S.on(hostLabel) };
  if (input.lastWrite > 0 && input.findingsAt < input.lastWrite) {
    const failed = (input.findingsErrorAt ?? 0) >= input.lastWrite;
    return failed ? { status: "attention", caption: `${S.on(hostLabel)} · ${S.cantCheck}`, retry: true } : { status: "neutral", caption: S.checking(hostLabel) };
  }
  const shown = input.plain ? plainFindings(input.findings.findings, inventory.sources) : input.findings.findings;
  const status = shown.some((finding) => finding.severity === "error") ? "error" : shown.length ? "attention" : "ok";
  return { status, caption: `${S.on(hostLabel)} · ${shown.length ? S.worth(shown.length) : S.tidy}` };
}
