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
import { onSettingsChanged, readMemoriesSettings } from "./settings";
import { fitEntries, readStateJson, removeState, StateSaver, sweepStateTemps, yieldNow } from "./state-file";

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
 *    every chunk and every 64 stats, so a backlog of gigabytes is read over
 *    many passes (64 MB each, 30 s apart) without anyone noticing; while
 *    catching up, the list of logs is reused for up to 10 minutes instead of
 *    being made again for every pass;
 *  - counting turned off (Settings) stops everything at once: nothing in
 *    memory, the saved copy removed, and no pass or save until it is back on;
 *  - every log's cursor and tallies are saved (state/skill-usage.json, names
 *    and counts only, never a line's text), so a reload or an update carries
 *    on where it left off and reads only what is new.
 */

export const PASS_LIMITS = { readBytes: 64 * 1024 * 1024, files: 20_000 };
export const MAX_LINE = 4 * 1024 * 1024;
const CHUNK = 256 * 1024;
const INTERVAL_MS = 10 * 60_000;
/** Catching up: the next pass this long after the last (each one is paced too). */
const CARRY_ON_MS = 30_000;
/** Catching up: the list of logs is made again at most this often (logs that grow are still read to their end). */
const LIST_REUSE_MS = 10 * 60_000;
/** The saved copy is written at most this often. */
const SAVE_EVERY_MS = 60_000;
/** Stats between rests while listing logs. */
const LIST_STEP = 64;
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
/** Bumped by forgetUsage: a load or pass still under way must not bring the old counts back. */
let forgets = 0;
/** The last list of logs, reused while catching up. */
let carried: { logs: LogFile[]; at: number; key: string } | null = null;
/** Fresh listings since the last forget (tests and diagnostics). */
let listings = 0;
let stopListening: (() => void) | null = null;

/** A copy that shares no memory with the line it came from. */
function own(text: string): string {
  return Buffer.from(text, "utf8").toString("utf8");
}

// ------------------------------------------------------------------ finding logs

type LogFile = { path: string; kind: LogKind; mtimeMs: number; size: number; ino: number; session: string };

/** One listing: what it found, from when, and a rest every LIST_STEP stats. */
type Listing = { since: number; out: LogFile[]; pacer: Pacer; stats: number };

async function statLog(listing: Listing, path: string, kind: LogKind, session: string): Promise<void> {
  listing.stats += 1;
  if (listing.stats % LIST_STEP === 0) await listing.pacer.step();
  const stat = await fs.stat(path).catch(() => null);
  if (!stat || !stat.isFile() || stat.mtimeMs < listing.since) return;
  listing.out.push({ path, kind, mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, session });
}

async function names(folder: string): Promise<Array<{ name: string; dir: boolean }>> {
  try {
    return (await fs.readdir(folder, { withFileTypes: true })).map((entry) => ({ name: entry.name, dir: entry.isDirectory() }));
  } catch {
    return [];
  }
}

/** Claude: `<cfg>/projects/<project>/<session>.jsonl` and `<project>/<session>/subagents/agent-*.jsonl`. */
async function claudeLogs(dir: string, listing: Listing): Promise<void> {
  const root = join(dir, "projects");
  for (const project of await names(root)) {
    if (!project.dir) continue;
    const folder = join(root, project.name);
    for (const entry of await names(folder)) {
      if (listing.out.length >= PASS_LIMITS.files) return;
      if (!entry.dir && entry.name.endsWith(".jsonl")) {
        await statLog(listing, join(folder, entry.name), "claude", entry.name.slice(0, -".jsonl".length));
      } else if (entry.dir && entry.name !== "memory") {
        const helpers = join(folder, entry.name, "subagents");
        for (const helper of await names(helpers)) {
          if (helper.dir || !helper.name.endsWith(".jsonl")) continue;
          await statLog(listing, join(helpers, helper.name), "claude-helper", entry.name);
        }
      }
    }
  }
}

/** Codex: `<home>/sessions/YYYY/MM/DD/*.jsonl` (day folders in the window only) and `archived_sessions/*.jsonl`. */
async function codexLogs(home: string, listing: Listing): Promise<void> {
  const firstDay = new Date(listing.since - DAY_MS).toISOString().slice(0, 10);
  const sessions = join(home, "sessions");
  for (const year of await names(sessions)) {
    if (!year.dir || !/^\d{4}$/.test(year.name) || year.name < firstDay.slice(0, 4)) continue;
    for (const month of await names(join(sessions, year.name))) {
      if (!month.dir || `${year.name}-${month.name}` < firstDay.slice(0, 7)) continue;
      for (const day of await names(join(sessions, year.name, month.name))) {
        if (!day.dir || `${year.name}-${month.name}-${day.name}` < firstDay) continue;
        const folder = join(sessions, year.name, month.name, day.name);
        for (const entry of await names(folder)) {
          if (listing.out.length >= PASS_LIMITS.files) return;
          if (entry.dir || !entry.name.endsWith(".jsonl")) continue;
          await statLog(listing, join(folder, entry.name), "codex", "");
        }
      }
    }
  }
  for (const entry of await names(join(home, "archived_sessions"))) {
    if (listing.out.length >= PASS_LIMITS.files) return;
    if (entry.dir || !entry.name.endsWith(".jsonl")) continue;
    await statLog(listing, join(home, "archived_sessions", entry.name), "codex", "");
  }
}

/** Every log in the window, sorted by path. Paced like the reading. */
async function listLogs(since: number, pacer: Pacer): Promise<LogFile[]> {
  const listing: Listing = { since, out: [], pacer, stats: 0 };
  for (const account of wanted) {
    if (!account.exists) continue;
    if (account.agent === "claude") await claudeLogs(account.dir, listing);
    else if (account.agent === "codex") await codexLogs(account.dir, listing);
  }
  return listing.out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ------------------------------------------------------------------ reading

const NEWLINE = 10;
const CLAUDE_BYTES = CLAUDE_MARKERS.map((marker) => Buffer.from(marker));
const CODEX_BYTES = CODEX_MARKERS.map((marker) => Buffer.from(marker));

/** The days counted: KEEP_DAYS back, and no later than tomorrow (a line dated further ahead has a clock set wrong). */
type DayWindow = { first: number; last: number };

function dayWindow(now: number): DayWindow {
  return { first: dayOf(now - KEEP_DAYS * DAY_MS), last: dayOf(now) + 1 };
}

const inWindow = (at: number, days: DayWindow) => {
  const day = dayOf(at);
  return day >= days.first && day <= days.last;
};

function handleLine(entry: Entry, line: string, days: DayWindow): void {
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
    if (!inWindow(parsed.at, days)) return;
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
    if (!inWindow(use.at, days)) continue;
    const known = entry.tally.skills.has(use.skill) ? use.skill : own(use.skill);
    addUse(entry.tally.skills, known, use.at, use.typed, entry.kind === "claude-helper");
  }
}

// ------------------------------------------------------------------ saved state

const LOG_KINDS = ["claude", "claude-helper", "codex"] as const;
const count = z.number().int().nonnegative();
const SavedSkill = z.object({
  // Days outside the window are dropped on load (a clock set wrong must not make the log unreadable).
  days: z.array(z.tuple([z.number().int(), count])).max(1000),
  typed: count,
  model: count,
  helper: count,
  last: z.number(),
});
const SavedLog = z.object({
  path: z.string().min(1).max(4096),
  kind: z.enum(LOG_KINDS),
  ino: z.number(),
  size: z.number().nonnegative(),
  mtimeMs: z.number(),
  offset: count,
  skipping: z.boolean(),
  agent: z.enum(["claude", "codex"]),
  cwd: z.string().max(4096),
  session: z.string().max(512),
  turn: z.array(z.string().max(512)).max(1000),
  skills: z.array(z.tuple([z.string().min(1).max(512), SavedSkill])).max(5000),
});
/** The file as a whole; each log is checked on its own, so one bad log costs only that log. */
const SavedUsage = z.object({
  version: z.literal(STATE_VERSION),
  complete: z.boolean(),
  cursor: count,
  finishedAt: z.string().nullable(),
  logs: z.array(z.unknown()).max(PASS_LIMITS.files),
});
type SavedLogEntry = z.infer<typeof SavedLog>;

function saveLog(path: string, entry: Entry, days: DayWindow): SavedLogEntry {
  const skills: SavedLogEntry["skills"] = [];
  for (const [name, skill] of entry.tally.skills) {
    const kept = [...skill.days].filter(([day]) => day >= days.first && day <= days.last);
    if (kept.length) skills.push([name, { days: kept, typed: skill.typed, model: skill.model, helper: skill.helper, last: skill.last }]);
  }
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
    skills,
  };
}

/**
 * The text to save: cursors and tallies, newest logs first, each checked
 * against the schema it is loaded with, up to the byte cap. Logs left out
 * (over the cap, or failing the check) are read again from the start after
 * the next load, and the count is marked unfinished until then. Built a few
 * hundred logs at a time, letting other work in between.
 */
async function snapshotText(now = Date.now()): Promise<string | null> {
  const days = dayWindow(now);
  const ordered = [...cache].sort(([, a], [, b]) => b.mtimeMs - a.mtimeMs);
  const parts: string[] = [];
  let invalid = 0;
  for (const [index, [path, entry]] of ordered.entries()) {
    const saved = SavedLog.safeParse(saveLog(path, entry, days));
    if (saved.success) parts.push(JSON.stringify(saved.data));
    else invalid += 1;
    if (index % 256 === 255) await yieldNow();
  }
  const head = (whole: boolean) => ({ version: STATE_VERSION, complete: whole && complete, cursor: whole ? cursor : 0, finishedAt: lastFinishedAt });
  let fitted = fitEntries(head(invalid === 0), "logs", parts);
  // Some left out: the count is unfinished after a load, and the cursor starts over.
  if (fitted.dropped && invalid === 0) fitted = fitEntries(head(false), "logs", parts);
  const left = fitted.dropped + invalid;
  if (left) console.warn(`[paseo-memories] skill-use state: ${left} of ${ordered.length} logs not saved (${fitted.dropped} over the size cap, ${invalid} invalid); they are read again after a restart`);
  return fitted.text;
}

const saver = new StateSaver(STATE_NAME, () => snapshotText(), SAVE_EVERY_MS);

/** One saved log, or null when it doesn't check out (only it is read again). Days outside the window are dropped. */
function restoreLog(raw: unknown, days: DayWindow): [string, Entry] | null {
  const parsed = SavedLog.safeParse(raw);
  if (!parsed.success) return null;
  const log = parsed.data;
  const skills = new Map<string, SkillTally>();
  for (const [name, skill] of log.skills) {
    const kept = skill.days.filter(([day]) => day >= days.first && day <= days.last);
    if (kept.length) skills.set(name, { days: new Map(kept), typed: skill.typed, model: skill.model, helper: skill.helper, last: skill.last });
  }
  return [
    log.path,
    { kind: log.kind, ino: log.ino, size: log.size, mtimeMs: log.mtimeMs, offset: log.offset, skipping: log.skipping, tally: { agent: log.agent, cwd: log.cwd, session: log.session, skills }, turnSkills: new Set(log.turn) },
  ];
}

async function restore(saved: z.infer<typeof SavedUsage>, before: number): Promise<void> {
  const days = dayWindow(Date.now());
  const restored: Array<[string, Entry]> = [];
  for (const [index, raw] of saved.logs.entries()) {
    const one = restoreLog(raw, days);
    if (one) restored.push(one);
    if (index % 256 === 255) await yieldNow();
  }
  if (before !== forgets || cache.size) return;
  for (const [path, entry] of restored) cache.set(path, entry);
  const all = restored.length === saved.logs.length;
  complete = saved.complete && all;
  cursor = all ? saved.cursor : 0;
  lastFinishedAt = saved.finishedAt;
}

/**
 * Whether counting is on. When it is off, everything is forgotten (the
 * saved copy too) and stays so: this is checked before every pass, on every
 * timer tick and whenever Paseo says the settings changed.
 */
async function countingOn(): Promise<boolean> {
  if ((await readMemoriesSettings()).skillsUsage) return true;
  if (!saver.isClosed || cache.size || wanted.length || running) forgetUsage();
  return false;
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
      if (!(await countingOn())) return removeState(STATE_NAME);
      const parsed = SavedUsage.safeParse(await readStateJson(STATE_NAME));
      if (parsed.success && before === forgets && cache.size === 0) await restore(parsed.data, before);
    })().catch(() => undefined);
  }
  return loading;
}

/** Read from `entry.offset`, at most `budget` bytes, line by line; `entry.offset` ends just past the last whole line. */
async function readFrom(path: string, entry: Entry, budget: number, days: DayWindow, pacer: Pacer, buffer: Buffer, started: number): Promise<{ read: number; atEnd: boolean }> {
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
          if (markers.some((marker) => line.includes(marker))) handleLine(entry, line.toString("utf8"), days);
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
      // Counting turned off meanwhile: stop reading (the pass then keeps nothing).
      if (forgets !== started) break;
    }
  } finally {
    await handle.close();
  }
  return { read, atEnd };
}

// ------------------------------------------------------------------ passes

async function runPass(now = Date.now()): Promise<void> {
  if (!(await countingOn())) return;
  saver.open();
  await loadSaved();
  const started = forgets;
  const since = now - KEEP_DAYS * DAY_MS;
  const days = dayWindow(now);
  const firstDay = days.first;
  const pacer = new Pacer();
  // Catching up: the last list again (each log is still read to its real end); otherwise a fresh one.
  const key = JSON.stringify(wanted);
  const reuse = !complete && carried !== null && carried.key === key && now - carried.at < LIST_REUSE_MS;
  const logs = reuse ? carried!.logs : await listLogs(since, pacer);
  if (!reuse) {
    carried = { logs, at: now, key };
    listings += 1;
  }
  // Sweep: logs gone or aged out are forgotten, and old days dropped from the rest.
  const live = new Set(logs.map((log) => log.path));
  let changed = false;
  for (const path of [...cache.keys()]) if (!live.has(path)) changed = cache.delete(path) || changed;
  for (const entry of cache.values()) {
    const before = entry.tally.skills.size;
    let kept = 0;
    for (const tally of entry.tally.skills.values()) kept += tally.days.size;
    pruneDays(entry.tally.skills, firstDay, days.last);
    for (const tally of entry.tally.skills.values()) kept -= tally.days.size;
    if (kept || entry.tally.skills.size !== before) changed = true;
  }
  let budget = PASS_LIMITS.readBytes;
  let cut = -1;
  // One read buffer for the whole pass: thousands of logs, one allocation.
  const buffer = Buffer.alloc(CHUNK);
  const start = logs.length ? cursor % logs.length : 0;
  for (let i = 0; i < logs.length; i += 1) {
    // Turned off mid-pass: stop, and keep nothing.
    if (forgets !== started) return;
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
        const { read, atEnd } = await readFrom(log.path, entry, budget, days, pacer, buffer, started);
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
  if (forgets !== started) return;
  const wasComplete = complete;
  complete = cut < 0;
  if (complete) carried = null;
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

/** Counting was turned off: forget everything, the saved copy too, and save nothing until a pass runs with it on again. */
export function forgetUsage(): void {
  forgets += 1;
  loading = Promise.resolve();
  void saver.close();
  wanted = [];
  carried = null;
  listings = 0;
  lastPassBytes = 0;
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
export function usageStats(): { files: number; skills: number; days: number; complete: boolean; readBytes: number; listings: number } {
  let skills = 0;
  let days = 0;
  for (const entry of cache.values()) {
    skills += entry.tally.skills.size;
    for (const tally of entry.tally.skills.values()) days += tally.days.size;
  }
  return { files: cache.size, skills, days, complete, readBytes: lastPassBytes, listings };
}

/** For tests: write the saved copy now. */
export function saveUsageNow(): Promise<void> {
  return saver.now();
}

/** For tests: the text a save would write. */
export function usageSnapshotText(): Promise<string | null> {
  return snapshotText();
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
  carried = null;
  saver.reset();
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
export async function timerPassDue(): Promise<boolean> {
  if (!(await countingOn())) return false;
  return wanted.length > 0 && (complete ? pageOpen() : clientSeenWithin());
}

function schedule(): void {
  const delay = !complete && lastFinishedAt && failures === 0 ? CARRY_ON_MS : backoffMs(failures, INTERVAL_MS, 60 * 60_000);
  timer = setTimeout(() => {
    timerPassDue()
      .then((due) => {
        if (due) requestUsagePass(wanted, { minGapMs: 0 });
      })
      .catch(() => undefined)
      .finally(() => {
        if (timer) schedule();
      });
  }, delay);
  timer.unref?.();
}

onStart(() => {
  // Off the startup path: temp files a crash left, then the saved place, so the first page shows the last counts straight away.
  void sweepStateTemps().then(() => loadSaved());
  stopListening = onSettingsChanged(() => void countingOn().catch(() => undefined));
  schedule();
});
onShutdown(() => {
  if (timer) clearTimeout(timer);
  timer = null;
  stopListening?.();
  stopListening = null;
  void saver.stop();
});
