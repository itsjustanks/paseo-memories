/**
 * Skill uses read out of agent chat logs, one line at a time, and the small
 * tallies kept from them. Pure: the host (server/skill-usage.ts) streams the
 * files and keeps only what these return.
 *
 * Claude Code (checked against this machine's logs, 2026-10-04): the model's
 * use is an `assistant` line whose `message.content[]` holds
 * `{type:"tool_use", name:"Skill", input:{skill}}`, in the main chat and in
 * helper (subagent) logs alike; a person typing `/name` is a `user` line
 * holding `<command-name>/name</command-name>` (content a string or text
 * blocks). Every line carries `sessionId`, `cwd` and `timestamp`; a helper's
 * `sessionId` is its parent chat's. Exact.
 *
 * Codex (codex-cli 0.156): no event records a skill use. Estimated from a
 * `<skill><name>…</name>` block in a user message (an explicit use, as Paseo
 * sends it), and from a tool call that reads `…/skills/<name>/SKILL.md`
 * (`skillReads`: reads only, never lists, edits or writes). At most one use per skill per turn. The thread
 * id and folder come from `session_meta`.
 */

export const DAY_MS = 86_400_000;
/** Daily tallies are kept this long. */
export const KEEP_DAYS = 90;

export type UseAgent = "claude" | "codex";

/** A skill name as logs spell it, cleaned: no leading slash, no spaces or markup, at most 200 characters. */
export function cleanSkillName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/^\/+/, "");
  if (!name || name.length > 200 || /[\s<>"'`\\]/.test(name)) return null;
  return name;
}

function timeOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** UTC day number of a time. */
export function dayOf(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

// ------------------------------------------------------------------ Claude

const COMMAND = /<command-name>\s*\/?([^<\s]{1,200})\s*<\/command-name>/g;

/** Substrings at least one of which every interesting Claude line holds; checked on raw bytes before any parse. */
export const CLAUDE_MARKERS = ["<command-name>", '"Skill"'] as const;

export type ClaudeLine = { uses: Array<{ at: number; skill: string; typed: boolean }>; cwd?: string; sessionId?: string };

/** The uses in one line of a Claude Code chat log; null when it holds none or is not JSON. */
export function claudeUsesInLine(line: string): ClaudeLine | null {
  if (!line.includes(CLAUDE_MARKERS[0]) && !line.includes(CLAUDE_MARKERS[1])) return null;
  let event: { type?: unknown; timestamp?: unknown; cwd?: unknown; sessionId?: unknown; isMeta?: unknown; message?: { content?: unknown } };
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;
  const at = timeOf(event.timestamp);
  if (at === null) return null;
  const uses: ClaudeLine["uses"] = [];
  const content = event.message?.content;
  if (event.type === "assistant" && Array.isArray(content)) {
    for (const block of content as Array<{ type?: unknown; name?: unknown; input?: { skill?: unknown } }>) {
      if (!block || block.type !== "tool_use" || block.name !== "Skill") continue;
      const skill = cleanSkillName(block.input?.skill);
      if (skill) uses.push({ at, skill, typed: false });
    }
  } else if (event.type === "user" && event.isMeta !== true) {
    const texts =
      typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? (content as Array<{ type?: unknown; text?: unknown }>).filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text as string)
          : [];
    for (const text of texts) {
      for (const match of text.matchAll(COMMAND)) {
        const skill = cleanSkillName(match[1]);
        if (skill) uses.push({ at, skill, typed: true });
      }
    }
  }
  if (uses.length === 0) return null;
  return { uses, ...(typeof event.cwd === "string" ? { cwd: event.cwd } : {}), ...(typeof event.sessionId === "string" ? { sessionId: event.sessionId } : {}) };
}

// ------------------------------------------------------------------ Codex

const SKILL_BLOCK = /<skill>\s*<name>\s*([^<\s]{1,200})\s*<\/name>/g;
const SKILL_FILE = /\/skills\/(?:\.system\/)?([A-Za-z0-9._-]{1,100})\/SKILL\.md/g;

export const CODEX_MARKERS = ["SKILL.md", "<skill>", '"session_meta"', '"turn_context"'] as const;

export type CodexLine =
  | { kind: "meta"; cwd?: string; threadId?: string }
  | { kind: "turn"; cwd?: string }
  | { kind: "uses"; at: number; skills: string[]; typed: boolean };

/** One line of a Codex session log: its folder and thread, a new turn, or the skills it used; null for anything else. */
export function codexLine(line: string): CodexLine | null {
  if (!CODEX_MARKERS.some((marker) => line.includes(marker))) return null;
  let event: { type?: unknown; timestamp?: unknown; payload?: Record<string, unknown> };
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  const payload = event?.payload;
  if (!payload || typeof payload !== "object") return null;
  if (event.type === "session_meta") {
    return { kind: "meta", ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}), ...(typeof payload.id === "string" ? { threadId: payload.id } : {}) };
  }
  if (event.type === "turn_context") return { kind: "turn", ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}) };
  if (event.type !== "response_item") return null;
  const at = timeOf(event.timestamp);
  if (at === null) return null;
  const found = new Set<string>();
  let typed = false;
  if (payload.type === "message" && payload.role === "user" && Array.isArray(payload.content)) {
    for (const block of payload.content as Array<{ text?: unknown }>) {
      if (typeof block?.text !== "string") continue;
      for (const match of block.text.matchAll(SKILL_BLOCK)) {
        const skill = cleanSkillName(match[1]);
        if (skill) {
          found.add(skill);
          typed = true;
        }
      }
    }
  } else if (payload.type === "function_call" || payload.type === "custom_tool_call" || payload.type === "local_shell_call") {
    for (const skill of skillReads(payload)) found.add(skill);
  }
  if (found.size === 0) return null;
  return { kind: "uses", at, skills: [...found], typed };
}

/** Tools that only read a file, and tools that change one (Codex and common MCP names). */
const READ_TOOLS = new Set(["read_file", "view", "view_file", "open_file", "read"]);
const WRITE_TOOLS = new Set(["apply_patch", "write_file", "edit_file", "create_file", "str_replace", "write", "edit"]);
/** Commands that read a file without changing it. */
const READERS = new Set(["cat", "sed", "head", "tail", "less", "more", "bat", "nl", "awk", "grep", "rg", "view", "wc", "type", "Get-Content"]);
/** What may come before the command itself: shells, their flags, env and sudo. */
const WRAPPERS = new Set(["bash", "sh", "zsh", "-lc", "-c", "-l", "sudo", "env", "command", "exec"]);

/** The command text of a tool call: `cmd`/`command` from JSON arguments (string or argv), else the raw text. */
function commandText(payload: Record<string, unknown>): string {
  const pieces: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string") pieces.push(value);
    else if (Array.isArray(value)) pieces.push(value.filter((part) => typeof part === "string").join(" "));
  };
  for (const raw of [payload.arguments, payload.input]) {
    if (typeof raw !== "string") continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        for (const key of ["cmd", "command", "path", "file_path", "filePath"]) add(parsed[key]);
        continue;
      }
    } catch {
      // not JSON: the text is the command
    }
    pieces.push(raw);
  }
  add((payload.action as { command?: unknown } | undefined)?.command);
  return pieces.join("\n");
}

/** Does this one command (no `;`, `&&`, pipes) read the file it names, rather than list, write or change it? */
function readsInSegment(segment: string): boolean {
  if (/>{1,2}\s*\S*SKILL\.md/.test(segment)) return false;
  const words = segment.trim().split(/\s+/).map((word) => word.replace(/^['"(]+|['")]+$/g, ""));
  let i = 0;
  while (i < words.length && (WRAPPERS.has(words[i]!) || /^[A-Z_][A-Z0-9_]*=/.test(words[i]!))) i += 1;
  const verb = words[i] ?? "";
  if (!READERS.has(verb)) return false;
  if (verb === "sed" && words.slice(i + 1).some((word) => /^-[a-zA-Z]*i/.test(word) || word.startsWith("--in-place"))) return false;
  return true;
}

/**
 * Skills whose SKILL.md this tool call read (Codex's sign that it used one).
 * Only reads count: `read_file`-style tools, and shell commands such as
 * `cat`, `sed -n`, `head` or `less` on a `…/skills/<name>/SKILL.md`. Listing
 * (`ls`), editing (`apply_patch`, `sed -i`), creating and writing don't.
 */
export function skillReads(payload: Record<string, unknown>): string[] {
  const tool = typeof payload.name === "string" ? payload.name : "";
  if (WRITE_TOOLS.has(tool)) return [];
  const text = commandText(payload);
  const found = new Set<string>();
  const segments = READ_TOOLS.has(tool) ? [text] : text.split(/&&|\|\||;|\||\n/);
  for (const segment of segments) {
    if (!segment.includes("SKILL.md")) continue;
    if (!READ_TOOLS.has(tool) && !readsInSegment(segment)) continue;
    for (const match of segment.matchAll(SKILL_FILE)) {
      const skill = cleanSkillName(match[1]);
      if (skill) found.add(skill);
    }
  }
  return [...found];
}

// ------------------------------------------------------------------ tallies

/** One skill in one log: uses per UTC day, how many a person typed, how many the model chose, how many ran in a helper, and the last one. */
export type SkillTally = { days: Map<number, number>; typed: number; model: number; helper: number; last: number };

/** What a log contributes; the host keeps one of these per file and nothing else from it. */
export type LogTally = { agent: UseAgent; cwd: string; session: string; skills: Map<string, SkillTally> };

export function addUse(skills: Map<string, SkillTally>, skill: string, at: number, typed: boolean, helper: boolean): void {
  let tally = skills.get(skill);
  if (!tally) skills.set(skill, (tally = { days: new Map(), typed: 0, model: 0, helper: 0, last: 0 }));
  const day = dayOf(at);
  tally.days.set(day, (tally.days.get(day) ?? 0) + 1);
  if (typed) tally.typed += 1;
  else tally.model += 1;
  if (helper) tally.helper += 1;
  if (at > tally.last) tally.last = at;
}

/** Drop days before `firstDay` and after `lastDay` (a clock set wrong); skills left with none go. */
export function pruneDays(skills: Map<string, SkillTally>, firstDay: number, lastDay = Number.POSITIVE_INFINITY): void {
  for (const [name, tally] of skills) {
    for (const day of tally.days.keys()) if (day < firstDay || day > lastDay) tally.days.delete(day);
    if (tally.days.size === 0) skills.delete(name);
  }
}

/**
 * The installed skill a logged name means: the same name in any case, else
 * the part after a plugin's `plugin:` prefix. Null for a name nothing
 * installed matches.
 */
export function matchInstalled(logged: string, installed: ReadonlyMap<string, string>): string | null {
  const lower = logged.toLowerCase();
  const direct = installed.get(lower);
  if (direct) return direct;
  const colon = lower.lastIndexOf(":");
  if (colon >= 0) return installed.get(lower.slice(colon + 1)) ?? null;
  return null;
}

export type UsageRow = {
  name: string;
  total: number;
  claude: number;
  codex: number;
  typed: number;
  helpers: number;
  /** Uses per day over the window, oldest first. */
  perDay: number[];
  projects: Array<{ path: string; count: number }>;
  lastUsed: string;
  chats: number;
  installed: boolean;
};

/**
 * Per-skill counts over the last `days` days up to `now`, busiest first.
 * A model's use of a name nothing installed matches is kept (a removed
 * skill); a typed `/name` that matches no skill is a command, not a skill.
 */
export function summarizeUsage(logs: Iterable<LogTally>, installedNames: readonly string[], days: number, now = Date.now()) {
  const installed = new Map(installedNames.map((name) => [name.toLowerCase(), name] as const));
  const lastDay = dayOf(now);
  const firstDay = lastDay - days + 1;
  type Acc = UsageRow & { byProject: Map<string, number>; sessions: Set<string>; lastMs: number };
  const rows = new Map<string, Acc>();
  const totals = { uses: 0, claude: 0, codex: 0, typed: 0 };
  for (const log of logs) {
    for (const [logged, tally] of log.skills) {
      let count = 0;
      for (const [day, n] of tally.days) if (day >= firstDay && day <= lastDay) count += n;
      if (count === 0) continue;
      const known = matchInstalled(logged, installed);
      if (!known && tally.model === 0) continue;
      const name = known ?? logged;
      let row = rows.get(name);
      if (!row) {
        row = { name, total: 0, claude: 0, codex: 0, typed: 0, helpers: 0, perDay: new Array(days).fill(0), projects: [], lastUsed: "", chats: 0, installed: Boolean(known), byProject: new Map(), sessions: new Set(), lastMs: 0 };
        rows.set(name, row);
      }
      for (const [day, n] of tally.days) if (day >= firstDay && day <= lastDay) row.perDay[day - firstDay]! += n;
      row.total += count;
      row[log.agent] += count;
      row.typed += Math.min(tally.typed, count);
      row.helpers += Math.min(tally.helper, count);
      if (tally.last > row.lastMs) row.lastMs = tally.last;
      row.byProject.set(log.cwd, (row.byProject.get(log.cwd) ?? 0) + count);
      if (log.session) row.sessions.add(log.session);
      totals.uses += count;
      totals[log.agent] += count;
      totals.typed += Math.min(tally.typed, count);
    }
  }
  const out: UsageRow[] = [...rows.values()]
    .map(({ byProject, sessions, lastMs, ...row }) => ({
      ...row,
      lastUsed: lastMs ? new Date(lastMs).toISOString() : "",
      chats: sessions.size,
      projects: [...byProject].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)).slice(0, 5),
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const used = new Set(out.filter((row) => row.installed).map((row) => row.name.toLowerCase()));
  const neverUsed = [...new Set(installedNames)].filter((name) => !used.has(name.toLowerCase())).sort();
  return { rows: out, totals, neverUsed, firstDay: new Date(firstDay * DAY_MS).toISOString().slice(0, 10), lastDay: new Date(lastDay * DAY_MS).toISOString().slice(0, 10) };
}
