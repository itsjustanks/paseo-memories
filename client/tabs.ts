/**
 * Five sections, one job each, in one row. Icons are Lucide names drawn by the
 * Paseo app. Plain mode takes its labels and intros from `PLAIN`; technical
 * mode keeps the file-level words (`label`, `title`, `heading`). "What you can
 * do here" is the same plain list in both, unless a tab has its own `canDo`.
 */
export const TABS = [
  { id: "overview", label: "Overview", icon: "LayoutDashboard", title: "Overview", heading: "What your agents remember on this host, and the one thing to tidy next." },
  { id: "user", label: "User", icon: "User", title: "User files", heading: "Files every agent of yours reads, in every project: per agent and per account." },
  { id: "projects", label: "Projects", icon: "FolderCode", title: "Project files", heading: "What each project adds: its instruction files and Claude's auto memory for it." },
  { id: "transfer", label: "Import & Export", icon: "ArrowLeftRight", title: "Import & Export", heading: "Bring memories in from another agent or a file, or keep a copy out." },
  {
    id: "guide",
    label: "Guide",
    icon: "BookOpen",
    title: "Guide",
    heading: "Where each agent keeps what it remembers, what loads when, and what is safe to edit.",
    // Technical mode shows the reference only, not the how-tos.
    canDo: ["See what each agent reads, in what order, and how much", "Learn what can't be edited here, and why", "See how a save keeps a backup and checks its work"],
  },
] as const;

export type SectionId = (typeof TABS)[number]["id"];
