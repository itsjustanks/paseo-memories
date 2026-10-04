/**
 * The background code-name scan must not hold on to source text: memory
 * stays flat across passes while files change, deleted files and dropped
 * projects are forgotten, and the answers stay right.
 */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import { makeSandbox } from "./helpers";

const sb = await makeSandbox();
const { forgetScans, requestScan, scanSettled, scanStats, symbolIndex, PASS_LIMITS } = await import("../server/symbols");

after(() => sb.cleanup());

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;
function heapAfterGc(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

const MB = 1024 * 1024;
const PROJECTS = 6;
const FILES = 120;

// Long identifiers: V8 cuts matches of 13+ characters out of the file's text instead of copying them.
let seed = 7;
const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const WORDS = ["workspace", "member", "channel", "property", "agreement", "portfolio", "render", "fetch", "update", "query", "widget", "handler"];
const ident = () => Array.from({ length: 3 }, (_, i) => (i ? (w: string) => w[0]!.toUpperCase() + w.slice(1) : (w: string) => w)(WORDS[Math.floor(random() * WORDS.length)]!)).join("") + Math.floor(random() * 5000);
function source(bytes: number, extra = ""): string {
  const lines = [extra];
  let size = 0;
  while (size < bytes) {
    const line = `export function ${ident()}(${ident()}: number) { return ${ident()}.${ident()}(); }`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

const roots = Array.from({ length: PROJECTS }, (_, i) => join(sb.root, "scan", `project${i}`));
const liveFiles = () => roots.reduce((sum, root) => sum + (readdirSync(join(root, "src"), { recursive: true }) as string[]).filter((name) => name.endsWith(".ts")).length, 0);
for (const root of roots) {
  mkdirSync(join(root, "src"), { recursive: true });
  for (let i = 0; i < FILES; i += 1) writeFileSync(join(root, "src", `f${i}.ts`), source(15_000 + Math.floor(random() * 20_000), i === 0 ? "const plantedNameAlpha = 1;" : ""));
}
const queries = new Map(roots.map((root) => [root, ["plantedNameAlpha", "laterNameBeta", "neverThereGamma"]]));

async function pass(q: Map<string, string[]> = queries): Promise<void> {
  requestScan(q, true);
  await scanSettled();
}

function churn(round: number): void {
  for (const root of roots) {
    for (let i = 1; i < FILES; i += 1) {
      const path = join(root, "src", `f${i}.ts`);
      const roll = random();
      if (roll < 0.1) writeFileSync(path, source(20_000));
      else if (roll < 0.15) rmSync(path, { force: true });
    }
    for (let i = 0; i < 6; i += 1) writeFileSync(join(root, "src", `r${round}_${i}.ts`), source(20_000));
  }
}

test("the code-name scan keeps a small, flat amount of memory and forgets what is gone", async () => {
  forgetScans();
  const baseline = heapAfterGc();
  const heaps: number[] = [];
  for (let round = 1; round <= 6; round += 1) {
    if (round > 1) churn(round);
    if (round === 3) rmSync(join(roots[0]!, "src", "f0.ts"));
    if (round === 4) writeFileSync(join(roots[1]!, "src", "later.ts"), "export const laterNameBeta = 2;\n");
    await pass();
    heaps.push(heapAfterGc());
    const stats = scanStats();
    assert.equal(stats.unfinished, false);
    assert.equal(stats.files, liveFiles(), `round ${round}: one cache entry per live file, deleted files forgotten`);

    const first = symbolIndex(roots[0]!)!;
    assert.equal(first.found.has("plantedNameAlpha"), round < 3, `round ${round}: a deleted name is gone`);
    assert.equal(symbolIndex(roots[1]!)!.found.has("laterNameBeta"), round >= 4, `round ${round}: a new name is found`);
    assert.equal(first.found.has("neverThereGamma"), false);
  }
  // About 25 MB of source is scanned each round; before 0.2.1 all of it stayed in memory, twice over.
  const retained = heaps[heaps.length - 1]! - baseline;
  assert.ok(retained < 8 * MB, `retained ${(retained / MB).toFixed(1)} MB after six rounds`);
  assert.ok(heaps[heaps.length - 1]! <= heaps[0]! + 2 * MB, `no growth across rounds: ${heaps.map((heap) => (heap / MB).toFixed(1)).join(", ")} MB`);

  // A project no memory mentions any more is dropped with its cache.
  const fewer = new Map([...queries].slice(1));
  await pass(fewer);
  assert.equal(symbolIndex(roots[0]!), null);
  assert.equal(scanStats().projects, PROJECTS - 1);
  assert.equal(scanStats().files, liveFiles() - (readdirSync(join(roots[0]!, "src")) as string[]).length);
});

test("the read budget spreads a big first scan over several passes without losing work", async () => {
  forgetScans();
  const budget = PASS_LIMITS.readBytes;
  PASS_LIMITS.readBytes = 2 * MB;
  try {
    await pass();
    const cut = scanStats();
    assert.equal(cut.unfinished, true);
    assert.ok(cut.projects < PROJECTS, "projects not fully read have no answer yet");
    let passes = 1;
    while (scanStats().unfinished && passes < 40) {
      await pass();
      passes += 1;
    }
    assert.equal(scanStats().unfinished, false);
    assert.equal(scanStats().projects, PROJECTS);
    assert.equal(scanStats().files, liveFiles());
    assert.ok(passes > 3, `took ${passes} passes`);
    assert.equal(symbolIndex(roots[1]!)!.found.has("laterNameBeta"), true);
  } finally {
    PASS_LIMITS.readBytes = budget;
  }
});

// ------------------------------------------------------------------ skill use (0.4.0)

const usage = await import("../server/skill-usage");

test("the skill-use scan keeps small tallies only, flat across passes, and forgets deleted logs", async () => {
  const { markClientSeen } = await import("../server/presence");
  const { claudeNoiseLine, claudeSkillLine, isoDaysAgo, writeLines } = await import("./skills-helpers");
  markClientSeen();
  usage.forgetUsage();
  const dir = join(sb.root, "skills-scan", "claude");
  const LOGS = 12;
  const SKILLS = ["alpha", "beta", "gamma", "delta"];
  const logPath = (i: number) => join(dir, "projects", `-w-p${i % 3}`, `sess-${i}.jsonl`);
  // About 3 MB per log: long noise lines (the text agents write) with a skill use now and then.
  const chunk = (i: number, round: number) => {
    const lines: string[] = [];
    for (let j = 0; j < 400; j += 1) {
      lines.push(claudeNoiseLine(isoDaysAgo(j % 20), `sess-${i}`, `/w/p${i % 3}`, 7_000 + (j % 5) * 100));
      if (j % 40 === 0) lines.push(claudeSkillLine(`${SKILLS[(i + j + round) % SKILLS.length]}`, isoDaysAgo(j % 20), `sess-${i}`, `/w/p${i % 3}`));
    }
    return lines;
  };
  for (let i = 0; i < LOGS; i += 1) writeLines(logPath(i), chunk(i, 0));
  const accounts = [{ agent: "claude", dir, exists: true }];
  const run = async () => {
    usage.requestUsagePass(accounts, { force: true });
    await usage.usageSettled();
  };
  const baseline = heapAfterGc();
  const heaps: number[] = [];
  let expected = 0;
  for (let round = 1; round <= 5; round += 1) {
    if (round > 1) for (let i = round > 4 ? 1 : 0; i < LOGS; i += 1) writeLines(logPath(i), chunk(i, round), true);
    if (round === 4) rmSync(logPath(0));
    await run();
    heaps.push(heapAfterGc());
    const stats = usage.usageStats();
    assert.equal(stats.complete, true);
    assert.equal(stats.files, round >= 4 ? LOGS - 1 : LOGS, `round ${round}: one entry per live log`);
    assert.ok(stats.skills <= stats.files * SKILLS.length);
    assert.ok(stats.days <= stats.skills * 20, "only days with uses are kept");
    const total = usage.usageSummary(SKILLS, 90).totals.uses;
    expected = (round >= 4 ? LOGS - 1 : LOGS) * 10 * round;
    assert.equal(total, expected, `round ${round}: every use counted once`);
  }
  // About 36 MB of logs is read in round one and 36 MB more each round after.
  const retained = heaps[heaps.length - 1]! - baseline;
  assert.ok(retained < 8 * MB, `retained ${(retained / MB).toFixed(1)} MB after five rounds`);
  assert.ok(heaps[heaps.length - 1]! <= heaps[0]! + 2 * MB, `no growth across rounds: ${heaps.map((heap) => (heap / MB).toFixed(1)).join(", ")} MB`);
  assert.ok(expected > 0);
});
