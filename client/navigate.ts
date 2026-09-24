/**
 * Panels get no `openSurface`; the client entry lends its opener here. A
 * panel or the Overview can also ask the surface to land on a tab, a source
 * or an import prefilled with entries to copy. (paseo-mcp `client/navigate.ts` pattern.)
 */

export type Destination = {
  tab?: "overview" | "user" | "projects" | "transfer" | "guide";
  sourceId?: string;
  entryKey?: string;
  /** Import & Export prefilled: entries to copy or move, or text to read. */
  from?: Array<{ sourceId: string; key?: string }>;
  text?: string;
  /** Pick this target and show the preview straight away. */
  target?: { kind: string; sourceId?: string; path?: string };
  preview?: boolean;
  exportView?: boolean;
  /** Open "Add a note", optionally in one project's workspace. */
  addNote?: { workspaceId?: string };
};

let opener: ((id: string) => void) | null = null;
let pending: Destination | null = null;
const listeners = new Set<(destination: Destination) => void>();

export function registerSurfaceOpener(open: ((id: string) => void) | null): void {
  opener = open;
}

export function canOpenMemories(): boolean {
  return opener !== null;
}

/** Open the Memories page, optionally at a destination. */
export function openMemories(destination: Destination | null = null): void {
  if (destination) {
    pending = destination;
    for (const listener of listeners) listener(destination);
  }
  opener?.("memories");
}

/** Consumed on read by a surface that just mounted. */
export function takeDestination(): Destination | null {
  const value = pending;
  pending = null;
  return value;
}

/** A mounted surface hears later requests too. */
export function onDestination(listener: (destination: Destination) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
