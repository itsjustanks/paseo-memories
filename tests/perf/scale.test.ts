/**
 * Speed and memory at the size of the busiest real host (899
 * memory files, 109 project roots, 253 instruction files, ~2,000 chat logs
 * of which some run to tens of megabytes), on a generated HOME
 * (big-home.ts). What 0.4.0 got wrong there: every read of the
 * findings worked everything out again (12 s on that host, every ~20 s
 * while a page was open), in long synchronous stretches that held up every
 * other plugin call.
 *
 * Checked here: a cold read stays within a sane bound; a warm read takes
 * under 200 ms and works nothing out again; a change on disk shows after a
 * background check; repeated polls leave memory flat; the usage count
 * streams the logs; and the event loop never stops for more than 100 ms.
 * The numbers are printed (`node --test` diagnostics).
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import { makeSandbox } from "../helpers";
import { makeBigHome } from "./big-home";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;
const MB = 1024 * 1024;

const sb = await makeSandbox();
const big = makeBigHome(sb, { logBytes: 64 * MB, logFiles: 2049, bigLogs: 4, bigLogBytes: 16 * MB });
const tidy = await import("../../server/tidy");
const read = await import("../../server/read");
const symbols = await import("../../server/symbols");
const usage = await import("../../server/skill-usage");
const presence = await import("../../server/presence");
const files = await import("../../server/files");
const corpus = await import("../../server/corpus");
const paseo = big.paseo.api;

after(() => sb.cleanup());

/**
 * The longest the event loop went without running a 2 ms timer, per phase.
 * On a busy machine the system can also leave the whole process waiting;
 * the loop cannot have been held for longer than the main thread's CPU in
 * the gap, so `held` (the smaller of the two) is what is checked, and the
 * plain gap is reported beside it. (Without `process.threadCpuUsage`, Node
 * < 23.9, the whole process's CPU: a looser bound.)
 */
const threadCpu = (process as { threadCpuUsage?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage }).threadCpuUsage?.bind(process) ?? process.cpuUsage.bind(process);
const stalls = new Map<string, { gap: number; held: number }>();
let phase = "start";
let lastTick = performance.now();
let lastCpu = threadCpu();
const ticker = setInterval(() => {
  const now = performance.now();
  const cpu = threadCpu(lastCpu);
  const gap = now - lastTick - 2;
  const held = Math.min(gap, (cpu.user + cpu.system) / 1000);
  const worst = stalls.get(phase) ?? { gap: 0, held: 0 };
  stalls.set(phase, { gap: Math.max(worst.gap, gap), held: Math.max(worst.held, held) });
  lastTick = now;
  lastCpu = threadCpu();
}, 2);
after(() => clearInterval(ticker));

function enter(name: string): void {
  phase = name;
  lastTick = performance.now();
  lastCpu = threadCpu();
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const began = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - began };
}

/** Memory after a full collection (the collection itself stops the loop: not counted as a stall). */
function memory(): { rss: number; heap: number } {
  const was = phase;
  enter("measuring");
  gc();
  gc();
  const m = process.memoryUsage();
  enter(was);
  return { rss: m.rss / MB, heap: m.heapUsed / MB };
}

test("at a big host's size: the findings are worked out once, then read from the cache", async (t) => {
  presence.markClientSeen();
  enter("cold findings");
  const cold = await timed(() => tidy.findingsFor(paseo));
  await settle();
  t.diagnostic(`cold findings: ${cold.ms.toFixed(0)} ms, ${cold.value.findings.length} findings; ${cold.value.checked[0]}`);
  assert.ok(cold.value.findings.length > 0);
  assert.ok(cold.ms < 20_000, `a first read at this size should take seconds at most, took ${cold.ms.toFixed(0)} ms`);

  enter("code-name scan");
  await symbols.scanSettled();
  await settle();

  const computed = tidy.findingsComputations();
  enter("warm findings");
  let worst = 0;
  for (let i = 0; i < 30; i += 1) {
    const warm = await timed(() => tidy.findingsFor(paseo));
    worst = Math.max(worst, warm.ms);
  }
  await settle();
  t.diagnostic(`warm findings: worst of 30 reads ${worst.toFixed(1)} ms`);
  assert.ok(worst < 200, `a warm read took ${worst.toFixed(0)} ms`);
  assert.equal(tidy.findingsComputations(), computed, "polls with nothing changed work nothing out again");
});

test("a page left open: each poll checks in the background, works nothing out again, and memory stays flat", async (t) => {
  const timing = { ...tidy.FINDINGS_TIMING };
  // Every poll starts a check (the real gap is 10 s), so 200 polls do 200 checks.
  tidy.FINDINGS_TIMING.checkEveryMs = 0;
  tidy.FINDINGS_TIMING.reuseMs = 0;
  try {
    enter("polls");
    const poll = async () => {
      presence.markClientSeen();
      await tidy.findingsFor(paseo);
      await read.inventoryFor(paseo);
      await tidy.findingsSettled();
    };
    for (let i = 0; i < 40; i += 1) await poll();
    const computed = tidy.findingsComputations();
    // Memory after every 50 polls: the heap must stay flat; the RSS may wobble with the allocator, but not climb.
    const marks = [memory()];
    let slowest = 0;
    for (let block = 0; block < 4; block += 1) {
      for (let i = 0; i < 50; i += 1) {
        const one = await timed(poll);
        slowest = Math.max(slowest, one.ms);
      }
      marks.push(memory());
    }
    await settle();
    const first = marks[0]!;
    const last = marks[marks.length - 1]!;
    t.diagnostic(`200 polls, each with a full check: slowest ${slowest.toFixed(0)} ms; rss ${marks.map((mark) => mark.rss.toFixed(0)).join(" → ")} MB; heap ${marks.map((mark) => mark.heap.toFixed(1)).join(" → ")} MB`);
    assert.equal(tidy.findingsComputations(), computed, "nothing changed on disk, so nothing is worked out again");
    assert.ok(last.heap - first.heap < 4, `heap grew ${(last.heap - first.heap).toFixed(1)} MB over 200 polls`);
    assert.ok(last.rss - first.rss < 48, `rss grew ${(last.rss - first.rss).toFixed(0)} MB over 200 polls`);

    // A memory written by an agent (not through this plugin): the next poll still answers at once, the one after shows it.
    enter("change on disk");
    writeFileSync(join(big.memoryDirs[3]!, "fresh-note.md"), "---\nname: fresh note\ndescription: added by an agent\ntype: project\n---\n\nThe old importer lives in `src/lib/gone-importer-xyz.ts`.\n");
    const stale = await timed(() => tidy.findingsFor(paseo));
    assert.ok(stale.ms < 200, `the poll after a change answered in ${stale.ms.toFixed(0)} ms`);
    assert.equal(stale.value.checking, true, "it says a check is running");
    await tidy.findingsSettled();
    const fresh = await tidy.findingsFor(paseo);
    assert.equal(tidy.findingsComputations(), computed + 1, "worked out once for the change");
    assert.ok(fresh.findings.some((finding) => finding.message.includes("fresh-note.md") || finding.message.includes("fresh note")), "the new file shows");
    await settle();
  } finally {
    Object.assign(tidy.FINDINGS_TIMING, timing);
  }
});

test("the caches keep to their budgets, and the findings are the same when they overflow", async (t) => {
  enter("small caches");
  const full = await tidy.findingsFor(paseo, true);
  const sizes = { files: files.fileCacheSizes(), corpus: corpus.corpusCacheSize() };
  t.diagnostic(`caches: ${sizes.files.texts} texts (${(sizes.files.textBytes / MB).toFixed(1)} MB), ${sizes.files.jsons} parsed; corpus ${sizes.corpus.files} files (${(sizes.corpus.bytes / MB).toFixed(1)} MB)`);
  assert.ok(sizes.files.textBytes <= files.FILE_CACHE_LIMITS.textBytes && sizes.files.texts <= files.FILE_CACHE_LIMITS.files);
  assert.ok(sizes.corpus.bytes <= corpus.CORPUS_CACHE_LIMITS.bytes && sizes.corpus.files <= corpus.CORPUS_CACHE_LIMITS.files);
  const limits = { files: { ...files.FILE_CACHE_LIMITS }, corpus: { ...corpus.CORPUS_CACHE_LIMITS } };
  // Room for about a tenth of the notes: most are read again on every pass.
  files.FILE_CACHE_LIMITS.textBytes = MB;
  corpus.CORPUS_CACHE_LIMITS.bytes = MB;
  try {
    const squeezed = await tidy.findingsFor(paseo, true);
    assert.ok(files.fileCacheSizes().textBytes <= MB);
    assert.ok(corpus.corpusCacheSize().bytes <= MB);
    const ids = (answer: typeof full) => answer.findings.map((finding) => finding.id).sort();
    assert.deepEqual(ids(squeezed), ids(full), "the same findings");
  } finally {
    Object.assign(files.FILE_CACHE_LIMITS, limits.files);
    Object.assign(corpus.CORPUS_CACHE_LIMITS, limits.corpus);
  }
  await settle();
});

test("the usage count streams large chat logs: never a whole log in memory", async (t) => {
  enter("usage count");
  const accounts = [{ agent: "claude", dir: sb.claude, exists: true }];
  const base = process.memoryUsage();
  let peak = 0;
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    peak = Math.max(peak, m.arrayBuffers - base.arrayBuffers, m.external - base.external);
  }, 5);
  const began = performance.now();
  let passes = 0;
  try {
    while (!usage.usageStats().complete && passes < 20) {
      passes += 1;
      usage.requestUsagePass(accounts, { force: true });
      await usage.usageSettled();
    }
  } finally {
    clearInterval(sampler);
  }
  await settle();
  t.diagnostic(`usage: ${(big.logBytes / MB).toFixed(0)} MB of logs in ${big.logFiles} files counted in ${passes} passes, ${((performance.now() - began) / 1000).toFixed(1)} s; peak buffers +${(peak / MB).toFixed(1)} MB`);
  assert.ok(usage.usageStats().complete, "every log counted");
  assert.ok(usage.usageStats().skills > 0);
  assert.ok(peak < 12 * MB, `buffers peaked at +${(peak / MB).toFixed(1)} MB with 16 MB logs`);
});

test("the event loop never stops for more than 100 ms", (t) => {
  const report = [...stalls].map(([name, { gap, held }]) => `${name} ${held.toFixed(0)} ms (gap ${gap.toFixed(0)})`).join(", ");
  t.diagnostic(`longest the loop was held per phase: ${report}`);
  for (const [name, { held }] of stalls) if (name !== "start" && name !== "measuring") assert.ok(held < 100, `${name}: the event loop was held for ${held.toFixed(0)} ms`);
});
