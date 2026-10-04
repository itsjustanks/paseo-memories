import type { PluginClientContext } from "@getpaseo/plugin/client";
import * as HostUI from "@getpaseo/plugin/client/ui";
import { registerSurfaceOpener } from "./client/navigate";
import { MemoriesAgentPanel, MemoriesWorkspacePanel } from "./client/panels";
import { openFrom, registerMainScreen, type LegacyClient, type ScreenClient, type SidebarRowComponent } from "./client/register";
import { MemoriesSettingsScreen } from "./client/settings";
import { MemoriesSurface } from "./client/surface";

/** The app's sidebar row, on Paseo 0.11+; looked up at runtime, since the 0.8 SDK does not export it. */
const SidebarRow = (HostUI as unknown as { SidebarRow?: SidebarRowComponent }).SidebarRow;

export default function contribute(client: PluginClientContext) {
  // A native screen and sidebar row on Paseo 0.11+, the surface and sidebar item before.
  const page = registerMainScreen(client as unknown as LegacyClient & ScreenClient, { id: "memories", title: "Memories", icon: "Brain", Component: MemoriesSurface }, SidebarRow);
  // Panels have no way to open the page of their own; lend them this one.
  registerSurfaceOpener(page.open);
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
    onSelect(context) {
      openFrom(context, "memories");
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
