/**
 * Counting skill use from chat logs: Claude's exact records (the model's
 * Skill calls, typed /commands, helper chats), Codex's estimates (<skill>
 * blocks, SKILL.md reads, once per turn), reading only what is new, a cut
 * last line left for later, rewritten and deleted logs, presence gating, and
 * "used in this chat" for an agent.
 */
import assert from "node:assert/strict";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { fakePaseo, makeSandbox } from "./helpers";
import {
  addSkills,
  claudeCommandLine,
  claudeNoiseLine,
  claudeSkillLine,
  codexListingLine,
  codexMetaLine,
  codexReadLine,
  codexSkillBlockLine,
  codexTurnLine,
  isoDaysAgo,
  writeLines,
} from "./skills-helpers";

const sb = addSkills(await makeSandbox());
const { requestUsagePass, usageSettled, usageStats, usageState, forgetUsage, PASS_LIMITS } = await import("../server/skill-usage");
const { handleSkillsUsage, handleSkillsAgent } = await import("../server/skill-handlers");
const { forgetSkillCaches } = await import("../server/skills");
const { markClientSeen, resetPresence } = await import("../server/presence");
const { discoverAccounts } = await import("../server/accounts");

after(() => sb.cleanup());

const project = join(sb.claude, "projects", "-w-app");
const mainLog = join(project, "sess-main.jsonl");
const helperLog = join(project, "sess-main", "subagents", "agent-a1.jsonl");
const otherLog = join(project, "sess-other.jsonl");
const codexLog = join(sb.codex, "sessions", ...isoDaysAgo(1).slice(0, 10).split("-"), "rollout-1.jsonl");

const fake = fakePaseo(sb);
const agentSnapshots = new Map<string, Record<string, unknown>>();
(fake.api as unknown as { agents: unknown }).agents = {
  ref: (id: string) => ({ refresh: async () => null, current: () => agentSnapshots.get(id) ?? null }),
};
const ctx = { paseo: fake.api };

async function pass(): Promise<void> {
  const { accounts } = await discoverAccounts();
  requestUsagePass(accounts, { force: true });
  await usageSettled();
}

function writeLogs(): void {
  writeLines(mainLog, [
    claudeNoiseLine(isoDaysAgo(2), "sess-main", sb.app),
    claudeSkillLine("alpha", isoDaysAgo(2), "sess-main", sb.app),
    claudeSkillLine("alpha", isoDaysAgo(1), "sess-main", sb.app),
    claudeCommandLine("own-skill", isoDaysAgo(1), "sess-main", sb.app),
    claudeCommandLine("model", isoDaysAgo(1), "sess-main", sb.app),
    claudeSkillLine("toolkit:deploy", isoDaysAgo(1), "sess-main", sb.app),
    claudeSkillLine("alpha", isoDaysAgo(60), "sess-main", sb.app),
  ]);
  writeLines(helperLog, [claudeSkillLine("beta", isoDaysAgo(1), "sess-main", sb.app, { agentId: "a1", isSidechain: true })]);
  writeLines(otherLog, [claudeSkillLine("beta", isoDaysAgo(3), "sess-other", join(sb.home, "code", "plain"))]);
  writeLines(codexLog, [
    codexMetaLine("thread-9", sb.app, isoDaysAgo(1)),
    codexTurnLine(sb.app, isoDaysAgo(1)),
    codexListingLine(isoDaysAgo(1)),
    codexSkillBlockLine("alpha", isoDaysAgo(1)),
    codexReadLine("alpha", isoDaysAgo(1)),
    codexTurnLine(sb.app, isoDaysAgo(1)),
    codexReadLine("legacy-x", isoDaysAgo(1), "custom_tool_call"),
  ]);
}

const rowsOf = async (days = 30) => {
  forgetSkillCaches();
  const usage = await handleSkillsUsage({ days }, ctx);
  return Object.fromEntries(usage.rows.map((row) => [row.name, row]));
};

test("Claude exact and Codex estimated, over the window", async () => {
  forgetUsage();
  writeLogs();
  markClientSeen();
  await pass();
  const rows = await rowsOf(30);
  assert.equal(rows.alpha!.total, 3, "two Claude calls in the window, one Codex use (block and read in one turn count once)");
  assert.equal(rows.alpha!.claude, 2);
  assert.equal(rows.alpha!.codex, 1);
  assert.equal(rows.alpha!.chats, 2, "one Claude chat and one Codex thread");
  assert.equal(rows["own-skill"]!.typed, 1, "a typed /own-skill counts");
  assert.equal(rows.model, undefined, "a typed /model names no skill: it's a command");
  assert.equal(rows["toolkit:deploy"]!.total, 1, "a plugin skill by its full name");
  assert.equal(rows.beta!.total, 2);
  assert.equal(rows.beta!.helpers, 1, "the helper chat's use");
  assert.equal(rows["legacy-x"]!.codex, 1);
  assert.equal(rows.alpha!.skillId !== undefined, true);
  assert.equal((await rowsOf(90)).alpha!.total, 4, "the 60-day-old use is inside 90 days");
  const usage = await handleSkillsUsage({}, ctx);
  assert.equal(usage.state.state, "ready");
  assert.equal(usage.state.complete, true);
  assert.ok(usage.neverUsed.some((entry) => entry.name === "slot-skill"));
  assert.ok(usage.notes[0]!.includes("estimated"));
});

test("only new lines are read; a cut last line waits for its end", async () => {
  const before = usageStats();
  // A line cut mid-way (a chat still being written), then its end.
  const line = claudeSkillLine("alpha", isoDaysAgo(0), "sess-main", sb.app);
  writeFileSync(mainLog, line.slice(0, 40), { flag: "a" });
  await pass();
  assert.equal((await rowsOf()).alpha!.claude, 2, "half a line is not counted");
  writeFileSync(mainLog, `${line.slice(40)}\n`, { flag: "a" });
  await pass();
  assert.equal((await rowsOf()).alpha!.claude, 3, "counted once it is whole");
  await pass();
  assert.equal((await rowsOf()).alpha!.claude, 3, "and never twice");
  assert.equal(usageStats().files, before.files);
});

test("a rewritten log is read again; a deleted one is forgotten", async () => {
  // Replaced by a new file (new inode) with fewer uses.
  writeLines(`${otherLog}.new`, [claudeSkillLine("own-skill", isoDaysAgo(1), "sess-other", sb.plain)]);
  renameSync(`${otherLog}.new`, otherLog);
  await pass();
  let rows = await rowsOf();
  assert.equal(rows.beta!.total, 1, "the old file's uses are gone with it");
  assert.equal(rows["own-skill"]!.total, 2);
  rmSync(helperLog);
  await pass();
  rows = await rowsOf();
  assert.equal(rows.beta, undefined, "a deleted log's uses are dropped");
});

test("the read budget spreads a pass out and loses nothing", async () => {
  forgetUsage();
  const budget = PASS_LIMITS.readBytes;
  PASS_LIMITS.readBytes = 300;
  try {
    await pass();
    assert.equal(usageState().complete, false);
    let passes = 1;
    while (!usageState().complete && passes < 50) {
      await pass();
      passes += 1;
    }
    assert.equal(usageState().complete, true);
    assert.ok(passes > 2, `took ${passes} passes`);
    assert.equal((await rowsOf()).alpha!.claude, 3);
  } finally {
    PASS_LIMITS.readBytes = budget;
  }
});

test("no pass while no app is connected, unless forced", async () => {
  forgetUsage();
  resetPresence();
  const { accounts } = await discoverAccounts();
  requestUsagePass(accounts);
  await usageSettled();
  assert.equal(usageState().state, "waiting");
  markClientSeen();
  requestUsagePass(accounts);
  await usageSettled();
  assert.equal(usageState().state, "ready");
});

test("used in this chat: exact by the agent's chat id, else by folder and time", async () => {
  agentSnapshots.set("ag-claude", { id: "ag-claude", provider: "claude", model: "claude-opus-5-5", cwd: sb.app, createdAt: isoDaysAgo(3), persistence: { provider: "claude", sessionId: "sess-main" } });
  agentSnapshots.set("ag-codex", { id: "ag-codex", provider: "codex", cwd: sb.app, createdAt: isoDaysAgo(3), persistence: { provider: "codex", sessionId: "x", nativeHandle: "thread-9" } });
  agentSnapshots.set("ag-old", { id: "ag-old", provider: "claude", cwd: sb.app, createdAt: isoDaysAgo(5), persistence: null });
  const claude = await handleSkillsAgent({ workspaceId: "ws-app", providerId: "claude", agentId: "ag-claude" }, ctx);
  assert.equal(claude.chat.match, "exact");
  assert.deepEqual(Object.fromEntries(claude.chat.skills.map((skill) => [skill.name, skill.count])), { alpha: 4, "own-skill": 1, "toolkit:deploy": 1 });
  assert.ok(claude.skills.some((skill) => skill.name === "app-helper"), "the project's own skills are listed");
  assert.ok(claude.cost && claude.cost.chars > 0);
  assert.deepEqual([claude.cost!.budgetKnown, claude.cost!.budgetChars], [true, 40_000], "this agent's own model sets its budget");
  const codex = await handleSkillsAgent({ workspaceId: "ws-app", providerId: "codex", agentId: "ag-codex" }, ctx);
  assert.equal(codex.chat.match, "exact");
  assert.deepEqual(codex.chat.skills.map((skill) => skill.name).sort(), ["alpha", "legacy-x"]);
  const old = await handleSkillsAgent({ workspaceId: "ws-app", providerId: "claude", agentId: "ag-old" }, ctx);
  assert.equal(old.chat.match, "folder-time");
  assert.ok(old.chat.note.includes("folder"));
  const none = await handleSkillsAgent({ workspaceId: "ws-app", providerId: "claude", agentId: "missing" }, ctx);
  assert.equal(none.chat.match, "unknown");
});
