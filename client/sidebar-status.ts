import { useSyncExternalStore } from "react";

/**
 * The sidebar rows' status dot (0.5.0): whether Memories or Skills has
 * something worth a look, in place of anything in the composer. The pages
 * report what they already read (the header's cached findings, the skills
 * list), so the dot costs no extra call or scan; it shows once a page or
 * panel has looked this session, and clears when things are tidy.
 */

/** "attention": something is worth a look; "error": something needs attention now (a password in a note). */
export type SidebarTone = "attention" | "error";

const tones = new Map<string, SidebarTone>();
const listeners = new Set<() => void>();

/** Per page and per host: each host has its own sidebar rows. */
const keyOf = (screenId: string, hostId: string) => `${screenId}\u0000${hostId}`;

export function reportSidebarStatus(screenId: string, hostId: string, tone: SidebarTone | null): void {
  const key = keyOf(screenId, hostId);
  if ((tones.get(key) ?? null) === tone) return;
  if (tone) tones.set(key, tone);
  else tones.delete(key);
  for (const listener of listeners) listener();
}

export function sidebarStatus(screenId: string, hostId: string): SidebarTone | null {
  return tones.get(keyOf(screenId, hostId)) ?? null;
}

export function useSidebarStatus(screenId: string, hostId: string): SidebarTone | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => sidebarStatus(screenId, hostId),
    () => sidebarStatus(screenId, hostId),
  );
}
