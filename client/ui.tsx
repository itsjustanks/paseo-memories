import type { PluginTheme } from "@getpaseo/plugin";
import * as HostRN from "@getpaseo/plugin/client/react-native";
import React, { createContext, useContext, useMemo, useState } from "react";
import { ActivityIndicator, Clipboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle } from "react-native";
import { middlePath } from "../shared/labels";

/**
 * The plugin's design system.
 *
 * Paseo hands each surface semantic colours, host-rendered icons and a compact
 * flag. Keep those host tokens as the source of truth so every theme and client
 * renders the same meaning.
 *
 * Two rules keep it honest:
 *   - one filled button per view; everything else is quieter than it,
 *   - nothing non-interactive gets a border, so a border means "you can press".
 */

// ------------------------------------------------------------------- colour

function parse(color: string): [number, number, number, number] | null {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim());
  if (hex) {
    const value = hex[1]!;
    const expand = (part: string) => parseInt(part.length === 1 ? part + part : part, 16);
    if (value.length === 3 || value.length === 4) {
      return [expand(value[0]!), expand(value[1]!), expand(value[2]!), value.length === 4 ? expand(value[3]!) / 255 : 1];
    }
    if (value.length === 6 || value.length === 8) {
      return [
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16),
        value.length === 8 ? parseInt(value.slice(6, 8), 16) / 255 : 1,
      ];
    }
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb) {
    const parts = rgb[1]!.split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((part) => Number.isFinite(part))) {
      return [parts[0]!, parts[1]!, parts[2]!, Number.isFinite(parts[3]!) ? parts[3]! : 1];
    }
  }
  return null;
}

/**
 * Translucent version of a colour. A colour this cannot parse is returned
 * unchanged on purpose: a solid border is a cosmetic flaw, and the string
 * concatenation this replaces produced an invisible one.
 */
export function alpha(color: string, amount: number): string {
  const parsed = parse(color);
  if (!parsed) return color;
  const [r, g, b, a] = parsed;
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.max(0, Math.min(1, a * amount))})`;
}

export function mix(base: string, over: string, amount: number): string {
  const one = parse(base);
  const two = parse(over);
  if (!one || !two) return base;
  const blend = (a: number, b: number) => Math.round(a + (b - a) * Math.max(0, Math.min(1, amount)));
  return `rgb(${blend(one[0], two[0])}, ${blend(one[1], two[1])}, ${blend(one[2], two[2])})`;
}

export function isDarkSurface(color: string): boolean {
  const parsed = parse(color);
  if (!parsed) return false;
  const [r, g, b] = parsed;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

// Older Paseo hosts did not supply success and warning colours. These remain
// compatibility fallbacks for a directory install opened by an older client.
const SUCCESS = { dark: "#3ecf8e", light: "#12855a" };
const WARNING = { dark: "#e0a33e", light: "#a16207" };

// ------------------------------------------------------------------ wrapping

/**
 * Long unbroken text (paths, URLs, hashes, code) breaks anywhere on the web.
 * The browser's default `break-word` still counts the whole token as the
 * text's narrowest width, so one path could set the width of the page. Native
 * Text already breaks such tokens, so this is web-only.
 */
export const wrapAnywhere = (Platform.OS === "web" ? { overflowWrap: "anywhere", wordBreak: "break-word" } : {}) as TextStyle;

// ---------------------------------------------------------------------- type

/**
 * One type scale for every view, the same as the other Paseo plugins (AI
 * Router's `TYPE`): nothing below 13 px, body text at 15, secondary at 14,
 * section titles at 17, tab titles at 20, the page title at 22 and headline
 * numbers at 26. Views use it through `t.text.*`.
 */
export const TYPE = {
  page: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  tabTitle: { fontSize: 20, lineHeight: 26, fontWeight: "700" },
  section: { fontSize: 17, lineHeight: 23, fontWeight: "600" },
  lead: { fontSize: 16, lineHeight: 24 },
  item: { fontSize: 15, lineHeight: 21, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 22 },
  secondary: { fontSize: 14, lineHeight: 20 },
  small: { fontSize: 13, lineHeight: 18 },
  mono: { fontSize: 13, lineHeight: 19, fontFamily: "monospace" },
  /** A headline number. */
  figure: { fontSize: 26, lineHeight: 32, fontWeight: "700" },
} as const;

/**
 * One spacing scale for every view (the shared design standard, AI Router
 * 0.15.0 `SPACE`): `section` between cards, `card` inside them, `md` the
 * narrow page's side padding and a button's, `row` between the lines of a
 * card, `sm`/`xs`/`hair` for tight pairs. Views use these names through
 * `t.space.*`, never raw numbers.
 */
export const SPACE = { hair: 2, xs: 4, sm: 8, row: 12, md: 16, card: 20, section: 24 } as const;
export const RADIUS = { card: 16, control: 10, pill: 999 } as const;

/** The app's icon component (Lucide names), when the host provides one; looked up at runtime so an app without it still renders. */
export const HostIcon = (HostRN as unknown as { Icon?: React.ComponentType<{ name: string; size?: number; color?: string }> }).Icon;

// -------------------------------------------------------------------- tokens

export type Tokens = ReturnType<typeof tokens>;

export function tokens(theme: PluginTheme, compact: boolean) {
  const dark = isDarkSurface(theme.colors.surface0);
  const ink = dark ? "#ffffff" : "#000000";
  const colors = theme.colors as PluginTheme["colors"] & Partial<{
    surface1: string;
    surface2: string;
    border: string;
    statusSuccess: string;
    statusWarning: string;
  }>;
  const fg = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const accent = theme.colors.accent;
  const danger = theme.colors.statusDanger;
  const success = colors.statusSuccess || (dark ? SUCCESS.dark : SUCCESS.light);
  const warning = colors.statusWarning || (dark ? WARNING.dark : WARNING.light);
  const mono = compact ? "monospace" : "Menlo";

  return {
    compact,
    dark,
    color: {
      fg,
      muted,
      accent,
      accentFg: theme.colors.accentForeground,
      danger,
      success,
      warning,
      // Native semantic surfaces on Paseo 0.7+, with compatible derivation for
      // older hosts. Never nest one inside another of the same level.
      surface0: theme.colors.surface0,
      surface1: colors.surface1 || mix(theme.colors.surface0, ink, dark ? 0.05 : 0.03),
      surface2: colors.surface2 || mix(theme.colors.surface0, ink, dark ? 0.09 : 0.06),
      borderSubtle: alpha(muted, 0.14),
      border: colors.border || alpha(muted, 0.24),
      borderStrong: alpha(muted, 0.4),
      accentWash: alpha(accent, 0.14),
      accentSoft: alpha(accent, 0.07),
      accentLine: alpha(accent, 0.45),
      dangerWash: alpha(danger, 0.14),
      dangerLine: alpha(danger, 0.45),
      successWash: alpha(success, 0.14),
      warningWash: alpha(warning, 0.14),
      disabled: alpha(fg, 0.38),
      // Placeholder text is load-bearing (often the field's only label), so it
      // sits above the disabled tint contrast-wise without shouting.
      placeholder: alpha(fg, 0.5),
    },
    // The shared scale. Body notes use the full text colour; muted grey is
    // only for hints, times and paths (`caption`).
    text: {
      page: { ...TYPE.page, color: fg, ...wrapAnywhere },
      display: { ...TYPE.tabTitle, color: fg, ...wrapAnywhere },
      section: { ...TYPE.section, color: fg, ...wrapAnywhere },
      lead: { ...TYPE.lead, color: fg, ...wrapAnywhere },
      value: { ...TYPE.figure, color: fg, ...wrapAnywhere },
      heading: { ...TYPE.item, color: fg, ...wrapAnywhere },
      body: { ...TYPE.body, fontWeight: "400" as const, color: fg, ...wrapAnywhere },
      bodyStrong: { ...TYPE.body, fontWeight: "600" as const, color: fg, ...wrapAnywhere },
      label: { ...TYPE.secondary, fontWeight: "600" as const, color: fg, ...wrapAnywhere },
      caption: { ...TYPE.secondary, fontWeight: "400" as const, color: muted, ...wrapAnywhere },
      small: { ...TYPE.small, fontWeight: "600" as const, color: muted, ...wrapAnywhere },
      mono: { ...TYPE.mono, fontFamily: mono, color: fg, ...wrapAnywhere },
    },
    space: SPACE,
    radius: RADIUS,
    control: { min: compact ? 44 : 40, hit: { top: 6, bottom: 6, left: 6, right: 6 } },
    /** The page width every plugin uses on a wide screen. */
    maxWidth: 980,
  };
}

const TokensContext = createContext<Tokens | null>(null);

export function TokensProvider({ value, children }: { value: Tokens; children: React.ReactNode }) {
  return <TokensContext.Provider value={value}>{children}</TokensContext.Provider>;
}

export function useTokens(): Tokens {
  const value = useContext(TokensContext);
  if (!value) throw new Error("useTokens must be used inside a Screen");
  return value;
}

export function useUi(theme: PluginTheme, compact: boolean): Tokens {
  return useMemo(() => tokens(theme, compact), [theme, compact]);
}

// ---------------------------------------------------------------- status map

export type Status = "ok" | "attention" | "error" | "neutral" | "busy";

export function statusColor(t: Tokens, status: Status): string {
  if (status === "ok") return t.color.success;
  if (status === "attention") return t.color.warning;
  if (status === "error") return t.color.danger;
  if (status === "busy") return t.color.accent;
  return t.color.muted;
}

// ----------------------------------------------------------------- structure

export function Screen({
  t,
  children,
  scroll = true,
  paddingTop,
}: {
  t: Tokens;
  children: React.ReactNode;
  scroll?: boolean;
  /** A header rendered above the scroll area already carries the top padding. */
  paddingTop?: number;
}) {
  const pad = t.compact ? SPACE.md : SPACE.section;
  const body = (
    <View style={{ maxWidth: t.maxWidth, width: "100%", alignSelf: "center", gap: t.space.section }}>{children}</View>
  );
  return (
    <TokensProvider value={t}>
      {scroll ? (
        <ScrollView
          style={{ flex: 1, backgroundColor: t.color.surface0 }}
          contentContainerStyle={{ padding: pad, paddingTop: paddingTop ?? pad, paddingBottom: SPACE.section * 2 }}
        >
          {body}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, backgroundColor: t.color.surface0, padding: pad, paddingTop: paddingTop ?? pad }}>{body}</View>
      )}
    </TokensProvider>
  );
}

/** A soft circle with an icon in it: the visual anchor of headers, cards and steps. Nothing without the app's icons. */
export function IconBadge({ name, tone = "accent", size = 32 }: { name: string; tone?: Status | "accent"; size?: number }) {
  const t = useTokens();
  if (!HostIcon) return null;
  const color = tone === "accent" ? t.color.accent : statusColor(t, tone);
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: alpha(color, 0.14), alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <HostIcon name={name} size={Math.round(size * 0.5)} color={color} />
    </View>
  );
}

/** A status as an icon colour: the accent unless it says something (ok, attention, error). */
function badgeTone(tone: Status | undefined): Status | "accent" {
  return tone && tone !== "neutral" && tone !== "busy" ? tone : "accent";
}

/** A small dot in a status colour, beside words that say the same thing. */
export function Dot({ status }: { status: Status }) {
  const t = useTokens();
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusColor(t, status), flexShrink: 0 }} />;
}

/**
 * The page header every plugin shares: the plugin's icon and name, one line
 * of status beside a coloured dot, and the page's own actions on the right.
 */
export function Header({ title, icon = "Brain", status, caption, trailing, panel }: { title: string; icon?: string; status?: Status; caption: string; trailing?: React.ReactNode; /** A side panel: the title a step smaller. */ panel?: boolean }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.row }}>
      <IconBadge name={icon} size={panel ? 36 : t.compact ? 40 : 46} />
      <View style={{ flex: 1, minWidth: 0, gap: SPACE.hair }}>
        <Text accessibilityRole="header" style={panel ? t.text.display : t.text.page}>
          {title}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
          {status ? <Dot status={status} /> : null}
          <Text style={[t.text.caption, { flexShrink: 1 }]}>{caption}</Text>
        </View>
      </View>
      {trailing ? <View style={{ flexShrink: 0 }}>{trailing}</View> : null}
    </View>
  );
}

/** A heading over a group, with an optional icon and something on the right (a count, an action). */
export function Section({ title, icon, trailing, children }: { title?: string; icon?: string; trailing?: React.ReactNode; children: React.ReactNode }) {
  const t = useTokens();
  return (
    <View style={{ gap: t.space.sm }}>
      {title ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
          {icon ? <IconBadge name={icon} size={28} /> : null}
          <Text style={[t.text.section, { flex: 1, minWidth: 0 }]}>{title}</Text>
          {trailing}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/**
 * A card. With `title` it gets a header (icon, title, subtitle, something on
 * the right). Unpadded cards hold a list of Rows, which bring their own
 * padding and dividers; their header keeps its padding.
 */
export function Card({
  children,
  level = 1,
  padded = true,
  tone,
  title,
  icon,
  iconTone,
  subtitle,
  trailing,
}: {
  children: React.ReactNode;
  level?: 1 | 2;
  padded?: boolean;
  /** Tints the card's edge, for a card whose whole content is in that state. */
  tone?: Status;
  title?: string;
  /** The header icon's colour, when it says a state without tinting the whole card. */
  iconTone?: Status;
  icon?: string;
  subtitle?: string;
  trailing?: React.ReactNode;
}) {
  const t = useTokens();
  const pad = SPACE.card;
  const header = title ? (
    <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.row, ...(padded ? {} : { padding: pad, borderBottomWidth: 1, borderBottomColor: t.color.borderSubtle }) }}>
      {icon ? <IconBadge name={icon} tone={badgeTone(iconTone ?? tone)} size={34} /> : null}
      <View style={{ flex: 1, minWidth: 0, gap: SPACE.hair }}>
        <Text style={t.text.section}>{title}</Text>
        {subtitle ? <Text style={t.text.caption}>{subtitle}</Text> : null}
      </View>
      {trailing}
    </View>
  ) : null;
  return (
    <View
      style={{
        backgroundColor: level === 1 ? t.color.surface1 : t.color.surface2,
        borderRadius: t.radius.card,
        borderWidth: 1,
        borderColor: tone ? alpha(statusColor(t, tone), 0.4) : t.color.border,
        padding: padded ? pad : 0,
        // An unpadded card holds a list of Rows, which bring their own padding and dividers.
        gap: padded ? 14 : 0,
        overflow: "hidden",
      }}
    >
      {header}
      {children}
    </View>
  );
}

/**
 * The big status card at the top of the Overview: a tinted band with an icon
 * and the state in words, then the details and actions. Neutral uses the
 * accent, so "checking" does not read as a warning.
 */
export function HeroCard({ tone, icon, title, lead, children }: { tone: Status; icon: string; title: string; lead?: React.ReactNode; children?: React.ReactNode }) {
  const t = useTokens();
  const color = tone === "neutral" || tone === "busy" ? t.color.accent : statusColor(t, tone);
  const pad = SPACE.card;
  return (
    <View style={{ backgroundColor: t.color.surface1, borderColor: alpha(color, 0.4), borderWidth: 1, borderRadius: RADIUS.card, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.md, padding: pad, backgroundColor: alpha(color, 0.09) }}>
        <IconBadge name={icon} tone={tone === "neutral" || tone === "busy" ? "accent" : tone} size={t.compact ? 44 : 52} />
        <View style={{ flex: 1, minWidth: 0, gap: SPACE.xs }}>
          <Text accessibilityRole="header" style={[t.text.display, tone === "error" ? { color } : null]}>
            {title}
          </Text>
          {lead ? <Text style={t.text.body}>{lead}</Text> : null}
        </View>
      </View>
      {children ? <View style={{ padding: pad, gap: t.space.row }}>{children}</View> : null}
    </View>
  );
}

/** Short lines, each with a check mark in the accent colour; two across when `columns` and there is room. */
export function Bullets({ items, columns, icon = "Check" }: { items: readonly string[]; columns?: boolean; icon?: string }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: columns ? "row" : "column", flexWrap: columns ? "wrap" : "nowrap", columnGap: SPACE.card, rowGap: t.space.sm }}>
      {items.map((line) => (
        <View key={line} style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.sm + SPACE.hair, ...(columns ? { flexBasis: "45%", minWidth: 240, flexGrow: 1, flexShrink: 1 } : {}) }}>
          {HostIcon ? (
            <View style={{ paddingTop: SPACE.hair }}>
              <HostIcon name={icon} size={16} color={t.color.accent} />
            </View>
          ) : (
            <Text style={[t.text.body, { color: t.color.accent }]}>•</Text>
          )}
          <Text style={[t.text.body, { flex: 1, minWidth: 0 }]}>{line}</Text>
        </View>
      ))}
    </View>
  );
}

/** A numbered step: a filled circle with the number, then the words. */
export function NumberedStep({ n, children }: { n: number; children: React.ReactNode }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: t.space.row }}>
      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: t.color.accent, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Text style={{ ...TYPE.secondary, color: t.color.accentFg, fontWeight: "700" }}>{n}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: SPACE.hair, paddingTop: SPACE.hair }}>{typeof children === "string" ? <Text style={t.text.body}>{children}</Text> : children}</View>
    </View>
  );
}

/** A thin rule between the parts of a card. */
export function Divider() {
  const t = useTokens();
  return <View style={{ height: 1, backgroundColor: t.color.border }} />;
}

/**
 * One line of a list. Slotted rather than positional, and deliberately without
 * flexWrap: a wrapping row is what pushes an action button off screen the
 * moment an account email gets long.
 */
export function Row({
  leading,
  title,
  subtitle,
  meta,
  trailing,
  expanded,
  onPress,
  tone,
  selected,
  first,
}: {
  leading?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  meta?: React.ReactNode;
  trailing?: React.ReactNode;
  expanded?: React.ReactNode;
  onPress?: () => void;
  tone?: Status;
  selected?: boolean;
  first?: boolean;
}) {
  const t = useTokens();
  const body = (
    <View style={{ gap: t.space.sm }}>
      <View style={{ flexDirection: t.compact ? "column" : "row", alignItems: t.compact ? "stretch" : "center", gap: t.space.sm }}>
        {leading ? <View style={{ flexShrink: 0 }}>{leading}</View> : null}
        <View style={{ flex: 1, minWidth: 0, gap: SPACE.hair }}>
          {typeof title === "string" ? (
            <Text numberOfLines={1} style={t.text.bodyStrong}>
              {title}
            </Text>
          ) : (
            title
          )}
          {typeof subtitle === "string" ? (
            <Text numberOfLines={1} style={t.text.caption}>
              {subtitle}
            </Text>
          ) : (
            subtitle
          )}
          {meta}
        </View>
        {trailing ? (
          <View
            style={{
              flexDirection: "row",
              gap: t.space.sm,
              flexShrink: 0,
              justifyContent: t.compact ? "flex-start" : "flex-end",
            }}
          >
            {trailing}
          </View>
        ) : null}
      </View>
      {expanded}
    </View>
  );

  const style = {
    paddingVertical: t.space.row,
    paddingHorizontal: t.compact ? t.space.row : t.space.md,
    borderTopWidth: first ? 0 : 1,
    borderTopColor: t.color.borderSubtle,
    borderLeftWidth: tone ? 3 : 0,
    borderLeftColor: tone ? statusColor(t, tone) : "transparent",
    backgroundColor: selected ? t.color.accentWash : "transparent",
  };

  if (!onPress) return <View style={style}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={onPress}
      style={({ pressed }) => [style, pressed ? { backgroundColor: alpha(t.color.muted, 0.1) } : null]}
    >
      {body}
    </Pressable>
  );
}

/** Up to three short facts, dot-separated — replaces long grey sentences. */
export function Facts({ items }: { items: Array<{ value: string; tone?: Status } | null | undefined> }) {
  const t = useTokens();
  const list = items.filter(Boolean) as Array<{ value: string; tone?: Status }>;
  if (list.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACE.xs + SPACE.hair }}>
      {list.map((item, index) => (
        <React.Fragment key={`${item.value}-${index}`}>
          {index > 0 ? <Text style={[t.text.caption, { opacity: 0.5 }]}>·</Text> : null}
          <Text style={[t.text.caption, { flexShrink: 1 }, item.tone ? { color: statusColor(t, item.tone), fontWeight: "600" } : null]}>{item.value}</Text>
        </React.Fragment>
      ))}
    </View>
  );
}

// ------------------------------------------------------------------- atoms

/** A small pill: a short state or count. Toned pills get a soft fill and a tinted edge. */
export function Tag({ label, tone }: { label: string; tone?: Status }) {
  const t = useTokens();
  const color = tone && tone !== "neutral" ? statusColor(t, tone) : t.color.muted;
  return (
    <View
      style={{
        backgroundColor: tone && tone !== "neutral" ? alpha(color, 0.1) : t.color.surface2,
        borderColor: tone && tone !== "neutral" ? alpha(color, 0.55) : t.color.border,
        borderWidth: 1,
        borderRadius: t.radius.pill,
        paddingVertical: SPACE.hair,
        paddingHorizontal: SPACE.sm + SPACE.hair,
        flexShrink: 1,
        minWidth: 0,
      }}
    >
      <Text style={[{ ...TYPE.small, fontWeight: "600", color: tone && tone !== "neutral" ? color : t.color.fg }, wrapAnywhere]}>{label}</Text>
    </View>
  );
}

/**
 * One line of an at-a-glance list: what it is, its state as a pill, a short
 * hint, and a link to where it is dealt with.
 */
export function StatusLine({ label, value, status, hint, action }: { label: string; value: string; status: Status; hint?: string | null; action?: { label: string; onPress: () => void } | null }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: SPACE.sm + SPACE.hair, rowGap: SPACE.xs, paddingVertical: SPACE.hair }}>
      <Text style={[t.text.body, { fontWeight: "500", width: t.compact ? "100%" : 220 }]}>{label}</Text>
      <Tag label={value} tone={status} />
      {hint ? <Text style={[t.text.caption, { flexShrink: 1 }]}>{hint}</Text> : null}
      {action ? (
        <Pressable accessibilityRole="link" accessibilityLabel={action.label} onPress={action.onPress} hitSlop={t.control.hit}>
          <Text style={[t.text.caption, { color: t.color.accent, fontWeight: "600" }]}>{`${action.label} →`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** `quiet-danger`: a text link in the danger colour, for a destructive action that sits beside everyday ones. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "quiet-danger";

export function Button({
  label,
  onPress,
  variant = "secondary",
  disabled,
  loading,
  grow,
  icon,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  grow?: boolean;
  /** A Lucide icon name, drawn before the label when the app has icons. */
  icon?: string;
}) {
  const t = useTokens();
  const off = Boolean(disabled) || Boolean(loading);
  const palette = {
    primary: { bg: t.color.accent, border: t.color.accent, fg: t.color.accentFg },
    secondary: { bg: t.color.surface2, border: t.color.border, fg: t.color.fg },
    ghost: { bg: "transparent", border: "transparent", fg: t.color.accent },
    danger: { bg: t.color.dangerWash, border: t.color.dangerLine, fg: t.color.danger },
    "quiet-danger": { bg: "transparent", border: "transparent", fg: t.color.danger },
  }[variant];
  const quiet = variant === "ghost" || variant === "quiet-danger";
  const ink = off ? t.color.disabled : palette.fg;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy: Boolean(loading) }}
      onPress={onPress}
      disabled={off}
      hitSlop={t.control.hit}
      style={({ pressed }) => ({
        flexGrow: grow ? 1 : 0,
        // A long label wraps inside the button instead of pushing past the edge.
        flexShrink: 1,
        minWidth: 0,
        maxWidth: "100%",
        minHeight: t.control.min,
        paddingHorizontal: quiet ? 8 : 14,
        paddingVertical: quiet ? 4 : 8,
        borderRadius: RADIUS.control,
        borderWidth: 1,
        borderColor: off && !quiet ? t.color.borderSubtle : palette.border,
        backgroundColor: off && variant === "primary" ? alpha(t.color.accent, 0.25) : palette.bg,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: SPACE.sm,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {loading ? <ActivityIndicator size="small" color={ink} /> : icon && HostIcon ? <HostIcon name={icon} size={16} color={ink} /> : null}
      <Text style={[{ ...TYPE.body, fontWeight: "600", color: ink, flexShrink: 1, textAlign: "center" }, wrapAnywhere]}>{label}</Text>
    </Pressable>
  );
}

/** A quiet text action in the accent colour, for "Open the Guide" style links. */
export function Link({ label, onPress, accessibilityLabel }: { label: string; onPress: () => void; accessibilityLabel?: string }) {
  const t = useTokens();
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={accessibilityLabel ?? label} onPress={onPress} hitSlop={t.control.hit} style={{ paddingVertical: SPACE.xs, alignSelf: "flex-start" }}>
      <Text style={[t.text.body, { color: t.color.accent, fontWeight: "600" }]}>{label}</Text>
    </Pressable>
  );
}

/** An on/off switch with its state in a word as well as a position, so colour is never the only channel. */
export function Toggle({
  value,
  onChange,
  disabled,
  loading,
  label,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  loading?: boolean;
  label: string;
}) {
  const t = useTokens();
  const off = Boolean(disabled) || Boolean(loading);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: off, busy: Boolean(loading) }}
      // react-native-web maps accessibilityState.checked inconsistently across versions; say it plainly too.
      {...({ "aria-checked": value } as object)}
      disabled={off}
      hitSlop={t.control.hit}
      onPress={() => onChange(!value)}
      style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, minHeight: t.control.min, opacity: off ? 0.6 : 1 }}
    >
      <View
        style={{
          width: 44,
          height: 26,
          borderRadius: 13,
          padding: SPACE.hair,
          backgroundColor: value ? t.color.accent : t.color.surface2,
          borderWidth: 1,
          borderColor: value ? t.color.accent : t.color.border,
          alignItems: value ? "flex-end" : "flex-start",
          justifyContent: "center",
        }}
      >
        <View style={{ width: 20, height: 20, borderRadius: RADIUS.control, backgroundColor: value ? t.color.accentFg : t.color.muted }} />
      </View>
      {loading ? <ActivityIndicator size="small" color={t.color.muted} /> : <Text style={[t.text.caption, { fontWeight: "600", color: value ? t.color.accent : t.color.muted }]}>{value ? "on" : "off"}</Text>}
    </Pressable>
  );
}

/** A destructive action asks once, in place, rather than through a dialog. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  variant = "danger",
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  variant?: ButtonVariant;
}) {
  const t = useTokens();
  const [armed, setArmed] = useState(false);
  if (!armed) return <Button label={label} variant={variant} onPress={() => setArmed(true)} />;
  return (
    <View style={{ flexDirection: "row", gap: t.space.sm, flexWrap: "wrap" }}>
      <Button
        label={confirmLabel}
        variant="danger"
        onPress={() => {
          setArmed(false);
          onConfirm();
        }}
      />
      <Button label="Cancel" variant="ghost" onPress={() => setArmed(false)} />
    </View>
  );
}

/**
 * A quiet text link in the danger colour; pressed, it asks `question` in the
 * row and only acts on "yes". For Remove beside Change on every card.
 */
export function ConfirmLink({ label, question, yes, no = "Keep it", onConfirm }: { label: string; question: string; yes: string; no?: string; onConfirm: () => void }) {
  const t = useTokens();
  const [armed, setArmed] = useState(false);
  if (!armed) return <Button label={label} variant="quiet-danger" onPress={() => setArmed(true)} />;
  return (
    <View style={{ flexBasis: "100%", gap: t.space.sm, paddingTop: t.space.xs }}>
      <Text style={t.text.body}>{question}</Text>
      <View style={{ flexDirection: "row", gap: t.space.sm, flexWrap: "wrap" }}>
        <Button
          label={yes}
          variant="danger"
          onPress={() => {
            setArmed(false);
            onConfirm();
          }}
        />
        <Button label={no} variant="ghost" onPress={() => setArmed(false)} />
      </View>
    </View>
  );
}

/** Filter pills (0.5.1, as Connectors and Hosts): one row of rounded chips, the chosen one tinted. For filters; Segmented stays for switches inside a form. */
export function Pills<T extends string>({ options, value, onChange, label }: { options: ReadonlyArray<{ value: T; label: string }>; value: T; onChange: (value: T) => void; label?: string }) {
  const t = useTokens();
  return (
    <View accessibilityRole="radiogroup" {...(label ? { accessibilityLabel: label } : {})} style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active, checked: active }}
            {...({ "aria-checked": active } as object)}
            onPress={() => onChange(option.value)}
            hitSlop={t.control.hit}
            style={{
              minHeight: t.compact ? 40 : 34,
              justifyContent: "center",
              paddingHorizontal: t.space.row,
              borderRadius: t.radius.pill,
              borderWidth: 1,
              borderColor: active ? t.color.accentLine : t.color.border,
              backgroundColor: active ? t.color.accentWash : "transparent",
            }}
          >
            <Text style={{ ...TYPE.secondary, fontWeight: "600", color: active ? t.color.accent : t.color.fg }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const t = useTokens();
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        backgroundColor: t.color.surface2,
        borderRadius: RADIUS.control,
        padding: SPACE.hair,
        alignSelf: "flex-start",
        maxWidth: "100%",
        flexShrink: 1,
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active, disabled: Boolean(option.disabled) }}
            disabled={option.disabled}
            onPress={() => onChange(option.value)}
            hitSlop={t.control.hit}
            style={{
              paddingVertical: SPACE.xs + SPACE.hair,
              paddingHorizontal: SPACE.row,
              minHeight: t.control.min - 6,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: RADIUS.control,
              backgroundColor: active ? t.color.surface0 : "transparent",
              borderWidth: 1,
              borderColor: active ? t.color.border : "transparent",
              flexShrink: 1,
              minWidth: 0,
            }}
          >
            <Text
              style={[
                {
                  ...TYPE.secondary,
                  fontWeight: "600",
                  textAlign: "center",
                  color: option.disabled ? t.color.disabled : active ? t.color.fg : t.color.muted,
                },
                wrapAnywhere,
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  multiline,
  mono,
  minHeight,
  autoFocus,
  hint,
}: {
  label?: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
  minHeight?: number;
  autoFocus?: boolean;
  hint?: string;
}) {
  const t = useTokens();
  return (
    <View style={{ gap: SPACE.xs + SPACE.hair }}>
      {label ? <Text style={t.text.label}>{label}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.color.placeholder}
        accessibilityLabel={label ?? placeholder}
        multiline={multiline}
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        style={{
          borderWidth: 1,
          borderColor: t.color.border,
          borderRadius: RADIUS.control,
          backgroundColor: t.color.surface0,
          paddingVertical: SPACE.sm + SPACE.hair,
          paddingHorizontal: SPACE.row,
          color: t.color.fg,
          minHeight: minHeight ?? (multiline ? 120 : t.control.min),
          textAlignVertical: multiline ? "top" : "center",
          ...(mono ? { fontFamily: t.text.mono.fontFamily, fontSize: TYPE.mono.fontSize, lineHeight: TYPE.mono.lineHeight } : { fontSize: TYPE.body.fontSize }),
          // Soft-wrap long lines in the editor; a textarea would otherwise scroll sideways on some engines.
          ...(multiline ? { ...wrapAnywhere, ...(Platform.OS === "web" ? ({ whiteSpace: "pre-wrap" } as object) : {}) } : {}),
        }}
      />
      {hint ? <Text style={t.text.caption}>{hint}</Text> : null}
    </View>
  );
}

export function ComboBox({
  label,
  value,
  onChange,
  options,
  placeholder,
  hint,
  allowCustom = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; description?: string; disabled?: boolean }>;
  placeholder?: string;
  hint?: string;
  allowCustom?: boolean;
}) {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const known = options.some((option) => option.value === value);
  const query = known ? "" : value.trim().toLowerCase();
  const matches = options
    .filter((option) => !query || option.value.toLowerCase().includes(query) || option.label.toLowerCase().includes(query))
    .slice(0, 12);
  return (
    <View style={{ gap: SPACE.xs + SPACE.hair }}>
      <Text style={t.text.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={(next) => {
          onChange(next);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => globalThis.setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        placeholderTextColor={t.color.placeholder}
        accessibilityLabel={label}
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        style={{
          borderWidth: 1,
          borderColor: !allowCustom && value && !known ? t.color.danger : t.color.border,
          borderRadius: RADIUS.control,
          backgroundColor: t.color.surface0,
          paddingVertical: SPACE.sm + SPACE.hair,
          paddingHorizontal: SPACE.row,
          color: t.color.fg,
          minHeight: t.control.min,
          fontFamily: t.text.mono.fontFamily,
          fontSize: TYPE.mono.fontSize,
        }}
      />
      {open && matches.length > 0 ? (
        <View style={{ backgroundColor: t.color.surface2, borderRadius: RADIUS.control, overflow: "hidden" }}>
          {matches.map((option, index) => (
            <Pressable
              key={option.value}
              disabled={option.disabled}
              onPress={() => {
                onChange(option.value);
                setOpen(false);
              }}
              style={({ pressed }) => ({
                paddingVertical: SPACE.sm + SPACE.hair,
                paddingHorizontal: SPACE.row,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopColor: t.color.borderSubtle,
                backgroundColor: pressed ? t.color.accentWash : option.value === value ? t.color.surface0 : "transparent",
                opacity: option.disabled ? 0.45 : 1,
              })}
            >
              <Text style={t.text.bodyStrong}>{option.label}</Text>
              <Text style={t.text.caption}>{option.description ? `${option.value} · ${option.description}` : option.value}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {!allowCustom && value && !known ? <Text style={[t.text.caption, { color: t.color.danger }]}>Choose a listed value.</Text> : hint ? <Text style={t.text.caption}>{hint}</Text> : null}
    </View>
  );
}

/**
 * No RPC copies arbitrary text, so this goes through the host's clipboard —
 * which a host is free not to have. The caller says so rather than pretending
 * the copy happened; the text stays selectable either way.
 */
export function copyToClipboard(text: string): boolean {
  try {
    Clipboard.setString(text);
    return true;
  } catch {
    return false;
  }
}

/** "Copy" as a small link that says "Copied" for a moment; nothing when the host has no clipboard. */
export function CopyLink({ text, label = "Copy" }: { text: string; label?: string }) {
  const t = useTokens();
  const [copied, setCopied] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? "Copied to clipboard" : `${label} to clipboard`}
      hitSlop={t.control.hit}
      style={{ flexShrink: 0 }}
      onPress={() => {
        if (!copyToClipboard(text)) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <Text style={[t.text.caption, { fontWeight: "600", color: copied ? t.color.success : t.color.accent }]}>{copied ? "Copied" : label}</Text>
    </Pressable>
  );
}

/** Long lines wrap (the mono token breaks anywhere); nothing scrolls sideways. */
export function CodeBlock({ children, tone, copy = true }: { children: string; tone?: Status; copy?: boolean }) {
  const t = useTokens();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: t.space.sm,
        backgroundColor: t.color.surface2,
        borderRadius: RADIUS.control,
        borderLeftWidth: tone ? 3 : 0,
        borderLeftColor: tone ? statusColor(t, tone) : "transparent",
        padding: t.space.row,
      }}
    >
      <Text selectable style={[t.text.mono, { flex: 1, minWidth: 0 }]}>
        {children}
      </Text>
      {copy ? <CopyLink text={children} /> : null}
    </View>
  );
}

/**
 * A path on one line, cut in the middle so its start and its file name both
 * show (`~/…/acme-web/CLAUDE.md`), sized to the room it has. Screen readers
 * get the whole path. `full` is for where the path is the point: all of it,
 * wrapped, selectable, with a Copy link.
 */
export function PathText({ path, style, full }: { path: string; style?: StyleProp<TextStyle>; full?: boolean }) {
  const t = useTokens();
  const [width, setWidth] = useState(0);
  if (full) {
    return (
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: t.space.sm, minWidth: 0 }}>
        <Text selectable style={[t.text.mono, { color: t.color.muted, flex: 1, minWidth: 0 }, style]}>
          {path}
        </Text>
        <CopyLink text={path} label="Copy path" />
      </View>
    );
  }
  const flat = StyleSheet.flatten([t.text.caption, style]);
  const mono = /mono|menlo|courier/i.test(String(flat.fontFamily ?? ""));
  // A rough character width: enough to pick how much to cut; the one-line clip catches the rest.
  const perChar = (flat.fontSize ?? 14) * (mono ? 0.62 : 0.55);
  const max = width > 0 ? Math.max(16, Math.floor(width / perChar)) : 48;
  return (
    <View style={{ minWidth: 0, alignSelf: "stretch" }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <Text numberOfLines={1} accessibilityLabel={path} style={[t.text.caption, style]}>
        {middlePath(path, max)}
      </Text>
    </View>
  );
}

const NOTICE_ICON: Record<Status, string> = { ok: "CircleCheck", attention: "TriangleAlert", error: "CircleAlert", neutral: "Info", busy: "Loader" };

/** A sentence that needs noticing, on a soft fill of its tone with an icon. Neutral uses the accent. */
export function Notice({
  tone = "neutral",
  children,
  onDismiss,
}: {
  tone?: Status;
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  const t = useTokens();
  const color = tone === "neutral" ? t.color.accent : statusColor(t, tone);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: SPACE.sm + SPACE.hair,
        backgroundColor: alpha(color, 0.08),
        borderRadius: t.radius.control,
        borderWidth: 1,
        borderColor: alpha(color, 0.3),
        paddingVertical: t.space.row,
        paddingHorizontal: t.space.row,
      }}
    >
      {HostIcon ? (
        <View style={{ paddingTop: SPACE.hair }}>
          <HostIcon name={NOTICE_ICON[tone]} size={16} color={color} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>{typeof children === "string" ? <Text style={t.text.body}>{children}</Text> : children}</View>
      {onDismiss ? <Button label="Dismiss" variant="ghost" onPress={onDismiss} /> : null}
    </View>
  );
}

export function EmptyState({ title, body, action, icon = "Inbox" }: { title: string; body: string; action?: React.ReactNode; icon?: string }) {
  const t = useTokens();
  return (
    <View style={{ padding: t.space.section, gap: t.space.row, alignItems: "flex-start", backgroundColor: t.color.surface1, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.color.border }}>
      <IconBadge name={icon} size={40} />
      <Text style={t.text.section}>{title}</Text>
      <Text style={[t.text.body, { maxWidth: 560 }]}>{body}</Text>
      {action ? <View style={{ paddingTop: t.space.xs }}>{action}</View> : null}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, padding: t.space.row }}>
      <ActivityIndicator size="small" color={t.color.accent} />
      {label ? <Text style={t.text.caption}>{label}</Text> : null}
    </View>
  );
}

export function ErrorText({ children }: { children: string }) {
  const t = useTokens();
  return <Text style={[t.text.body, { color: t.color.danger }]}>{children}</Text>;
}

/**
 * A refresh failed but an earlier answer is on screen: say so above it, with
 * the time that answer was read and why the new one failed, instead of
 * replacing the content with an error.
 */
export function StaleNote({ what, at, reason, onRetry }: { what: string; at: string; reason: string; onRetry?: () => void }) {
  const t = useTokens();
  return (
    <Notice tone="attention">
      <View style={{ gap: t.space.xs }}>
        <Text style={t.text.bodyStrong}>{`Could not refresh ${what}. Showing what was read at ${at}.`}</Text>
        <Text style={t.text.body}>{reason}</Text>
        {onRetry ? (
          <View style={{ flexDirection: "row" }}>
            <Button label="Try again" variant="ghost" icon="RefreshCw" onPress={onRetry} />
          </View>
        ) : null}
      </View>
    </Notice>
  );
}

/** A "Learn more" style toggle: a chevron and a label; the children show while it is open. */
export function Disclosure({ title, openTitle, children, open: initial = false, quiet }: { title: string; openTitle?: string; children: React.ReactNode; open?: boolean; /** Secondary size in the muted colour: for extras ("What you can do here") that should not compete with the page. */ quiet?: boolean }) {
  const t = useTokens();
  const [open, setOpen] = useState(initial);
  const shown = open && openTitle ? openTitle : title;
  const color = quiet ? t.color.muted : t.color.accent;
  const words = quiet ? t.text.caption : t.text.body;
  return (
    <View style={{ gap: quiet ? t.space.sm : t.space.row }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={shown}
        accessibilityState={{ expanded: open }}
        {...({ "aria-expanded": open } as object)}
        onPress={() => setOpen((value) => !value)}
        hitSlop={t.control.hit}
        style={{ flexDirection: "row", alignItems: "center", gap: t.space.xs, paddingVertical: t.space.xs, alignSelf: "flex-start" }}
      >
        {HostIcon ? <HostIcon name={open ? "ChevronDown" : "ChevronRight"} size={quiet ? 14 : 16} color={color} /> : <Text style={[words, { color }]}>{open ? "▾" : "▸"}</Text>}
        <Text style={[words, { color, fontWeight: "600" }]}>{shown}</Text>
      </Pressable>
      {open ? <View style={{ gap: t.space.row }}>{children}</View> : null}
    </View>
  );
}

/**
 * A card of fold-out rows (0.5.0, as paseo-mcp 0.19.0): the technical or
 * less-used parts of a page sit here, each one press away, so the page itself
 * stays plain. Children are AccordionItems; the card draws the rule between them.
 */
export function Accordion({ children }: { children: React.ReactNode }) {
  const t = useTokens();
  const items = React.Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;
  return (
    <View style={{ backgroundColor: t.color.surface1, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.color.border, overflow: "hidden" }}>
      {items.map((child, index) => (
        <View key={index} style={index > 0 ? { borderTopWidth: 1, borderTopColor: t.color.border } : undefined}>
          {child}
        </View>
      ))}
    </View>
  );
}

/** One row of an Accordion: an icon, a title, a short summary and a chevron; its content opens below it. */
export function AccordionItem({
  icon,
  title,
  summary,
  tone,
  open: initial = false,
  children,
}: {
  icon?: string;
  title: string;
  /** One line under the title, so the row says what's inside before it's opened. */
  summary?: string;
  tone?: Status;
  open?: boolean;
  children: React.ReactNode;
}) {
  const t = useTokens();
  const [open, setOpen] = useState(initial);
  const pad = t.compact ? t.space.md : t.space.card;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        // react-native-web 0.21 ignores accessibilityState; say it the web way too.
        {...({ "aria-expanded": open } as object)}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: t.space.row, paddingHorizontal: pad, paddingVertical: t.space.row + t.space.hair, minHeight: 56, opacity: pressed ? 0.7 : 1 })}
      >
        {icon ? <IconBadge name={icon} tone={tone && tone !== "neutral" ? tone : "accent"} size={32} /> : null}
        <View style={{ flex: 1, gap: t.space.hair, minWidth: 0 }}>
          <Text style={[t.text.bodyStrong, tone === "error" ? { color: statusColor(t, "error") } : null]}>{title}</Text>
          {summary ? (
            <Text style={t.text.caption} numberOfLines={2}>
              {summary}
            </Text>
          ) : null}
        </View>
        {HostIcon ? <HostIcon name={open ? "ChevronUp" : "ChevronDown"} size={18} color={t.color.muted} /> : <Text style={{ ...TYPE.body, color: t.color.muted }}>{open ? "▴" : "▾"}</Text>}
      </Pressable>
      {open ? <View style={{ paddingHorizontal: pad, paddingBottom: pad, gap: t.space.row }}>{children}</View> : null}
    </View>
  );
}

/** A tab's one plain sentence (0.5.0: no intro block), with the tab's main button beside it when it has one. */
export function TabLine({ children, action }: { children: string; action?: React.ReactNode }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: t.space.md, rowGap: t.space.sm }}>
      <Text style={[t.text.body, { flexShrink: 1, flexBasis: 320, flexGrow: 1 }]}>{children}</Text>
      {action}
    </View>
  );
}

/** The top of a page that sits under a tab (Import & Export, Add a skill): a way back, its title and one sentence. */
export function SubPageTop({ back, onBack, title, children }: { back: string; onBack: () => void; title: string; children?: string }) {
  const t = useTokens();
  return (
    <View style={{ gap: t.space.sm }}>
      <View style={{ flexDirection: "row" }}>
        <Button label={back} icon="ArrowLeft" variant="ghost" onPress={onBack} />
      </View>
      <Text accessibilityRole="header" style={t.text.display}>
        {title}
      </Text>
      {children ? <Text style={t.text.body}>{children}</Text> : null}
    </View>
  );
}

/** A heading inside a card, for one part of a longer explanation. */
export function SectionTitle({ icon, children }: { icon?: string; children: React.ReactNode }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
      {icon && HostIcon ? <HostIcon name={icon} size={18} color={t.color.accent} /> : null}
      <Text accessibilityRole="header" style={t.text.section}>
        {children}
      </Text>
    </View>
  );
}

/**
 * One muted line with an icon and links, outside any card: things worth
 * knowing but not worth a box (the other screen, where something else lives).
 */
export function QuietLine({ icon, children, links }: { icon?: string; children: React.ReactNode; links?: ReadonlyArray<{ label: string; onPress: () => void; accessibilityLabel?: string }> }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: t.space.sm }}>
      {icon && HostIcon ? (
        <View style={{ paddingTop: t.space.hair }}>
          <HostIcon name={icon} size={16} color={t.color.muted} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: t.space.row, rowGap: t.space.xs }}>
        <Text style={[t.text.caption, { flexShrink: 1 }]}>{children}</Text>
        {(links ?? []).map((link) => (
          <Pressable key={link.label} accessibilityRole="link" accessibilityLabel={link.accessibilityLabel ?? link.label} onPress={link.onPress} hitSlop={t.control.hit}>
            <Text style={[t.text.caption, { color: t.color.accent, fontWeight: "600" }]}>{link.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** A secondary sentence in the muted colour: steady facts, times, hints. */
export function Meta({ children }: { children: React.ReactNode }) {
  const t = useTokens();
  return <Text style={t.text.caption}>{children}</Text>;
}
