/**
 * Plain words for the Skills screen and panels (0.4.0): every label, intro,
 * finding and host message a person sees with "Show technical details" off.
 * No file names, no "SKILL.md", "npx", lock files or links-on-disk words;
 * the jargon test (tests/plain.test.ts) reads every string here. Pure.
 */

import { plainAgent } from "./plain";

export const SKILL_TABS = [
  { id: "overview", icon: "LayoutDashboard", label: "Overview", technical: "Overview" },
  { id: "skills", icon: "Sparkles", label: "Your skills", technical: "Skills" },
  { id: "usage", icon: "ChartColumn", label: "Usage", technical: "Usage" },
  { id: "add", icon: "Plus", label: "Add a skill", technical: "Add" },
  { id: "guide", icon: "BookOpen", label: "Guide", technical: "Guide" },
] as const;

export type SkillTabId = (typeof SKILL_TABS)[number]["id"];

/** Where a skill came from, as a person would say it. */
export function plainProvenance(provenance: string, detail?: string): string {
  switch (provenance) {
    case "paseo":
      return "Comes with Paseo";
    case "npx-skills":
      return detail ? `Installed from ${detail}` : "Installed with the skills installer";
    case "added-here":
      return detail && detail !== "written here" ? `Added here from ${detail}` : "Added here";
    case "claude-plugin":
      return detail ? `Part of the ${detail} plugin for Claude` : "Part of a Claude plugin";
    case "claude-ai":
      return "From your claude.ai account";
    case "codex-builtin":
      return "Built into Codex";
    case "managed":
      return "Set up by your organisation";
    case "project":
      return "Belongs to one project";
    default:
      return "Added by hand";
  }
}

/** The same, in the file-level words of the technical view. */
export function technicalProvenance(provenance: string, detail?: string): string {
  const base: Record<string, string> = {
    paseo: "Paseo-managed (.paseo-managed-files.json)",
    "npx-skills": "npx skills lock entry",
    "added-here": "Added by this plugin",
    "claude-plugin": "Claude Code plugin",
    "claude-ai": "claude.ai synced",
    "codex-builtin": "Codex .system",
    managed: "Managed",
    project: "Project folder",
    "by-hand": "Added by hand",
  };
  return `${base[provenance] ?? provenance}${detail ? ` · ${detail}` : ""}`;
}

/** Who reads a skill: "Claude, Codex and 4 more". */
export function plainReaders(agents: readonly string[]): string {
  const order = ["claude", "codex"];
  const sorted = [...agents].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const names = [...new Set(sorted.map((agent) => (agent === "gemini" ? "Gemini" : agent === "cursor" ? "Cursor" : plainAgent(agent))))];
  if (names.length <= 3) return names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** About N words, from characters (≈4 characters a token, ≈0.75 words a token). */
export function plainWordsFromChars(chars: number): string {
  const words = Math.round((chars / 4) * 0.75);
  if (words < 1000) return `about ${Math.max(10, Math.round(words / 10) * 10).toLocaleString("en-US")} words`;
  return `about ${(Math.round(words / 100) * 100).toLocaleString("en-US")} words`;
}

/** An agent's state for a skill, in a word or two; "" when it is simply on. */
export function plainState(state: string | undefined): string {
  switch (state) {
    case "off":
      return "Off";
    case "mixed":
      return "Off for some accounts";
    case "name-only":
      return "Name only";
    case "user-invocable-only":
      return "Only when you ask";
    case "model-off":
      return "Only when you ask";
    default:
      return "";
  }
}

/** A "Worth a look" finding in plain words; the host's own message is the technical view's. */
export function plainSkillFinding(finding: { kind: string; message: string }): { title: string; detail: string } {
  const name = finding.message.split(/[ :]/)[0] ?? "";
  switch (finding.kind) {
    case "broken-link":
      return { title: "A skill that points to nothing", detail: `${name} leads to a skill that's no longer there. Removing it changes nothing for your agents.` };
    case "empty-folder":
      return { title: "An empty skill", detail: `${name} has nothing in it. Moving it out of the way changes nothing for your agents.` };
    case "stray-file":
      return { title: "A packed file agents don't read", detail: `${name} sits with your skills, but agents can't use a packed file. It can go to the backups.` };
    case "invalid":
      return /instructions file/.test(finding.message)
        ? { title: "A skill without instructions", detail: `${name} has no instructions, so agents skip it.` }
        : { title: "A skill agents may not read properly", detail: plainSkillMessage(finding.message) };
    case "duplicate":
      return { title: "Two different skills with one name", detail: plainSkillMessage(finding.message) };
    case "unused": {
      const count = /^(\d[\d,]*)/.exec(finding.message)?.[1] ?? "Some";
      return { title: `${count} skills not used lately`, detail: "They weren't used on this computer in that time, but every chat still starts by reading their descriptions. Turning some off makes room for the ones you use." };
    }
    case "over-budget":
      return { title: "Claude's list of skills is too long", detail: "Claude cuts some descriptions short to fit, so it may miss when to use them. Turning off skills you don't use helps." };
    case "paseo-orphan":
      return { title: "An old skill from Paseo", detail: `${name} came with an earlier Paseo. Nothing updates or removes it now; it can go to the backups.` };
    case "lock-missing": {
      const listed = /lists (\S+)/.exec(finding.message)?.[1] ?? "a skill";
      return { title: "A skill listed but not here", detail: `The skills installer still lists ${listed}, but it isn't on this computer. Taking it off the list changes nothing for your agents.` };
    }
    default:
      return { title: "Worth a look", detail: plainSkillMessage(finding.message) };
  }
}

/** A host message in plain words: file and tool names swapped for what they are. */
export function plainSkillMessage(message: string): string {
  return message
    .replace(/SKILL\.md/g, "instructions file")
    .replace(/npx skills' list of installed skills/g, "the skills installer's list")
    .replace(/npx skills' list/g, "the skills installer's list")
    .replace(/The skills record kept by npx skills/g, "The skills installer's list")
    .replace(/npx skills/g, "the skills installer")
    .replace(/In a project folder tracked by git: a change here is shared with everyone on the project\./g, "Everyone who works on this project shares it.")
    .replace(/ ?\(it isn't valid JSON\)/g, "")
    .replace(/It contains \S+, which marks it/g, "It contains a file that marks it")
    .replace(/\btokens?\b/g, "words")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The "+" on the sidebar's Skills row. */
export const ADD_SKILL_LABEL = "Add a skill";

export const SKILLS_PLAIN = {
  name: "Skills",
  status: {
    checking: (host: string) => `Checking the skills on ${host}`,
    cantRead: (host: string) => `Couldn't read the skills on ${host}`,
    on: (host: string) => `Your agents' skills on ${host}`,
  },
  intros: {
    skills: {
      title: "Your skills",
      summary: "Every skill your agents can use on this computer, grouped by where it lives. Open one to see what it does, turn it off for an agent, or remove it.",
      canDo: ["See which agents can use each skill", "Turn a skill off for Claude or Codex without deleting it", "Remove a skill you added (a copy is kept)", "Read a skill's instructions and files"],
    },
    usage: {
      title: "Usage",
      summary: "Which skills your agents actually used, and how often, from their chat history on this computer.",
      canDo: ["See the busiest skills and when each was last used", "Spot skills nobody uses that still take up room in every chat", "Pick 7, 30 or 90 days"],
    },
    add: {
      title: "Add a skill",
      summary: "Pick one from our list, bring one from GitHub, or write your own. You always see exactly what will be added first.",
      canDo: ["Add a well-known skill in one go", "Bring a skill from a GitHub link", "Write a skill in plain words", "See every file before anything is added"],
    },
    guide: {
      title: "Guide",
      summary: "What skills are, how agents use them, and how to keep the list short and useful.",
      canDo: ["Learn how agents decide to use a skill", "See why a short list works better", "Learn what can't be changed here, and why"],
    },
  },
  hero: {
    loading: { title: "Checking your agents' skills", lead: "Reading every agent's skills on this computer. This takes a moment." },
    cantRead: "Couldn't read your agents' skills",
    none: { title: "No skills yet", lead: "Skills teach your agents how to do one kind of job well. Add your first one to get started." },
    tidy: "All set: your skills look tidy",
    tidyLead: "Your agents can use every skill listed here.",
    attention: "Something needs your attention",
    worth: (count: number) => (count === 1 ? "One thing is worth a look" : `${count} things are worth a look`),
  },
  rows: {
    claude: "Claude can use",
    codex: "Codex can use",
    others: "Other agents can use",
    used: "Used lately",
    skills: (count: number) => `${count} ${count === 1 ? "skill" : "skills"}`,
    listCost: (words: string) => `${words} at the start of every chat`,
    usedValue: (skills: number, uses: number) => `${skills} ${skills === 1 ? "skill" : "skills"} · ${uses} ${uses === 1 ? "use" : "uses"}`,
    usedHint: (days: number) => `in the last ${days} days`,
    countingOff: "Off in the settings",
    counting: "Still counting",
  },
  lastCounted: (time: string) => `Use counted at ${time}.`,
  checked: (time: string) => `Checked at ${time}.`,
  overLimit: "Too long: some descriptions get cut",
  allWorth: (count: number) => (count === 1 ? "See the one thing worth a look" : `See all ${count} things worth a look`),
  hideWorth: "Hide the list",
  show: "Show me",
  fix: "Fix it",
  addButton: "Add a skill",
  seeSkills: "Your skills",
  newTo: "New to Skills? How it works",
  about: {
    whatIsTitle: "What are skills?",
    whatIs: [
      "A skill is a short set of instructions that teaches an agent one kind of job, such as testing a web page or writing release notes. Agents see every skill's name and description at the start of a chat, and read the full instructions only when the job comes up.",
      "Skills shows every skill your agents can use on this computer, which ones they actually use, and lets you add, turn off or remove them safely.",
    ],
    howTitle: "How it works",
    flow: [
      { icon: "Plus", title: "You add a skill", text: "From our list, from GitHub, or written here." },
      { icon: "ListChecks", title: "Agents see the list", text: "Each chat starts with every skill's name and description." },
      { icon: "Bot", title: "A job comes up", text: "The agent reads the matching skill's instructions and follows them." },
      { icon: "ChartColumn", title: "You see what's used", text: "Usage shows which skills ran; the rest can be turned off." },
    ],
    flowNote: "The list is read at the start of every chat, so a short list of skills you use works best.",
    useTitle: "How to use it",
    steps: [
      "Press Add a skill, pick one, and read what it will add before you confirm.",
      "Start a new chat: the agent uses the skill when the job comes up.",
      "Now and then, open Usage. Turn off skills nobody uses so the list stays short.",
      "Open Your skills to read a skill, turn it off for one agent, or remove it.",
    ],
    wordsTitle: "Words you'll see",
    words: [
      { icon: "Sparkles", term: "Skill", text: "Instructions for one kind of job. An agent reads them only when that job comes up." },
      { icon: "List", term: "The skill list", text: "Every skill's name and description, read at the start of each chat. Long lists get cut short." },
      { icon: "Share2", term: "Shared skills", text: "Skills most agents read from one place on this computer: Codex, OpenCode, Copilot, Gemini, Cursor and pi." },
      { icon: "Power", term: "Turned off", text: "Still on this computer, but that agent no longer sees it. Nothing is deleted." },
      { icon: "FileCode", term: "Includes code", text: "Files an agent might run, not just read. You see them, and confirm, before such a skill is added." },
      { icon: "Lock", term: "Can't be changed here", text: "Skills that Paseo, a plugin, claude.ai or your organisation looks after. Opening one says why." },
    ],
  },
  list: {
    groups: {
      shared: "Shared by your agents",
      claude: "Claude only",
      codex: "Codex only",
      project: "In your projects",
      other: "Looked after elsewhere",
    } as Record<string, string>,
    filterAll: "All agents",
    search: "Find a skill by name or what it does",
    none: "No skill matches.",
    empty: "No agent on this computer has any skills yet. Use Add a skill to add the first one.",
    back: "Back to the list",
    usedTimes: (count: number) => `Used ${count}×`,
    notUsed: "Not used lately",
    readOnly: "Can't be changed here",
    checkedFolders: (count: number) => `Checked ${count} places agents look for skills.`,
  },
  detail: {
    from: "Where it came from",
    who: "Who can use it",
    listCost: "In every chat's list",
    files: (count: number) => `${count} ${count === 1 ? "file" : "files"}`,
    filesWithCode: (count: number, code: number) => `${count} ${count === 1 ? "file" : "files"}, ${code} with code`,
    showInstructions: "Read its instructions",
    showFiles: "See its files",
    code: "may run",
    turnOff: (agent: string) => `Turn off for ${agent}`,
    turnOn: (agent: string) => `Turn on for ${agent}`,
    remove: "Remove",
    removeQuestion: "Remove this skill? A copy goes to this plugin's backups, so it can be put back.",
    removeYes: "Yes, remove it",
    keep: "Keep it",
    whyNotOff: "Why it can't be turned off here",
    whyNotRemove: "Why it can't be removed here",
    used: (count: number, when: string) => `Used ${count}× · last ${when}`,
    neverUsed: "Not used lately on this computer",
    estimated: "Codex's count is an estimate.",
    runs: "Can run commands",
    shared: "Everyone who works on this project shares it.",
  },
  usage: {
    days: (n: number) => `${n} days`,
    total: (uses: number, skills: number) => `${uses} ${uses === 1 ? "use" : "uses"} of ${skills} ${skills === 1 ? "skill" : "skills"}`,
    none: (days: number) => `No skill was used in the last ${days} days on this computer.`,
    by: (claude: number, codex: number) => [claude ? `Claude ${claude}` : "", codex ? `Codex about ${codex}` : ""].filter(Boolean).join(" · "),
    typed: (count: number) => `${count} asked for by name`,
    lastUsed: (when: string) => `last ${when}`,
    neverTitle: (count: number) => `${count} ${count === 1 ? "skill" : "skills"} not used in this time`,
    neverHint: "They're still in every chat's list. Turn off the ones you don't need.",
    estimated: "Claude records every skill it uses, so its counts are exact. Codex doesn't, so its counts are estimates.",
    off: "Counting skill use is turned off in the settings.",
    waiting: "Reading chat history for the first time; counts appear when it's done.",
    partial: "Chat history is still being read; these counts are partial.",
  },
  add: {
    modes: { catalog: "From our list", github: "From GitHub", write: "Write your own" } as Record<string, string>,
    catalogNote: "Each one is pinned to the exact version we checked, so what you see is what gets added.",
    hasCode: "Includes code",
    added: "Already added",
    preview: "Preview",
    linkLabel: "GitHub link",
    linkPlaceholder: "github.com/owner/project/tree/main/skills/name",
    pick: "This link holds several skills. Pick one:",
    nameLabel: "Name",
    namePlaceholder: "release-notes",
    nameHint: "Lower-case letters, digits and hyphens.",
    whenLabel: "When should agents use it?",
    whenPlaceholder: "When asked for release notes, or before a new version goes out.",
    howLabel: "What should they do?",
    howPlaceholder: "1. List what changed since the last version.\n2. Write three short sections: new, fixed, changed.",
    check: "Check it",
    whatWillBeAdded: "What will be added",
    whereItGoes: "Where it goes",
    files: "Files",
    instructions: "Its instructions",
    codeWarning: "This skill includes code your agents may run. Read the file list before you add it.",
    codeConfirm: "I've looked at the files and want to add it",
    addIt: "Add it",
    startOver: "Back",
    whereShared: "The shared skills place, which Codex, OpenCode, Copilot, Gemini, Cursor and pi read",
    whereClaude: (count: number) => (count === 1 ? "A link so Claude sees it too" : `A link so Claude sees it too (${count} accounts)`),
    whereList: "The skills installer's list, so it can update it later",
    restartNote: "New chats see it straight away; chats already open may need a restart.",
    linkForClaude: "Link it for Claude",
    linkForClaudeHint: "Claude doesn't see this skill in every account yet.",
  },
  panel: {
    title: "Skills",
    count: (count: number, words: string) => `${count} ${count === 1 ? "skill" : "skills"} · ${words} at the start of every chat`,
    usedHere: "Used here lately",
    usedChat: "Used in this chat",
    usedChatGuess: "Used in this folder since this agent started",
    noneUsed: "None yet.",
    unknown: "Which skills this chat used can't be told for this agent.",
    all: (count: number) => `All ${count} skills agents here can use`,
    allAgent: (count: number) => `All ${count} skills this agent can use`,
    open: "Open Skills",
  },
};

/** "today", "yesterday", "5 days ago": when something last happened. */
export function sinceText(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "earlier";
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

type ReportLike = { target: string; ok: boolean; action: string; error?: string; backupPath?: string };

/** The account a folder belongs to, as the app names it: "default" for the usual folder, else the account's own folder name. */
function accountName(dir: string, home: string, usual: string): string {
  if (dir === `${home}/${usual}`) return "default";
  return dir.split("/").filter(Boolean).pop() ?? dir;
}

/** A place a change touched, in plain words. */
export function plainPlace(path: string, home: string): string {
  const parts = path.split("/");
  const name = parts[parts.length - 1] ?? path;
  const parent = parts.slice(0, -1).join("/");
  if (/\/plugin-data\/paseo-memories\/backups\//.test(path)) return "This plugin's backups";
  if (name === ".skill-lock.json" || name === "skills-lock.json") return "The skills installer's list";
  if (name === "settings.json") return `Claude's settings (${accountName(parent, home, ".claude")})`;
  if (name === "config.toml") return `Codex's settings (${accountName(parent, home, ".codex")})`;
  if (parent === `${home}/.agents/skills`) return `The shared skills place (${name})`;
  const at = parts.lastIndexOf("skills");
  if (at > 0) {
    const account = parts.slice(0, at).join("/");
    if (account === `${home}/.claude` || /\/accounts\/claude\/[^/]+$/.test(account) || /\/\.claude-accounts\/[^/]+$/.test(account) || parts.includes(".claude")) return `Claude's skills (${accountName(account, home, ".claude")})`;
    if (parts.includes(".codex") || /\/accounts\/codex\//.test(account)) return `Codex's skills (${accountName(account, home, ".codex")})`;
    if (parts.includes(".pi")) return "pi's skills";
  }
  return name;
}

/** What happened at that place, in plain words. */
function plainOutcome(report: ReportLike): string {
  if (!report.ok) return report.error ? plainSkillMessage(report.error) : "Not changed.";
  if (report.backupPath?.endsWith(".link.json")) return "Link taken away (noted in the backups).";
  switch (report.action) {
    case "moved":
    case "copied-and-deleted":
    case "deleted":
      return "Moved to the backups.";
    case "created":
      return "Added.";
    case "updated":
      return "Changed.";
    case "unchanged":
      return "Already as asked; nothing to change.";
    default:
      return "Done.";
  }
}

/**
 * One line per place an add, remove, turn off/on or fix touched: where, and
 * whether it was done (or not, and why). Plain: names a person knows;
 * technical: the path and the host's own words.
 */
export function reportLines(reports: readonly ReportLike[], plain: boolean, home: string): Array<{ place: string; state: string; ok: boolean }> {
  return reports.map((report) =>
    plain
      ? { place: plainPlace(report.target, home), state: plainOutcome(report), ok: report.ok }
      : { place: report.target, state: [report.action, report.error ?? "", report.backupPath ? `backup: ${report.backupPath}` : ""].filter(Boolean).join(" · "), ok: report.ok },
  );
}

/** "Changed in 3 places; 1 wasn't." */
export function reportSummary(lines: ReadonlyArray<{ ok: boolean }>): string {
  const done = lines.filter((line) => line.ok).length;
  const not = lines.length - done;
  const places = (n: number) => `${n} ${n === 1 ? "place" : "places"}`;
  return not ? `Done in ${places(done)}; ${not === 1 ? "1 wasn't" : `${not} weren't`}.` : `Done in ${places(done)}.`;
}
