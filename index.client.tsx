import type { PluginClientContext } from "@getpaseo/plugin/client";
import * as HostUI from "@getpaseo/plugin/client/ui";
import { registerSurfaceOpener, screenTitle } from "./client/navigate";
import { MemoriesAgentPanel, MemoriesWorkspacePanel } from "./client/panels";
import { AddNotePopover, QuickAddButton } from "./client/popover";
import { openFrom, registerMainScreen, type SidebarRowComponent } from "./client/register";
import { MemoriesSettingsScreen } from "./client/settings";
import { MemoriesSurface } from "./client/surface";

/** The app's sidebar row, on Paseo 0.11+; looked up at runtime, since older apps do not have it. */
const SidebarRow = (HostUI as Partial<{ SidebarRow: SidebarRowComponent }>).SidebarRow;

export default function contribute(client: PluginClientContext) {
  // A native screen and sidebar row (with "+" for Add a note) on Paseo 0.11+, the surface and sidebar item before.
  const page = registerMainScreen(
    client,
    {
      id: "memories",
      title: "Memories",
      screenTitle,
      icon: "Brain",
      Component: MemoriesSurface,
      quickAdd: { label: "Add a note", Button: QuickAddButton, params: { add: "note" }, Popover: AddNotePopover },
    },
    SidebarRow,
  );
  // Panels have no way to open the page of their own; lend them this one. Native screens keep their place in params.
  registerSurfaceOpener(page.open, { params: page.screen === "native" });
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
