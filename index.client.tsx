import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerSurfaceOpener } from "./client/navigate";
import { MemoriesAgentPanel, MemoriesWorkspacePanel } from "./client/panels";
import { MemoriesSettingsScreen } from "./client/settings";
import { MemoriesSurface } from "./client/surface";

export default function contribute(client: PluginClientContext) {
  // Panels have no openSurface of their own; lend them this one.
  registerSurfaceOpener((id) => client.openSurface(id));
  client.addSurface("memories", MemoriesSurface);
  client.addSidebarItem({ id: "memories", title: "Memories", icon: "Brain", surface: "memories" });
  client.addWorkspacePanel({
    id: "memories-workspace",
    title: "Memories",
    icon: "Brain",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: MemoriesWorkspacePanel,
  });
  client.addWorkspacePanel({
    id: "memories-agent",
    title: "Memories",
    icon: "Brain",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: MemoriesAgentPanel,
  });
  client.addSettingsScreen({ id: "memories", title: "Memories", icon: "Brain", Component: MemoriesSettingsScreen });
  client.addCommandCenterItem({
    id: "open-memories",
    title: "Open Memories",
    icon: "Brain",
    keywords: ["memory", "memories", "claude.md", "agents.md", "instructions", "tidy", "import", "export"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("memories");
    },
  });
  client.addCommandCenterItem({
    id: "open-workspace-memories",
    title: "What agents load in this workspace",
    icon: "Brain",
    keywords: ["memory", "memories", "claude.md", "agents.md", "load", "context"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("memories-workspace");
    },
  });
  client.addCommandCenterItem({
    id: "open-agent-memories",
    title: "What this agent loads",
    icon: "Brain",
    keywords: ["memory", "memories", "context", "agent"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("memories-agent");
    },
  });
  return () => {
    registerSurfaceOpener(null);
  };
}
