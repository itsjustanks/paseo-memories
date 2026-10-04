import React, { useEffect, useMemo, useRef, useState } from "react";
import { PLAIN, isCodexInternal } from "../shared/plain";
import { AddNote } from "./add-note";
import { QueryState, useCachedFindings, useInvalidate, useInventory, useLastWrite, useSourceDetail, useWorkspaceFolders } from "./data";
import { headerStatus } from "./freshness";
import { ModeProvider, usePlain } from "./mode";
import { Guide } from "./guide";
import { isStaleSource, landing, moveToTab, resolveEntry, resolveSource, unknownSourceLanding, onDestination, opensTransfer, syncScreenParams, takeDestination, toScreenParams, type Destination } from "./navigate";
import type { MemoriesScreenProps } from "./register";
import { TabBar, TabIntro, type SectionId } from "./navigation";
import { Overview } from "./overview";
import { SourcesTab, projectGroups, userGroups } from "./sources";
import { TransferTab } from "./transfer";
import { Button, Header, Screen, TokensProvider, useTokens, useUi, type Status } from "./ui";

/** The Memories page: Overview · User · Projects · Import & Export · Guide. */

/** The header's one line: which computer, and how its notes are doing (client/freshness.ts). Reads only cached findings, so other tabs cost no extra scan. */
function useHeaderStatus(hostId: string, hostLabel: string, plain: boolean): { status: Status; caption: string; retry?: boolean } {
  const inventory = useInventory(hostId);
  const cached = useCachedFindings(hostId);
  const lastWrite = useLastWrite(hostId);
  return headerStatus({ hostLabel, plain, inventory: inventory.data, inventoryError: Boolean(inventory.error), findings: cached.data, findingsAt: cached.dataUpdatedAt, findingsErrorAt: cached.errorUpdatedAt, lastWrite });
}

/** The unmatched part of a landing: refs only when no real id came with it. */
function linkRefs(destination: Destination): { sourceRef?: string; entryRef?: string } {
  if (destination.sourceId) return {};
  return {
    ...(destination.sourceRef ? { sourceRef: destination.sourceRef } : {}),
    ...(destination.sourceRef && destination.entryRef ? { entryRef: destination.entryRef } : {}),
  };
}

export function MemoriesSurface(props: MemoriesScreenProps) {
  const t = useUi(props.theme, props.layout.compact);
  return (
    <TokensProvider value={t}>
      <ModeProvider>
        <MemoriesBody key={props.host.id} {...props} />
      </ModeProvider>
    </TokensProvider>
  );
}

function MemoriesBody({ host, params }: MemoriesScreenProps) {
  const t = useTokens();
  const plain = usePlain();
  const hostId = host.id;
  const first = useMemo(() => landing(params), []);
  const [tab, setTab] = useState<SectionId>(opensTransfer(first) ? "transfer" : (first.tab ?? "overview"));
  const [sourceId, setSourceId] = useState<string | null>(first.sourceId ?? null);
  const [entryKey, setEntryKey] = useState<string | null>(first.entryKey ?? null);
  const [transfer, setTransfer] = useState<Destination | null>(opensTransfer(first) ? first : null);
  // A link's source and note, until matched against what this host lists (client/navigate.ts resolveSource).
  const [unmatched, setUnmatched] = useState(() => linkRefs(first));
  const inventory = useInventory(hostId);
  const workspaces = useWorkspaceFolders(hostId);
  const refreshAll = useInvalidate(hostId);
  // Add a note, open over the current tab; `workspaceId` preselects "Only in <project>".
  const [adding, setAdding] = useState<{ workspaceId?: string } | null>(first.addNote ?? null);

  const go = (destination: Destination) => {
    setAdding(destination.addNote ?? null);
    if (destination.tab) setTab(destination.tab);
    if (destination.sourceId !== undefined) {
      setSourceId(destination.sourceId);
      setEntryKey(destination.entryKey ?? null);
    }
    if (destination.tab === "transfer" || destination.from || destination.text) {
      setTab("transfer");
      setTransfer(destination);
    }
  };
  useEffect(
    () =>
      onDestination((destination) => {
        takeDestination();
        go(destination);
      }),
    [],
  );

  // Paseo 0.11+: the page's place lives in its params. New params on this
  // screen (back/forward) move the page; a move inside the page records new
  // params, handing the in-memory part (entries to copy) to the next screen.
  const paramsKey = JSON.stringify(params ?? null);
  const seenParams = useRef(paramsKey);
  useEffect(() => {
    if (seenParams.current === paramsKey) return;
    seenParams.current = paramsKey;
    const destination = landing(params);
    setAdding(destination.addNote ?? null);
    setTab(opensTransfer(destination) ? "transfer" : (destination.tab ?? "overview"));
    setSourceId(destination.sourceId ?? null);
    setEntryKey(destination.entryKey ?? null);
    setTransfer(opensTransfer(destination) ? destination : null);
    setUnmatched(linkRefs(destination));
  }, [paramsKey]);
  const placeParams = (over: { sourceId?: string | null; entryKey?: string | null; refs?: { sourceRef?: string; entryRef?: string } } = {}) => {
    const shownSource = over.sourceId !== undefined ? over.sourceId : sourceId;
    const shownEntry = over.entryKey !== undefined ? over.entryKey : entryKey;
    return toScreenParams({
      tab,
      ...(shownSource ? { sourceId: shownSource } : {}),
      ...(shownEntry ? { entryKey: shownEntry } : {}),
      ...(over.refs ?? unmatched),
      ...(adding ? { addNote: adding } : {}),
    });
  };
  const here = placeParams();
  const hereKey = JSON.stringify(here);
  // Set when a link's source or note can't be found: the page lands without a new history entry.
  const quietKey = useRef<string | null>(null);
  useEffect(() => {
    const quiet = quietKey.current === hereKey;
    quietKey.current = null;
    if (quiet) return;
    syncScreenParams(here, params, tab === "transfer" ? transfer : null);
  }, [hereKey]);
  // A link's source, once the list is in: the source it means, or (gone) the same tab with nothing selected.
  const sourcesNow = inventory.data?.sources;
  useEffect(() => {
    if (!unmatched.sourceRef || !sourcesNow) return;
    const id = resolveSource(unmatched.sourceRef, sourcesNow);
    if (id) {
      setSourceId(id);
      setUnmatched(unmatched.entryRef ? { entryRef: unmatched.entryRef } : {});
      return;
    }
    quietKey.current = JSON.stringify(placeParams({ sourceId: null, entryKey: null, refs: {} }));
    setUnmatched({});
  }, [unmatched.sourceRef, sourcesNow]);
  // A link's note, once that source's notes are in.
  const linkedDetail = useSourceDetail(hostId, unmatched.entryRef && !unmatched.sourceRef ? sourceId : null);
  useEffect(() => {
    if (!unmatched.entryRef || unmatched.sourceRef || !sourceId || !linkedDetail.data) return;
    const key = resolveEntry(sourceId, unmatched.entryRef, linkedDetail.data.entries.map((entry) => entry.key));
    if (key) setEntryKey(key);
    else quietKey.current = JSON.stringify(placeParams({ entryKey: null, refs: {} }));
    setUnmatched({});
  }, [unmatched.entryRef, unmatched.sourceRef, sourceId, linkedDetail.data]);
  // A source this host doesn't list (deleted, or one only a workspace plan shows): the same tab, nothing selected.
  useEffect(() => {
    if (!isStaleSource(sourceId, sourcesNow)) return;
    const landed = unknownSourceLanding({ tab, sourceId, entryKey });
    quietKey.current = JSON.stringify(placeParams({ sourceId: landed.sourceId, entryKey: landed.entryKey, refs: {} }));
    setSourceId(landed.sourceId);
    setEntryKey(landed.entryKey);
  }, [sourceId, sourcesNow]);

  /** The tab bar and the Overview's links: User and Projects open on their list, not on a note left open earlier. */
  const goToTab = (next: SectionId) => {
    const moved = moveToTab({ tab, sourceId, entryKey }, next);
    setAdding(null);
    setTab(moved.tab);
    setEntryKey(moved.entryKey);
  };

  /** Open a source on the tab it belongs to. */
  const open = (id: string, key?: string) => {
    const source = inventory.data?.sources.find((entry) => entry.id === id);
    setAdding(null);
    setTab(source && source.scope === "project" ? "projects" : "user");
    setSourceId(id);
    setEntryKey(key ?? null);
  };
  const copy = (from: Array<{ sourceId: string; key?: string }>) => go({ tab: "transfer", from });

  const sources = inventory.data?.sources ?? [];
  // Plain mode leaves Codex's own working files out of the lists.
  const listed = plain ? sources.filter((source) => !isCodexInternal(source)) : sources;
  const accounts = inventory.data?.accounts ?? [];
  // A project's workspace, so Add a note from Projects starts in that project.
  const workspaceFor = (id: string | null) => {
    const path = sources.find((source) => source.id === id)?.projectPath;
    return path ? (workspaces.data ?? []).find((entry) => entry.path === path || path.startsWith(`${entry.path}/`))?.id : undefined;
  };
  const addNote = (workspaceId?: string) => setAdding(workspaceId ? { workspaceId } : {});
  const header = useHeaderStatus(hostId, host.label ?? hostId, plain);
  const lists = tab === "overview" || tab === "user" || tab === "projects";
  return (
    <Screen t={t}>
      <Header
        title="Memories"
        icon="Brain"
        status={header.status}
        caption={header.caption}
        trailing={header.retry ? <Button label="Try again" icon="RefreshCw" variant="ghost" onPress={() => void refreshAll()} /> : lists ? <Button label={PLAIN.refresh} icon="RefreshCw" variant="ghost" onPress={() => void refreshAll()} loading={inventory.isFetching} /> : null}
      />
      <TabBar
        active={tab}
        onSelect={goToTab}
      />
      <TabIntro
        key={tab}
        section={tab}
        actions={!adding && (tab === "user" || tab === "projects") ? <Button label={PLAIN.overview.primary} icon="Plus" onPress={() => addNote(tab === "projects" ? workspaceFor(sourceId) : undefined)} /> : null}
      />
      {adding ? <AddNote key={adding.workspaceId ?? "everywhere"} hostId={hostId} {...(adding.workspaceId ? { workspaceId: adding.workspaceId } : {})} onClose={() => setAdding(null)} /> : null}
      {!adding && tab === "overview" ? <Overview
          hostId={hostId}
          onOpen={open}
          onAddNote={() => addNote()}
          onGo={goToTab}
        /> : null}
      {!adding && (tab === "user" || tab === "projects") ? (
        inventory.data ? (
          <SourcesTab
            hostId={hostId}
            groups={tab === "user" ? userGroups(listed, accounts, plain) : projectGroups(listed, workspaces.data ?? [], plain)}
            selected={sourceId && sources.some((source) => source.id === sourceId && (tab === "projects") === (source.scope === "project")) ? sourceId : null}
            entryKey={entryKey}
            onSelect={(id) => {
              setSourceId(id);
              setEntryKey(null);
            }}
            onOpenEntry={setEntryKey}
            onCopy={copy}
            empty={plain ? (tab === "user" ? PLAIN.emptyUser : PLAIN.emptyProjects) : tab === "user" ? "No agent has a user-level memory or instruction file on this host." : (inventory.data.checked[0] ?? "No project files found.")}
          />
        ) : (
          <QueryState query={inventory} what="what your agents remember" />
        )
      ) : null}
      {!adding && tab === "transfer" ? <TransferTab hostId={hostId} destination={transfer} /> : null}
      {!adding && tab === "guide" ? <Guide /> : null}
    </Screen>
  );
}
