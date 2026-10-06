import type { PluginPopoverProps } from "@getpaseo/plugin/client";
import React, { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { AddNote } from "./add-note";
import { AddSkill } from "./skills-add";
import { openSkills, type AddMode } from "./skills-nav";
import { ModeProvider } from "./mode";
import { noteDrafts } from "./note-draft";
import type { QuickAddButtonProps, SidebarDotProps, SidebarParts } from "./register";
import { SPACE, TokensProvider, useUi } from "./ui";

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

/** The sidebar row's status dot (0.5.0): something worth a look, said in colour and to screen readers. */
function SidebarDot({ color, label }: SidebarDotProps) {
  return <View testID="sidebar-status-dot" accessibilityRole="image" accessibilityLabel={label} style={{ width: SPACE.sm, height: SPACE.sm, borderRadius: SPACE.xs, backgroundColor: color, marginHorizontal: SPACE.xs }} />;
}

function SidebarGroup({ children }: { children?: React.ReactNode }) {
  return <View style={{ flexDirection: "row", alignItems: "center" }}>{children}</View>;
}

export const SIDEBAR_PARTS: SidebarParts = { Dot: SidebarDot, Group: SidebarGroup };
