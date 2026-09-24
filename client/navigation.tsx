import * as HostRN from "@getpaseo/plugin/client/react-native";
import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { PLAIN } from "../shared/plain";
import { usePlain } from "./mode";
import { useTokens } from "./ui";

/**
 * Five sections, one job each, in one row. Icons are Lucide names drawn by the
 * Paseo app; `heading` is the one line under the bar saying what the section
 * is for. Copied from paseo-mcp 0.11.0 `client/navigation.tsx`.
 */
export const TABS = [
  { id: "overview", label: "Overview", icon: "LayoutDashboard", heading: "What your agents remember on this host, and the one thing to tidy next." },
  { id: "user", label: "User", icon: "User", heading: "Files every agent of yours reads, in every project: per agent and per account." },
  { id: "projects", label: "Projects", icon: "FolderCode", heading: "What each project adds: its instruction files and Claude's auto memory for it." },
  { id: "transfer", label: "Import & Export", icon: "ArrowLeftRight", heading: "Bring memories in from another agent or a file, or keep a copy out." },
  { id: "guide", label: "Guide", icon: "BookOpen", heading: "Where each agent keeps what it remembers, what loads when, and what is safe to edit." },
] as const;

export type SectionId = (typeof TABS)[number]["id"];

/** The app's icon component, when the host provides one; looked up at runtime so an app without it still renders the bar. */
const HostIcon = (HostRN as unknown as { Icon?: React.ComponentType<{ name: string; size?: number; color?: string }> }).Icon;

/**
 * An underline tab bar in one row. Narrow screens show every section's icon
 * and the active one's label beside its icon, so nothing is hidden. Without
 * app icons, the labels scroll sideways instead.
 */
export function TabBar({ active, onSelect }: { active: SectionId; onSelect: (id: SectionId) => void }) {
  const t = useTokens();
  const plain = usePlain();
  const iconsOnly = t.compact && Boolean(HostIcon);
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
          minHeight: t.compact ? 44 : 40,
          paddingHorizontal: t.compact ? 10 : 12,
          marginBottom: -1,
          borderBottomWidth: 2,
          borderBottomColor: selected ? t.color.accent : "transparent",
          opacity: pressed ? 0.7 : 1,
          ...(iconsOnly && !selected ? { flexGrow: 1 } : {}),
        })}
      >
        {HostIcon ? <HostIcon name={tab.icon} size={16} color={color} /> : null}
        {!iconsOnly || selected ? (
          <Text numberOfLines={1} style={{ color: selected ? t.color.accent : t.color.fg, fontSize: 13, fontWeight: selected ? "700" : "500" }}>
            {label}
          </Text>
        ) : null}
      </Pressable>
    );
  });
  const bar = { flexDirection: "row" as const, borderBottomWidth: 1, borderBottomColor: t.color.border };
  if (t.compact && !HostIcon) {
    // The rule sits on a wrapper: a horizontal ScrollView does not draw its own bottom border on the web.
    return (
      <View style={{ borderBottomWidth: 1, borderBottomColor: t.color.border }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" accessibilityLabel="Memories sections" style={{ flexGrow: 0 }}>
          {items}
        </ScrollView>
      </View>
    );
  }
  return (
    <View accessibilityRole="tablist" accessibilityLabel="Memories sections" style={bar}>
      {items}
    </View>
  );
}

/** One line under the tabs saying what the section is for. */
export function SectionHeading({ section }: { section: SectionId }) {
  const t = useTokens();
  const plain = usePlain();
  const tab = TABS.find((entry) => entry.id === section)!;
  return <Text style={[t.text.body, { color: t.color.muted, maxWidth: 760 }]}>{plain ? PLAIN.tabs[section] : tab.heading}</Text>;
}
