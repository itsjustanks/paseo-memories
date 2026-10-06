import fs from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Account } from "../shared/contracts";
import { backoffMs } from "../shared/schedule";
import {
  CLAUDE_MARKERS,
  CODEX_MARKERS,
  DAY_MS,
  KEEP_DAYS,
  addUse,
  claudeUsesInLine,
  codexLine,
  dayOf,
  pruneDays,
  summarizeUsage,
  type LogTally,
  type SkillTally,
  type UseAgent,
} from "../shared/skill-usage";
import { onShutdown, onStart } from "./lifecycle";
import { Pacer } from "./pace";
import { clientSeenWithin, pageOpen } from "./presence";
import { readMemoriesSettings } from "./settings";
import { readState, removeState, StateSaver, STATE_MAX_BYTES } from "./state-file";

/**
 * Which skills ran, counted from the chat logs on this host in the
 * background (docs/SKILLS-SPEC.md "Usage"). Nothing on the RPC path waits:
 * reads take the last answer and ask for a new pass.
 *
 * Bounded so memory stays flat (the 0.2.1 lesson):
 *  - only logs changed in the last KEEP_DAYS days are opened;
 *  - each log keeps a cursor (inode, size, mtime, offset of the last whole
 *    line) and is read from there: logs only grow, and a log that shrank or
 *    was replaced is read again from the start;
 *  - a partial last line is left for the next pass;
 *  - lines are cut from fixed-size chunks; a line over MAX_LINE is skipped
 *    unread, and only a line holding one of the marker substrings is decoded
 *    and parsed;
 *  - per log only small tallies are kept (skill → uses per day), names copied
 *    with `own()`, never a slice of a line;
 *  - one global read budget per pass, resumed next pass where it stopped;
 *  - logs that disappear or age out are dropped every pass;
 *  - catching up on history not yet counted runs while an app is connected;
 *    once caught up, the check for new lines runs only while a page is open
 *    (server/presence.ts), backing off after failures;
 *  - a pass works at most 4% of one core (server/pace.ts) and yields after
 *    every chunk, so a backlog of gigabytes is read over many passes (64 MB
 *    each) without anyone noticing;
 *  - every log's cursor and tallies are saved (state/skill-usage.json, names
 *    and counts only, never a line's text), so a reload or an update carries
 *    on where it left off and reads only what is new.
 */

export const PASS_LIMITS = { readBytes: 64 * 1024 * 1024, files: 20_000 };
export const MAX_LINE = 4 * 1024 * 1024;
const CHUNK = 256 * 1024;
const INTERVAL_MS = 10 * 60_000;
/** Catching up: the next pass soon after the last (each one is paced). */
const CARRY_ON_MS = 5_000;
const MIN_GAP_MS = 60_000;
const STATE_NAME = "skill-usage";
const STATE_VERSION = 1;

type LogKind = "claude" | "claude-helper" | "codex";

type Entry = {
  kind: LogKind;
  ino: number;
  size: number;
  mtimeMs: number;
  /** Bytes read so far: just past the last whole line. */
  offset: number;
  tally: LogTally;
  /** Codex: the turn being read and the skills already counted in it (one use per skill per turn). */
  turnSkills: Set<string>;
  /** Inside a line longer than MAX_LINE: everything up to its end is thrown away (and the cursor moves past it). */
  skipping: boolean;
};

const cache = new Map<string, Entry>();
let running: Promise<void> | null = null;
let failures = 0;
let lastPassAt = 0;
let lastFinishedAt: string | null = null;
let complete = false;
let cursor = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let wanted: Array<Pick<Account, "agent" | "dir" | "exists">> = [];
/** Bytes read from logs by the last pass (tests and diagnostics). */
let lastPassBytes = 0;
let loading: Promise<void> | null = null;
/** Bumped by forgetUsage: a load still under way must not bring the old counts back. */
let forgets = 0;

/** A copy that shares no memory with the line it came from. */
function own(text: string): string {
  return Buffer.from(text, "utf8").toString("utf8");
}

// ------------------------------------------------------------------ finding logs

type LogFile = { path: string; kind: LogKind; mtimeMs: number; size: number; ino: number; session: string };

async function statLog(path: string, kind: LogKind, since: number, session: string): Promise<LogFile | null> {
  const stat = await fs.stat(path).catch(() => null);
  if (!stat || !stat.isFile() || stat.mtimeMs < since) return null;
  return { path, kind, mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, session };
}

async function names(folder: string): Promise<Array<{ name: string; dir: boolean }>> {
  try {
    return (await fs.readdir(folder, { withFileTypes: true })).map((entry) => ({ name: entry.name, dir: entry.isDirectory() }));
  } catch {
    return [];
  }
}

/** Claude: `<cfg>/projects/<project>/<session>.jsonl` and `<project>/<session>/subagents/agent-*.jsonl`. */
async function claudeLogs(dir: string, since: number, out: LogFile[]): Promise<void> {
  const root = join(dir, "projects");
  for (const project of await names(root)) {
    if (!project.dir) continue;
    const folder = join(root, project.name);
    for (const entry of await names(folder)) {
      if (out.length >= PASS_LIMITS.files) return;
      if (!entry.dir && entry.name.endsWith(".jsonl")) {
        const file = await statLog(join(folder, entry.name), "claude", since, entry.name.slice(0, -".jsonl".length));
        if (file) out.push(file);
      } else if (entry.dir && entry.name !== "memory") {
        const helpers = join(folder, entry.name, "subagents");
        for (const helper of await names(helpers)) {
          if (helper.dir || !helper.name.endsWith(".jsonl")) continue;
          const file = await statLog(join(helpers, helper.name), "claude-helper", since, entry.name);
          if (file) out.push(file);
        }
      }
    }
  }
}

/** Codex: `<home>/sessions/YYYY/MM/DD/*.jsonl` (day folders in the window only) and `archived_sessions/*.jsonl`. */
async function codexLogs(home: string, since: number, out: LogFile[]): Promise<void> {
  const firstDay = new Date(since - DAY_MS).toISOString().slice(0, 10);
  const sessions = join(home, "sessions");
  for (const year of await names(sessions)) {
    if (!year.dir || !/^\d{4}$/.test(year.name) || year.name < firstDay.slice(0, 4)) continue;
    for (const month of await names(join(sessions, year.name))) {
      if (!month.dir || `${year.name}-${month.name}` < firstDay.slice(0, 7)) continue;
      for (const day of await names(join(sessions, year.name, month.name))) {
        if (!day.dir || `${year.name}-${month.name}-${day.name}` < firstDay) continue;
        const folder = join(sessions, year.name, month.name, day.name);
        for (const entry of await names(folder)) {
          if (out.length >= PASS_LIMITS.files) return;
          if (entry.dir || !entry.name.endsWith(".jsonl")) continue;
          const file = await statLog(join(folder, entry.name), "codex", since, "");
          if (file) out.push(file);
        }
      }
    }
  }
  for (const entry of await names(join(home, "archived_sessions"))) {
    if (out.length >= PASS_LIMITS.files) return;
    if (entry.dir || !entry.name.endsWith(".jsonl")) continue;
    const file = await statLog(join(home, "archived_sessions", entry.name), "codex", since, "");
    if (file) out.push(file);
  }
}

// ------------------------------------------------------------------ reading

const NEWLINE = 10;
const CLAUDE_BYTES = CLAUDE_MARKERS.map((marker) => Buffer.from(marker));
const CODEX_BYTES = CODEX_MARKERS.map((marker) => Buffer.from(marker));

function handleLine(entry: Entry, line: string, firstDay: number): void {
  if (entry.kind === "codex") {
    const parsed = codexLine(line);
    if (!parsed) return;
    if (parsed.kind === "meta") {
      if (parsed.cwd) entry.tally.cwd = own(parsed.cwd);
      if (parsed.threadId) entry.tally.session = own(parsed.threadId);
      return;
    }
    if (parsed.kind === "turn") {
      entry.turnSkills = new Set();
      if (parsed.cwd) entry.tally.cwd = own(parsed.cwd);
      return;
    }
    if (dayOf(parsed.at) < firstDay) return;
    for (const skill of parsed.skills) {
      if (entry.turnSkills.has(skill)) continue;
      const name = own(skill);
      entry.turnSkills.add(name);
      addUse(entry.tally.skills, name, parsed.at, parsed.typed, false);
    }
    return;
  }
  const parsed = claudeUsesInLine(line);
  if (!parsed) return;
  if (parsed.cwd && parsed.cwd !== entry.tally.cwd) entry.tally.cwd = own(parsed.cwd);
  for (const use of parsed.uses) {
    if (dayOf(use.at) < firstDay) continue;
    const known = entry.tally.skills.has(use.skill) ? use.skill : own(use.skill);
    addUse(entry.tally.skills, known, use.at, use.typed, entry.kind === "claude-helper");
  }
}

// ------------------------------------------------------------------ saved state

const LOG_KINDS = ["claude", "claude-helper", "codex"] as const;
const SavedSkill = z.object({
  days: z.array(z.tuple([z.number().int(), z.number().int().nonnegative()])).max(KEEP_DAYS + 2),
  typed: z.number().int().nonnegative(),
  model: z.number().int().nonnegative(),
  helper: z.number().int().nonnegative(),
  last: z.number(),
});
const SavedLog = z.object({
  path: z.string().min(1).max(4096),
  kind: z.enum(LOG_KINDS),
  ino: z.number(),
  size: z.number().nonnegative(),
  mtimeMs: z.number(),
  offset: z.number().int().nonnegative(),
  skipping: z.boolean(),
  agent: z.enum(["claude", "codex"]),
  cwd: z.string().max(4096),
  session: z.string().max(512),
  turn: z.array(z.string().max(512)).max(1000),
  skills: z.array(z.tuple([z.string().min(1).max(512), SavedSkill])).max(5000),
});
const SavedUsage = z.object({
  version: z.literal(STATE_VERSION),
  complete: z.boolean(),
  cursor: z.number().int().nonnegative(),
  finishedAt: z.string().nullable(),
  logs: z.array(SavedLog).max(PASS_LIMITS.files),
});
type SavedLogEntry = z.infer<typeof SavedLog>;

function saveLog(path: string, entry: Entry): SavedLogEntry {
  return {
    path,
    kind: entry.kind,
    ino: entry.ino,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    offset: entry.offset,
    skipping: entry.skipping,
    agent: entry.tally.agent,
    cwd: entry.tally.cwd,
    session: entry.tally.session,
    turn: [...entry.turnSkills],
    skills: [...entry.tally.skills].map(([name, skill]) => [name, { days: [...skill.days], typed: skill.typed, model: skill.model, helper: skill.helper, last: skill.last }]),
  };
}

/**
 * Cursors and tallies, newest logs first, up to the size cap. A log left out
 * is read again from the start after the next load, and the count is marked
 * unfinished until then.
 */
function snapshot(): z.infer<typeof SavedUsage> {
  const ordered = [...cache].sort(([, a], [, b]) => b.mtimeMs - a.mtimeMs);
  const logs: SavedLogEntry[] = [];
  let bytes = 1024;
  for (const [path, entry] of ordered) {
    const saved = saveLog(path, entry);
    bytes += JSON.stringify(saved).length + 1;
    if (bytes > STATE_MAX_BYTES) break;
    logs.push(saved);
  }
  const all = logs.length === cache.size;
  return { version: STATE_VERSION, complete: complete && all, cursor: all ? cursor : 0, finishedAt: lastFinishedAt, logs };
}

const saver = new StateSaver(STATE_NAME, snapshot);

function restore(saved: z.infer<typeof SavedUsage>): void {
  for (const log of saved.logs) {
    const skills = new Map<string, SkillTally>();
    for (const [name, skill] of log.skills) skills.set(name, { days: new Map(skill.days), typed: skill.typed, model: skill.model, helper: skill.helper, last: skill.last });
    cache.set(log.path, {
      kind: log.kind,
      ino: log.ino,
      size: log.size,
      mtimeMs: log.mtimeMs,
      offset: log.offset,
      skipping: log.skipping,
      tally: { agent: log.agent, cwd: log.cwd, session: log.session, skills },
      turnSkills: new Set(log.turn),
    });
  }
  complete = saved.complete;
  cursor = saved.cursor;
  lastFinishedAt = saved.finishedAt;
}

/**
 * Once per plugin load, before the first pass: where the last load left off.
 * A bad or unknown file means starting fresh; with counting turned off the
 * saved copy is removed, not read.
 */
function loadSaved(): Promise<void> {
  if (!loading) {
    const before = forgets;
    loading = (async () => {
      if (!(await readMemoriesSettings()).skillsUsage) return removeState(STATE_NAME);
      const saved = await readState(STATE_NAME, SavedUsage);
      if (saved && before === forgets && cache.size === 0) restore(saved);
    })().catch(() => undefined);
  }
  return loading;
}

/** Read from `entry.offset`, at most `budget` bytes, line by line; `entry.offset` ends just past the last whole line. */
async function readFrom(path: string, entry: Entry, budget: number, firstDay: number, pacer: Pacer, buffer: Buffer): Promise<{ read: number; atEnd: boolean }> {
  if (entry.offset === 0) entry.skipping = false;
  const handle = await fs.open(path, "r");
  const markers = entry.kind === "codex" ? CODEX_BYTES : CLAUDE_BYTES;
  let read = 0;
  let atEnd = false;
  try {
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let position = entry.offset;
    // Within the budget; past it only to finish a line already begun (at most MAX_LINE), and then stop. Bytes thrown away count too (review-040 #6).
    while (read < budget || (pendingBytes > 0 && !entry.skipping)) {
      const finishing = read >= budget;
      const { bytesRead } = await handle.read(buffer, 0, finishing ? CHUNK : Math.min(CHUNK, budget - read), position);
      if (bytesRead === 0) {
        atEnd = true;
        break;
      }
      read += bytesRead;
      const chunkStart = position;
      position += bytesRead;
      let start = 0;
      let finished = false;
      for (;;) {
        const end = buffer.indexOf(NEWLINE, start);
        if (end === -1 || end >= bytesRead) break;
        if (!entry.skipping) {
          const piece = buffer.subarray(start, end);
          const line = pendingBytes ? Buffer.concat([...pending, piece]) : piece;
          if (markers.some((marker) => line.includes(marker))) handleLine(entry, line.toString("utf8"), firstDay);
        }
        pending = [];
        pendingBytes = 0;
        entry.skipping = false;
        start = end + 1;
        entry.offset = chunkStart + start;
        if (finishing) {
          // The line is whole: what follows it in this chunk is left for the next pass (and not counted as read).
          read -= bytesRead - start;
          finished = true;
          break;
        }
      }
      if (finished) break;
      if (start < bytesRead) {
        if (entry.skipping) entry.offset = position;
        else {
          pendingBytes += bytesRead - start;
          if (pendingBytes > MAX_LINE) {
            // Too long to be a log line: drop it, and move the cursor past what was read so it is never read again.
            pending = [];
            pendingBytes = 0;
            entry.skipping = true;
            entry.offset = position;
          } else pending.push(Buffer.from(buffer.subarray(start, bytesRead)));
        }
      }
      await pacer.step();
    }
  } finally {
    await handle.close();
  }
  return { read, atEnd };
}

// ------------------------------------------------------------------ passes

async function runPass(now = Date.now()): Promise<void> {
  await loadSaved();
  const since = now - KEEP_DAYS * DAY_MS;
  const firstDay = dayOf(since);
  const logs: LogFile[] = [];
  for (const account of wanted) {
    if (!account.exists) continue;
    if (account.agent === "claude") await claudeLogs(account.dir, since, logs);
    else if (account.agent === "codex") await codexLogs(account.dir, since, logs);
  }
  logs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Sweep: logs gone or aged out are forgotten, and old days dropped from the rest.
  const live = new Set(logs.map((log) => log.path));
  let changed = false;
  for (const path of [...cache.keys()]) if (!live.has(path)) changed = cache.delete(path) || changed;
  for (const entry of cache.values()) {
    const before = entry.tally.skills.size;
    let days = 0;
    for (const tally of entry.tally.skills.values()) days += tally.days.size;
    pruneDays(entry.tally.skills, firstDay);
    for (const tally of entry.tally.skills.values()) days -= tally.days.size;
    if (days || entry.tally.skills.size !== before) changed = true;
  }
  let budget = PASS_LIMITS.readBytes;
  let cut = -1;
  const pacer = new Pacer();
  // One read buffer for the whole pass: thousands of logs, one allocation.
  const buffer = Buffer.alloc(CHUNK);
  const start = logs.length ? cursor % logs.length : 0;
  for (let i = 0; i < logs.length; i += 1) {
    const index = (start + i) % logs.length;
    const log = logs[index]!;
    let entry = cache.get(log.path);
    // Replaced (new inode) or shrunk (rewritten): read again from the start.
    if (entry && (entry.ino !== log.ino || log.size < entry.offset)) entry = undefined;
    if (!entry) {
      const agent: UseAgent = log.kind === "codex" ? "codex" : "claude";
      entry = { kind: log.kind, ino: log.ino, size: 0, mtimeMs: 0, offset: 0, tally: { agent, cwd: "", session: own(log.session), skills: new Map<string, SkillTally>() }, turnSkills: new Set(), skipping: false };
      cache.set(log.path, entry);
      changed = true;
    }
    // Read only what is new: a tail with no line end is read once and then left until the file changes.
    const unchanged = log.size === entry.size && log.mtimeMs === entry.mtimeMs;
    if (log.size > entry.offset && !unchanged) {
      if (budget <= 0) {
        if (cut < 0) cut = index;
        continue;
      }
      try {
        const { read, atEnd } = await readFrom(log.path, entry, budget, firstDay, pacer, buffer);
        budget -= read;
        if (read) changed = true;
        if (!atEnd) {
          if (cut < 0) cut = index;
          // Not at the end yet: the next pass carries on from the cursor.
          continue;
        }
      } catch {
        cache.delete(log.path);
        changed = true;
        continue;
      }
    }
    if (entry.size !== log.size || entry.mtimeMs !== log.mtimeMs) changed = true;
    entry.size = log.size;
    entry.mtimeMs = log.mtimeMs;
  }
  const wasComplete = complete;
  complete = cut < 0;
  cursor = complete ? 0 : cut;
  lastPassAt = Date.now();
  lastFinishedAt = new Date().toISOString();
  lastPassBytes = PASS_LIMITS.readBytes - budget;
  if (changed || complete !== wasComplete) saver.soon();
}

/** Start a pass if none is running and one is due. Only while an app is connected, unless `force`. */
export function requestUsagePass(accounts: Array<Pick<Account, "agent" | "dir" | "exists">>, opts: { force?: boolean; minGapMs?: number } = {}): void {
  wanted = accounts.filter((account) => account.agent === "claude" || account.agent === "codex").map((account) => ({ agent: account.agent, dir: account.dir, exists: account.exists }));
  if (running) return;
  if (!opts.force && !clientSeenWithin()) return;
  if (!opts.force && Date.now() - lastPassAt < (opts.minGapMs ?? MIN_GAP_MS) && lastFinishedAt) return;
  running = runPass()
    .then(() => {
      failures = 0;
    })
    .catch(() => {
      failures += 1;
    })
    .finally(() => {
      running = null;
    });
}

/** Counting was turned off: forget everything, the saved copy too. */
export function forgetUsage(): void {
  forgets += 1;
  loading = Promise.resolve();
  void saver.cancel();
  cache.clear();
  complete = false;
  lastFinishedAt = null;
  lastPassAt = 0;
  cursor = 0;
}

export function usageState(enabled = true): { state: string; asOf?: string; complete: boolean; files: { claude: number; codex: number }; note: string } {
  if (!enabled) {
    if (cache.size) forgetUsage();
    return { state: "off", complete: false, files: { claude: 0, codex: 0 }, note: "Counting skill use is turned off in the settings." };
  }
  const files = { claude: 0, codex: 0 };
  for (const entry of cache.values()) entry.kind === "codex" ? (files.codex += 1) : (files.claude += 1);
  if (!lastFinishedAt) return { state: running ? "checking" : "waiting", complete: false, files, note: "Reading chat history for the first time; counts appear when it's done." };
  return {
    state: running ? "checking" : "ready",
    asOf: lastFinishedAt,
    complete,
    files,
    note: complete ? "" : "Chat history is still being read; counts so far are partial.",
  };
}

function* tallies(): Generator<LogTally> {
  for (const entry of cache.values()) if (entry.tally.skills.size) yield entry.tally;
}

export function usageSummary(installedNames: readonly string[], days: number, now = Date.now()) {
  return summarizeUsage(tallies(), installedNames, days, now);
}

/** Whether a logged name counts: a name a person typed (`/model`) that no skill has is a command, not a skill. */
export type KeepName = (name: string, modelUses: number) => boolean;

/** Skills used in the chats with these ids (Claude session ids, Codex thread ids). */
export function chatUsage(sessionIds: readonly string[], keep: KeepName): Map<string, number> {
  const ids = new Set(sessionIds.filter(Boolean));
  const out = new Map<string, number>();
  for (const tally of tallies()) {
    if (!ids.has(tally.session)) continue;
    for (const [name, skill] of tally.skills) {
      if (!keep(name, skill.model)) continue;
      let count = 0;
      for (const n of skill.days.values()) count += n;
      out.set(name, (out.get(name) ?? 0) + count);
    }
  }
  return out;
}

/** Skills used in chats that worked in `cwd` (or a folder under it), from `sinceMs` on. */
export function folderUsage(cwd: string, sinceMs: number, keep: KeepName, agent?: UseAgent): Map<string, number> {
  const firstDay = dayOf(sinceMs);
  const out = new Map<string, number>();
  for (const tally of tallies()) {
    if (agent && tally.agent !== agent) continue;
    if (tally.cwd !== cwd && !tally.cwd.startsWith(`${cwd}/`)) continue;
    for (const [name, skill] of tally.skills) {
      if (skill.last < sinceMs || !keep(name, skill.model)) continue;
      let count = 0;
      for (const [day, n] of skill.days) if (day >= firstDay) count += n;
      if (count) out.set(name, (out.get(name) ?? 0) + count);
    }
  }
  return out;
}

/** For tests and diagnostics: how much the scan keeps, and how much the last pass read. */
export function usageStats(): { files: number; skills: number; days: number; complete: boolean; readBytes: number } {
  let skills = 0;
  let days = 0;
  for (const entry of cache.values()) {
    skills += entry.tally.skills.size;
    for (const tally of entry.tally.skills.values()) days += tally.days.size;
  }
  return { files: cache.size, skills, days, complete, readBytes: lastPassBytes };
}

/** For tests: write the saved copy now. */
export function saveUsageNow(): Promise<void> {
  return saver.now();
}

/** For tests: what a new plugin load starts with (nothing in memory; the saved copy is read before the next pass). */
export async function reloadUsage(): Promise<void> {
  await running;
  await saver.flush();
  cache.clear();
  complete = false;
  lastFinishedAt = null;
  lastPassAt = 0;
  lastPassBytes = 0;
  cursor = 0;
  failures = 0;
  loading = null;
}

/** For tests: wait for the pass in flight. */
export async function usageSettled(): Promise<void> {
  await running;
}

/**
 * Whether the timer's next pass should run: catching up on history not yet
 * counted, while an app is connected; once caught up, checking for new
 * lines only while a page is open. Otherwise the plugin stays idle.
 */
export function timerPassDue(): boolean {
  return wanted.length > 0 && (complete ? pageOpen() : clientSeenWithin());
}

function schedule(): void {
  const delay = !complete && lastFinishedAt && failures === 0 ? CARRY_ON_MS : backoffMs(failures, INTERVAL_MS, 60 * 60_000);
  timer = setTimeout(() => {
    if (timerPassDue()) requestUsagePass(wanted, { minGapMs: 0 });
    schedule();
  }, delay);
  timer.unref?.();
}

onStart(() => {
  // Read the saved place off the startup path, so the first page shows the last counts straight away.
  void loadSaved();
  schedule();
});
onShutdown(() => {
  if (timer) clearTimeout(timer);
  timer = null;
  void saver.flush();
});
