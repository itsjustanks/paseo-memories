import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { openMemories, registerSurfaceOpener } from "../../client/navigate";
import { MemoriesAgentPanel, MemoriesWorkspacePanel } from "../../client/panels";
import { MemoriesSettingsScreen } from "../../client/settings";
import { MemoriesSurface } from "../../client/surface";
import { APP, H, appMemory, codexIndex, importText } from "./plugin";

/**
 * Fixture preview. Params: ?tab=overview|user|projects|transfer|guide,
 * ?memory (a memory open in the editor), ?codex (Codex memory with the
 * pending warning), ?import (preview diff), ?export, ?workspace, ?agent
 * (&provider=), ?settings, ?dark, ?empty, ?error, ?stale. Plain view by
 * default (?plain); ?technical shows file names and paths. ?add (Add a note;
 * ?add=ws-1 in a project), ?notes (your Claude instructions as note cards).
 */
registerSurfaceOpener((id) => console.info("[open-surface]", id));
const queryClient = new QueryClient();
const params = new URLSearchParams(location.search);
const light = !params.has("dark");
const colors = light ? {
  surface0: "#ffffff", surface1: "#f8f9fa", surface2: "#eef0f2", border: "#dfe3e8", foreground: "#1f2328",
  foregroundMuted: "#636c76", accent: "#1f6f43", accentForeground: "#ffffff", statusSuccess: "#1a7f37", statusWarning: "#9a6700", statusDanger: "#cf222e",
} : {
  surface0: "#11151b", surface1: "#1a2029", surface2: "#252d38", border: "#394352", foreground: "#eef1f6",
  foregroundMuted: "#a2adbc", accent: "#a5b4fc", accentForeground: "#14192c", statusSuccess: "#6ee7a0", statusWarning: "#facc6b", statusDanger: "#fda4af",
};

const tab = params.get("tab") as "overview" | "user" | "projects" | "transfer" | "guide" | null;
if (params.has("add")) openMemories({ tab: "overview", addNote: params.get("add") ? { workspaceId: params.get("add")! } : {} });
else if (params.has("notes")) openMemories({ tab: "user", sourceId: `${H}/.claude/CLAUDE.md` });
else if (params.has("memory")) openMemories({ tab: "projects", sourceId: appMemory, entryKey: "payments_retry_limit.md" });
else if (params.has("codex")) openMemories({ tab: "user", sourceId: codexIndex });
else if (params.has("import")) openMemories({ tab: "transfer", text: importText, target: { kind: "append", path: `${APP}/CLAUDE.md` }, preview: true });
else if (params.has("export")) openMemories({ tab: "transfer", exportView: true });
else if (tab) openMemories({ tab });

function Preview() {
  const [compact, setCompact] = useState(innerWidth < 640);
  useEffect(() => { const resize = () => setCompact(innerWidth < 640); addEventListener("resize", resize); return () => removeEventListener("resize", resize); }, []);
  useEffect(() => {
    // ?stale: the first answers arrive, then a refresh fails: the views keep them "as of HH:MM".
    if (params.has("stale")) setTimeout(() => void queryClient.invalidateQueries(), 800);
  }, []);
  const props = { theme: { colors }, host: { id: "preview", label: "demo-host" }, layout: { compact, platform: "web" as const } } as any;
  return <QueryClientProvider client={queryClient}>
    {params.has("agent") ? <MemoriesAgentPanel {...props} context="agent" workspaceId="ws-1" agentId="agent-1" />
      : params.has("settings") ? <MemoriesSettingsScreen {...props} />
      : params.has("workspace") ? <MemoriesWorkspacePanel {...props} context="workspace" workspaceId="ws-1" /> : <MemoriesSurface {...props} />}
  </QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
