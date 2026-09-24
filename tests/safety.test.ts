/**
 * Rules that hold for every RPC: panel reads start no process, nothing on the
 * RPC path calls a blocking fs function, and memory text never reaches a log
 * line or an error message.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { captureOutput, fakePaseo, makeSandbox, spawned, violations, withoutSyncFs, type Sandbox } from "./helpers";

let sb: Sandbox = await makeSandbox();
const { forgetAllFiles } = await import("../server/files");
const { forgetDiscovery } = await import("../server/discover");
const { resetDaemonCache } = await import("../server/daemon");
const read = await import("../server/read");
const { claudeCreate, claudeUpdate, claudeDelete } = await import("../server/claude-memory");
const { instructionWrite } = await import("../server/instructions");
const { promptSet, handlePromptGet } = await import("../server/prompt");
const { codexWrite } = await import("../server/codex-memory");
const { sha256 } = await import("../server/files");
const { findingsFor } = await import("../server/tidy");
const { searchFor } = await import("../server/search");
const transfer = await import("../server/transfer");
const { scanSettled } = await import("../server/symbols");

/** A string that must never leave a memory file except through the entry RPC. */
const CANARY = "CANARY-7f3a9c-do-not-log";

async function fresh(): Promise<Sandbox> {
  sb.cleanup();
  sb = await makeSandbox();
  forgetAllFiles();
  forgetDiscovery();
  resetDaemonCache();
  // Plant the canary everywhere memory text lives, including files that fail to parse.
  appendFileSync(join(sb.appMemory, "nested.md"), `\n${CANARY}\n`);
  appendFileSync(join(sb.appMemory, "MEMORY.md"), `- [${CANARY}](${CANARY}.md) — ${CANARY}\n`);
  appendFileSync(join(sb.claude, "CLAUDE.md"), `\n${CANARY}\n`);
  appendFileSync(join(sb.app, "AGENTS.md"), `\n${CANARY}\n`);
  appendFileSync(join(sb.codex, "memories", "MEMORY.md"), `\n${CANARY}\n`);
  writeFileSync(join(sb.app, ".claude", "settings.json"), `{"broken": "${CANARY}`);
  writeFileSync(join(sb.claude, "settings.json"), `{ not json ${CANARY}`);
  mkdirSync(join(sb.paseoHome, "plugin-settings", "paseo-memories"), { recursive: true });
  writeFileSync(join(sb.paseoHome, "plugin-settings", "paseo-memories", "memories.json"), `{"version": 1, "values": ${CANARY}`);
  return sb;
}

afterEach(() => assert.deepEqual(violations, [], "no write outside the sandbox"));

type Call = { name: string; run: () => Promise<unknown>; mayFail?: boolean };

function readCalls(paseo: never): Call[] {
  const ctx = { paseo };
  return [
    { name: "inventory", run: () => read.handleInventory({ refresh: true }, ctx) },
    { name: "source memory folder", run: () => read.handleSourceDetail({ sourceId: sb.appMemory }, ctx) },
    { name: "source CLAUDE.md", run: () => read.handleSourceDetail({ sourceId: join(sb.claude, "CLAUDE.md") }, ctx) },
    { name: "source codex", run: () => read.handleSourceDetail({ sourceId: join(sb.codex, "memories", "MEMORY.md") }, ctx) },
    { name: "source folder", run: () => read.handleSourceDetail({ sourceId: join(sb.codex, "memories", "rollout_summaries") }, ctx) },
    { name: "source workspace-only", run: () => read.handleSourceDetail({ sourceId: join(sb.app, "packages", "web", "CLAUDE.md"), workspaceId: "ws-app" }, ctx) },
    { name: "source missing", run: () => read.handleSourceDetail({ sourceId: join(sb.app, "nope.md") }, ctx), mayFail: true },
    { name: "entry section", run: () => read.handleEntryBody({ sourceId: join(sb.claude, "CLAUDE.md"), key: "1:style" }, ctx) },
    { name: "entry missing section", run: () => read.handleEntryBody({ sourceId: join(sb.claude, "CLAUDE.md"), key: "9:gone" }, ctx), mayFail: true },
    { name: "workspace plan", run: () => read.handleWorkspacePlan({ workspaceId: "ws-app" }, ctx) },
    { name: "workspace plan (worktree)", run: () => read.handleWorkspacePlan({ workspaceId: "ws-wt" }, ctx) },
    { name: "agent plan", run: () => read.handleAgentPlan({ workspaceId: "ws-app", providerId: "codex" }, ctx) },
    { name: "agent plan unknown", run: () => read.handleAgentPlan({ workspaceId: "ws-app", providerId: "gemini" }, ctx) },
    { name: "plan unknown workspace", run: () => read.handleWorkspacePlan({ workspaceId: "gone" }, ctx), mayFail: true },
    { name: "findings", run: async () => {
      await findingsFor(paseo, true);
      await scanSettled();
      return findingsFor(paseo);
    } },
    { name: "search", run: () => searchFor(paseo, "CANARY") },
    { name: "search nothing", run: () => searchFor(paseo, "zzz-nothing") },
    { name: "import parse", run: async () => transfer.importParse({ text: `## ${CANARY}\n\n${CANARY}\n`, files: [{ name: "x.mdc", text: `---\ndescription: ${CANARY}\n---\n${CANARY}\n` }] }) },
    { name: "import parse bad bundle", run: async () => transfer.importParse({ text: `{"format":"paseo-memories","version":9,"note":"${CANARY}"}` }) },
    { name: "import preview", run: () => transfer.importPreview(paseo, { items: [{ id: "c", title: CANARY, body: `${CANARY}\n`, masked: false, format: "markdown", warnings: [] }], target: { kind: "claude-memory", sourceId: sb.appMemory } }) },
    { name: "copy preview", run: () => transfer.importPreview(paseo, { from: [{ sourceId: sb.appMemory, key: "nested.md" }], target: { kind: "append", path: join(sb.codex, "AGENTS.md") } }) },
    { name: "preview bad target", run: () => transfer.importPreview(paseo, { items: [], target: { kind: "append", path: join(sb.codex, "memories", "raw_memories.md") } }), mayFail: true },
    { name: "export", run: () => transfer.exportMemories(paseo, { selection: { scope: "all" }, format: "bundle" }) },
    { name: "export markdown", run: () => transfer.exportMemories(paseo, { selection: { sourceIds: [sb.appMemory] }, format: "markdown" }) },
  ];
}

function stampOf(path: string) {
  const buffer = readFileSync(path);
  const stat = statSync(path);
  return { size: stat.size, mtimeMs: stat.mtimeMs, hash: sha256(buffer) };
}

/** Every write RPC, including ones that must be refused; results carry messages that are checked too. */
function writeCalls(paseo: never): Call[] {
  const ctx = { paseo };
  // Stamps are taken now, outside any window where the test blocks sync fs.
  const stamp = Object.fromEntries(
    [join(sb.codex, "AGENTS.md"), join(sb.appMemory, "nested.md"), join(sb.appMemory, "flat.md"), join(sb.appMemory, "unindexed.md"), join(sb.claude, "CLAUDE.md"), join(sb.managed, "CLAUDE.md"), join(sb.codex, "memories", "MEMORY.md"), join(sb.codex, "memories", "memory_summary.md"), join(sb.codex, "memories", "raw_memories.md")].map((path) => [path, stampOf(path)]),
  );
  const stampOfNow = (path: string) => stamp[path]!;
  const nested = () => join(sb.appMemory, "nested.md");
  return [
    { name: "claude create", run: () => claudeCreate(paseo, { sourceId: sb.appMemory, name: `Note ${CANARY}`, description: CANARY, body: `${CANARY}\n`, hook: CANARY }) },
    { name: "claude update", run: () => claudeUpdate(paseo, { sourceId: sb.appMemory, key: "nested.md", expected: stampOfNow(nested()), body: `\n${CANARY} edited\n`, name: `Nested ${CANARY}` }) },
    { name: "claude update stale", run: () => claudeUpdate(paseo, { sourceId: sb.appMemory, key: "flat.md", expected: { size: 1, mtimeMs: 1 }, body: CANARY }) },
    { name: "claude update masked", run: () => claudeUpdate(paseo, { sourceId: sb.appMemory, key: "flat.md", expected: stampOfNow(join(sb.appMemory, "flat.md")), body: `${CANARY} sk-a••••••••` }) },
    { name: "claude rename", run: () => claudeUpdate(paseo, { sourceId: sb.appMemory, key: "flat.md", expected: stampOfNow(join(sb.appMemory, "flat.md")), rename: "flat_2.md" }) },
    { name: "claude delete", run: () => claudeDelete(paseo, { sourceId: sb.appMemory, key: "unindexed.md", expected: stampOfNow(join(sb.appMemory, "unindexed.md")) }) },
    { name: "instruction edit", run: () => instructionWrite(paseo, { path: join(sb.claude, "CLAUDE.md"), text: `# ${CANARY}\n`, expected: stampOfNow(join(sb.claude, "CLAUDE.md")) }) },
    { name: "instruction refused", run: () => instructionWrite(paseo, { path: join(sb.managed, "CLAUDE.md"), text: CANARY, expected: stampOfNow(join(sb.managed, "CLAUDE.md")) }) },
    { name: "instruction unknown", run: () => instructionWrite(paseo, { path: join(sb.home, CANARY), text: CANARY, expected: null }) },
    { name: "prompt get", run: () => handlePromptGet({}, ctx) },
    { name: "prompt set", run: () => promptSet(paseo, { text: `${CANARY} new`, expected: CANARY }) },
    { name: "prompt set stale", run: () => promptSet(paseo, { text: CANARY, expected: "nope" }) },
    { name: "codex write", run: () => codexWrite(paseo, { sourceId: join(sb.codex, "memories", "MEMORY.md"), text: `# ${CANARY}\n`, expected: stampOfNow(join(sb.codex, "memories", "MEMORY.md")) }) },
    { name: "codex summary without v1", run: () => codexWrite(paseo, { sourceId: join(sb.codex, "memories", "memory_summary.md"), text: CANARY, expected: stampOfNow(join(sb.codex, "memories", "memory_summary.md")) }) },
    { name: "import apply", run: () => transfer.importApply(paseo, { items: [{ id: "c", title: `Imported ${CANARY}`, body: `${CANARY}\n`, masked: false, format: "markdown", warnings: [] }], target: { kind: "claude-memory", sourceId: sb.appMemory }, selected: ["c"] }) },
    { name: "import apply refused", run: () => transfer.importApply(paseo, { items: [{ id: "c", title: CANARY, body: CANARY, masked: false, format: "markdown", warnings: [] }], target: { kind: "append", path: join(sb.managed, "CLAUDE.md") }, selected: ["c"], expected: null }) },
    { name: "move", run: () => transfer.importApply(paseo, { from: [{ sourceId: sb.appMemory, key: "flat_session.md" }], target: { kind: "append", path: join(sb.codex, "AGENTS.md") }, selected: [`${sb.appMemory}#flat_session.md`], expected: stampOfNow(join(sb.codex, "AGENTS.md")), move: true }) },
    { name: "codex forbidden", run: () => codexWrite(paseo, { sourceId: join(sb.codex, "memories", "raw_memories.md"), text: CANARY, expected: stampOfNow(join(sb.codex, "memories", "raw_memories.md")) }) },
  ];
}

async function runAll(calls: Call[]): Promise<{ output: string; errors: string[] }> {
  const outputs: string[] = [];
  const errors: string[] = [];
  for (const call of calls) {
    const { result, error, output } = await captureOutput(call.run);
    outputs.push(output);
    const said = result && typeof result === "object" && "message" in result ? JSON.stringify({ message: (result as { message: unknown }).message, reports: (result as { reports?: unknown }).reports, warnings: (result as { warnings?: unknown }).warnings }) : "";
    if (said) errors.push(said);
    if (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!call.mayFail) assert.fail(`${call.name} threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { output: outputs.join("\n"), errors };
}

test("the harness itself catches a spawn and a blocking call", async () => {
  const { execFileSync } = await import("node:child_process");
  const fsNamespace = await import("node:fs");
  spawned.length = 0;
  execFileSync("/bin/echo", ["ok"]);
  assert.equal(spawned.length, 1, "a spawn is counted");
  const { blocked } = await withoutSyncFs(async () => {
    try {
      fsNamespace.existsSync("/");
    } catch {
      // expected
    }
  });
  assert.deepEqual(blocked, ["existsSync /"], "an ESM import of a sync fs call is blocked");
});

test("write RPCs start no process and make no blocking fs call", async () => {
  await fresh();
  const paseo = fakePaseo(sb, { prompt: CANARY }).api;
  spawned.length = 0;
  const calls = writeCalls(paseo);
  const { blocked } = await withoutSyncFs(() => runAll(calls));
  assert.deepEqual(blocked, []);
  assert.deepEqual(spawned, []);
});

test("memory text never reaches a log line or an error on the write path", async () => {
  await fresh();
  const paseo = fakePaseo(sb, { prompt: CANARY }).api;
  const { output, errors } = await runAll(writeCalls(paseo));
  assert.ok(output.includes("[paseo-memories]"), "writes are logged (by path and outcome)");
  assert.ok(!output.includes(CANARY), "no canary in console output");
  for (const message of errors) assert.ok(!message.includes(CANARY), `no canary in: ${message}`);
});

test("read RPCs start no process", async () => {
  await fresh();
  const paseo = fakePaseo(sb, { prompt: CANARY }).api;
  spawned.length = 0;
  for (let round = 0; round < 3; round += 1) await runAll(readCalls(paseo));
  assert.deepEqual(spawned, []);
});

test("read RPCs make no blocking fs call", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const { blocked } = await withoutSyncFs(() => runAll(readCalls(paseo)));
  assert.deepEqual(blocked, []);
});

test("memory text never reaches a log line or an error message on the read path", async () => {
  await fresh();
  const paseo = fakePaseo(sb, { prompt: CANARY }).api;
  const { output, errors } = await runAll(readCalls(paseo));
  assert.ok(!output.includes(CANARY), "no canary in console output");
  for (const message of errors) assert.ok(!message.includes(CANARY), `no canary in: ${message}`);
  // The entry RPC is the one door, and only when asked.
  const body = await read.handleEntryBody({ sourceId: sb.appMemory, key: "nested.md" }, { paseo });
  assert.ok(body.body.includes(CANARY));
});

test.after(() => sb.cleanup());
