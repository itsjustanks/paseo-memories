/**
 * Add a note's unsaved text, kept per host while the app runs. The sidebar
 * popover uses it: closing the popover (Close, or a tap outside) never loses
 * what was typed; it is back the next time "+" is pressed, until it is saved
 * or cleared. Only in memory, never written anywhere. Pure.
 */

export type Who = "all" | "claude" | "codex";
export type NoteDraft = { text: string; who: Who; where: "everywhere" | "project"; workspaceId: string };
export type DraftStore = { read(): NoteDraft | null; write(draft: NoteDraft | null): void };

const drafts = new Map<string, NoteDraft>();

export function noteDrafts(hostId: string): DraftStore {
  return {
    read: () => drafts.get(hostId) ?? null,
    write: (draft) => {
      // Nothing typed: nothing to keep.
      if (draft && draft.text.trim()) drafts.set(hostId, { ...draft });
      else drafts.delete(hostId);
    },
  };
}
