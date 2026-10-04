import type { PluginClientContext } from "@getpaseo/plugin/client";
import * as HostUI from "@getpaseo/plugin/client/ui";
import { registerSurfaceOpener, rememberTitleMode, screenTitle } from "./client/navigate";
import { MemoriesAgentPanel, MemoriesWorkspacePanel } from "./client/panels";
import { AddNotePopover, AddSkillPopover, QuickAddButton } from "./client/popover";
import { registerScreenOpener } from "./client/screens";
import { skillsScreenTitle } from "./client/skills-nav";
import { SkillsSurface } from "./client/skills-surface";
import { openFrom, registerMainScreen, type SidebarRowComponent } from "./client/register";
import { MemoriesSettingsScreen } from "./client/settings";
import { MemoriesSurface } from "./client/surface";
import { recallTechnicalTitles } from "./client/web";

/** The app's sidebar row, on Paseo 0.11+; looked up at runtime, since older apps do not have it. */
const SidebarRow = (HostUI as Partial<{ SidebarRow: SidebarRowComponent }>).SidebarRow;

export default function contribute(client: PluginClientContext) {
  // Header titles before the page has read its settings: the last mode seen (web), else plain.
  rememberTitleMode(recallTechnicalTitles());
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
  // The second page, Skills (0.4.0), the same way: its own screen and sidebar row, with "+" for Add a skill.
  registerMainScreen(
    client,
    {
      id: "skills",
      title: "Skills",
      screenTitle: skillsScreenTitle,
      icon: "Sparkles",
      Component: SkillsSurface,
      quickAdd: { label: "Add a skill", Button: QuickAddButton, params: { tab: "add" }, Popover: AddSkillPopover },
    },
    SidebarRow,
  );
  // Panels have no way to open a page of their own; lend them this one. Native screens keep their place in params.
  registerSurfaceOpener(page.open, { params: page.screen === "native" });
  registerScreenOpener(page.open, { params: page.screen === "native" });
  client.addWorkspacePanel({
    id: "memories-workspace",
    title: "Memories & Skills",
    icon: "Brain",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: MemoriesWorkspacePanel,
  });
  client.addWorkspacePanel({
    id: "memories-agent",
    title: "Memories & Skills",
    icon: "Brain",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: MemoriesAgentPanel,
  });
  client.addSettingsScreen({ id: "memories", title: "Memories & Skills", icon: "Brain", Component: MemoriesSettingsScreen });
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
    id: "open-skills",
    title: "Open Skills",
    icon: "Sparkles",
    keywords: ["skill", "skills", "SKILL.md", "usage", "add a skill", "npx skills"],
    context: "global",
    onSelect(context) {
      openFrom(context, "skills");
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
    registerScreenOpener(null);
  };
}
