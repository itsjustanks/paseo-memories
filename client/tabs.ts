/**
 * Four tabs, grouped by what people come to do (0.5.0): Overview, Everywhere
 * (`user`), Projects and Help. Icons are Lucide names drawn by the Paseo app.
 * Plain mode takes its labels from `PLAIN.tabLabels`; technical mode keeps the
 * file-level words (`label`, `heading`). Import & Export is a page under a
 * tab, not a tab of its own, and the old Guide is Help.
 */
export const TABS = [
  { id: "overview", label: "Overview", icon: "LayoutDashboard", heading: "What your agents remember on this host, and the one thing to tidy next." },
  { id: "user", label: "User", icon: "User", heading: "Files every agent of yours reads, in every project: per agent and per account." },
  { id: "projects", label: "Projects", icon: "FolderCode", heading: "What each project adds: its instruction files and Claude's auto memory for it." },
  { id: "help", label: "Help", icon: "CircleHelp", heading: "Common questions, then where each agent keeps what it remembers and what loads when." },
] as const;

export type SectionId = (typeof TABS)[number]["id"];

/** Every place the page can show: a tab, or Import & Export (a page under Everywhere or Projects). */
export type PageId = SectionId | "transfer";

export const TRANSFER_PAGE = { id: "transfer", label: "Import & Export", icon: "ArrowLeftRight" } as const;

/** Tab ids from before 0.5.0 that still arrive in links, and where they land now. */
export const LEGACY_TABS: Readonly<Record<string, PageId>> = { guide: "help" };

const PAGES: readonly string[] = [...TABS.map((tab) => tab.id), TRANSFER_PAGE.id];

/** A page id from a link or a caller, old ids included; undefined when it means nothing here. */
export function pageFor(raw: unknown): PageId | undefined {
  if (typeof raw !== "string") return undefined;
  if (PAGES.includes(raw)) return raw as PageId;
  return LEGACY_TABS[raw];
}

/** The tab that stays lit while a page under it is open: Import & Export keeps the tab it was opened from. */
export function litTab(page: PageId, from: SectionId | null): SectionId {
  if (page !== "transfer") return page;
  return from === "projects" ? "projects" : "user";
}
