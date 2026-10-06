import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { groupFindings, groupSummary, groupTitle, type FindingGroup, type Page } from "../shared/finding-groups";
import { Button, Card, HostIcon, Link, statusColor, useTokens, type Status } from "./ui";

/**
 * Things worth a look, one row per kind (0.5.1): "58 notes missing from
 * Claude's list · Fix all", opening in place to the named items, each with
 * its own action. A kind with a single item shows that item's own row, as
 * before. Memories and Skills both use it; each page draws its item rows.
 */

type Item = { id: string; kind: string; message: string; severity?: string; action?: { kind: string } | undefined };

/** The rows shown at once inside an open group; the rest behind "N more". */
const PAGE_ROWS = 25;

const TONE: Record<string, Status> = { error: "error", warn: "attention", info: "neutral" };

export function GroupedFindings<F extends Item>({
  page,
  findings,
  renderRow,
  onFixAll,
  busyGroup,
}: {
  page: Page;
  findings: readonly F[];
  /** One item's row: `grouped` rows sit under a heading that already says what's wrong, so they only name the item. */
  renderRow: (finding: F, options: { grouped: boolean; first: boolean }) => React.ReactNode;
  onFixAll?: (group: FindingGroup<F>) => void;
  busyGroup?: string | null;
}) {
  const groups = groupFindings(page, findings);
  return (
    <Card padded={false}>
      {groups.map((group, index) =>
        group.findings.length === 1 ? (
          <React.Fragment key={group.key}>{renderRow(group.findings[0]!, { grouped: false, first: index === 0 })}</React.Fragment>
        ) : (
          <GroupRow key={group.key} page={page} group={group} first={index === 0} renderRow={renderRow} {...(onFixAll ? { onFixAll } : {})} busy={busyGroup === group.key} />
        ),
      )}
    </Card>
  );
}

function GroupRow<F extends Item>({ page, group, first, renderRow, onFixAll, busy }: { page: Page; group: FindingGroup<F>; first: boolean; renderRow: (finding: F, options: { grouped: boolean; first: boolean }) => React.ReactNode; onFixAll?: (group: FindingGroup<F>) => void; busy: boolean }) {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const count = group.findings.length;
  const title = groupTitle(page, group.key, count);
  const tone = TONE[group.findings[0]!.severity ?? "info"] ?? "neutral";
  const shown = all ? group.findings : group.findings.slice(0, PAGE_ROWS);
  const pad = t.compact ? t.space.row : t.space.md;
  return (
    <View testID={`finding-group-${group.key}`} style={{ borderTopWidth: first ? 0 : 1, borderTopColor: t.color.borderSubtle, borderLeftWidth: tone !== "neutral" ? 3 : 0, borderLeftColor: tone !== "neutral" ? statusColor(t, tone) : "transparent" }}>
      <View style={{ flexDirection: t.compact ? "column" : "row", alignItems: t.compact ? "stretch" : "center", gap: t.space.sm, paddingVertical: t.space.row, paddingHorizontal: pad }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={title}
          accessibilityState={{ expanded: open }}
          {...({ "aria-expanded": open } as object)}
          onPress={() => setOpen((value) => !value)}
          style={({ pressed }) => ({ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: t.space.sm, opacity: pressed ? 0.7 : 1 })}
        >
          {HostIcon ? <HostIcon name={open ? "ChevronDown" : "ChevronRight"} size={16} color={t.color.muted} /> : <Text style={[t.text.body, { color: t.color.muted }]}>{open ? "▾" : "▸"}</Text>}
          <View style={{ flex: 1, minWidth: 0, gap: t.space.hair }}>
            <Text style={t.text.bodyStrong}>{title}</Text>
            <Text style={t.text.body}>{groupSummary(page, group.key)}</Text>
          </View>
        </Pressable>
        <View style={{ flexDirection: "row", gap: t.space.sm, flexShrink: 0 }}>
          {group.fixAll && onFixAll ? <Button label="Fix all" variant="ghost" loading={busy} onPress={() => onFixAll(group)} /> : null}
          <Button label={open ? "Hide" : `Show ${count.toLocaleString("en-AU")}`} variant="ghost" onPress={() => setOpen((value) => !value)} />
        </View>
      </View>
      {open ? (
        <View style={{ borderTopWidth: 1, borderTopColor: t.color.borderSubtle, paddingLeft: t.compact ? 0 : t.space.md }}>
          {shown.map((finding, index) => (
            <React.Fragment key={finding.id}>{renderRow(finding, { grouped: true, first: index === 0 })}</React.Fragment>
          ))}
          {count > PAGE_ROWS ? (
            <View style={{ paddingVertical: t.space.row, paddingHorizontal: pad, borderTopWidth: 1, borderTopColor: t.color.borderSubtle }}>
              <Link label={all ? "Show fewer" : `${(count - PAGE_ROWS).toLocaleString("en-AU")} more`} onPress={() => setAll(!all)} />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
