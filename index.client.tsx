import type { PluginClientContext } from "@getpaseo/plugin/client";
import * as HostUI from "@getpaseo/plugin/client/ui";
import { openMemories, registerSurfaceOpener, rememberTitleMode, screenTitle } from "./client/navigate";
import { MemoriesAgentPanel, MemoriesWorkspacePanel } from "./client/panels";
import { AddNotePopover, AddSkillPopover, QuickAddButton, SIDEBAR_PARTS } from "./client/popover";
import { registerScreenOpener } from "./client/screens";
import { openSkills, skillsScreenTitle } from "./client/skills-nav";
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
    SIDEBAR_PARTS,
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
    SIDEBAR_PARTS,
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
  // 0.5.0: the common jobs as commands, so nothing needs a composer chip.
  client.addCommandCenterItem({
    id: "add-memory-note",
    title: "Add a note for your agents",
    icon: "NotebookPen",
    keywords: ["memory", "memories", "note", "remember", "instructions", "add"],
    context: "global",
    onSelect() {
      openMemories({ addNote: {} });
    },
  });
  client.addCommandCenterItem({
    id: "tidy-memories",
    title: "Tidy memories",
    icon: "ListChecks",
    keywords: ["memory", "memories", "tidy", "worth a look", "duplicates", "clean up", "passwords"],
    context: "global",
    onSelect() {
      openMemories({ tab: "overview", worth: true });
    },
  });
  client.addCommandCenterItem({
    id: "add-skill",
    title: "Add a skill",
    icon: "PackagePlus",
    keywords: ["skill", "skills", "add", "install", "SKILL.md"],
    context: "global",
    onSelect() {
      openSkills({ tab: "add" });
    },
  });
  client.addCommandCenterItem({
    id: "add-workspace-note",
    title: "Add a note for this project",
    icon: "NotebookPen",
    keywords: ["memory", "memories", "note", "remember", "project", "instructions"],
    context: "workspace",
    onSelect({ workspace }) {
      openMemories({ addNote: { workspaceId: workspace.id } });
    },
  });
  // In a chat: "/remember <text>" starts Add a note in this project; "/memories" opens what this agent loads.
  // Feature-detected, as every newer API: an app without slash commands simply doesn't get them.
  if (typeof client.addSlashCommand === "function") {
    client.addSlashCommand({
      name: "remember",
      description: "Add a note your agents will follow (Memories)",
      argumentHint: "what to remember",
      context: "agent",
      onSubmit({ workspace, args }) {
        const text = args.trim();
        openMemories({ addNote: { workspaceId: workspace.id, ...(text ? { text } : {}) } });
      },
    });
    client.addSlashCommand({
      name: "memories",
      description: "See what this agent remembers and which skills it has",
      argumentHint: "",
      context: "agent",
      onSubmit({ openPanel }) {
        openPanel("memories-agent");
      },
    });
  }
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
