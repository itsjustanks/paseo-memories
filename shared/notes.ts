/**
 * Notes: an instruction file's sections as a person sees them (a title and
 * what it says), and "Add a note": which files a note goes to for each
 * agent, decided from what that agent's load plan says it reads. Pure; the
 * server gathers the facts and does the writing through the usual safe path.
 */

// ------------------------------------------------------------------ sections as notes

export type Note = { title: string; body: string; level: number; headless: boolean };

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/** A section's text (as `sectionText` returns it) as a note. The "0:" section before any heading has no title. */
export function noteFromSection(text: string, headless: boolean): Note {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (headless) return { title: "", body: lines.join("\n").trim(), level: 0, headless: true };
  const match = HEADING.exec(lines[0] ?? "");
  return { title: match?.[2] ?? (lines[0] ?? "").trim(), body: lines.slice(1).join("\n").trim(), level: match?.[1]!.length ?? 2, headless: false };
}

/**
 * The text to send with `sectionKey` so the section becomes `note` and
 * everything around it stays as it was: the heading line is kept byte for
 * byte when the title did not change, and so are the blank lines between
 * the heading and the text and after the text (which separate it from the
 * next heading).
 */
export function sectionReplacement(original: string, note: { title: string; body: string }, headless: boolean): string {
  const lines = original.split("\n");
  let trailing = 0;
  for (let index = lines.length - 1; index >= 0 && lines[index]!.trim() === ""; index -= 1) trailing += 1;
  const body = note.body.replace(/\r/g, "").trim();
  const bodyLines = body ? body.split("\n") : [];
  let out: string[];
  if (headless) {
    out = [...bodyLines, ...Array<string>(trailing).fill("")];
  } else {
    const was = noteFromSection(original, false);
    const heading = note.title.trim() === was.title ? lines[0]! : `${"#".repeat(was.level || 2)} ${note.title.replace(/\n/g, " ").trim()}`;
    let gap = 0;
    for (let index = 1; index < lines.length - trailing && lines[index]!.trim() === ""; index += 1) gap += 1;
    out = [heading, ...(bodyLines.length ? [...Array<string>(gap || 1).fill(""), ...bodyLines] : []), ...Array<string>(trailing).fill("")];
  }
  // replaceSection drops one final line break from what it is given.
  return `${out.join("\n")}\n`;
}

/** A short title from what someone typed: the first line, cut to about eight words. */
export function noteTitle(text: string): string {
  const first = (text.split("\n").find((line) => line.trim()) ?? "").replace(/^[-*#>\s]+/, "").trim();
  const words = first.split(/\s+/).filter(Boolean);
  const short = words.slice(0, 8).join(" ");
  const cut = words.length > 8 || short.length > 70;
  const title = short.length > 70 ? short.slice(0, 68).replace(/\s+\S*$/, "") : short;
  return (cut ? `${title.replace(/[.,;:!?]+$/, "")}…` : title.replace(/[.;:]+$/, "")) || "Note";
}

// ------------------------------------------------------------------ Add a note

export const NOTE_WHO = ["all", "claude", "codex"] as const;
export type NoteWho = (typeof NOTE_WHO)[number];

/** What a load plan says about one file, as far as Add a note cares. */
export type NoteFact = {
  kind: string;
  scope: string;
  path: string;
  /** launch | on-demand | skipped | missing */
  when: string;
  access: string;
  versionControlled?: boolean;
};

/** Per agent: its plan's items, or why there is no plan (not set up here). */
export type NoteFacts = Partial<Record<"claude" | "codex", { items: NoteFact[]; account?: string } | { unavailable: string }>>;

export type NoteWhere = { kind: "everywhere" } | { kind: "project"; name: string };

export type NoteTargetPlan = {
  agent: "claude" | "codex";
  /** claude-memory: a new note in Claude's notes for the project; append: a section at the end of a file. */
  kind: "claude-memory" | "append";
  path: string;
  label: string;
  /** Nothing is there yet: the save creates it. */
  creates: boolean;
  /** Shared through git with everyone on the project. */
  shared: boolean;
  /** Only the person on this computer sees it. */
  private: boolean;
};

export type NotePlan = { targets: NoteTargetPlan[]; skipped: Array<{ agent: string; reason: string }> };

const READ = new Set(["launch", "missing"]);

function editable(item: NoteFact): boolean {
  return item.access === "editable" && READ.has(item.when);
}

function forClaude(items: NoteFact[], where: NoteWhere, account?: string): NoteTargetPlan | string {
  if (where.kind === "everywhere") {
    const user = items.find((item) => item.kind === "claude-md" && item.scope === "user" && item.path.endsWith("/CLAUDE.md"));
    if (!user || !editable(user)) return "Claude isn't set up to read your own instructions on this computer.";
    return { agent: "claude", kind: "append", path: user.path, label: `Your instructions for Claude${account ? ` · ${account}` : ""}`, creates: user.when === "missing", shared: false, private: true };
  }
  const memory = items.find((item) => item.kind === "claude-auto-memory");
  if (!memory) return `Claude doesn't keep notes for ${where.name}.`;
  if (memory.when === "skipped") return `Claude's own notes are turned off for ${where.name}.`;
  if (!editable(memory)) return `Claude's notes for ${where.name} can't be changed here.`;
  return { agent: "claude", kind: "claude-memory", path: memory.path, label: `Claude's notes for ${where.name}`, creates: memory.when === "missing", shared: false, private: true };
}

function forCodex(items: NoteFact[], where: NoteWhere, account?: string): NoteTargetPlan | string {
  if (where.kind === "everywhere") {
    const user = items.filter((item) => item.kind === "agents-md" && item.scope === "user");
    // The one Codex reads: the override when it has text, else AGENTS.md (an empty or missing one starts being read once it has this note).
    const read = user.find((item) => item.when === "launch") ?? user.find((item) => /\/AGENTS\.md$/.test(item.path) && (item.when === "missing" || item.when === "skipped"));
    if (!read || read.access !== "editable") return "Codex isn't set up to read your own instructions on this computer.";
    return { agent: "codex", kind: "append", path: read.path, label: `Your instructions for Codex${account ? ` · ${account}` : ""}`, creates: read.when === "missing", shared: false, private: true };
  }
  const project = items.filter((item) => item.kind === "agents-md" && item.scope === "project");
  // The deepest file Codex reads (closest to where agents start), else the one it would read once written.
  const read = [...project].reverse().find((item) => item.when === "launch") ?? project.find((item) => item.when === "missing");
  if (!read) {
    return project.some((item) => item.when === "skipped") ? `Codex's project instructions for ${where.name} are already as long as Codex will read.` : `Codex has nowhere to read project instructions for ${where.name}.`;
  }
  if (!editable(read)) return `Codex's project instructions for ${where.name} can't be changed here.`;
  const shared = Boolean(read.versionControlled);
  return { agent: "codex", kind: "append", path: read.path, label: `Project instructions · ${where.name}${shared ? " (shared with the team)" : ""}`, creates: read.when === "missing", shared, private: false };
}

/**
 * Where a note goes. Everywhere: your own instructions for Claude and for
 * Codex. One project: a new private Claude note for that project, and the
 * project's instructions for Codex (shared through git when it is in one).
 * Only files the agent's load plan says it reads (or will, once written);
 * never Codex's own generated notes and never Paseo's prompt for every agent.
 */
export function planNote(who: NoteWho, where: NoteWhere, facts: NoteFacts): NotePlan {
  const agents: Array<"claude" | "codex"> = who === "all" ? ["claude", "codex"] : [who];
  const plan: NotePlan = { targets: [], skipped: [] };
  for (const agent of agents) {
    const fact = facts[agent];
    if (!fact) {
      plan.skipped.push({ agent, reason: `${agent === "claude" ? "Claude" : "Codex"} isn't set up on this computer.` });
      continue;
    }
    if ("unavailable" in fact) {
      plan.skipped.push({ agent, reason: fact.unavailable });
      continue;
    }
    const picked = agent === "claude" ? forClaude(fact.items, where, fact.account) : forCodex(fact.items, where, fact.account);
    if (typeof picked === "string") plan.skipped.push({ agent, reason: picked });
    else if (!plan.targets.some((target) => target.path === picked.path)) plan.targets.push(picked);
  }
  return plan;
}

/** The one-line warning for a target, in plain words. */
export function noteTargetWarning(target: Pick<NoteTargetPlan, "shared">): string | undefined {
  return target.shared ? "This is shared with your team through git." : undefined;
}
