import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import React, { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { QueryState, useInvalidate, useInventory, useWorkspaceFolders } from "./data";
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
      <MemoriesBody key={props.host.id} {...props} />
    </TokensProvider>
  );
}

function MemoriesBody({ host }: PluginSurfaceProps) {
  const t = useTokens();
  const hostId = host.id;
  const first = useMemo(() => takeDestination(), []);
  const [tab, setTab] = useState<SectionId>(first?.tab ?? (first?.from || first?.text ? "transfer" : "overview"));
  const [sourceId, setSourceId] = useState<string | null>(first?.sourceId ?? null);
  const [entryKey, setEntryKey] = useState<string | null>(first?.entryKey ?? null);
  const [transfer, setTransfer] = useState<Destination | null>(first?.tab === "transfer" || first?.from || first?.text ? first : null);
  const inventory = useInventory(hostId);
  const workspaces = useWorkspaceFolders(hostId);
  const refreshAll = useInvalidate(hostId);

  const go = (destination: Destination) => {
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
    setTab(source && source.scope === "project" ? "projects" : "user");
    setSourceId(id);
    setEntryKey(key ?? null);
  };
  const copy = (from: Array<{ sourceId: string; key?: string }>) => go({ tab: "transfer", from });

  const sources = inventory.data?.sources ?? [];
  const accounts = inventory.data?.accounts ?? [];
  return (
    <Screen t={t}>
      <Header
        title="Memories"
        caption={`What your coding agents remember · ${host.label ?? hostId}`}
        pill={inventory.isFetching ? <Tag label="Checking" tone="busy" /> : null}
      />
      <TabBar
        active={tab}
        onSelect={(next) => {
          setTab(next);
          if (next === "user" || next === "projects") setEntryKey(null);
        }}
      />
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: t.space.sm }}>
        <View style={{ flex: 1 }}>
          <SectionHeading section={tab} />
        </View>
        {tab === "overview" || tab === "user" || tab === "projects" ? <Button label="Refresh" variant="ghost" onPress={() => void refreshAll()} loading={inventory.isFetching} /> : null}
      </View>
      {tab === "overview" ? <Overview hostId={hostId} onOpen={open} /> : null}
      {tab === "user" || tab === "projects" ? (
        inventory.data ? (
          <SourcesTab
            hostId={hostId}
            groups={tab === "user" ? userGroups(sources, accounts) : projectGroups(sources, workspaces.data ?? [])}
            selected={sourceId && sources.some((source) => source.id === sourceId && (tab === "projects") === (source.scope === "project")) ? sourceId : null}
            entryKey={entryKey}
            onSelect={(id) => {
              setSourceId(id);
              setEntryKey(null);
            }}
            onOpenEntry={setEntryKey}
            onCopy={copy}
            empty={tab === "user" ? "No agent has a user-level memory or instruction file on this host." : (inventory.data.checked[0] ?? "No project files found.")}
          />
        ) : (
          <QueryState query={inventory} what="what your agents remember" />
        )
      ) : null}
      {tab === "transfer" ? <TransferTab hostId={hostId} destination={transfer} /> : null}
      {tab === "guide" ? <Guide /> : null}
    </Screen>
  );
}
