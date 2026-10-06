import type { PluginScreenParams } from "@getpaseo/plugin/client";
import type { LoadPlan } from "../shared/contracts";
import { sha256Hex } from "../shared/hash";
import { PLAIN } from "../shared/plain";
import { TABS, TRANSFER_PAGE, pageFor, type PageId } from "./tabs";

/**
 * Panels get no `openSurface`; the client entry lends its opener here. A
 * panel or the Overview can also ask the surface to land on a tab, a source
 * or an import prefilled with entries to copy. (paseo-mcp `client/navigate.ts` pattern.)
 *
 * On Paseo 0.11+ the opener also takes screen params, so where the page is
 * (tab, source, entry, Add a note) lives in its URL: reload and back/forward
 * land in the same place. Params are opaque: a source and an open note travel
 * as short hashes of their ids, resolved against what the page lists, so the
 * app's URL, history and titles never hold a path, a user, project or note
 * name, or memory text. The rest of a destination (entries to copy, text to
 * read) still travels in memory. Older apps open the page without params,
 * exactly as before.
 */

export type Destination = {
  /** A tab, or Import & Export. Old ids from links ("guide") are mapped by `fromScreenParams`. */
  tab?: PageId;
  sourceId?: string;
  entryKey?: string;
  /** From a link: a source and note not yet matched against the list (`sourceRef`, `entryRef`). */
  sourceRef?: string;
  entryRef?: string;
  /** Import & Export prefilled: entries to copy or move, or text to read. */
  from?: Array<{ sourceId: string; key?: string }>;
  text?: string;
  /** Pick this target and show the preview straight away. */
  target?: { kind: string; sourceId?: string; path?: string };
  preview?: boolean;
  exportView?: boolean;
  /** Open "Add a note", optionally in one project's workspace, optionally with its text started (in memory only, never in params). */
  addNote?: { workspaceId?: string; text?: string };
  /** Open the Overview's list of things worth a look ("Tidy memories" in the command center). */
  worth?: boolean;
};

export type ScreenOpener = (id: string, params?: PluginScreenParams) => void;

let opener: ScreenOpener | null = null;
let withParams = false;
let pending: Destination | null = null;
const listeners = new Set<(destination: Destination) => void>();

/** `params`: the opener takes screen params (Paseo 0.11+ `openScreen`). */
export function registerSurfaceOpener(open: ScreenOpener | null, { params = false }: { params?: boolean } = {}): void {
  opener = open;
  withParams = Boolean(open) && params;
}

export function canOpenMemories(): boolean {
  return opener !== null;
}

/** The page keeps its place in screen params (Paseo 0.11+). */
export function screenParamsSupported(): boolean {
  return withParams;
}

/** Open the Memories page, optionally at a destination. */
export function openMemories(destination: Destination | null = null): void {
  if (withParams) {
    // The app opens a screen for these params; it takes the rest of the destination when it mounts.
    pending = destination;
    opener?.("memories", destination ? toScreenParams(destination) : {});
    return;
  }
  if (destination) {
    pending = destination;
    for (const listener of listeners) listener(destination);
  }
  opener?.("memories");
}

/**
 * Record where the page is now, so reload and back/forward come back here;
 * `handOver` is the in-memory rest (entries to copy) for the screen the app
 * opens. No-op before Paseo 0.11.
 */
export function syncScreenParams(next: PluginScreenParams, current: PluginScreenParams | undefined, handOver: Destination | null = null): void {
  if (!withParams || !opener || paramsKey(next) === paramsKey(current ?? {})) return;
  pending = handOver;
  opener("memories", next);
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

type TabId = PageId;
const listsSources = (tab: TabId | undefined) => tab === "user" || tab === "projects";

/** Moving to a tab: User and Projects open on their list, so a note left open earlier closes (and `entry` leaves the params). */
export function moveToTab<Tab extends TabId>(state: { tab: TabId; sourceId: string | null; entryKey: string | null }, next: Tab): { tab: Tab; sourceId: string | null; entryKey: string | null } {
  return { tab: next, sourceId: state.sourceId, entryKey: listsSources(next) ? null : state.entryKey };
}

/** A source's id in links: the first 12 hex digits of SHA-256 of its id (a path, which never leaves the page). */
export const sourceRef = (sourceId: string): string => sha256Hex(sourceId).slice(0, 12);
/** An open note's id in links: the same, of `<source id>#<note key>`. */
export const entryRef = (sourceId: string, key: string): string => sha256Hex(`${sourceId}#${key}`).slice(0, 12);
const isRef = (value: string) => /^[0-9a-f]{12}$/.test(value);

/** The source a link means, among those listed now; null when it is gone. */
export function resolveSource(ref: string | undefined, sources: ReadonlyArray<{ id: string }>): string | null {
  return (ref && sources.find((source) => sourceRef(source.id) === ref)?.id) || null;
}

/** The note a link means, among the source's notes now; null when it is gone. */
export function resolveEntry(sourceId: string, ref: string | undefined, keys: readonly string[]): string | null {
  return (ref && keys.find((key) => entryRef(sourceId, key) === ref)) || null;
}

/** The tab, source and note as screen params (opaque ids). Text, entries to copy and targets stay out. */
export function toScreenParams(destination: Destination): PluginScreenParams {
  const params: PluginScreenParams = {};
  const tab = pageFor(destination.tab) ?? (destination.from || destination.text || destination.exportView ? "transfer" : undefined);
  if (tab && tab !== "overview") params.tab = tab;
  const source = destination.sourceId ? sourceRef(destination.sourceId) : destination.sourceRef;
  if (listsSources(tab) && source) {
    params.source = source;
    const entry = destination.sourceId && destination.entryKey ? entryRef(destination.sourceId, destination.entryKey) : destination.entryRef;
    if (entry) params.entry = entry;
  }
  if (destination.addNote) {
    params.add = "note";
    if (destination.addNote.workspaceId) params.workspace = destination.addNote.workspaceId;
  }
  return params;
}

/**
 * A destination from screen params. Anything unknown is dropped, so an old
 * or hand-edited link lands on the Overview instead of failing.
 */
export function fromScreenParams(params: PluginScreenParams | undefined): Destination {
  if (!params || typeof params !== "object") return {};
  const value = (key: string) => (typeof params[key] === "string" && params[key]!.length > 0 ? params[key]! : undefined);
  // Old ids still land: a link to the Guide opens Help (client/tabs.ts LEGACY_TABS).
  const tab = pageFor(value("tab"));
  const destination: Destination = {};
  if (tab) destination.tab = tab;
  const source = value("source");
  if (listsSources(tab) && source && isRef(source)) {
    destination.sourceRef = source;
    const entry = value("entry");
    if (entry && isRef(entry)) destination.entryRef = entry;
  }
  if (value("add") === "note") {
    const workspaceId = value("workspace");
    destination.addNote = workspaceId ? { workspaceId } : {};
  }
  return destination;
}

/**
 * Where the page opens: the screen's params (Paseo 0.11+; ids and keys only),
 * plus what a panel or the Overview handed over in memory (entries to copy,
 * text to read). Before 0.11 there are no params and only the hand-over counts.
 */
export function landing(params: PluginScreenParams | undefined): Destination {
  const fromLink = fromScreenParams(params);
  const handed = takeDestination();
  return handed ? normalised({ ...fromLink, ...handed }) : fromLink;
}

/**
 * A destination with its tab as this version names it: an old id ("guide",
 * from a caller or a plugin built against 0.4) becomes its new tab, and an
 * unknown one is dropped, so the page never lands on a tab it can't show.
 */
export function normalised(destination: Destination): Destination {
  if (destination.tab === undefined) return destination;
  const tab = pageFor(destination.tab);
  const { tab: _old, ...rest } = destination;
  return tab ? { ...rest, tab } : rest;
}

export const opensTransfer = (destination: Destination) => destination.tab === "transfer" || Boolean(destination.from || destination.text);

/**
 * Where the page lands for a source it doesn't list: the same tab, nothing
 * selected (as in 0.2). The tab stays, so the title stays right.
 */
export function unknownSourceLanding<Tab extends TabId>(state: { tab: Tab; sourceId: string | null; entryKey: string | null }): { tab: Tab; sourceId: null; entryKey: null } {
  return { tab: state.tab, sourceId: null, entryKey: null };
}

/** A source the page doesn't list (gone, or one only a workspace plan shows). */
export function isStaleSource(sourceId: string | null | undefined, sources: ReadonlyArray<{ id: string }> | undefined): boolean {
  return Boolean(sourceId && sources && !sources.some((source) => source.id === sourceId));
}

let technicalTitles = false;

/**
 * Plain or technical tab names in the header title ("Everywhere" or "User").
 * The title is worked out before the page reads its settings, so the page
 * reports the mode here (and client/web.ts keeps it across reloads on web).
 */
export function rememberTitleMode(technical: boolean): void {
  technicalTitles = technical;
}

/** The header title on Paseo 0.11+: "Memories · Projects", "Memories · Add a note". */
export function screenTitle(params: PluginScreenParams): string {
  const destination = fromScreenParams(params);
  if (destination.addNote) return `Memories · ${PLAIN.addNote.title}`;
  if (!destination.tab || destination.tab === "overview") return "Memories";
  const label = technicalTitles ? (TABS.find((tab) => tab.id === destination.tab) ?? TRANSFER_PAGE).label : PLAIN.tabLabels[destination.tab];
  return `Memories · ${label}`;
}


function paramsKey(params: PluginScreenParams): string {
  return JSON.stringify(Object.keys(params).sort().map((key) => [key, params[key]]));
}

/** Where a row opens in the Memories page: its source, on the tab it belongs to. */
export function itemDestination(item: Pick<LoadPlan["items"][number], "sourceId" | "scope" | "kind">): Destination | null {
  // Only a project's own files open on Projects; user, managed (organisation) and Paseo's prompt open on User.
  return item.sourceId ? { tab: item.scope === "project" && item.kind !== "paseo-prompt" ? "projects" : "user", sourceId: item.sourceId } : null;
}

/** "Open Memories" from a panel: straight to this project's first file that loads, else the Projects tab. */
export function panelDestination(plans: ReadonlyArray<Pick<LoadPlan, "items">>): Destination {
  for (const plan of plans) {
    const item = plan.items.find((candidate) => candidate.when !== "missing" && candidate.sourceId && candidate.scope === "project" && candidate.kind !== "paseo-prompt");
    if (item) return itemDestination(item)!;
  }
  return { tab: "projects" };
}
