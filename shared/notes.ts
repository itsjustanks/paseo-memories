/**
 * Notes: an instruction file's sections as a person sees them (a title and
 * what it says), and "Add a note": which files a note goes to for each
 * agent, decided from what that agent's load plan says it reads. Pure; the
 * server gathers the facts and does the writing through the usual safe path.
 */

import { sectionText, splitSections } from "./markdown";
import { MASK_FILL } from "./secrets";

// ------------------------------------------------------------------ sections as notes

export type Note = { title: string; body: string; level: number; headless: boolean };

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Blank lines off both ends; spaces inside a line (indented code, a trailing hard break) stay. */
function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start += 1;
  while (end > start && lines[end - 1]!.trim() === "") end -= 1;
  return lines.slice(start, end);
}

function blanks(count: number): string[] {
  return Array<string>(count).fill("");
}

/** A section's text (as `sectionText` returns it) as a note. The "0:" section before any heading has no title. */
export function noteFromSection(text: string, headless: boolean): Note {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (headless) return { title: "", body: trimBlankLines(lines).join("\n"), level: 0, headless: true };
  const match = HEADING.exec(lines[0] ?? "");
  return { title: match?.[2] ?? (lines[0] ?? "").trim(), body: trimBlankLines(lines.slice(1)).join("\n"), level: match?.[1]!.length ?? 2, headless: false };
}

/**
 * The text to send with `sectionKey` so the section becomes `note` and
 * everything around it stays as it was: the heading line is kept byte for
 * byte when the title did not change, and so are the blank lines around the
 * text (which separate it from its neighbours) and the file's line endings.
 */
export function sectionReplacement(original: string, note: { title: string; body: string }, headless: boolean): string {
  const lines = original.split("\n");
  const crlf = lines.some((line) => line.endsWith("\r"));
  const lastHasCr = (lines[lines.length - 1] ?? "").endsWith("\r");
  const hasText = lines.some((line) => line.trim() !== "");
  let trailing = 0;
  for (let index = lines.length - 1; index >= (headless ? 0 : 1) && lines[index]!.trim() === ""; index += -1) trailing += 1;
  const bodyLines = trimBlankLines(note.body.replace(/\r/g, "").split("\n"));
  let out: string[];
  if (headless) {
    let lead = 0;
    for (let index = 0; hasText && index < lines.length && lines[index]!.trim() === ""; index += 1) lead += 1;
    out = [...blanks(lead), ...bodyLines, ...blanks(hasText ? trailing : 0)];
  } else {
    const was = noteFromSection(original, false);
    const heading = note.title.trim() === was.title ? lines[0]!.replace(/\r$/, "") : `${"#".repeat(was.level || 2)} ${note.title.replace(/\n/g, " ").trim()}`;
    let gap = 0;
    for (let index = 1; index < lines.length - trailing && lines[index]!.trim() === ""; index += 1) gap += 1;
    out = [heading, ...(bodyLines.length ? [...blanks(gap || 1), ...bodyLines] : []), ...blanks(trailing)];
  }
  // The file's own line endings; the last line keeps whatever it had (a file may end without a break).
  const ended = crlf ? out.map((line, index) => (index === out.length - 1 && !lastHasCr ? line : `${line}\r`)) : out;
  // replaceSection drops one final line break from what it is given.
  return `${ended.join("\n")}\n`;
}

// ------------------------------------------------------------------ note cards

/** A leading `---` block: Claude's `paths:`, Copilot's `applyTo:`, any other header. Never a card; kept byte for byte. */
const HEADER = /^(\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))/;

export type NoteCard = { key: string; headless: boolean; header: string; original: string; note: Note };

/** An instruction file as cards: one per section, without the file's header, and none for a header on its own. */
export function noteCards(text: string): NoteCard[] {
  return splitSections(text).flatMap((section) => {
    const original = sectionText(text, section);
    const headless = section.key === "0:";
    const header = headless ? HEADER.exec(original)?.[1] ?? "" : "";
    const note = noteFromSection(original.slice(header.length), headless);
    if (headless && !note.body.trim()) return [];
    return [{ key: section.key, headless, header, original, note }];
  });
}

/** What to send with the card's `sectionKey` to change it; the header stays as it was. */
export function cardReplacement(card: NoteCard, next: { title: string; body: string }): string {
  return card.header + sectionReplacement(card.original.slice(card.header.length), next, card.headless);
}

/** What to send to remove a card: the whole section, or everything after the header when the file has one. */
export function cardRemoval(card: NoteCard): { text: string; removeSection?: boolean } {
  if (!card.header) return { text: "", removeSection: true };
  const rest = card.original.slice(card.header.length).split("\n");
  let trailing = 0;
  for (let index = rest.length - 1; index >= 0 && rest[index]!.trim() === ""; index -= 1) trailing += 1;
  const cr = card.header.includes("\r\n") ? "\r" : "";
  // The header ends in a line break, so it already makes the first blank line.
  return { text: `${card.header}${Array<string>(Math.max(0, trailing - 1)).fill(cr).join("\n")}${trailing > 1 ? "\n" : ""}\n` };
}

export const HIDDEN_TEXT = "This note contains hidden characters (••••). Press Show on the original note to copy the real text.";

export function hasHiddenText(text: string): boolean {
  return text.includes(MASK_FILL);
}

/**
 * A card's "Add a note": refused with hidden characters, skipped when the
 * same note is already there, warned when one says almost the same; saved
 * against the file as the user saw it, so a newer file is refused.
 */
export function planCardAdd<Stamp>({ text, seen, preview }: { text: string; seen: Stamp; preview: { duplicate: string; duplicateOf?: string; identical?: boolean } }): { skip: string } | { expected: Stamp; warning?: string } {
  if (hasHiddenText(text)) return { skip: HIDDEN_TEXT };
  if (preview.identical) return { skip: `This note is already there${preview.duplicateOf ? `: "${preview.duplicateOf}"` : ""}, so it wasn't added again.` };
  if (preview.duplicate === "exact" || preview.duplicate === "near") return { expected: seen, warning: `A note that says almost the same already exists${preview.duplicateOf ? `: "${preview.duplicateOf}"` : ""}.` };
  return { expected: seen };
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
  /** Bytes of this file the agent reads at most (Codex: what is left of its project-doc budget when it gets here). */
  readLimit?: number;
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
  /** Only the person on this computer sees it (not in a git folder). */
  private: boolean;
  /** From the load plan; see `NoteFact.readLimit`. */
  readLimit?: number;
};

/** `covered`: not needed, because the agent already reads another target (said as it is, not as a problem). */
export type NotePlan = { targets: NoteTargetPlan[]; skipped: Array<{ agent: string; reason: string; covered?: boolean }> };

export const COVERED_BY_PROJECT = "Claude reads the project instructions too, so one note is enough.";

const READ = new Set(["launch", "missing"]);

function editable(item: NoteFact): boolean {
  return item.access === "editable" && READ.has(item.when);
}

/** Shared when the file sits in a git folder (a project, or a home folder kept in git); private only when it doesn't. */
function sharing(item: NoteFact): { shared: boolean; private: boolean } {
  return { shared: Boolean(item.versionControlled), private: !item.versionControlled };
}

function forClaude(items: NoteFact[], where: NoteWhere, account?: string): NoteTargetPlan | string {
  if (where.kind === "everywhere") {
    const user = items.find((item) => item.kind === "claude-md" && item.scope === "user" && item.path.endsWith("/CLAUDE.md"));
    if (!user || !editable(user)) return "Claude isn't set up to read your own instructions on this computer.";
    return { agent: "claude", kind: "append", path: user.path, label: `Your instructions for Claude${account ? ` · ${account}` : ""}`, creates: user.when === "missing", ...sharing(user) };
  }
  const memory = items.find((item) => item.kind === "claude-auto-memory");
  if (!memory) return `Claude doesn't keep notes for ${where.name}.`;
  if (memory.when === "skipped") return `Claude's own notes are turned off for ${where.name}.`;
  if (!editable(memory)) return `Claude's notes for ${where.name} can't be changed here.`;
  return { agent: "claude", kind: "claude-memory", path: memory.path, label: `Claude's notes for ${where.name}`, creates: memory.when === "missing", ...sharing(memory) };
}

function forCodex(items: NoteFact[], where: NoteWhere, account?: string): NoteTargetPlan | string {
  if (where.kind === "everywhere") {
    const user = items.filter((item) => item.kind === "agents-md" && item.scope === "user");
    // The one Codex reads: the override when it has text, else AGENTS.md (an empty or missing one starts being read once it has this note).
    const read = user.find((item) => item.when === "launch") ?? user.find((item) => /\/AGENTS\.md$/.test(item.path) && (item.when === "missing" || item.when === "skipped"));
    if (!read || read.access !== "editable") return "Codex isn't set up to read your own instructions on this computer.";
    return { agent: "codex", kind: "append", path: read.path, label: `Your instructions for Codex${account ? ` · ${account}` : ""}`, creates: read.when === "missing", ...sharing(read) };
  }
  const project = items.filter((item) => item.kind === "agents-md" && item.scope === "project");
  // The deepest file Codex reads (closest to where agents start), else the one it would read once written.
  const read = [...project].reverse().find((item) => item.when === "launch") ?? project.find((item) => item.when === "missing");
  if (!read) {
    return project.some((item) => item.when === "skipped") ? `Codex's project instructions for ${where.name} are already as long as Codex will read.` : `Codex has nowhere to read project instructions for ${where.name}.`;
  }
  if (!editable(read)) return `Codex's project instructions for ${where.name} can't be changed here.`;
  const shared = Boolean(read.versionControlled);
  return { agent: "codex", kind: "append", path: read.path, label: `Project instructions · ${where.name}${shared ? " (shared with the team)" : ""}`, creates: read.when === "missing", shared, private: false, ...(read.readLimit !== undefined ? { readLimit: read.readLimit } : {}) };
}

/**
 * Where a note goes. Everywhere: your own instructions for Claude and for
 * Codex. One project: a new private Claude note for that project, and the
 * project's instructions for Codex (shared through git when it is in one).
 * Only files the agent's load plan says it reads (or will, once written);
 * never Codex's own generated notes and never Paseo's prompt for every agent.
 * For all agents in one project, when Claude already reads the project's
 * instructions at launch, the Claude note is left out: one note is enough.
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
  const shared = plan.targets.find((target) => target.agent === "codex");
  const claude = facts.claude && "items" in facts.claude ? facts.claude.items : [];
  if (who === "all" && where.kind === "project" && shared && claude.some((item) => item.kind === "agents-md" && item.path === shared.path && item.when === "launch")) {
    plan.targets = plan.targets.filter((target) => target.agent !== "claude");
    plan.skipped.push({ agent: "claude", reason: COVERED_BY_PROJECT, covered: true });
  }
  return plan;
}

// ------------------------------------------------------------------ read limits

export const CODEX_PAST_LIMIT = "Codex only reads the start of this project's instructions, and this note would land past that point. Shorten them first: Worth a look shows how.";
export const CLAUDE_LIST_FULL = "Claude's list of notes for this project is full: it only reads the first 200 lines. Tidy it first.";
export const CLAUDE_LIST_TOO_BIG = "Claude's list of notes for this project is full: it only reads the start of it. Tidy it first.";
export const CLAUDE_FILE_TOO_BIG = "Claude skips instructions this long altogether, so this note wouldn't be read. Shorten them first.";

/** The one-line warning for a target, in plain words. */
export function noteTargetWarning(target: Pick<NoteTargetPlan, "shared">): string | undefined {
  return target.shared ? "Everyone who works on this project will see this note." : undefined;
}
