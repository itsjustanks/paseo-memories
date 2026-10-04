import type { PluginScreenParams } from "@getpaseo/plugin/client";
import type { LoadPlan } from "../shared/contracts";
import { PLAIN } from "../shared/plain";
import { TABS } from "./tabs";

/**
 * Panels get no `openSurface`; the client entry lends its opener here. A
 * panel or the Overview can also ask the surface to land on a tab, a source
 * or an import prefilled with entries to copy. (paseo-mcp `client/navigate.ts` pattern.)
 *
 * On Paseo 0.11+ the opener also takes screen params, so where the page is
 * (tab, source, entry, Add a note) lives in its URL: reload and back/forward
 * land in the same place. Params carry ids and keys only, never memory text;
 * the rest of a destination (entries to copy, text to read) still travels in
 * memory. Older apps open the page without params, exactly as before.
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

const TAB_IDS = ["overview", "user", "projects", "transfer", "guide"] as const;
type TabId = (typeof TAB_IDS)[number];
const isTab = (value: unknown): value is TabId => typeof value === "string" && (TAB_IDS as readonly string[]).includes(value);
const listsSources = (tab: TabId | undefined) => tab === "user" || tab === "projects";

/** Moving to a tab: User and Projects open on their list, so a note left open earlier closes (and `entry` leaves the params). */
export function moveToTab<Tab extends TabId>(state: { tab: TabId; sourceId: string | null; entryKey: string | null }, next: Tab): { tab: Tab; sourceId: string | null; entryKey: string | null } {
  return { tab: next, sourceId: state.sourceId, entryKey: listsSources(next) ? null : state.entryKey };
}

/** The ids and keys of a destination, as screen params. Text, entries to copy and targets stay out. */
export function toScreenParams(destination: Destination): PluginScreenParams {
  const params: PluginScreenParams = {};
  const tab = destination.tab ?? (destination.from || destination.text || destination.exportView ? "transfer" : undefined);
  if (tab && tab !== "overview") params.tab = tab;
  if (listsSources(tab) && destination.sourceId) {
    params.source = destination.sourceId;
    if (destination.entryKey) params.entry = destination.entryKey;
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
  const raw = value("tab");
  const tab = isTab(raw) ? raw : undefined;
  const destination: Destination = {};
  if (tab) destination.tab = tab;
  const sourceId = value("source");
  if (listsSources(tab) && sourceId) {
    destination.sourceId = sourceId;
    const entryKey = value("entry");
    if (entryKey) destination.entryKey = entryKey;
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
  return handed ? { ...fromLink, ...handed } : fromLink;
}

export const opensTransfer = (destination: Destination) => destination.tab === "transfer" || Boolean(destination.from || destination.text);

/** A source named in a link that this host no longer has: the page falls back to the Overview. */
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
  const label = technicalTitles ? TABS.find((tab) => tab.id === destination.tab)!.label : PLAIN.tabLabels[destination.tab];
  return `Memories · ${label}`;
}

const staleLinks = new Set<string>();

/**
 * A link to a source this host no longer has. The first time, the page moves
 * to the Overview with new params, so the title follows (openScreen can't
 * replace the current entry). Seen again (Back to it), it falls back quietly,
 * so Back is never a loop.
 */
export function firstTimeStale(params: PluginScreenParams | undefined): boolean {
  const key = paramsKey(params ?? {});
  if (staleLinks.has(key)) return false;
  staleLinks.add(key);
  return true;
}

function paramsKey(params: PluginScreenParams): string {
  return JSON.stringify(Object.keys(params).sort().map((key) => [key, params[key]]));
}

/** Where a row opens in the Memories page: its source, on the tab it belongs to. */
export function itemDestination(item: Pick<LoadPlan["items"][number], "sourceId" | "scope" | "kind">): Destination | null {
  return item.sourceId ? { tab: item.scope === "user" || item.kind === "paseo-prompt" ? "user" : "projects", sourceId: item.sourceId } : null;
}

/** "Open Memories" from a panel: straight to this project's first file that loads, else the Projects tab. */
export function panelDestination(plans: ReadonlyArray<Pick<LoadPlan, "items">>): Destination {
  for (const plan of plans) {
    const item = plan.items.find((candidate) => candidate.when !== "missing" && candidate.sourceId && itemDestination(candidate)?.tab === "projects");
    if (item) return itemDestination(item)!;
  }
  return { tab: "projects" };
}
