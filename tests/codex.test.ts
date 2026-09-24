import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { fakePaseo, makeSandbox, violations, writeCodexDb, type JobState, type Sandbox } from "./helpers";

let sb: Sandbox = await makeSandbox();
const { forgetAllFiles, sha256 } = await import("../server/files");
const { forgetDiscovery } = await import("../server/discover");
const { resetDaemonCache } = await import("../server/daemon");
const { codexLockState, setSqliteLoader } = await import("../server/codex-lock");
const { codexWrite } = await import("../server/codex-memory");
const { codexState } = await import("../server/codex-state");
const { instructionWrite } = await import("../server/instructions");

async function fresh(job: JobState = "done"): Promise<Sandbox> {
  sb.cleanup();
  sb = await makeSandbox({ job });
  forgetAllFiles();
  forgetDiscovery();
  resetDaemonCache();
  setSqliteLoader(null);
  return sb;
}

afterEach(() => {
  setSqliteLoader(null);
  assert.deepEqual(violations, [], "no write outside the sandbox");
});

const summary = () => join(sb.codex, "memories", "memory_summary.md");
const index = () => join(sb.codex, "memories", "MEMORY.md");

function stampOf(path: string) {
  const buffer = readFileSync(path);
  const stat = statSync(path);
  return { size: stat.size, mtimeMs: stat.mtimeMs, hash: sha256(buffer) };
}

function codexFiles(): string[] {
  return readdirSync(sb.codex).sort();
}

test("the lock: free, held, expired, failed, unknown, missing row, missing database", async () => {
  const cases: Array<[JobState, string]> = [
    ["done", "free"],
    ["error", "free"],
    ["no-row", "free"],
    ["running", "locked"],
    ["running-expired", "unsure"],
    ["running-stale", "free"],
    ["strange", "unsure"],
    ["no-db", "unsure"],
  ];
  for (const [job, lock] of cases) {
    await fresh(job);
    const before = codexFiles();
    const state = await codexLockState(sb.codex);
    assert.equal(state.lock, lock, `${job}: ${state.reason}`);
    assert.deepEqual(codexFiles(), before, `${job}: reading the lock creates no file`);
  }
});

test("a pending consolidation warns with the deleted-input count, and a save needs a confirm", async () => {
  await fresh("error");
  const { pendingSettled } = await import("../server/codex-pending");
  const diff = join(sb.codex, "memories", "phase2_workspace_diff.md");
  writeFileSync(diff, ["a", "b", "c"].map((name) => `diff --git a/rollout_summaries/${name}.md b/rollout_summaries/${name}.md\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n`).join(""));
  const paseo = fakePaseo(sb).api;
  const before = readFileSync(index(), "utf8");
  const first = await codexWrite(paseo, { sourceId: index(), text: `${before}- x\n`, expected: stampOf(index()) });
  assert.equal(first.ok, false);
  assert.equal(first.needsConfirm, true);
  assert.equal(readFileSync(index(), "utf8"), before, "nothing written before the confirm");
  await pendingSettled();
  const counted = await codexWrite(paseo, { sourceId: index(), text: `${before}- x\n`, expected: stampOf(index()) });
  assert.match(counted.message, /^Codex hasn't finished its last clean-up \(it failed on \d{4}-\d{2}-\d{2}\)\. When it next runs it may remove memory backed by 3 deleted inputs, and it will fold in your edit at the same time\./);
  const state = await codexState(index());
  assert.equal(state.pendingInfo!.deletions, 3);
  const confirmed = await codexWrite(paseo, { sourceId: index(), text: `${before}- x\n`, expected: stampOf(index()), confirmPending: true });
  assert.equal(confirmed.ok, true, confirmed.message);
  // No diff file: no confirm needed.
  const { rmSync } = await import("node:fs");
  rmSync(diff);
  const plain = await codexWrite(paseo, { sourceId: index(), text: `${before}- y\n`, expected: stampOf(index()) });
  assert.equal(plain.ok, true, plain.message);
});

test("no node:sqlite means unsure, and unsure means no save", async () => {
  await fresh("done");
  setSqliteLoader(() => Promise.reject(new Error("No such built-in module: node:sqlite")));
  const state = await codexLockState(sb.codex);
  assert.equal(state.lock, "unsure");
  assert.match(state.reason, /node:sqlite/);
  const before = readFileSync(index(), "utf8");
  const result = await codexWrite(fakePaseo(sb).api, { sourceId: index(), text: `${before}- more\n`, expected: stampOf(index()) });
  assert.equal(result.ok, false);
  assert.match(result.message, /node:sqlite/);
  assert.equal(readFileSync(index(), "utf8"), before);
});

test("a WAL database is read without creating -wal or -shm files", async () => {
  await fresh("done");
  await writeCodexDb(sb.codexDb, "running", { wal: true });
  assert.equal(readFileSync(sb.codexDb).subarray(18, 20).toString("hex"), "0202", "the file is in WAL mode");
  const before = codexFiles();
  assert.ok(!before.some((name) => name.endsWith("-wal") || name.endsWith("-shm")));
  const state = await codexLockState(sb.codex);
  assert.equal(state.lock, "locked", state.reason);
  assert.deepEqual(codexFiles(), before, "immutable read: nothing created");
  // Only one of the pair: in-between, so unsure.
  writeFileSync(`${sb.codexDb}-wal`, "");
  assert.equal((await codexLockState(sb.codex)).lock, "unsure");
  // A rollback journal left behind: a writer is mid-transaction.
  await writeCodexDb(sb.codexDb, "done");
  writeFileSync(`${sb.codexDb}-journal`, "");
  assert.equal((await codexLockState(sb.codex)).lock, "unsure");
});

test("edits: saved while free, refused while consolidating or unsure", async () => {
  await fresh("done");
  const paseo = fakePaseo(sb).api;
  const text = `${readFileSync(index(), "utf8")}- Deploys happen on Fridays.\n`;
  const ok = await codexWrite(paseo, { sourceId: index(), text, expected: stampOf(index()), confirmPending: true });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(readFileSync(index(), "utf8"), text);
  assert.ok(ok.warnings.some((warning) => warning.includes("wording may change")));
  assert.ok(ok.warnings.some((warning) => warning.includes("consolidation")));
  assert.ok(ok.reports[0]!.backupPath!.startsWith(join(sb.paseoHome, "plugin-data")));

  for (const job of ["running", "running-expired", "no-db"] as const) {
    await fresh(job);
    const before = readFileSync(index(), "utf8");
    const refused = await codexWrite(fakePaseo(sb).api, { sourceId: index(), text: `${before}- x\n`, expected: stampOf(index()) });
    assert.equal(refused.ok, false, job);
    assert.equal(readFileSync(index(), "utf8"), before, job);
  }
});

test("memory_summary.md must keep v1 as its first line", async () => {
  await fresh("done");
  const paseo = fakePaseo(sb).api;
  const current = readFileSync(summary(), "utf8");
  const bad = await codexWrite(paseo, { sourceId: summary(), text: current.replace(/^v1\n/, "# Summary\n"), expected: stampOf(summary()), confirmPending: true });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /"v1"/);
  const also = await codexWrite(paseo, { sourceId: summary(), text: ` v1\n${current.slice(3)}`, expected: stampOf(summary()) });
  assert.equal(also.ok, false, "exactly v1, nothing around it");
  const good = await codexWrite(paseo, { sourceId: summary(), text: `${current}- One more fact.\n`, expected: stampOf(summary()), confirmPending: true });
  assert.equal(good.ok, true, good.message);
});

test("only MEMORY.md and memory_summary.md: never .git, the sqlite, raw memories, rollouts or extensions", async () => {
  await fresh("done");
  const paseo = fakePaseo(sb).api;
  const forbidden = [
    join(sb.codex, "memories", "raw_memories.md"),
    join(sb.codex, "memories", "rollout_summaries", "2026-09-01-a.md"),
    join(sb.codex, "memories", "rollout_summaries"),
    join(sb.codex, "memories", "extensions", "ad_hoc", "instructions.md"),
    join(sb.codex, "memories", "extensions"),
    join(sb.codex, "memories", ".git", "HEAD"),
    join(sb.codex, "memories", "phase2_workspace_diff.md"),
    sb.codexDb,
    join(sb.codex, "AGENTS.md"),
  ];
  for (const path of forbidden) {
    const isFile = existsSync(path) && statSync(path).isFile();
    const before = isFile ? readFileSync(path) : null;
    const result = await codexWrite(paseo, { sourceId: path, text: "v1\nnope\n", expected: isFile ? stampOf(path) : { size: 0, mtimeMs: 0 } });
    assert.equal(result.ok, false, path);
    if (before) assert.deepEqual(readFileSync(path), before, path);
    if (isFile && path !== join(sb.codex, "AGENTS.md")) {
      const viaInstructions = await instructionWrite(paseo, { path, text: "nope", expected: stampOf(path) });
      assert.equal(viaInstructions.ok, false, `instruction-write ${path}`);
    }
  }
});

test("Codex edits can be switched off in settings", async () => {
  await fresh("done");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(sb.paseoHome, "plugin-settings", "paseo-memories"), { recursive: true });
  writeFileSync(join(sb.paseoHome, "plugin-settings", "paseo-memories", "memories.json"), JSON.stringify({ version: 1, values: { codexEdits: false } }));
  forgetAllFiles();
  forgetDiscovery();
  const result = await codexWrite(fakePaseo(sb).api, { sourceId: index(), text: "# x\n", expected: stampOf(index()), confirmPending: true });
  assert.equal(result.ok, false);
  assert.match(result.message, /turned off/);
});

test("after Codex's next run: kept, reworded, or not run yet", async () => {
  await fresh("done");
  const paseo = fakePaseo(sb).api;
  assert.equal((await codexState(index())).kept!.status, "none");
  const before = readFileSync(index(), "utf8");
  const text = `${before}- Deploys happen on Fridays.\n- Staging is eu-west.\n`;
  await codexWrite(paseo, { sourceId: index(), text, expected: stampOf(index()), confirmPending: true });
  assert.equal((await codexState(index())).kept!.status, "unchanged");
  // Codex rewrites the file and keeps both lines.
  writeFileSync(index(), `# Codex memory (consolidated)\n\n- Deploys happen on Fridays.\n- Staging is eu-west.\n- pnpm everywhere.\n`);
  assert.equal((await codexState(index())).kept!.status, "kept");
  // Codex rewords one of them.
  writeFileSync(index(), `# Codex memory\n\n- Deploys go out on Fridays.\n- Staging is eu-west.\n`);
  const reworded = (await codexState(index())).kept!;
  assert.equal(reworded.status, "changed");
  assert.match(reworded.detail, /kept 1 of the 2 lines/);
  // The record lives with the plugin's data, not in Codex's folder.
  assert.ok(!readdirSync(join(sb.codex, "memories")).some((name) => name.includes("paseo")));
});

test("the source detail shows the lock and the pending consolidation", async () => {
  await fresh("running");
  const state = await codexState(index());
  assert.equal(state.lock, "locked");
  assert.match(state.pending!, /hasn't finished its last clean-up/);
  assert.equal(state.lastJob!.status, "running");
});

test.after(() => sb.cleanup());
