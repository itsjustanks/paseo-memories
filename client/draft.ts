import type { FileStamp } from "../shared/contracts";

/**
 * An editor's draft against the text it was loaded from. A reload of the
 * same file never replaces what the user typed: an untouched draft follows
 * the file, a dirty one stays and is flagged "changed on disk". The stamp is
 * the one the draft was loaded with, so a save over a changed file is still
 * refused by the host (the stale-write guard stays the backstop). Pure.
 */

export type Draft<T> = {
  value: T;
  /** What the file said when this draft was loaded. */
  baseline: T;
  stamp?: FileStamp;
  /** The file changed underneath a dirty draft; the newer version waits here. */
  newer?: { value: T; stamp?: FileStamp };
  /** The newer version the user chose to keep editing past; not flagged again. */
  ignored?: string;
};

const same = <T>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

export function isDirty<T>(draft: Draft<T> | null): boolean {
  return Boolean(draft && !same(draft.value, draft.baseline));
}

/** Data arrived from the host (first load, refetch, another save). */
export function receive<T>(draft: Draft<T> | null, incoming: { value: T; stamp?: FileStamp }): Draft<T> {
  if (!draft) return { value: incoming.value, baseline: incoming.value, ...(incoming.stamp ? { stamp: incoming.stamp } : {}) };
  const unchanged = same(incoming.value, draft.baseline) && (incoming.stamp?.hash ?? "") === (draft.stamp?.hash ?? "");
  if (unchanged) return draft.newer ? { ...draft, newer: undefined } : draft;
  if (!isDirty(draft)) return { value: incoming.value, baseline: incoming.value, ...(incoming.stamp ? { stamp: incoming.stamp } : {}) };
  const key = incoming.stamp?.hash ?? JSON.stringify(incoming.value);
  if (draft.ignored === key) return draft;
  return { ...draft, newer: incoming };
}

/** "Reload": take the file as it is now, dropping the draft. */
export function reload<T>(draft: Draft<T>): Draft<T> {
  if (!draft.newer) return draft;
  return { value: draft.newer.value, baseline: draft.newer.value, ...(draft.newer.stamp ? { stamp: draft.newer.stamp } : {}) };
}

/** "Keep editing": hide the notice; the old stamp stays, so saving will ask to reload first. */
export function keepEditing<T>(draft: Draft<T>): Draft<T> {
  const ignored = draft.newer ? draft.newer.stamp?.hash ?? JSON.stringify(draft.newer.value) : draft.ignored;
  return { ...draft, newer: undefined, ...(ignored ? { ignored } : {}) };
}

export function edit<T>(draft: Draft<T>, value: T): Draft<T> {
  return { ...draft, value };
}
