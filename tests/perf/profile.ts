/**
 * Timings at the size of a busy real host (tests/perf/big-home.ts), cold and
 * warm, plus memory and the CPU a page left open costs. Not part of
 * `npm test` (it writes over a gigabyte of chat logs); run by hand:
 *
 *   node --import tsx --expose-gc tests/perf/profile.ts [--log-mb 1100] [--cycles 20]
 */
import { makeSandbox } from "../helpers";
import { makeBigHome } from "./big-home";

const arg = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? Number(process.argv[at + 1]) : fallback;
};
const LOG_MB = arg("log-mb", 1100);
const CYCLES = arg("cycles", 20);

const sb = await makeSandbox();
const builtAt = Date.now();
const big = makeBigHome(sb, { logBytes: LOG_MB * 1024 * 1024 });
console.log(`built: ${big.projects.length} projects, ${big.memoryDirs.length} memory folders, ${(big.logBytes / 1024 / 1024).toFixed(0)} MB logs in ${big.logFiles} files (${((Date.now() - builtAt) / 1000).toFixed(1)} s)`);

const read = await import("../../server/read");
const tidy = await import("../../server/tidy");
const search = await import("../../server/search");
const skills = await import("../../server/skill-handlers");
const usage = await import("../../server/skill-usage");
const symbols = await import("../../server/symbols");
const presence = await import("../../server/presence");
const { forgetDiscovery } = await import("../../server/discover");

const ctx = { paseo: big.paseo.api } as never;
const gc = (globalThis as { gc?: () => void }).gc ?? (() => undefined);
const MB = 1024 * 1024;
const mem = () => {
  gc();
  gc();
  const m = process.memoryUsage();
  return `rss ${(m.rss / MB).toFixed(0)} MB, heap ${(m.heapUsed / MB).toFixed(0)} MB (of ${(m.heapTotal / MB).toFixed(0)}), external ${(m.external / MB).toFixed(0)} MB`;
};

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  presence.markClientSeen();
  const began = performance.now();
  const cpu = process.cpuUsage();
  const out = await fn();
  const used = process.cpuUsage(cpu);
  console.log(`${label.padEnd(34)} ${(performance.now() - began).toFixed(0).padStart(7)} ms  (cpu ${((used.user + used.system) / 1000).toFixed(0)} ms)`);
  return out;
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`start: ${mem()}`);
const ws = "ws-big-3";
const calls: Array<[string, () => Promise<unknown>]> = [
  ["inventory", () => read.handleInventory({}, ctx)],
  ["findings", () => tidy.handleFindings({}, ctx)],
  ["search", () => search.handleSearch({ query: "workspace member" }, ctx)],
  ["skills-inventory", () => skills.handleSkillsInventory({}, ctx)],
  ["skills-usage", () => skills.handleSkillsUsage({}, ctx)],
  ["workspace-plan", () => read.handleWorkspacePlan({ workspaceId: ws }, ctx)],
  ["agent-plan", () => read.handleAgentPlan({ workspaceId: ws, providerId: "claude" }, ctx)],
];
for (const [label, fn] of calls) await time(`cold ${label}`, fn);
await symbols.scanSettled();
for (const [label, fn] of calls) await time(`warm ${label}`, fn);
await pause(2_100);
for (const [label, fn] of calls) await time(`warm +2s ${label}`, fn);
await symbols.scanSettled();
console.log(`after one round: ${mem()}`);

// Ten findings at once, nothing changed.
await pause(2_100);
await time("burst 10× findings", () => Promise.all(Array.from({ length: 10 }, () => tidy.handleFindings({}, ctx))));
await symbols.scanSettled();

// A page left open: the app asks for findings every 30 s; here back to back, nothing changed on disk.
{
  const cpu = process.cpuUsage();
  const began = performance.now();
  for (let i = 0; i < 6; i += 1) {
    await pause(2_100);
    presence.markClientSeen();
    await tidy.handleFindings({}, ctx);
    await read.handleInventory({}, ctx);
    await symbols.scanSettled();
  }
  const used = process.cpuUsage(cpu);
  const idle = 6 * 2_100;
  console.log(`page open, 6 polls, nothing changed: cpu ${((used.user + used.system) / 1000 - 0).toFixed(0)} ms over ${(performance.now() - began - idle).toFixed(0)} ms busy`);
}

// Usage: passes until the whole backlog is counted.
{
  const accounts = [{ agent: "claude", dir: sb.claude, exists: true }];
  let passes = 0;
  let busy = 0;
  let cpuMs = 0;
  for (;;) {
    passes += 1;
    const began = performance.now();
    const cpu = process.cpuUsage();
    usage.requestUsagePass(accounts, { force: true });
    await usage.usageSettled();
    const used = process.cpuUsage(cpu);
    busy += performance.now() - began;
    cpuMs += (used.user + used.system) / 1000;
    if (usage.usageStats().complete || passes > 200) break;
  }
  console.log(`usage: ${passes} passes, ${(busy / 1000).toFixed(1)} s working, cpu ${(cpuMs / 1000).toFixed(1)} s, ${mem()}`);
}

// Cycles with churn: memory must stay flat.
for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
  presence.markClientSeen();
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  writeFileSync(join(big.memoryDirs[cycle % big.memoryDirs.length]!, `churn-${cycle}.md`), `---\nname: churn ${cycle}\n---\n\nChanged in cycle ${cycle}, see \`src/lib/x${cycle}.ts\`.\n`);
  forgetDiscovery();
  await read.handleInventory({ refresh: true }, ctx);
  await tidy.handleFindings({ refresh: true }, ctx);
  await skills.handleSkillsInventory({ refresh: true }, ctx);
  await symbols.scanSettled();
  if (cycle === 1 || cycle % 5 === 0) console.log(`cycle ${cycle}: ${mem()}`);
}
sb.cleanup();
process.exit(0);
