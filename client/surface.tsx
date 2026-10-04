import React, { useEffect, useMemo, useRef, useState } from "react";
import { PLAIN, isCodexInternal, plainFindings } from "../shared/plain";
import { AddNote } from "./add-note";
import { QueryState, useCachedFindings, useInvalidate, useInventory, useWorkspaceFolders } from "./data";
import { ModeProvider, usePlain } from "./mode";
import { Guide } from "./guide";
import { isStaleSource, landing, onDestination, opensTransfer, syncScreenParams, takeDestination, toScreenParams, type Destination } from "./navigate";
import type { MemoriesScreenProps } from "./register";
import { TabBar, TabIntro, type SectionId } from "./navigation";
import { Overview } from "./overview";
import { SourcesTab, projectGroups, userGroups } from "./sources";
import { TransferTab } from "./transfer";
import { Button, Header, Screen, TokensProvider, useTokens, useUi, type Status } from "./ui";

/** The Memories page: Overview · User · Projects · Import & Export · Guide. */

/**
 * The header's one line: which computer, and how its notes are doing. The
 * tidy count comes from the checks the Overview already ran (read from the
 * cache, never fetched here), so other tabs cost no extra scan.
 */
function useHeaderStatus(hostId: string, hostLabel: string, plain: boolean): { status: Status; caption: string } {
  const inventory = useInventory(hostId);
  const tidy = useCachedFindings(hostId).data;
  const S = PLAIN.status;
  if (!inventory.data) return inventory.error ? { status: "error", caption: S.cantRead(hostLabel) } : { status: "busy", caption: S.checking(hostLabel) };
  if (inventory.data.counts.sources === 0) return { status: "neutral", caption: `${S.on(hostLabel)} · ${S.none}` };
  if (!tidy) return { status: "neutral", caption: S.on(hostLabel) };
  const shown = plain ? plainFindings(tidy.findings, inventory.data.sources) : tidy.findings;
  const status: Status = shown.some((finding) => finding.severity === "error") ? "error" : shown.length ? "attention" : "ok";
  return { status, caption: `${S.on(hostLabel)} · ${shown.length ? S.worth(shown.length) : S.tidy}` };
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
  }, [paramsKey]);
  const here = toScreenParams({
    tab,
    ...(sourceId ? { sourceId } : {}),
    ...(entryKey ? { entryKey } : {}),
    ...(adding ? { addNote: adding } : {}),
  });
  const hereKey = JSON.stringify(here);
  // A stale link falls back to the Overview without a new history entry, so Back is not a loop.
  const quietKey = useRef<string | null>(null);
  useEffect(() => {
    const quiet = quietKey.current === hereKey;
    quietKey.current = null;
    if (quiet) return;
    syncScreenParams(here, params, tab === "transfer" ? transfer : null);
  }, [hereKey]);
  // A source this host no longer has (an old link, a deleted file): back to the Overview.
  const sourcesNow = inventory.data?.sources;
  useEffect(() => {
    if (!isStaleSource(sourceId, sourcesNow)) return;
    quietKey.current = JSON.stringify(toScreenParams(adding ? { addNote: adding } : {}));
    setTab("overview");
    setSourceId(null);
    setEntryKey(null);
  }, [sourceId, sourcesNow]);

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
        trailing={lists ? <Button label={PLAIN.refresh} icon="RefreshCw" variant="ghost" onPress={() => void refreshAll()} loading={inventory.isFetching} /> : null}
      />
      <TabBar
        active={tab}
        onSelect={(next) => {
          setAdding(null);
          setTab(next);
          if (next === "user" || next === "projects") setEntryKey(null);
        }}
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
          onGo={(next) => {
            setAdding(null);
            setTab(next);
          }}
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
