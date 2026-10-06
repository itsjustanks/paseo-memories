import { useRpc, type PluginPopoverProps } from "@getpaseo/plugin/client";
import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { AddNote } from "./add-note";
import { AddSkill } from "./skills-add";
import { openSkills, type AddMode } from "./skills-nav";
import { ModeProvider } from "./mode";
import { noteDrafts } from "./note-draft";
import type { QuickAddButtonProps, SidebarDotProps, SidebarParts } from "./register";
import { sidebarStatus } from "../shared/contracts";
import { groupTitle, type Page } from "../shared/finding-groups";
import { toScreenParams } from "./navigate";
import { SEED_EVERY_MS, seedFromServer, useSidebarSummary } from "./sidebar-status";
import { Button, Dot, SPACE, TokensProvider, useUi } from "./ui";
import { recallTechnicalTitles } from "./web";

/**
 * Add a note from the sidebar's "+" (Paseo 0.11+): the same form as on the
 * page, anchored to the row on wide layouts and a bottom sheet on phones.
 * Close (or a tap outside) keeps what was typed for the next "+".
 */
export function AddNotePopover({ theme, host, close }: PluginPopoverProps) {
  const t = useUi(theme, true);
  return (
    <TokensProvider value={t}>
      <ModeProvider>
        <ScrollView style={{ maxHeight: 640, backgroundColor: t.color.surface0 }} contentContainerStyle={{ padding: t.space.row, gap: t.space.row }}>
          <AddNote hostId={host.id} onClose={close} closeLabel="Close" draft={noteDrafts(host.id)} />
        </ScrollView>
      </ModeProvider>
    </TokensProvider>
  );
}

/** The sidebar row's trailing "+": its own button beside the row's pressable. */
export function QuickAddButton({ label, color, onPress, testID = "memories-sidebar-add" }: QuickAddButtonProps) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} hitSlop={6} onPress={onPress} style={{ paddingHorizontal: SPACE.xs + SPACE.hair, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color, fontSize: 18, lineHeight: 20 }}>+</Text>
    </Pressable>
  );
}

/**
 * Add a skill from the Skills row's "+" (Paseo 0.11+): the same three ways
 * as on the page, compact. Once added, "Open it" takes you to the skill.
 */
export function AddSkillPopover({ theme, host, close }: PluginPopoverProps) {
  const t = useUi(theme, true);
  const [mode, setMode] = useState<AddMode>("catalog");
  return (
    <TokensProvider value={t}>
      <ModeProvider>
        <ScrollView style={{ maxHeight: 640, backgroundColor: t.color.surface0 }} contentContainerStyle={{ padding: t.space.md, gap: t.space.row }}>
          <Text accessibilityRole="header" style={t.text.section}>
            Add a skill
          </Text>
          <AddSkill
            hostId={host.id}
            mode={mode}
            onMode={setMode}
            compact
            onOpen={(skillId) => {
              close();
              openSkills({ tab: "skills", skillId });
            }}
          />
        </ScrollView>
      </ModeProvider>
    </TokensProvider>
  );
}

/** The sidebar row's status dot (0.5.0): something worth a look, said in colour and to screen readers. Pressable from 0.5.1: it opens the quick popover. */
function SidebarDot({ color, label, onPress }: SidebarDotProps) {
  const dot = <View testID="sidebar-status-dot" accessibilityRole={onPress ? undefined : "image"} accessibilityLabel={onPress ? undefined : label} style={{ width: SPACE.sm, height: SPACE.sm, borderRadius: SPACE.xs, backgroundColor: color }} />;
  if (!onPress) return <View style={{ marginHorizontal: SPACE.xs }}>{dot}</View>;
  return (
    <Pressable testID="sidebar-status-button" accessibilityRole="button" accessibilityLabel={`${label}. Quick look`} hitSlop={SPACE.sm} onPress={onPress} style={{ padding: SPACE.xs }}>
      {dot}
    </Pressable>
  );
}

function SidebarGroup({ children }: { children?: React.ReactNode }) {
  return <View style={{ flexDirection: "row", alignItems: "center" }}>{children}</View>;
}

/** Draws nothing if the seed can't run (an app without plugin calls in the sidebar): the dot then waits for a page, as in 0.5.0. */
class Quiet extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** One cheap read of the server's last known answer when the sidebar loads, and every few minutes after (0.5.1). Draws nothing. */
function SidebarSeedReader({ hostId }: { hostId: string }) {
  const call = useRpc(sidebarStatus);
  useEffect(() => {
    if (!hostId) return;
    const read = () => void seedFromServer(hostId, () => call({}), recallTechnicalTitles());
    read();
    const timer = setInterval(read, SEED_EVERY_MS);
    return () => clearInterval(timer);
  }, [hostId, call]);
  return null;
}

function SidebarSeed({ hostId }: { hostId: string }) {
  return (
    <Quiet>
      <SidebarSeedReader hostId={hostId} />
    </Quiet>
  );
}

const QUICK_PAGES: Record<string, { page: Page; title: string; open: string; icon: string }> = {
  memories: { page: "memories", title: "Memories", open: "Open Memories", icon: "Brain" },
  skills: { page: "skills", title: "Skills", open: "Open Skills", icon: "Sparkles" },
};

const quickCache = new Map<string, React.ComponentType<PluginPopoverProps>>();

/** The dot's quick popover (0.5.1, as AI Router and Hosts): how many things are worth a look, the biggest kinds, and a way to each. */
export function quickStatus(screenId: string): React.ComponentType<PluginPopoverProps> {
  const cached = quickCache.get(screenId);
  if (cached) return cached;
  const meta = QUICK_PAGES[screenId] ?? QUICK_PAGES.memories!;
  function QuickStatus({ theme, host, close, openScreen }: PluginPopoverProps) {
    const t = useUi(theme, true);
    const summary = useSidebarSummary(screenId, host.id);
    const tone = summary?.tone ?? null;
    const headline = !summary ? "Checking…" : summary.count === 0 ? "Nothing needs a look" : summary.count === 1 ? "1 thing worth a look" : `${summary.count.toLocaleString("en-AU")} things worth a look`;
    const show = () => {
      close();
      openScreen(screenId === "memories" ? { screenId, params: toScreenParams({ tab: "overview", worth: true }) } : { screenId, params: { tab: "overview" } });
    };
    return (
      <TokensProvider value={t}>
        <View testID={`${screenId}-quick-status`} style={{ padding: t.space.md, gap: t.space.row, minWidth: 280, maxWidth: 380 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
            <Dot status={tone === "error" ? "error" : tone === "attention" ? "attention" : summary ? "ok" : "neutral"} />
            <Text accessibilityRole="header" style={[t.text.bodyStrong, { flexShrink: 1 }]}>{`${meta.title} · ${headline}`}</Text>
          </View>
          {summary?.groups.length ? (
            <View style={{ gap: t.space.xs }}>
              {summary.groups.map((group) => (
                <Text key={group.key} style={t.text.body}>
                  {groupTitle(meta.page, group.key, group.count)}
                </Text>
              ))}
            </View>
          ) : null}
          {summary && summary.count > 0 ? <Button label="Show me" icon="ArrowRight" variant="primary" onPress={show} /> : null}
          <Button
            label={meta.open}
            icon={meta.icon}
            variant={summary && summary.count > 0 ? "secondary" : "primary"}
            onPress={() => {
              close();
              openScreen({ screenId });
            }}
          />
        </View>
      </TokensProvider>
    );
  }
  quickCache.set(screenId, QuickStatus);
  return QuickStatus;
}

export const SIDEBAR_PARTS: SidebarParts = { Dot: SidebarDot, Group: SidebarGroup, Seed: SidebarSeed, Quick: quickStatus };
