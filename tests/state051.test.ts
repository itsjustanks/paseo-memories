/**
 * 0.5.1: the background scans keep their place across plugin loads, so an
 * update or a restart reads only what is new; catching up is gentle; and
 * routine checks run only while a page is open. Synthetic logs and projects
 * only, all inside the sandbox.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { makeSandbox } from "./helpers";
import { claudeNoiseLine, claudeSkillLine, codexMetaLine, codexReadLine, codexSkillBlockLine, codexTurnLine, isoDaysAgo, writeLines } from "./skills-helpers";

const sb = await makeSandbox();
const usage = await import("../server/skill-usage");
const symbols = await import("../server/symbols");
const { statePath } = await import("../server/state-file");
const { markClientSeen, resetPresence, PAGE_OPEN_MS, WATCH_WINDOW_MS } = await import("../server/presence");
const { Revalidating } = await import("../server/revalidate");
const { Pacer, BACKGROUND_PACE } = await import("../server/pace");

after(() => sb.cleanup());

const SKILLS = ["alpha", "beta", "gamma"];
const claudeDir = join(sb.root, "s051", "claude");
const codexDir = join(sb.root, "s051", "codex");
const accounts = [
  { agent: "claude", dir: claudeDir, exists: true },
  { agent: "codex", dir: codexDir, exists: true },
];
const logPath = (i: number) => join(claudeDir, "projects", `-w-p${i % 2}`, `sess-${i}.jsonl`);
const codexLog = join(codexDir, "sessions", ...isoDaysAgo(1).slice(0, 10).split("-"), "rollout-9.jsonl");
const SECRET_TEXT = "transcript-words-that-must-never-be-saved";

function writeAll(): void {
  for (let i = 0; i < 6; i += 1) {
    const lines: string[] = [];
    for (let j = 0; j < 30; j += 1) {
      lines.push(claudeNoiseLine(isoDaysAgo(j % 10), `sess-${i}`, `/w/p${i % 2}`, 2_000).replace("xxxx", SECRET_TEXT));
      if (j % 5 === 0) lines.push(claudeSkillLine(SKILLS[(i + j) % SKILLS.length]!, isoDaysAgo(j % 10), `sess-${i}`, `/w/p${i % 2}`));
    }
    writeLines(logPath(i), lines);
  }
  writeLines(codexLog, [codexMetaLine("thread-1", "/w/p0", isoDaysAgo(1)), codexTurnLine("/w/p0", isoDaysAgo(1)), codexSkillBlockLine("alpha", isoDaysAgo(1))]);
}

async function pass(): Promise<number> {
  usage.requestUsagePass(accounts, { force: true });
  await usage.usageSettled();
  return usage.usageStats().readBytes;
}

async function catchUp(): Promise<void> {
  for (let i = 0; i < 200 && !usage.usageStats().complete; i += 1) await pass();
  if (!usage.usageStats().complete) await pass();
}

const counts = () => {
  const summary = usage.usageSummary(SKILLS, 90);
  return { total: summary.totals.uses, rows: summary.rows.map((row) => [row.name, row.total, row.claude, row.codex]) };
};

/** A new plugin load: the scan's memory is gone; only the saved copy remains. */
async function reload(): Promise<void> {
  await usage.saveUsageNow();
  await usage.reloadUsage();
}

const logBytes = () => [0, 1, 2, 3, 4, 5].reduce((sum, i) => sum + statSync(logPath(i)).size, 0) + statSync(codexLog).size;

test("after a reload, unchanged logs read nothing and the counts are the same", async () => {
  usage.forgetUsage();
  writeAll();
  assert.equal(await pass(), logBytes(), "the first pass reads every log once");
  const before = counts();
  assert.ok(before.total > 0);
  await reload();
  assert.equal(existsSync(statePath("skill-usage")), true);
  const saved = readFileSync(statePath("skill-usage"), "utf8");
  assert.equal(saved.includes(SECRET_TEXT), false, "never a line's text");
  assert.equal(saved.includes("Using a skill"), false);
  assert.equal(usage.usageState().state, "waiting", "nothing in memory before the saved copy is read");
  assert.equal(await pass(), 0, "nothing read again");
  assert.deepEqual(counts(), before);
  assert.equal(usage.usageState().complete, true);
});

test("lines added while the plugin was off are read after a reload, and only they are", async () => {
  const before = counts().total;
  const added = [claudeSkillLine("beta", isoDaysAgo(0), "sess-1", "/w/p1"), claudeNoiseLine(isoDaysAgo(0), "sess-1", "/w/p1", 500)];
  await reload();
  writeLines(logPath(1), added, true);
  // Codex: the same skill again in the same turn counts once; a new turn counts again.
  writeLines(codexLog, [codexReadLine("alpha", isoDaysAgo(1))], true);
  const read = await pass();
  assert.equal(read, added.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0) + Buffer.byteLength(codexReadLine("alpha", isoDaysAgo(1))) + 1);
  assert.equal(counts().total, before + 1, "the new Claude use; the Codex read was in a turn already counted");
  await reload();
  writeLines(codexLog, [codexTurnLine("/w/p0", isoDaysAgo(0)), codexReadLine("alpha", isoDaysAgo(0))], true);
  await pass();
  assert.equal(counts().total, before + 2, "a new turn counts again");
});

test("a log cut shorter, replaced or deleted while the plugin was off", async () => {
  const before = counts();
  // Cut shorter in place: read again from the start.
  await reload();
  writeLines(logPath(2), [claudeSkillLine("gamma", isoDaysAgo(0), "sess-2", "/w/p0")]);
  await pass();
  const afterCut = counts();
  assert.ok(afterCut.total < before.total, "the old uses went with the old text");
  // Replaced by a new file (rotated): read again from the start.
  await reload();
  writeLines(`${logPath(3)}.new`, [claudeSkillLine("alpha", isoDaysAgo(0), "sess-3", "/w/p1")]);
  renameSync(`${logPath(3)}.new`, logPath(3));
  await pass();
  const afterRotate = counts();
  assert.ok(afterRotate.total < afterCut.total);
  // Deleted: dropped from the counts and from the saved copy.
  await reload();
  rmSync(logPath(4));
  await pass();
  await usage.saveUsageNow();
  assert.equal(readFileSync(statePath("skill-usage"), "utf8").includes(logPath(4)), false, "a deleted log leaves the saved copy");
  assert.equal(usage.usageStats().files, 6, "five Claude logs and the Codex one");
  // Starting over from nothing gives the same counts.
  const kept = counts();
  usage.forgetUsage();
  await catchUp();
  assert.deepEqual(counts(), kept);
});

test("a broken, unknown or wrongly shaped saved copy means starting fresh, never a crash", async () => {
  await usage.saveUsageNow();
  const expected = counts();
  const bad = ["{not json", JSON.stringify({ version: 99, logs: [] }), JSON.stringify({ version: 1, complete: true, cursor: 0, finishedAt: null, logs: [{ path: 3 }] }), ""];
  for (const text of bad) {
    await usage.reloadUsage();
    writeFileSync(statePath("skill-usage"), text);
    const read = await pass();
    assert.ok(read > 0, "every log read again");
    assert.deepEqual(counts(), expected);
  }
});

test("turning counting off removes the saved copy", async () => {
  await usage.saveUsageNow();
  assert.equal(existsSync(statePath("skill-usage")), true);
  usage.forgetUsage();
  for (let i = 0; i < 50 && existsSync(statePath("skill-usage")); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(existsSync(statePath("skill-usage")), false);
  await usage.reloadUsage();
  assert.equal(existsSync(statePath("skill-usage")), false, "and it doesn't come back");
});

test("each pass reads at most its budget (64 MB on a host; finishing a line already begun aside)", async () => {
  assert.equal(usage.PASS_LIMITS.readBytes, 64 * 1024 * 1024);
  const budget = usage.PASS_LIMITS.readBytes;
  const longest = Math.max(...[0, 1, 2, 3, 5].flatMap((i) => readFileSync(logPath(i), "utf8").split("\n").map((line) => line.length + 1)));
  usage.PASS_LIMITS.readBytes = 9_000;
  try {
    usage.forgetUsage();
    let passes = 0;
    let total = 0;
    while (!usage.usageStats().complete && passes < 200) {
      const read = await pass();
      assert.ok(read <= 9_000 + longest, `a pass read ${read} bytes`);
      total += read;
      passes += 1;
    }
    assert.ok(passes > 3, `took ${passes} passes`);
    const live = [0, 1, 2, 3, 5].reduce((sum, i) => sum + statSync(logPath(i)).size, 0) + statSync(codexLog).size;
    assert.equal(total, live, "every byte read once over the passes");
  } finally {
    usage.PASS_LIMITS.readBytes = budget;
  }
});

test("catching up is paced to a few percent of one core", async () => {
  assert.ok(BACKGROUND_PACE.share <= 0.05);
  const pacer = new Pacer();
  const began = performance.now();
  let busy = 0;
  while (performance.now() - began < 1_500) {
    const start = performance.now();
    while (performance.now() - start < 2);
    busy += performance.now() - start;
    await pacer.step();
  }
  const share = busy / (performance.now() - began);
  assert.ok(share < 0.07, `worked ${(share * 100).toFixed(1)}% of the time`);
});

test("routine checks stop a minute after the last request and resume with the next", async () => {
  let checks = 0;
  const cache = new Revalidating<number>(() => 0, { reuseMs: 0, checkEveryMs: 0, checkWhile: () => Date.now() - seenAt < PAGE_OPEN_MS });
  let seenAt = Date.now();
  const work = { compute: async () => ({ value: 1, seen: new Map(), inputs: "x" }), inputs: async () => ((checks += 1), "x") };
  await cache.get(work, "stale-ok");
  await cache.get(work, "stale-ok");
  await cache.settled();
  assert.equal(checks, 1, "a page is open: checked");
  seenAt = Date.now() - PAGE_OPEN_MS - 1_000;
  await cache.get(work, "stale-ok");
  await cache.settled();
  assert.equal(checks, 1, "no request for over a minute: no check");
  seenAt = Date.now();
  await cache.get(work, "stale-ok");
  await cache.settled();
  assert.equal(checks, 2, "the next request: checking again");

  // The timers: a finished count re-checks only while a page is open; an unfinished one carries on while an app is connected.
  usage.forgetUsage();
  resetPresence();
  usage.requestUsagePass(accounts, { force: true });
  await usage.usageSettled();
  assert.equal(usage.usageStats().complete, true);
  markClientSeen(Date.now() - PAGE_OPEN_MS - 1_000);
  assert.equal(usage.timerPassDue(), false, "caught up and no page open: idle");
  markClientSeen();
  assert.equal(usage.timerPassDue(), true);
  const budget = usage.PASS_LIMITS.readBytes;
  usage.PASS_LIMITS.readBytes = 1_000;
  try {
    usage.forgetUsage();
    await pass();
    assert.equal(usage.usageStats().complete, false);
    markClientSeen(Date.now() - PAGE_OPEN_MS - 1_000);
    assert.equal(usage.timerPassDue(), true, "catching up carries on for a while after the page closes");
    markClientSeen(Date.now() - WATCH_WINDOW_MS - 1_000);
    assert.equal(usage.timerPassDue(), false, "and stops when no app has asked for 15 minutes");
  } finally {
    usage.PASS_LIMITS.readBytes = budget;
  }
  symbols.forgetScans();
  markClientSeen(Date.now() - PAGE_OPEN_MS - 1_000);
  assert.equal(symbols.timerScanDue(), false, "the code-name re-check: idle without a page");
  markClientSeen();
  assert.equal(symbols.timerScanDue(), true);
});

// ------------------------------------------------------------------ the code-name scan

const projectRoot = join(sb.root, "s051", "project");
const queries = () => new Map([[projectRoot, ["plantedName", "laterName", "neverThere"]]]);

async function scan(q = queries()): Promise<number> {
  symbols.requestScan(q, true);
  await symbols.scanSettled();
  return symbols.scanStats().readBytes;
}

test("the code-name scan carries on after a reload: unchanged files are not read again", async () => {
  symbols.forgetScans();
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  for (let i = 0; i < 20; i += 1) writeFileSync(join(projectRoot, "src", `f${i}.ts`), `export const value${i} = ${i};\n${i === 3 ? "const plantedName = 1;\n" : ""}`.repeat(50));
  const first = await scan();
  assert.ok(first > 0);
  assert.equal(symbols.symbolIndex(projectRoot)!.found.has("plantedName"), true);
  await symbols.saveScansNow();
  const saved = readFileSync(statePath("code-names"), "utf8");
  assert.equal(saved.includes("export const"), false, "never a file's text");

  await symbols.reloadScans();
  assert.equal(await scan(), 0, "nothing read after a reload");
  assert.deepEqual([...symbols.symbolIndex(projectRoot)!.found], ["plantedName"]);

  // A file changed while the plugin was off: only it is read.
  await symbols.saveScansNow();
  await symbols.reloadScans();
  const changed = join(projectRoot, "src", "f7.ts");
  writeFileSync(changed, "export const laterName = 2;\n");
  assert.equal(await scan(), statSync(changed).size);
  assert.equal(symbols.symbolIndex(projectRoot)!.found.has("laterName"), true);

  // Other names asked about: everything is read again.
  await symbols.saveScansNow();
  await symbols.reloadScans();
  assert.ok((await scan(new Map([[projectRoot, ["plantedName", "anotherName"]]]))) > first / 2);

  // A broken saved copy: a fresh scan.
  await symbols.reloadScans();
  writeFileSync(statePath("code-names"), "[broken");
  assert.ok((await scan()) > 0);
  assert.equal(symbols.symbolIndex(projectRoot)!.found.has("plantedName"), true);
});
