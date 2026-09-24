import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import React, { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { PLAIN, isCodexInternal } from "../shared/plain";
import { AddNote } from "./add-note";
import { QueryState, useInvalidate, useInventory, useWorkspaceFolders } from "./data";
import { ModeProvider, usePlain } from "./mode";
import { Guide } from "./guide";
import { onDestination, takeDestination, type Destination } from "./navigate";
import { SectionHeading, TabBar, type SectionId } from "./navigation";
import { Overview } from "./overview";
import { SourcesTab, projectGroups, userGroups } from "./sources";
import { TransferTab } from "./transfer";
import { Button, Header, Screen, Tag, TokensProvider, useTokens, useUi } from "./ui";

/** The Memories page: Overview · User · Projects · Import & Export · Guide. */

export function MemoriesSurface(props: PluginSurfaceProps) {
  const t = useUi(props.theme, props.layout.compact);
  return (
    <TokensProvider value={t}>
      <ModeProvider>
        <MemoriesBody key={props.host.id} {...props} />
      </ModeProvider>
    </TokensProvider>
  );
}

function MemoriesBody({ host }: PluginSurfaceProps) {
  const t = useTokens();
  const plain = usePlain();
  const hostId = host.id;
  const first = useMemo(() => takeDestination(), []);
  const [tab, setTab] = useState<SectionId>(first?.tab ?? (first?.from || first?.text ? "transfer" : "overview"));
  const [sourceId, setSourceId] = useState<string | null>(first?.sourceId ?? null);
  const [entryKey, setEntryKey] = useState<string | null>(first?.entryKey ?? null);
  const [transfer, setTransfer] = useState<Destination | null>(first?.tab === "transfer" || first?.from || first?.text ? first : null);
  const inventory = useInventory(hostId);
  const workspaces = useWorkspaceFolders(hostId);
  const refreshAll = useInvalidate(hostId);
  // Add a note, open over the current tab; `workspaceId` preselects "Only in <project>".
  const [adding, setAdding] = useState<{ workspaceId?: string } | null>(first?.addNote ?? null);

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
  return (
    <Screen t={t}>
      <Header
        title="Memories"
        caption={`${plain ? PLAIN.header.caption : "What your coding agents remember"} · ${host.label ?? hostId}`}
        pill={inventory.isFetching ? <Tag label={PLAIN.checking} tone="busy" /> : null}
      />
      <TabBar
        active={tab}
        onSelect={(next) => {
          setAdding(null);
          setTab(next);
          if (next === "user" || next === "projects") setEntryKey(null);
        }}
      />
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: t.space.sm }}>
        <View style={{ flex: 1 }}>
          <SectionHeading section={tab} />
        </View>
        {!adding && (tab === "user" || tab === "projects") ? <Button label={PLAIN.overview.primary} onPress={() => addNote(tab === "projects" ? workspaceFor(sourceId) : undefined)} /> : null}
        {tab === "overview" || tab === "user" || tab === "projects" ? <Button label="Refresh" variant="ghost" onPress={() => void refreshAll()} loading={inventory.isFetching} /> : null}
      </View>
      {adding ? <AddNote key={adding.workspaceId ?? "everywhere"} hostId={hostId} {...(adding.workspaceId ? { workspaceId: adding.workspaceId } : {})} onClose={() => setAdding(null)} /> : null}
      {!adding && tab === "overview" ? <Overview hostId={hostId} onOpen={open} onAddNote={() => addNote()} /> : null}
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
