import React, { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Text, View } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import contribute from "../../index.client";
import { openMemories } from "../../client/navigate";
import { MemoriesAgentPanel, MemoriesWorkspacePanel } from "../../client/panels";
import { MemoriesSettingsScreen } from "../../client/settings";
import { APP, H, appMemory, codexIndex, importText } from "./plugin";

/**
 * Fixture preview. Runs the real `index.client.tsx` against a fake app:
 * Paseo 0.11 by default (screens with params in the URL as `param.*`, the
 * sidebar row with "+", popovers), or Paseo 0.10 with ?legacy (surface and
 * old sidebar item, no params). ?chrome shows the app's sidebar and header.
 *
 * Params: ?tab=overview|user|projects|transfer|guide, ?memory (a memory open
 * in the editor), ?codex (Codex memory with the pending warning), ?import
 * (preview diff), ?export, ?workspace, ?agent (&provider=), ?settings, ?dark,
 * ?empty, ?error, ?stale. Plain view by default (?plain); ?technical shows
 * file names and paths. ?add (Add a note; ?add=ws-1 in a project), ?notes
 * (your Claude instructions as note cards), ?popover (Add a note from the
 * sidebar's "+"; implies ?chrome).
 */
const queryClient = new QueryClient();
const params = new URLSearchParams(location.search);
const legacy = params.has("legacy");
const chrome = params.has("chrome") || params.has("popover");
const light = !params.has("dark");
const colors = light ? {
  surface0: "#ffffff", surface1: "#f8f9fa", surface2: "#eef0f2", border: "#dfe3e8", foreground: "#1f2328",
  foregroundMuted: "#636c76", accent: "#1f6f43", accentForeground: "#ffffff", statusSuccess: "#1a7f37", statusWarning: "#9a6700", statusDanger: "#cf222e",
} : {
  surface0: "#11151b", surface1: "#1a2029", surface2: "#252d38", border: "#394352", foreground: "#eef1f6",
  foregroundMuted: "#a2adbc", accent: "#a5b4fc", accentForeground: "#14192c", statusSuccess: "#6ee7a0", statusWarning: "#facc6b", statusDanger: "#fda4af",
};

// ------------------------------------------------------------- the fake app

/** Scenario flags open a destination once; a navigation drops them so reload lands on the params. */
const SCENARIOS = ["tab", "add", "notes", "memory", "codex", "import", "export", "popover"];
const PREFIX = "param.";
const readScreenParams = () => {
  const out: Record<string, string> = {};
  new URLSearchParams(location.search).forEach((value, key) => { if (key.startsWith(PREFIX)) out[key.slice(PREFIX.length)] = value; });
  return out;
};
let screenParams = readScreenParams();
const screenListeners = new Set<() => void>();
const notify = () => screenListeners.forEach((listener) => listener());
addEventListener("popstate", () => { screenParams = readScreenParams(); notify(); });
function openScreenInApp(next: Record<string, string> = {}) {
  const url = new URLSearchParams(location.search);
  for (const key of [...url.keys()]) if (key.startsWith(PREFIX) || SCENARIOS.includes(key)) url.delete(key);
  for (const [key, value] of Object.entries(next)) url.set(PREFIX + key, value);
  history.pushState(null, "", `?${url.toString()}`);
  screenParams = { ...next };
  console.info("[open-screen]", JSON.stringify(next));
  notify();
}

type Registered = { Screen?: React.ComponentType<any>; title?: string | ((p: Record<string, string>) => string); Item?: React.ComponentType<any>; legacyItem?: { title: string } };
const registered: Registered = {};
const noop = () => () => undefined;
const fakeClient: any = {
  addSurface: (_id: string, Component: React.ComponentType<any>) => { registered.Screen = Component; return () => undefined; },
  addSidebarItem: (item: { title: string }) => { registered.legacyItem = item; return () => undefined; },
  openSurface: (id: string) => console.info("[open-surface]", id),
  addWorkspacePanel: noop, addSettingsScreen: noop, addCommandCenterItem: noop,
  ...(legacy ? {} : {
    addScreen: (screen: { title: Registered["title"]; Component: React.ComponentType<any> }) => { registered.Screen = screen.Component; registered.title = screen.title; return () => undefined; },
    addSidebarHeaderItem: (item: { Component: React.ComponentType<any> }) => { registered.Item = item.Component; return () => undefined; },
    openScreen: ({ params: next }: { screenId: string; params?: Record<string, string> }) => openScreenInApp(next),
  }),
};
contribute(fakeClient);

const tab = params.get("tab") as "overview" | "user" | "projects" | "transfer" | "guide" | null;
if (params.has("add")) openMemories({ tab: "overview", addNote: params.get("add") ? { workspaceId: params.get("add")! } : {} });
else if (params.has("notes")) openMemories({ tab: "user", sourceId: `${H}/.claude/CLAUDE.md` });
else if (params.has("memory")) openMemories({ tab: "projects", sourceId: appMemory, entryKey: "payments_retry_limit.md" });
else if (params.has("codex")) openMemories({ tab: "user", sourceId: codexIndex });
else if (params.has("import")) openMemories({ tab: "transfer", text: importText, target: { kind: "append", path: `${APP}/CLAUDE.md` }, preview: true });
else if (params.has("export")) openMemories({ tab: "transfer", exportView: true });
else if (tab) openMemories({ tab });

function useScreenParams() {
  return useSyncExternalStore((listener) => { screenListeners.add(listener); return () => screenListeners.delete(listener); }, () => screenParams);
}

function Preview() {
  const [compact, setCompact] = useState(innerWidth < 640);
  const [Popover, setPopover] = useState<React.ComponentType<any> | null>(null);
  const current = useScreenParams();
  useEffect(() => { const resize = () => setCompact(innerWidth < 640); addEventListener("resize", resize); return () => removeEventListener("resize", resize); }, []);
  useEffect(() => {
    // ?stale: the first answers arrive, then a refresh fails: the views keep them "as of HH:MM".
    if (params.has("stale")) setTimeout(() => void queryClient.invalidateQueries(), 800);
  }, []);
  const props = { theme: { colors }, host: { id: "preview", label: "demo-host" }, layout: { compact, platform: "web" as const } } as any;
  const Screen = registered.Screen!;
  const screen = params.has("agent") ? <MemoriesAgentPanel {...props} context="agent" workspaceId="ws-1" agentId="agent-1" />
    : params.has("settings") ? <MemoriesSettingsScreen {...props} />
    : params.has("workspace") ? <MemoriesWorkspacePanel {...props} context="workspace" workspaceId="ws-1" />
    : <Screen {...props} {...(legacy ? {} : { params: current })} />;
  const openPopover = (content: React.ComponentType<any>) => setPopover(() => content);
  useEffect(() => {
    // react-native-web's Pressable answers pointer events, not a bare click().
    if (params.has("popover")) setTimeout(() => { const plus = document.querySelector('[data-testid="memories-sidebar-add"]'); for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) plus?.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true })); }, 300);
  }, []);
  if (!chrome) return <QueryClientProvider client={queryClient}>{screen}</QueryClientProvider>;
  const title = typeof registered.title === "function" ? registered.title(current) : registered.title ?? "Memories";
  const Item = registered.Item;
  const muted = { color: colors.foregroundMuted };
  return <QueryClientProvider client={queryClient}>
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.surface0 }}>
      <View style={{ width: 240, borderRightWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, padding: 8, gap: 4 }}>
        <Text style={[muted, { padding: 8, fontWeight: "600" }]}>Paseo {legacy ? "0.10" : "0.11"}</Text>
        <View style={{ borderRadius: 8 }}><Text style={{ padding: 8, color: colors.foreground }}>Workspaces</Text></View>
        {Item ? <View style={{ position: "relative" }}><Item {...props} currentScreen={{ screenId: "memories", params: current }} openScreen={(input: any) => openScreenInApp(input.params)} openPopover={openPopover} /></View>
          : <Text style={{ padding: 8, color: colors.foreground }}>{registered.legacyItem?.title}</Text>}
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ height: 44, justifyContent: "center", paddingHorizontal: 16, borderBottomWidth: 1, borderColor: colors.border }}>
          <Text testID="app-header-title" style={{ color: colors.foreground, fontWeight: "600" }}>{title}</Text>
        </View>
        {screen}
      </View>
      {Popover ? (
          <View style={{ position: "absolute", left: 248, top: 88, width: 420, zIndex: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface0, boxShadow: "0 12px 32px rgba(0,0,0,0.18)" } as any}>
            <Popover {...props} close={() => setPopover(null)} openScreen={(input: any) => { setPopover(null); openScreenInApp(input.params); }} />
          </View>
        ) : null}
    </View>
  </QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
