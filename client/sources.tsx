import React, { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { Source } from "../shared/contracts";
import { formatBytes, formatTokens, plural } from "../shared/format";
import { kindLabel, shortPath } from "../shared/labels";
import { PLAIN, plainAgents, plainWords } from "../shared/plain";
import { notesIn, projectGroups, splitEmpty, userGroups, type SourceGroup } from "../shared/source-groups";
import { SourceDetail } from "./detail";
import { usePlain, useSourceNames } from "./mode";
import { Button, Card, EmptyState, Facts, Link, PathText, Row, Section, Tag, useTokens } from "./ui";

/**
 * User and Projects: a list of sources on the left, the chosen one on the
 * right (stacked on a narrow screen). The groups and counts come from
 * shared/source-groups.ts, the same ones the Overview adds up (0.5.1): each
 * badge is the group's number of notes, and groups with none fold behind
 * "Show empty".
 */

type Group = SourceGroup;

export { projectGroups, userGroups };

function PlainSourceRow({ source, name, first, selected, onPress }: { source: Source; name: string; first: boolean; selected: boolean; onPress: () => void }) {
  const t = useTokens();
  const readers = source.readBy.length ? `Followed by ${plainAgents(source.readBy)}` : undefined;
  return (
    <Row
      first={first}
      selected={selected}
      onPress={onPress}
      title={<Text style={t.text.bodyStrong}>{name}</Text>}
      // Wraps instead of cutting off: the list is the one place that says who follows a set of notes.
      {...(readers ? { subtitle: <Text style={t.text.caption}>{readers}</Text> } : {})}
      meta={
        <Facts
          items={[
            !source.exists ? { value: "Not written yet", tone: "neutral" } : source.isDirectory ? { value: `${source.files ?? 0} ${source.files === 1 ? "note" : "notes"}` } : { value: plainWords(Math.ceil(source.bytes / 4)) },
            source.access === "editable" ? null : { value: "Can't be changed here" },
          ]}
        />
      }
    />
  );
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
  foldEmpty = false,
}: {
  hostId: string;
  groups: Group[];
  selected: string | null;
  entryKey: string | null;
  onSelect: (id: string | null) => void;
  onOpenEntry: (key: string | null) => void;
  onCopy: (from: Array<{ sourceId: string; key?: string }>) => void;
  empty: string;
  /** Projects: groups with no notes fold behind "Show empty". */
  foldEmpty?: boolean;
}) {
  const t = useTokens();
  const plain = usePlain();
  const names = useSourceNames(hostId);
  const [showEmpty, setShowEmpty] = useState(false);
  const total = useMemo(() => groups.reduce((sum, group) => sum + group.sources.length, 0), [groups]);
  if (total === 0) return <EmptyState icon="Sparkles" title={PLAIN.nothingYet.title} body={empty} />;
  const split = foldEmpty ? splitEmpty(groups, selected) : { shown: groups, empty: [] };
  const visible = showEmpty ? groups : split.shown;
  const list = (
    <View style={{ gap: t.space.md }}>
      {visible.map((group) => (
        <Section key={group.key} title={group.title} icon={group.icon} trailing={<Tag label={String(notesIn(group.sources))} />}>
          {group.path ? <PathText path={group.path} /> : group.caption ? <Text style={t.text.caption}>{group.caption}</Text> : null}
          <Card padded={false}>
            {group.sources.map((source, index) =>
              plain ? (
                <PlainSourceRow key={source.id} source={source} name={names.name(source)} first={index === 0} selected={source.id === selected} onPress={() => onSelect(source.id)} />
              ) : (
                <SourceRow key={source.id} source={source} first={index === 0} selected={source.id === selected} onPress={() => onSelect(source.id)} />
              ),
            )}
          </Card>
        </Section>
      ))}
      {split.empty.length ? (
        <View style={{ flexDirection: "row" }}>
          <Link label={showEmpty ? PLAIN.hideEmpty : PLAIN.showEmpty(split.empty.length)} onPress={() => setShowEmpty(!showEmpty)} />
        </View>
      ) : null}
    </View>
  );
  const detail = selected ? (
    <View style={{ gap: t.space.sm }}>
      {t.compact ? (
        <View style={{ flexDirection: "row" }}>
          <Button label={PLAIN.back} icon="ArrowLeft" variant="ghost" onPress={() => onSelect(null)} />
        </View>
      ) : null}
      <SourceDetail key={selected} hostId={hostId} sourceId={selected} entryKey={entryKey} onOpenEntry={onOpenEntry} onCopy={onCopy} />
    </View>
  ) : (
    <EmptyState icon="PanelLeft" title={PLAIN.pickLeft.title} body={plain ? PLAIN.pickLeft.body : "Each row is one file or folder an agent reads. Open one to see what it says, who reads it and what it costs at launch."} />
  );
  if (t.compact) return selected ? detail : list;
  // Two columns: a fixed list, the detail gets the rest (the page itself scrolls).
  return (
    <View style={{ flexDirection: "row", gap: t.space.md, alignItems: "flex-start" }}>
      <View style={{ width: 320, flexShrink: 0 }}>{list}</View>
      <View style={{ flex: 1, minWidth: 0 }}>{detail}</View>
    </View>
  );
}
