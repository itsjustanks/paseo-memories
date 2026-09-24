/**
 * Plain names and words for people who don't work with files every day. Every
 * view uses this module when "Show technical details" is off, so the same
 * thing has the same name everywhere. Pure; the jargon test reads it.
 *
 * Rule for every string here: no file names, paths, "tokens", "frontmatter",
 * "slug", "scope", "repo", "config", "markdown", "git" or "commit". Plain words throughout.
 */

import { AGENT_LABELS } from "./agents";
import type { Finding, NextStep } from "./contracts";

/** Agent names as a person says them. */
export const PLAIN_AGENT: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  paseo: "Paseo",
  opencode: "OpenCode",
  pi: "pi",
  omp: "Oh My Pi",
  copilot: "Copilot",
};

export function plainAgent(agent: string): string {
  return PLAIN_AGENT[agent] ?? AGENT_LABELS[agent] ?? agent;
}

export function plainAgents(agents: string[]): string {
  const names = [...new Set(agents.map(plainAgent))];
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function lastPart(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function stem(path: string): string {
  return lastPart(path).replace(/\.instructions\.md$|\.md$/i, "").replace(/[-_]+/g, " ");
}

/** What the plain name needs to know about a source. */
export type PlainSourceLike = {
  kind: string;
  scope: string;
  agent: string;
  path: string;
  projectPath?: string;
  accountId?: string;
  versionControlled?: boolean;
};

export type PlainAccountLike = { id: string; origin: string; email?: string; label: string };

/** A project as a person would call it: the workspace's name when Paseo has one, else the folder's. */
export type ProjectNamer = (path: string) => string;

const defaultNamer: ProjectNamer = (path) => lastPart(path);

/**
 * The one name for a source. `accounts` names a second Claude or Codex
 * account ("· work@example.com") so two can be told apart.
 */
export function plainSourceName(source: PlainSourceLike, accounts: PlainAccountLike[] = [], projectName: ProjectNamer = defaultNamer): string {
  const project = source.projectPath ? projectName(source.projectPath) : undefined;
  const account = accounts.find((entry) => entry.id === source.accountId);
  const who = account && account.origin !== "default" && source.scope === "user" ? ` · ${account.email ?? account.label}` : "";
  const shared = source.versionControlled ? " (shared with the team)" : "";
  const file = lastPart(source.path);
  switch (source.kind) {
    case "claude-managed":
      return "Your organisation's instructions for Claude";
    case "claude-md":
      if (source.scope === "user") return `Your instructions for Claude${who}`;
      // AGENTS.md is the project's instructions for every agent; CLAUDE.md is Claude's own.
      return `Project instructions for Claude · ${project ?? "this project"}${shared}`;
    case "claude-local":
      return `Your private project instructions · ${project ?? "this project"}`;
    case "claude-rule":
      return source.scope === "user" ? `Your extra instructions for Claude · ${stem(source.path)}${who}` : `Extra project instructions · ${project ?? "this project"} · ${stem(source.path)}${shared}`;
    case "claude-import":
      return `Instructions included from another note · ${stem(source.path)}`;
    case "claude-auto-memory":
      return project ? `Claude's notes for ${project}` : "Claude's notes for a project not found on this computer";
    case "agents-md":
      if (source.scope === "user") return file.startsWith("AGENTS.override") ? `Your priority instructions for Codex${who}` : `Your instructions for Codex${who}`;
      return `Project instructions · ${project ?? "this project"}${shared}`;
    case "codex-memory":
      return file === "memory_summary.md" ? `What Codex has learned · short version${who}` : `What Codex has learned${who}`;
    case "codex-generated":
      return `Codex's working notes · ${stem(source.path)}`;
    case "codex-config":
      return "Instructions in Codex's settings";
    case "paseo-prompt":
      return "Instructions for every agent on this computer";
    case "opencode-md":
      return source.scope === "user" ? "Your instructions for OpenCode" : `Project instructions for OpenCode · ${project ?? "this project"}${shared}`;
    case "opencode-config":
      return "Instructions listed in OpenCode's settings";
    case "pi-md":
      return source.scope === "user" ? `Your instructions for pi · ${stem(source.path)}` : `Project instructions for pi · ${project ?? "this project"}${shared}`;
    case "omp-md":
      return source.scope === "user" ? `Your instructions for Oh My Pi · ${stem(source.path)}` : `Project instructions for Oh My Pi · ${project ?? "this project"}${shared}`;
    case "omp-generated":
      return "What Oh My Pi has learned";
    case "copilot-md":
      return source.scope === "user" ? `Your instructions for Copilot · ${stem(source.path)}` : `Project instructions for Copilot · ${project ?? "this project"}${shared}`;
    case "copilot-memory":
      return "What Copilot remembers (kept online)";
    default:
      return `Notes for ${plainAgent(source.agent)}`;
  }
}

/** What a load-plan row is, in the same words as the source it points at. */
export function plainPlanItemName(item: { kind: string; scope?: string; path?: string; label: string }, agent: string, directory: string, projectName: ProjectNamer = defaultNamer): string {
  const path = item.path ?? item.label;
  const projectPath = item.scope === "project" ? directory : undefined;
  const owner = item.kind === "agents-md" ? "codex" : agent;
  const name = plainSourceName({ kind: item.kind, scope: item.scope ?? "user", agent: owner, path, ...(projectPath ? { projectPath } : {}) }, [], projectName);
  // A file in a folder inside the project (read when the agent works there) says which folder.
  const folder = path.split("/").slice(0, -1).join("/");
  const inner = projectPath && item.kind !== "claude-auto-memory" && folder.startsWith(`${directory}/`) && !/\/\.(claude|github|omp)$/.test(folder) ? lastPart(folder) : "";
  return inner ? `${name} · ${inner} folder` : name;
}

/**
 * Codex's own working files: raw memories, rollout summaries, extensions, the
 * working diff, its database, and anything else read-only that Codex owns
 * (instructions in its settings file). Plain mode leaves them out of lists,
 * counts and search; they show with technical details on. "What Codex has
 * learned" is not one of them.
 */
export function isCodexInternal(source: { kind: string; agent?: string; access?: string }): boolean {
  if (source.kind === "codex-generated" || source.kind === "codex-config") return true;
  return source.agent === "codex" && source.access === "read-only" && source.kind !== "codex-memory";
}

// ------------------------------------------------------------------ sizes

function roundTo(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step);
}

/** "about 1,200 words" from the ≈token estimate (tokens × 0.75), rounded to a friendly number. */
export function plainWords(tokens: number): string {
  const words = tokens * 0.75;
  if (words <= 0) return "nothing";
  if (words < 15) return "a few words";
  const step = words < 100 ? 10 : words < 1000 ? 50 : words < 10_000 ? 100 : 1000;
  return `about ${roundTo(words, step).toLocaleString("en-AU")} words`;
}

/** Bytes to "about N words", for files known only by size. */
export function plainWordsFromBytes(bytes: number): string {
  return plainWords(Math.ceil(Math.max(0, bytes) / 4));
}

// ------------------------------------------------------------------ Claude memory types

export const PLAIN_MEMORY_TYPES: Record<string, string> = {
  user: "About you",
  feedback: "How you like things done",
  project: "About this project",
  reference: "Where to find things",
};

export function plainMemoryType(type: string | undefined): string {
  return type ? PLAIN_MEMORY_TYPES[type] ?? "Other" : "About this project";
}

// ------------------------------------------------------------------ load plans

/** Tags on a load-plan row. Read at the start: no tag. */
export function plainWhen(when: string): string {
  return ({ "on-demand": "Read when needed", skipped: "Not read", missing: "Not written yet" } as Record<string, string>)[when] ?? "";
}

// ------------------------------------------------------------------ notices

/** Why a source can't be changed here, in plain words. Server reasons are technical; this replaces them. */
export function plainReadOnly(source: { kind: string; access: string; reason?: string }): string {
  if (source.access === "online") return "This is kept online, not on this computer, so it can't be changed here.";
  switch (source.kind) {
    case "claude-managed":
      return "Your organisation sets this, so it can't be changed here.";
    case "codex-generated":
      return "Codex rebuilds this itself, so a change here would be lost.";
    case "codex-config":
    case "opencode-config":
      return "This lives in the agent's settings file, so it can't be changed here.";
    case "omp-generated":
      return "Oh My Pi rebuilds this itself, so a change here would be lost.";
    case "codex-memory":
      return "Changes to Codex's own notes are turned off in the Memories settings.";
    case "claude-import":
      return "Another note pulls this in. Open it where it lives to change it.";
    default:
      // No plain wording for this case: the host's own reason says why.
      return source.reason || "This can't be changed here.";
  }
}

export const PLAIN = {
  header: { title: "Memories", caption: "What your agents remember and follow" },
  tabs: {
    overview: "What your agents remember on this computer, and the one thing to look at next.",
    user: "Notes that go with you into every project.",
    projects: "Notes that belong to one project.",
    transfer: "Bring notes in from somewhere else, or take a copy with you.",
    guide: "Short how-tos for the things people most often want to do.",
  },
  tabLabels: { overview: "Overview", user: "Everywhere", projects: "Projects", transfer: "Import & Export", guide: "Guide" },
  checking: "Checking",
  refresh: "Refresh",
  shared: "Everyone who works on this project will see these notes.",
  sharedShort: "Everyone who works on this project will see this note.",
  codexRewrites: "Codex rewrites these notes in its own words when it next runs, so the wording may change.",
  codexPending: "Codex is still tidying its notes. Changes you make now will be folded in when it finishes.",
  codexBusy: "Codex is tidying its notes right now, so saving is paused. Try again in a few minutes.",
  codexUnsure: "It isn't clear whether Codex is busy with its notes, so saving is paused to be safe.",
  codexKeepFirstLine: 'Keep "v1" as the first line, or Codex starts this list again from scratch.',
  longNote: "This is long. Agents follow shorter instructions more closely.",
  missingNotes: "Claude's list of notes mentions some that are gone.",
  unlistedNotes: "Claude may not find some of these notes: they are missing from its list.",
  tooLong: "Claude only reads the start of its list of notes, and this one is longer than that.",
  replacesPi: "This replaces pi's own built-in instructions.",
  notThere: "Nothing is written here yet.",
  cantOpen: "This is too large to show here.",
  secretHidden: (count: number) => `${count === 1 ? "Something" : `${count} things`} that look like a password or key ${count === 1 ? "is" : "are"} hidden. Show ${count === 1 ? "it" : "them"} to change this note.`,
  secretShown: (count: number) => `${count === 1 ? "Something" : `${count} things`} that look like a password or key ${count === 1 ? "is" : "are"} shown.`,
  secretWarning: "This note contains something that looks like a password or key. Anyone whose agent reads it can see it. Remove it?",
  changedElsewhere: "This changed somewhere else since you opened it. Load the new version (your changes here are dropped), or keep going; saving will then ask you to load it first.",
  saved: "Saved. New agents will follow it; agents already running won't see it until they restart.",
  savedShort: "Saved.",
  nothingChanged: "Nothing changed, so nothing was saved.",
  notSaved: "Not saved.",
  backupNote: "A copy of the old version was kept, so this can be undone.",
  whereSaved: "Where it's saved",
  technical: "Technical details",
  wholeFile: "Edit the whole file (technical)",
  pickLeft: { title: "Pick something on the left", body: "Each row is a set of notes an agent reads. Open one to read it, change it or add to it." },
  back: "‹ Back to the list",
  emptyUser: "No agent has notes of its own on this computer yet. Use Add a note to write the first one.",
  emptyProjects: "No project has notes yet. Open a project in Paseo, then use Add a note.",
  nothingYet: { title: "Nothing here yet", body: "No agent on this computer has notes yet. Use Add a note to write the first one." },
  reading: (what: string) => `Reading ${what}`,
  tidy: {
    title: "Worth a look",
    none: "Nothing needs your attention.",
    guess: "This is a guess: check before changing anything.",
    show: "Show me",
    more: (count: number) => `${count} more`,
    allGood: { title: "Everything looks tidy", detail: "Nothing needs your attention. To teach your agents something new, use Add a note." },
  },
  search: {
    title: "Find a note",
    placeholder: "Search every note, for example: invoices",
    button: "Search",
    busy: "Searching",
  },
  overview: {
    primary: "Add a note",
    primaryHint: "Tell your agents something once, and they follow it from then on.",
    nextStep: "NEXT STEP",
    remember: "What your agents remember",
    projectNotes: "Notes in your projects",
    projectNotesHint: "Instructions that belong to one project",
    readAtStart: (words: string) => `${words} read at the start`,
  },
  notes: {
    heading: "Notes",
    none: "There are no notes here yet.",
    add: "Add a note",
    change: "Change",
    remove: "Remove",
    removeQuestion: "Remove this note? A copy of the old version is kept, so it can be put back.",
    removeConfirm: "Yes, remove it",
    keep: "Keep it",
    copy: "Copy to another agent",
    save: "Save",
    cancel: "Cancel",
    titleLabel: "Title",
    textLabel: "What it says",
    topTitle: "At the top",
    emptyBody: "Nothing under this heading yet.",
    readOnly: "These notes can be read here but not changed.",
  },
  memory: {
    heading: (count: number) => (count === 1 ? "1 note" : `${count} notes`),
    new: "New note",
    newTitle: "New note for Claude",
    title: "Title",
    titlePlaceholder: "Invoices go out on the 1st",
    summary: "Short summary",
    summaryHint: "One line Claude reads first to decide whether this note matters.",
    kind: "What kind of note",
    body: "What should Claude remember",
    save: "Save",
    saveNew: "Save note",
    copy: "Copy or move…",
    delete: "Remove",
    deleteConfirm: "Yes, remove it",
    back: "Back to the list",
    fileName: "File name",
    rename: "Rename",
    notListed: "Claude may not find this one",
    secret: "Looks like a password or key",
    firstNote: "This project has no notes from Claude yet; the first one you save starts them.",
  },
  prompt: {
    note: "Agents started from now on follow these; agents already running keep what they started with. Copilot doesn't get them.",
    placeholder: "Nothing here yet.",
  },
  addNote: {
    title: "Add a note",
    what: "What should your agents remember?",
    whatPlaceholder: "For example: Use plain words and short sentences. Invoices go out on the 1st of each month.",
    who: "Who should follow it?",
    whoAll: "All my agents",
    whoClaude: "Just Claude",
    whoCodex: "Just Codex",
    where: "Where?",
    everywhere: "Everywhere",
    onlyIn: "Only in one project",
    pickProject: "Pick a project",
    noProjects: "Paseo has no projects on this computer yet, so notes can only go everywhere.",
    next: "Check it",
    addsTo: "This adds a note to:",
    almostSame: "A note that says almost the same already exists:",
    alreadyThere: "This note is already there, so it won't be added again:",
    save: "Save",
    edit: "Change it",
    again: "Add another",
    nothingNew: "There is nowhere left to save this note: every place already has it, or wouldn't read it.",
    wontRead: "Won't be read there",
    skipped: "Not added for",
    privateNote: "Only you see this one; it isn't shared.",
    creates: "This will be the first note there.",
  },
  panel: {
    title: "Memories",
    caption: (project: string) => `What an agent started in ${project} reads`,
    captionAny: "What an agent started here reads",
    agentCaption: (agent: string) => `What this ${agent} agent reads`,
    readAtStart: (words: string) => `${words} read at the start`,
    nothing: "Nothing is read for this agent here.",
    nothingHere: { title: "Nothing is read here", body: "None of your agents have notes for this project yet." },
    open: "Open Memories",
    runningNote: "An agent that's already running keeps what it read when it started; this is what a new one would read.",
  },
  transfer: {
    import: "Import",
    export: "Export",
    importIntro: "Paste notes you exported from another computer, or any text with headings. Each heading becomes its own note.",
    pastePlaceholder: "Paste here",
    formatAuto: "Work it out",
    formatHeadings: "Split at headings",
    formatClaudeAi: "Lines from claude.ai",
    pick: "Pick files…",
    read: "Read it",
    whereTo: "WHERE TO",
    toClaude: "New notes for Claude",
    toFile: "Add to a set of instructions",
    targetHintAppend: "Each note is added at the end. To give a note to Codex, pick its instructions; Codex's own notes are never changed this way.",
    targetHintClaude: "Each note becomes one of Claude's notes for that project.",
    preview: "Check it",
    copying: (count: number) => `Copying ${count === 1 ? "1 note" : `${count} notes`} you picked. Choose where they go, check, then save.`,
    moveInstead: "Move instead: remove the originals once the copies are saved",
    noMove: "These can be copied but not moved.",
    importText: "Paste text instead",
    save: (count: number) => `Save ${count === 1 ? "1 note" : `${count} notes`}`,
    cancel: "Cancel",
    include: "Include",
    isNew: "New",
    isThere: "Already there",
    isNear: "Almost the same is there",
    isRepeat: "Repeats another one here",
    hidden: "Hidden values",
    hiddenWarning: "Some values in this text were hidden when it was exported, so they will be saved as dots.",
    everything: "Everything",
    yours: "Your own notes",
    oneProject: "One project",
    toImport: "To bring into another computer",
    toRead: "To read",
    includeSecrets: "Include values that look like passwords or keys (off: they are hidden)",
    exportButton: "Export",
    copyButton: "Copy",
    download: "Download",
    copied: "Copied.",
    cantCopy: "This app can't copy; select the text instead.",
    project: "Project",
  },
} as const;

/** A server message, in plain words when it is one of the known technical ones. */
export function plainMessage(message: string): string {
  if (/git repository/i.test(message)) return PLAIN.sharedShort;
  if (/hidden \(masked\) values/i.test(message) && /saved as they are|dots/i.test(message)) return "Some values were hidden when this was exported, so they were saved as dots.";
  if (/hidden \(masked\) values/i.test(message)) return "This still has hidden values in it. Show them first, so they aren't replaced by dots. Nothing was saved.";
  if (/changed (?:on disk )?since|changed since you opened/i.test(message)) return "This changed somewhere else since you opened it. Load it again; nothing was saved.";
  if (/section is no longer in the file/i.test(message)) return "That note has changed or gone since you opened it. Load it again; nothing was saved.";
  if (/^Saved\b|^Created\b|^Imported\b|^Copied\b/.test(message) && !/but/.test(message)) return PLAIN.saved;
  if (/^No change/.test(message)) return PLAIN.nothingChanged;
  if (/Codex hasn't finished|clean-up/i.test(message)) return PLAIN.codexPending;
  if (/replaces pi's whole base prompt/i.test(message)) return PLAIN.replacesPi;
  if (/MEMORY\.md could not be updated/i.test(message)) return "Claude's list of notes couldn't be updated, so this note was taken back out.";
  if (/Codex reads AGENTS\.md as instructions/i.test(message)) return "Codex follows these as instructions; they don't become Codex's own notes.";
  if (/look like secrets/i.test(message)) return "Holds something that looks like a password or key; it is hidden here and saved as it is.";
  return message;
}

/** Server warnings on a detail view, in plain words; unknown ones stay technical (shown only with technical details). */
export function plainDetailWarning(warning: string): string | null {
  if (/git repository/i.test(warning)) return null; // said once by the shared notice
  if (/under 200/.test(warning)) return PLAIN.longNote;
  if (/over Claude's limit/.test(warning)) return PLAIN.tooLong;
  if (/point(s)? to a file that does not exist/.test(warning)) return PLAIN.missingNotes;
  if (/not named in MEMORY\.md/.test(warning)) return PLAIN.unlistedNotes;
  if (/replaces pi's whole base prompt/.test(warning)) return PLAIN.replacesPi;
  if (/does not exist yet/.test(warning)) return PLAIN.notThere;
  if (/Too large/.test(warning)) return PLAIN.cantOpen;
  return null;
}

// ------------------------------------------------------------------ findings

function quoted(message: string): string | undefined {
  return /"([^"]{1,80})"/.exec(message)?.[1];
}

/** A finding as a heading and one line saying where. `nameOf` gives each source its plain name. */
export function plainFinding(finding: Pick<Finding, "kind" | "message" | "sourceIds">, nameOf: (sourceId: string) => string): { title: string; detail: string } {
  const places = [...new Set(finding.sourceIds.map(nameOf))];
  const where = places.length ? `In: ${places.slice(0, 3).join("; ")}${places.length > 3 ? ` and ${places.length - 3} more` : ""}.` : "";
  const about = quoted(finding.message);
  switch (finding.kind) {
    case "secret":
      return { title: "A note contains something that looks like a password or key", detail: `${where} Anyone whose agent reads it can see it. Remove it?`.trim() };
    case "duplicate":
      return { title: "Two notes say the same thing", detail: `${where} Keeping one is enough.`.trim() };
    case "conflict":
      return { title: about ? `Notes about "${about}" may disagree` : "Two notes may disagree", detail: `${where} This is a guess: check before changing anything.`.trim() };
    case "stale-path":
      return { title: "A note mentions a file or folder that no longer exists", detail: where };
    case "stale-symbol":
      return { title: "A note mentions something that is no longer in the project", detail: where };
    case "index-drift":
      return /does not exist/.test(finding.message)
        ? { title: "Claude's list of notes mentions one that's gone", detail: where }
        : { title: "Claude may not find one of its notes", detail: `${where} It is missing from Claude's list.`.trim() };
    case "over-limit":
      return { title: "A note is too long for the agent to read in full", detail: where };
    case "codex-pending":
      return { title: "Codex is still tidying its notes", detail: "Changes you make now will be folded in when it finishes." };
    default:
      return { title: "Something to look at", detail: where };
  }
}

export function plainNextStep(step: NextStep, first: Pick<Finding, "kind" | "message" | "sourceIds"> | undefined, total: number, nameOf: (sourceId: string) => string): { title: string; detail: string } {
  if (!first) return PLAIN.tidy.allGood;
  const plain = plainFinding(first, nameOf);
  void step;
  return { title: plain.title, detail: `${plain.detail}${total > 1 ? ` ${total - 1} more ${total - 1 === 1 ? "thing" : "things"} to look at below.` : ""}`.trim() };
}

// ------------------------------------------------------------------ jargon

/**
 * Words that must not reach a person in plain mode, case-insensitive.
 * Substrings, except "git" and "commit", which are whole words ("GitHub" and
 * "committee" are fine).
 */
export const JARGON = ["CLAUDE.md", "AGENTS.md", "MEMORY.md", "frontmatter", "token", "slug", "scope", "sqlite", "consolidation", "markdown", "repo", "config", "git", "commit"] as const;

const WHOLE_WORD: Record<string, RegExp> = { git: /\bgit\b/i, commit: /\bcommit(s|ted|ting)?\b/i };

export function jargonIn(text: string): string[] {
  const lower = text.toLowerCase();
  return JARGON.filter((word) => (WHOLE_WORD[word] ? WHOLE_WORD[word]!.test(text) : lower.includes(word.toLowerCase())));
}
