import { useSyncExternalStore } from "react";
import type { QuickSummary } from "../shared/finding-groups";

/**
 * The sidebar rows' status dot: whether Memories or Skills has something
 * worth a look, in place of anything in the composer.
 *
 * Two sources, the live one winning:
 *  - the pages report what they already read (the header's findings, the
 *    skills list), so an open page costs no extra call;
 *  - from load (0.5.1), one cheap read of the server's last known answer
 *    (`paseo-memories.sidebar-status`, nothing worked out for it) seeds the
 *    dot, shared by both rows and asked again at most every few minutes.
 * The dot clears when things are tidy.
 */

/** "attention": something is worth a look; "error": something needs attention now (a password in a note). */
export type SidebarTone = "attention" | "error";

type Held = { tone: SidebarTone | null; summary: QuickSummary | null };

const live = new Map<string, Held>();
const seeded = new Map<string, Held>();
const listeners = new Set<() => void>();

/** Per page and per host: each host has its own sidebar rows. */
const keyOf = (screenId: string, hostId: string) => `${screenId}\u0000${hostId}`;

function notify(): void {
  for (const listener of listeners) listener();
}

const sameSummary = (a: QuickSummary | null, b: QuickSummary | null) => JSON.stringify(a) === JSON.stringify(b);

/** A page read the state itself: this wins over the seed from then on. */
export function reportSidebarStatus(screenId: string, hostId: string, tone: SidebarTone | null, summary: QuickSummary | null = null): void {
  const key = keyOf(screenId, hostId);
  const held = live.get(key);
  if (held && held.tone === tone && sameSummary(held.summary, summary)) return;
  live.set(key, { tone, summary: summary ?? held?.summary ?? null });
  notify();
}

/** The server's last known answer, for a row no page has reported on yet. */
export function seedSidebarStatus(screenId: string, hostId: string, summary: QuickSummary | null): void {
  const key = keyOf(screenId, hostId);
  const held = seeded.get(key);
  const tone = summary?.tone ?? null;
  if (held && held.tone === tone && sameSummary(held.summary, summary)) return;
  seeded.set(key, { tone, summary });
  if (!live.has(key)) notify();
}

function held(screenId: string, hostId: string): Held | undefined {
  const key = keyOf(screenId, hostId);
  return live.get(key) ?? seeded.get(key);
}

export function sidebarStatus(screenId: string, hostId: string): SidebarTone | null {
  return held(screenId, hostId)?.tone ?? null;
}

/** The counts behind the dot, for its quick popover: the live page's when it reported them, else the seed's. */
export function sidebarSummary(screenId: string, hostId: string): QuickSummary | null {
  const key = keyOf(screenId, hostId);
  return live.get(key)?.summary ?? seeded.get(key)?.summary ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSidebarStatus(screenId: string, hostId: string): SidebarTone | null {
  return useSyncExternalStore(
    subscribe,
    () => sidebarStatus(screenId, hostId),
    () => sidebarStatus(screenId, hostId),
  );
}

export function useSidebarSummary(screenId: string, hostId: string): QuickSummary | null {
  return useSyncExternalStore(
    subscribe,
    () => sidebarSummary(screenId, hostId),
    () => sidebarSummary(screenId, hostId),
  );
}

// ------------------------------------------------------------------ the seed

/** How often the rows may ask the server again while the app stays open. */
export const SEED_EVERY_MS = 5 * 60_000;

export type SeedAnswer = {
  memories: { plain: QuickSummary; technical: QuickSummary } | null;
  skills: { summary: QuickSummary } | null;
};

const asked = new Map<string, { at: number; promise: Promise<void> }>();

/**
 * Seeds both rows for a host from one call; both rows ask, one call goes out
 * (and none again within SEED_EVERY_MS). `technical`: the user's last mode,
 * since plain mode leaves some things out.
 */
export function seedFromServer(hostId: string, fetch: () => Promise<SeedAnswer>, technical: boolean, now = Date.now()): Promise<void> {
  const last = asked.get(hostId);
  if (last && now - last.at < SEED_EVERY_MS) return last.promise;
  const promise = fetch()
    .then((answer) => {
      if (answer.memories) seedSidebarStatus("memories", hostId, technical ? answer.memories.technical : answer.memories.plain);
      if (answer.skills) seedSidebarStatus("skills", hostId, answer.skills.summary);
    })
    .catch(() => undefined);
  asked.set(hostId, { at: now, promise });
  return promise;
}

/** For tests. */
export function resetSidebarStatus(): void {
  live.clear();
  seeded.clear();
  asked.clear();
}
