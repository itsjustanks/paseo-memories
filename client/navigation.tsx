import React, { useState } from "react";
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { PLAIN } from "../shared/plain";
import { usePlain } from "./mode";
import { TABS, type SectionId } from "./tabs";
import { HostIcon, TYPE, useTokens } from "./ui";

export { TABS, type SectionId };

/** About what one tab needs with its label (icon, name, padding); four need ~500 px. */
const LABELLED_TAB_WIDTH = 124;

export type TabDef<Id extends string> = { id: Id; icon: string; label: string };

/**
 * An underline tab bar in one row. When the labels do not fit (a phone, or a
 * half-width window, measured here), every tab shows its icon and the active
 * tab its label beside it, so nothing is cut off. Without app icons, the
 * labels scroll sideways instead.
 */
export function TabBarOf<Id extends string>({ tabs, active, onSelect, name }: { tabs: ReadonlyArray<TabDef<Id>>; active: Id; onSelect: (id: Id) => void; name: string }) {
  const t = useTokens();
  const [width, setWidth] = useState<number | null>(null);
  const tight = t.compact || (width !== null && width < tabs.length * LABELLED_TAB_WIDTH);
  const iconsOnly = tight && Boolean(HostIcon);
  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next !== width) setWidth(next);
  };
  const items = tabs.map((tab) => {
    const selected = tab.id === active;
    const color = selected ? t.color.accent : t.color.muted;
    return (
      <Pressable
        key={tab.id}
        accessibilityRole="tab"
        accessibilityLabel={tab.label}
        accessibilityState={{ selected }}
        // react-native-web 0.21 ignores accessibilityState; say it the web way too.
        aria-selected={selected}
        onPress={() => onSelect(tab.id)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: t.space.xs + t.space.hair,
          minHeight: 44,
          paddingHorizontal: t.compact ? t.space.sm : t.space.sm + t.space.hair,
          marginBottom: -1,
          borderBottomWidth: 2,
          borderBottomColor: selected ? t.color.accent : "transparent",
          opacity: pressed ? 0.7 : 1,
          ...(iconsOnly && !selected ? { flexGrow: 1 } : {}),
        })}
      >
        {HostIcon ? <HostIcon name={tab.icon} size={16} color={color} /> : null}
        {!iconsOnly || selected ? (
          <Text numberOfLines={1} style={{ ...TYPE.secondary, color: selected ? t.color.accent : t.color.fg, fontWeight: selected ? "700" : "500" }}>
            {tab.label}
          </Text>
        ) : null}
      </Pressable>
    );
  });
  if (tight && !HostIcon) {
    // The rule sits on a wrapper: a horizontal ScrollView does not draw its own bottom border on the web.
    return (
      <View onLayout={onLayout} style={{ borderBottomWidth: 1, borderBottomColor: t.color.border }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" accessibilityLabel={name} style={{ flexGrow: 0 }}>
          {items}
        </ScrollView>
      </View>
    );
  }
  return (
    <View accessibilityRole="tablist" accessibilityLabel={name} onLayout={onLayout} style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: t.color.border }}>
      {items}
    </View>
  );
}

export function TabBar({ active, onSelect }: { active: SectionId; onSelect: (id: SectionId) => void }) {
  const plain = usePlain();
  const tabs = TABS.map((tab) => ({ id: tab.id, icon: tab.icon, label: plain ? PLAIN.tabLabels[tab.id] : tab.label }));
  return <TabBarOf tabs={tabs} active={active} onSelect={onSelect} name="Memories sections" />;
}
