/**
 * Review of 0.5.1 (review-051.md): counting turned off is honoured
 * everywhere and on disk; saved copies are measured in bytes and trimmed to
 * fit, never refused; catching up reuses its list of logs; one bad saved log
 * (or a clock set wrong) costs only that log; temp files from a crash are
 * swept; a shut-down load saves nothing more. Synthetic only.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { makeSandbox } from "./helpers";
import { claudeSkillLine, isoDaysAgo, writeLines } from "./skills-helpers";

const sb = await makeSandbox();
const usage = await import("../server/skill-usage");
const stateFile = await import("../server/state-file");
const { settingsPath } = await import("../server/settings");
const { memoriesSettings, MEMORIES_DEFAULTS } = await import("../shared/settings");
const { markClientSeen } = await import("../server/presence");

after(() => sb.cleanup());

/** Each test counts its own Claude folder: `-off`, `-cjk`, … */
let claudeDir = "";
const useFolder = (name: string) => (claudeDir = join(sb.root, "r051", name, "claude"));
const statePath = stateFile.statePath("skill-usage");
const logAt = (i: number, folder = "-w") => join(claudeDir, "projects", folder, `s${i}.jsonl`);

async function pass(): Promise<number> {
  usage.requestUsagePass([{ agent: "claude", dir: claudeDir, exists: true }], { force: true });
  await usage.usageSettled();
  return usage.usageStats().readBytes;
}

function setCounting(on: boolean): void {
  const path = settingsPath(memoriesSettings.id);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: memoriesSettings.version, values: { ...MEMORIES_DEFAULTS, skillsUsage: on } }));
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

// ------------------------------------------------------------------ 1. counting off

test("counting turned off: the timer stops, memory and the saved copy go, and nothing brings them back", async () => {
  setCounting(true);
  usage.forgetUsage();
  useFolder("off");
  for (let i = 0; i < 20; i += 1) writeLines(logAt(i, "-off"), [claudeSkillLine("alpha", isoDaysAgo(1), `s${i}`, "/w")]);
  await pass();
  await usage.saveUsageNow();
  assert.equal(existsSync(statePath), true);

  // Off in Settings, with a page open and the Skills tab never opened: no forgetUsage from a handler.
  setCounting(false);
  markClientSeen();
  assert.equal(await usage.timerPassDue(), false, "the timer does not run a pass");
  await until(() => !existsSync(statePath));
  assert.equal(existsSync(statePath), false, "the saved copy is removed");
  assert.equal(usage.usageStats().files, 0, "nothing kept in memory");

  // Whatever still asks for a pass reads nothing and saves nothing.
  assert.equal(await pass(), 0);
  assert.equal(usage.usageStats().files, 0);
  await usage.saveUsageNow();
  assert.equal(existsSync(statePath), false, "a save asked for while off writes nothing");

  // Back on: counting and saving resume.
  setCounting(true);
  assert.ok((await pass()) > 0);
  await usage.saveUsageNow();
  assert.equal(existsSync(statePath), true);
});

test("forgetting clears the accounts too, so the timer has nothing to count", async () => {
  setCounting(true);
  await pass();
  markClientSeen();
  assert.equal(await usage.timerPassDue(), true);
  usage.forgetUsage();
  assert.equal(await usage.timerPassDue(), false);
});

test("counting off at start: the saved copy is removed before anything reads it", async () => {
  setCounting(true);
  await pass();
  await usage.saveUsageNow();
  setCounting(false);
  await usage.reloadUsage();
  await usage.timerPassDue();
  await until(() => !existsSync(statePath));
  assert.equal(existsSync(statePath), false);
  setCounting(true);
});

// ------------------------------------------------------------------ 2. bytes, and trimming instead of refusing

test("sizes are measured in bytes, and an over-size copy is trimmed to fit (newest logs kept), never refused", async () => {
  setCounting(true);
  usage.forgetUsage();
  useFolder("cjk");
  // Folder names in a script that takes three bytes a character.
  const cwd = `/w/${"项目".repeat(60)}`;
  for (let i = 0; i < 30; i += 1) {
    writeLines(logAt(i, "-cjk"), [claudeSkillLine("alpha", isoDaysAgo(1), `s${i}`, cwd)]);
    const at = new Date(Date.now() - (30 - i) * 60_000);
    utimesSync(logAt(i, "-cjk"), at, at);
  }
  await pass();
  const whole = await usage.usageSnapshotText();
  const wholeBytes = Buffer.byteLength(whole!);
  const cap = stateFile.STATE_LIMITS.maxBytes;
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    // Room for about half, counted in characters it would all "fit".
    stateFile.STATE_LIMITS.maxBytes = Math.floor(wholeBytes / 2);
    assert.ok(whole!.length < wholeBytes, "the text has multi-byte characters");
    await usage.saveUsageNow();
  } finally {
    stateFile.STATE_LIMITS.maxBytes = cap;
    console.warn = warn;
  }
  const saved = readFileSync(statePath, "utf8");
  assert.ok(Buffer.byteLength(saved) <= Math.floor(wholeBytes / 2), "within the cap in bytes");
  const logs = (JSON.parse(saved) as { logs: Array<{ path: string }>; complete: boolean }).logs;
  assert.ok(logs.length > 5 && logs.length < 30, `${logs.length} of 30 logs kept`);
  assert.ok(logs.some((log) => log.path === logAt(29, "-cjk")), "the newest log is kept");
  assert.equal(logs.some((log) => log.path === logAt(0, "-cjk")), false, "the oldest goes first");
  assert.equal((JSON.parse(saved) as { complete: boolean }).complete, false, "marked unfinished: the rest is read again");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /\d+ of 30 logs not saved/);
  assert.equal(warnings[0]!.includes("项目"), false, "the warning has counts only");
  // After a reload only the logs left out are read again.
  await usage.reloadUsage();
  const read = await pass();
  const all = Array.from({ length: 30 }, (_, i) => statSync(logAt(i, "-cjk")).size).reduce((a, b) => a + b, 0);
  assert.ok(read > 0 && read < all, `read ${read} of ${all} bytes`);
});

test("fitEntries counts bytes, keeps order and always gives valid JSON", () => {
  const entries = ["\"ü\"", "\"€€\"", "\"x\""];
  const { text, dropped } = stateFile.fitEntries({ version: 1 }, "logs", entries, 30);
  assert.ok(Buffer.byteLength(text) <= 30);
  assert.deepEqual(JSON.parse(text), { version: 1, logs: entries.slice(0, entries.length - dropped).map((entry) => JSON.parse(entry)) });
  assert.ok(dropped >= 1);
});

// ------------------------------------------------------------------ 3. gentle listing

test("catching up lists the logs once, not on every pass", async () => {
  setCounting(true);
  usage.forgetUsage();
  useFolder("list");
  for (let i = 0; i < 12; i += 1) writeLines(logAt(i, "-list"), Array.from({ length: 20 }, () => claudeSkillLine("beta", isoDaysAgo(2), `s${i}`, "/w")));
  const budget = usage.PASS_LIMITS.readBytes;
  usage.PASS_LIMITS.readBytes = 4_000;
  try {
    let passes = 0;
    while (!usage.usageStats().complete && passes < 200) {
      await pass();
      passes += 1;
    }
    assert.ok(passes > 3);
    assert.equal(usage.usageStats().listings, 1, `${passes} passes, one listing`);
  } finally {
    usage.PASS_LIMITS.readBytes = budget;
  }
  // Caught up: every later pass looks for new logs.
  await pass();
  await pass();
  assert.equal(usage.usageStats().listings, 3);
});

// ------------------------------------------------------------------ 4. per-log validation, future dates

test("a clock set ahead doesn't spoil the saved copy: future days are dropped, the log resumes", async () => {
  setCounting(true);
  usage.forgetUsage();
  useFolder("future");
  const lines: string[] = [];
  for (let d = 0; d <= 89; d += 1) lines.push(claudeSkillLine("alpha", isoDaysAgo(d), "f1", "/w"));
  for (const ahead of [2, 3, 4]) lines.push(claudeSkillLine("alpha", isoDaysAgo(-ahead), "f1", "/w"));
  writeLines(logAt(1, "-future"), lines);
  writeLines(logAt(2, "-future"), [claudeSkillLine("beta", isoDaysAgo(1), "f2", "/w")]);
  await pass();
  const before = usage.usageSummary(["alpha", "beta"], 90).totals.uses;
  await usage.saveUsageNow();
  await usage.reloadUsage();
  assert.equal(await pass(), 0, "nothing read again after a reload");
  assert.equal(usage.usageSummary(["alpha", "beta"], 90).totals.uses, before);
});

test("one bad log in the saved copy costs only that log", async () => {
  await usage.saveUsageNow();
  const saved = JSON.parse(readFileSync(statePath, "utf8")) as { logs: Array<{ path: string; offset: number }> };
  const bad = saved.logs.find((log) => log.path === logAt(2, "-future"))!;
  bad.offset = -5;
  writeFileSync(statePath, JSON.stringify(saved));
  const before = usage.usageSummary(["alpha", "beta"], 90).totals.uses;
  await usage.reloadUsage();
  assert.equal(await pass(), statSync(logAt(2, "-future")).size, "only the bad log is read again");
  assert.equal(usage.usageSummary(["alpha", "beta"], 90).totals.uses, before);
});

// ------------------------------------------------------------------ 6. temp files, shutdown

test("temp files a crash left behind are removed at start; fresh ones are left alone", async () => {
  const dir = join(statePath, "..");
  mkdirSync(dir, { recursive: true });
  const old = join(dir, "skill-usage.json.aaaaaa.tmp");
  const fresh = join(dir, "skill-usage.json.bbbbbb.tmp");
  writeFileSync(old, "x");
  writeFileSync(fresh, "x");
  const past = new Date(Date.now() - 5 * 60_000);
  utimesSync(old, past, past);
  assert.equal(await stateFile.sweepStateTemps(), 1);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
});

test("a stopped saver (shutdown) makes the save that was due, then nothing more", async () => {
  let saves = 0;
  const saver = new stateFile.StateSaver("saver-test", async () => ((saves += 1), "{}"), 60_000);
  saver.soon();
  await saver.stop();
  assert.equal(saves, 1, "the due save is made");
  saver.soon();
  await saver.now();
  assert.equal(saves, 1, "nothing after the stop");
  assert.equal(existsSync(stateFile.statePath("saver-test")), true);
});
