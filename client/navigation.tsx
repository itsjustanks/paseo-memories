import React, { useState } from "react";
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { PLAIN } from "../shared/plain";
import { usePlain } from "./mode";
import { TABS, type SectionId } from "./tabs";
import { Bullets, Disclosure, HostIcon, IconBadge, TYPE, useTokens } from "./ui";

export { TABS, type SectionId };

/** About what one tab needs with its label (icon, name, padding); five need ~620 px. */
const LABELLED_TAB_WIDTH = 124;

/**
 * An underline tab bar in one row. When the labels do not fit (a phone, or a
 * half-width window, measured here), every tab shows its icon and the active
 * tab its label beside it, so nothing is cut off. Without app icons, the
 * labels scroll sideways instead.
 */
export function TabBar({ active, onSelect }: { active: SectionId; onSelect: (id: SectionId) => void }) {
  const t = useTokens();
  const plain = usePlain();
  const [width, setWidth] = useState<number | null>(null);
  const tight = t.compact || (width !== null && width < TABS.length * LABELLED_TAB_WIDTH);
  const iconsOnly = tight && Boolean(HostIcon);
  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next !== width) setWidth(next);
  };
  const items = TABS.map((tab) => {
    const selected = tab.id === active;
    const label = plain ? PLAIN.tabLabels[tab.id] : tab.label;
    const color = selected ? t.color.accent : t.color.muted;
    return (
      <Pressable
        key={tab.id}
        accessibilityRole="tab"
        accessibilityLabel={label}
        accessibilityState={{ selected }}
        // react-native-web 0.21 ignores accessibilityState; say it the web way too.
        aria-selected={selected}
        onPress={() => onSelect(tab.id)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          minHeight: 44,
          paddingHorizontal: t.compact ? 8 : 11,
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
            {label}
          </Text>
        ) : null}
      </Pressable>
    );
  });
  if (tight && !HostIcon) {
    // The rule sits on a wrapper: a horizontal ScrollView does not draw its own bottom border on the web.
    return (
      <View onLayout={onLayout} style={{ borderBottomWidth: 1, borderBottomColor: t.color.border }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" accessibilityLabel="Memories sections" style={{ flexGrow: 0 }}>
          {items}
        </ScrollView>
      </View>
    );
  }
  return (
    <View accessibilityRole="tablist" accessibilityLabel="Memories sections" onLayout={onLayout} style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: t.color.border }}>
      {items}
    </View>
  );
}

/**
 * The top of each tab: its icon, a clear title, one or two plain sentences on
 * what it is for, and "What you can do here". On a phone that list folds away
 * behind "Learn more", so the tab's own content stays near the top.
 */
export function TabIntro({ section, actions }: { section: SectionId; actions?: React.ReactNode }) {
  const t = useTokens();
  const plain = usePlain();
  const tab = TABS.find((entry) => entry.id === section)!;
  const intro = PLAIN.intros[section];
  const list = (
    <View style={{ gap: 10, padding: 14, borderRadius: 14, backgroundColor: t.color.surface1, borderWidth: 1, borderColor: t.color.border }}>
      {!t.compact ? <Text style={[t.text.caption, { fontWeight: "600" }]}>{PLAIN.whatYouCanDo}</Text> : null}
      <Bullets items={!plain && "canDo" in tab ? tab.canDo : intro.canDo} columns={!t.compact} />
    </View>
  );
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 14 }}>
        <IconBadge name={tab.icon} size={t.compact ? 40 : 46} />
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text accessibilityRole="header" style={t.text.display}>
            {plain ? intro.title : tab.title}
          </Text>
          <Text style={t.text.lead}>{plain ? intro.summary : tab.heading}</Text>
        </View>
      </View>
      {t.compact ? (
        <Disclosure key={section} title={PLAIN.learnMore} openTitle={PLAIN.hideMore}>
          {list}
        </Disclosure>
      ) : (
        list
      )}
      {actions ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>{actions}</View> : null}
    </View>
  );
}
