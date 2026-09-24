import React, { useMemo } from "react";
import { Text, View } from "react-native";
import { AGENT_LABELS } from "../shared/agents";
import type { Account, Source } from "../shared/contracts";
import { formatBytes, formatTokens, plural } from "../shared/format";
import { folderName, kindLabel, shortPath } from "../shared/labels";
import { SourceDetail } from "./detail";
import { Card, EmptyState, Facts, PathText, Row, Section, Tag, useTokens } from "./ui";

/**
 * User and Projects: a list of sources on the left, the chosen one on the
 * right (stacked on a narrow screen). User groups by agent and account;
 * Projects puts Paseo's workspaces first, then other known folders, then
 * Claude memory for projects whose path is unknown.
 */

type Group = { key: string; title: string; caption?: string; path?: string; sources: Source[] };

function accountTitle(account: Account | undefined, agent: string): string {
  const name = AGENT_LABELS[agent] ?? agent;
  if (!account) return name;
  return account.email ? `${name} · ${account.email}` : `${name} · ${account.label}`;
}

export function userGroups(sources: Source[], accounts: Account[]): Group[] {
  const groups = new Map<string, Group>();
  for (const source of sources) {
    if (source.scope !== "user" && source.scope !== "managed" && source.scope !== "host") continue;
    const account = accounts.find((entry) => entry.id === source.accountId);
    const key = source.scope === "managed" ? "managed" : source.scope === "host" ? "host" : source.accountId ?? source.agent;
    const title = source.scope === "managed" ? "Managed by your organisation" : source.scope === "host" ? "Paseo (every agent on this host)" : accountTitle(account, source.agent);
    const group = groups.get(key) ?? { key, title, ...(account ? { path: account.dir } : {}), sources: [] };
    group.sources.push(source);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function projectGroups(sources: Source[], workspaces: Array<{ name: string; path: string }>): Group[] {
  const groups = new Map<string, Group & { rank: number }>();
  for (const source of sources) {
    if (source.scope !== "project") continue;
    const path = source.projectPath;
    const key = path ?? "unknown";
    const workspace = path ? workspaces.find((entry) => entry.path === path || path.startsWith(`${entry.path}/`) || entry.path.startsWith(`${path}/`)) : undefined;
    const rank = workspace ? 0 : path ? 1 : 2;
    const group = groups.get(key) ?? { key, rank, title: path ? (workspace ? workspace.name : folderName(path)) : "Other projects (path unknown)", ...(path ? { path } : { caption: "Claude keeps these by a folder name that cannot be turned back into a path." }), sources: [] };
    group.rank = Math.min(group.rank, rank);
    group.sources.push(source);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));
}

function SourceRow({ source, first, selected, onPress }: { source: Source; first: boolean; selected: boolean; onPress: () => void }) {
  const t = useTokens();
  const title = source.kind === "claude-auto-memory" ? (source.projectPath ? `Claude memory` : `Claude memory · ${source.slug ?? ""}`) : source.path.startsWith("paseo:") ? "Appended system prompt" : source.path.startsWith("copilot:") ? "Copilot Memory" : shortPath(source.path);
  return (
    <Row
      first={first}
      selected={selected}
      onPress={onPress}
      title={<PathText path={title} style={t.text.bodyStrong} />}
      subtitle={kindLabel(source.kind)}
      meta={
        <Facts
          items={[
            !source.exists ? { value: "not there yet", tone: "neutral" } : source.isDirectory ? { value: plural(source.files ?? 0, "file") } : { value: formatBytes(source.bytes) },
            source.loaded.tokens ? { value: formatTokens(source.loaded.tokens) } : null,
            source.access === "read-only" ? { value: "read-only" } : source.access === "online" ? { value: "online" } : null,
          ]}
        />
      }
    />
  );
}

export function SourcesTab({
  hostId,
  groups,
  selected,
  entryKey,
  onSelect,
  onOpenEntry,
  onCopy,
  empty,
}: {
  hostId: string;
  groups: Group[];
  selected: string | null;
  entryKey: string | null;
  onSelect: (id: string | null) => void;
  onOpenEntry: (key: string | null) => void;
  onCopy: (from: Array<{ sourceId: string; key?: string }>) => void;
  empty: string;
}) {
  const t = useTokens();
  const total = useMemo(() => groups.reduce((sum, group) => sum + group.sources.length, 0), [groups]);
  if (total === 0) return <EmptyState title="Nothing here yet" body={empty} />;
  const list = (
    <View style={{ gap: t.space.lg }}>
      {groups.map((group) => (
        <Section key={group.key} title={group.title} trailing={<Tag label={String(group.sources.length)} />}>
          {group.path ? <PathText path={group.path} /> : group.caption ? <Text style={t.text.caption}>{group.caption}</Text> : null}
          <Card padded={false}>
            {group.sources.map((source, index) => (
              <SourceRow key={source.id} source={source} first={index === 0} selected={source.id === selected} onPress={() => onSelect(source.id)} />
            ))}
          </Card>
        </Section>
      ))}
    </View>
  );
  const detail = selected ? (
    <View style={{ gap: t.space.sm }}>
      {t.compact ? <Text style={[t.text.caption, { color: t.color.accent }]} onPress={() => onSelect(null)}>‹ Back to the list</Text> : null}
      <SourceDetail key={selected} hostId={hostId} sourceId={selected} entryKey={entryKey} onOpenEntry={onOpenEntry} onCopy={onCopy} />
    </View>
  ) : (
    <EmptyState title="Pick something on the left" body="Each row is one file or folder an agent reads. Open one to see what it says, who reads it and what it costs at launch." />
  );
  if (t.compact) return selected ? detail : list;
  // Two columns: a fixed list, the detail gets the rest (the page itself scrolls).
  return (
    <View style={{ flexDirection: "row", gap: t.space.lg, alignItems: "flex-start" }}>
      <View style={{ width: 360, flexShrink: 0 }}>{list}</View>
      <View style={{ flex: 1, minWidth: 0 }}>{detail}</View>
    </View>
  );
}
