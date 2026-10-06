import React, { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { fixAllConfirm, fixAllEffect, groupFindings, groupSummary, groupTitle, type FindingGroup, type Page } from "../shared/finding-groups";
import { Button, Card, HostIcon, Link, statusColor, useTokens, type Status } from "./ui";

/**
 * Things worth a look, one row per kind (0.5.1): "58 notes missing from
 * Claude's list · Fix all", opening in place to the named items, each with
 * its own action. A kind with a single item shows that item's own row, as
 * before. Memories and Skills both use it; each page draws its item rows.
 *
 * Fix all never acts on what the person hasn't seen: it opens the group and
 * a confirm that lists every item it will change (scrollable), with what
 * happens to each and where the backup goes, and only those items are sent.
 */

type Item = { id: string; kind: string; message: string; subject?: string | undefined; group?: string | undefined; severity?: string; action?: { kind: string } | undefined };

/** Fix all for a group: the items the person confirmed, by id (only these are changed). */
export type FixAllHandler<F> = (group: FindingGroup<F>, findingIds: string[]) => void;

const defaultName = (finding: Item) => finding.subject?.trim() || finding.message;

/** The rows shown at once inside an open group; the rest behind "N more". */
const PAGE_ROWS = 25;

const TONE: Record<string, Status> = { error: "error", warn: "attention", info: "neutral" };

export function GroupedFindings<F extends Item>({
  page,
  findings,
  renderRow,
  onFixAll,
  busyGroup,
  itemName = defaultName,
}: {
  page: Page;
  findings: readonly F[];
  /** One item's row: `grouped` rows sit under a heading that already says what's wrong, so they only name the item. */
  renderRow: (finding: F, options: { grouped: boolean; first: boolean }) => React.ReactNode;
  onFixAll?: FixAllHandler<F>;
  busyGroup?: string | null;
  /** How the confirm names an item, in plain words. */
  itemName?: (finding: F) => string;
}) {
  const groups = groupFindings(page, findings);
  return (
    <Card padded={false}>
      {groups.map((group, index) =>
        group.findings.length === 1 ? (
          <React.Fragment key={group.key}>{renderRow(group.findings[0]!, { grouped: false, first: index === 0 })}</React.Fragment>
        ) : (
          <GroupRow key={group.key} page={page} group={group} first={index === 0} renderRow={renderRow} itemName={itemName} {...(onFixAll ? { onFixAll } : {})} busy={busyGroup === group.key} />
        ),
      )}
    </Card>
  );
}

function GroupRow<F extends Item>({ page, group, first, renderRow, itemName, onFixAll, busy }: { page: Page; group: FindingGroup<F>; first: boolean; renderRow: (finding: F, options: { grouped: boolean; first: boolean }) => React.ReactNode; itemName: (finding: F) => string; onFixAll?: FixAllHandler<F>; busy: boolean }) {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  // The items the confirm lists, as they were when Fix all was pressed: exactly these are sent.
  const [confirming, setConfirming] = useState<F[] | null>(null);
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
          {group.fixAll && onFixAll ? (
            <Button
              label="Fix all"
              variant="ghost"
              loading={busy}
              onPress={() => {
                setOpen(true);
                setConfirming([...group.findings]);
              }}
            />
          ) : null}
          <Button label={open ? "Hide" : `Show ${count.toLocaleString("en-AU")}`} variant="ghost" onPress={() => setOpen((value) => !value)} />
        </View>
      </View>
      {open && confirming && onFixAll ? (
        <FixAllConfirm
          page={page}
          groupKey={group.key}
          items={confirming}
          itemName={itemName}
          onYes={() => {
            onFixAll(group, confirming.map((finding) => finding.id));
            setConfirming(null);
          }}
          onNo={() => setConfirming(null)}
        />
      ) : null}
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

/** The confirm Fix all opens: the question, every item it will change with what happens to it, and where the backup goes. */
function FixAllConfirm<F extends Item>({ page, groupKey, items, itemName, onYes, onNo }: { page: Page; groupKey: string; items: F[]; itemName: (finding: F) => string; onYes: () => void; onNo: () => void }) {
  const t = useTokens();
  const words = fixAllConfirm(page, groupKey, items.length);
  const effect = fixAllEffect(page, groupKey);
  const pad = t.compact ? t.space.row : t.space.md;
  return (
    <View testID={`fix-all-confirm-${groupKey}`} style={{ gap: t.space.sm, paddingVertical: t.space.row, paddingHorizontal: pad, borderTopWidth: 1, borderTopColor: t.color.borderSubtle, backgroundColor: t.color.surface1 }}>
      <Text style={t.text.bodyStrong}>{words.question}</Text>
      <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
        {items.map((finding) => (
          <View key={finding.id} testID={`fix-all-item-${finding.id}`} style={{ paddingVertical: t.space.xs, gap: t.space.hair }}>
            <Text style={t.text.body}>{itemName(finding)}</Text>
            <Text style={t.text.caption}>{effect}</Text>
          </View>
        ))}
      </ScrollView>
      <Text style={t.text.caption}>{words.backup}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
        <Button label={words.yes} variant="primary" onPress={onYes} />
        <Button label="Cancel" variant="ghost" onPress={onNo} />
      </View>
    </View>
  );
}
