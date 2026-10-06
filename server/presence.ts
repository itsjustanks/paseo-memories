/**
 * Whether anyone is looking. Every RPC the app sends marks the moment, so "no
 * RPC for WATCH_WINDOW_MS" means no app is connected and background passes
 * (phase C's stale-symbol scan) rest until one is.
 */

export const WATCH_WINDOW_MS = 15 * 60_000;
/**
 * A page counts as open for a minute after its last request (pages ask
 * again every few seconds while something is being checked). Routine checks
 * for changes (0.5.1) run only then; catching up on a backlog nobody has
 * read yet keeps the wider WATCH_WINDOW_MS.
 */
export const PAGE_OPEN_MS = 60_000;

let lastSeen = 0;

export function markClientSeen(now = Date.now()): void {
  lastSeen = now;
}

export function clientSeenWithin(windowMs = WATCH_WINDOW_MS, now = Date.now()): boolean {
  return lastSeen > 0 && now - lastSeen < windowMs;
}

/** A request arrived in the last minute: a page is really open. */
export function pageOpen(now = Date.now()): boolean {
  return clientSeenWithin(PAGE_OPEN_MS, now);
}

/** For tests. */
export function resetPresence(): void {
  lastSeen = 0;
}
