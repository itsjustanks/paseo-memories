import type { PluginPopoverProps } from "@getpaseo/plugin/client";
import React from "react";
import { Pressable, ScrollView, Text } from "react-native";
import { AddNote } from "./add-note";
import { ModeProvider } from "./mode";
import { noteDrafts } from "./note-draft";
import type { QuickAddButtonProps } from "./register";
import { TokensProvider, useUi } from "./ui";

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
        <ScrollView style={{ maxHeight: 640, backgroundColor: t.color.surface0 }} contentContainerStyle={{ padding: t.space.md, gap: t.space.md }}>
          <AddNote hostId={host.id} onClose={close} closeLabel="Close" draft={noteDrafts(host.id)} />
        </ScrollView>
      </ModeProvider>
    </TokensProvider>
  );
}

/** The sidebar row's trailing "+": its own button beside the row's pressable. */
export function QuickAddButton({ label, color, onPress }: QuickAddButtonProps) {
  return (
    <Pressable testID="memories-sidebar-add" accessibilityRole="button" accessibilityLabel={label} hitSlop={6} onPress={onPress} style={{ paddingHorizontal: 6, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color, fontSize: 18, lineHeight: 20 }}>+</Text>
    </Pressable>
  );
}
