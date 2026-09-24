import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test, { afterEach } from "node:test";
import { fakePaseo, makeSandbox, violations, type Sandbox } from "./helpers";

let sb: Sandbox = await makeSandbox();
const { forgetAllFiles, sha256 } = await import("../server/files");
const { forgetDiscovery } = await import("../server/discover");
const { resetDaemonCache } = await import("../server/daemon");
const read = await import("../server/read");
const { claudeCreate, claudeUpdate, claudeDelete } = await import("../server/claude-memory");
const { instructionWrite } = await import("../server/instructions");
const { promptSet } = await import("../server/prompt");
const { TEMP_PREFIX, backupsRoot, mirrored, newSession, safeWrite } = await import("../server/write");
const { parseMemoryFile, readFields } = await import("../shared/frontmatter");
const { parseIndex } = await import("../shared/memory-index");
const { MASK_FILL } = await import("../shared/secrets");

async function fresh(): Promise<Sandbox> {
  sb.cleanup();
  sb = await makeSandbox();
  forgetAllFiles();
  forgetDiscovery();
  resetDaemonCache();
  return sb;
}

afterEach(() => assert.deepEqual(violations, [], "no write outside the sandbox"));

function stampOf(path: string) {
  const buffer = readFileSync(path);
  const stat = statSync(path);
  return { size: stat.size, mtimeMs: stat.mtimeMs, hash: sha256(buffer) };
}

function settings(values: Record<string, unknown>): void {
  const dir = join(sb.paseoHome, "plugin-settings", "paseo-memories");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memories.json"), JSON.stringify({ version: 1, values }));
  forgetAllFiles();
  forgetDiscovery();
}

function tempFilesUnder(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.startsWith(TEMP_PREFIX) || entry.name.includes(".bak")) out.push(join(dir, entry.name));
    }
  };
  walk(folder);
  return out;
}

// ------------------------------------------------------------------ Claude auto memory

test("edit: only the change lands; shape, unknown keys and other lines stay byte-for-byte", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const path = join(sb.appMemory, "nested.md");
  const before = readFileSync(path, "utf8");
  const indexBefore = readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8");
  const result = await claudeUpdate(paseo, { sourceId: sb.appMemory, key: "nested.md", expected: stampOf(path), body: "\nA new body.\n", type: "feedback" });
  assert.equal(result.ok, true, result.message);
  const after = readFileSync(path, "utf8");
  const frontBefore = before.slice(0, before.indexOf("\n---\n") + 5);
  const frontAfter = after.slice(0, after.indexOf("\n---\n") + 5);
  assert.equal(frontAfter, frontBefore.replace("  type: project", "  type: feedback"));
  assert.ok(after.endsWith("---\n\nA new body.\n"));
  assert.equal(readFields(parseMemoryFile(after)).shape, "nested");
  assert.equal(readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8"), indexBefore, "name and hook unchanged: the index is not touched");
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0]!.readBack, "ok");
});

test("renaming the title updates its MEMORY.md line in place; flat shapes stay flat", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const path = join(sb.appMemory, "flat_session.md");
  const result = await claudeUpdate(paseo, { sourceId: sb.appMemory, key: "flat_session.md", expected: stampOf(path), name: "Session memory", hook: "a new hook" });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.reports.length, 2);
  const index = readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8");
  assert.ok(index.includes("- [Session memory](flat_session.md) - a new hook"), "the line keeps its ' - ' separator");
  const text = readFileSync(path, "utf8");
  assert.ok(text.startsWith("---\nname: Session memory\ndescription: Flat plus session\ntype: reference\noriginSessionId: 99999999-8888-7777-6666-555555555555\n---\n"));
});

test("create writes the file in the folder's usual shape and adds one index line", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const indexBefore = readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8");
  const result = await claudeCreate(paseo, { sourceId: sb.appMemory, name: "Use pnpm", description: "Package manager", type: "feedback", body: "Always pnpm.\n", hook: "pnpm, not npm" });
  assert.equal(result.ok, true, result.message);
  const created = join(sb.appMemory, "use_pnpm.md");
  const fields = readFields(parseMemoryFile(readFileSync(created, "utf8")));
  assert.deepEqual([fields.name, fields.type, fields.shape], ["Use pnpm", "feedback", "flat"], "the folder has more flat files than nested");
  assert.equal(readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8"), `${indexBefore}- [Use pnpm](use_pnpm.md) — pnpm, not npm\n`);
  assert.equal(statSync(created).mode & 0o777, 0o600, "new files in agent folders are private");
  const again = await claudeCreate(paseo, { sourceId: sb.appMemory, name: "Use pnpm", description: "dup", body: "x" });
  assert.equal(again.ok, true);
  assert.ok(existsSync(join(sb.appMemory, "use_pnpm_2.md")), "a clash gets a new name, never an overwrite");
  const named = await claudeCreate(paseo, { sourceId: sb.appMemory, fileName: "flat.md", name: "X", description: "Y", body: "Z" });
  assert.equal(named.ok, false);
  assert.match(named.message, /already exists/);
});

test("create in a project with no memory yet makes the folder and MEMORY.md", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const { plans } = await read.handleWorkspacePlan({ workspaceId: "ws-plain" }, { paseo });
  const folder = plans.find((entry) => entry.agent === "claude")!.items.find((item) => item.kind === "claude-auto-memory")!.path!;
  assert.equal(existsSync(folder), false);
  const result = await claudeCreate(paseo, { sourceId: folder, workspaceId: "ws-plain", name: "First", description: "first memory", body: "Hello.\n" });
  assert.equal(result.ok, true, result.message);
  assert.equal(readFileSync(join(folder, "MEMORY.md"), "utf8"), "- [First](first.md) — first memory\n");
  const refused = await claudeCreate(paseo, { sourceId: join(sb.plain, "made-up"), name: "No", description: "no", body: "no" });
  assert.equal(refused.ok, false);
});

test("rename and delete keep MEMORY.md in step", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const flat = join(sb.appMemory, "flat.md");
  const renamed = await claudeUpdate(paseo, { sourceId: sb.appMemory, key: "flat.md", expected: stampOf(flat), rename: "flat_renamed.md" });
  assert.equal(renamed.ok, true, renamed.message);
  assert.equal(existsSync(flat), false);
  assert.ok(existsSync(join(sb.appMemory, "flat_renamed.md")));
  let lines = parseIndex(readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8"));
  assert.ok(lines.some((line) => line.file === "flat_renamed.md" && line.title === "Flat memory"));
  assert.ok(!lines.some((line) => line.file === "flat.md"));

  const target = join(sb.appMemory, "flat_renamed.md");
  const deleted = await claudeDelete(paseo, { sourceId: sb.appMemory, key: "flat_renamed.md", expected: stampOf(target) });
  assert.equal(deleted.ok, true, deleted.message);
  assert.equal(existsSync(target), false);
  lines = parseIndex(readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8"));
  assert.ok(!lines.some((line) => line.file === "flat_renamed.md"));
  assert.ok(deleted.reports[0]!.backupPath && existsSync(deleted.reports[0]!.backupPath), "the deleted file is backed up");
  const unindexed = join(sb.appMemory, "unindexed.md");
  const noLine = await claudeDelete(paseo, { sourceId: sb.appMemory, key: "unindexed.md", expected: stampOf(unindexed) });
  assert.equal(noLine.ok, true);
  assert.equal(noLine.reports.length, 1, "no index line, so the index is not rewritten");
});

test("bad file names and paths outside the folder are refused", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  for (const key of ["../../CLAUDE.md", "MEMORY.md", ".hidden.md", "notes.txt"]) {
    const result = await claudeUpdate(paseo, { sourceId: sb.appMemory, key, expected: { size: 0, mtimeMs: 0 }, body: "x" });
    assert.equal(result.ok, false, key);
  }
  const wrongKind = await claudeUpdate(paseo, { sourceId: join(sb.claude, "CLAUDE.md"), key: "nested.md", expected: { size: 0, mtimeMs: 0 }, body: "x" });
  assert.equal(wrongKind.ok, false);
});

// ------------------------------------------------------------------ safety rules

test("backups go under PASEO_HOME/plugin-data, never next to the file", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const path = join(sb.appMemory, "flat.md");
  const original = readFileSync(path, "utf8");
  const result = await claudeUpdate(paseo, { sourceId: sb.appMemory, key: "flat.md", expected: stampOf(path), body: "\nChanged.\n" });
  const backup = result.reports[0]!.backupPath!;
  assert.ok(backup.startsWith(join(sb.paseoHome, "plugin-data", "paseo-memories", "backups")));
  assert.equal(relative(backupsRoot(), backup).split("/").slice(1).join("/"), mirrored(path));
  assert.equal(readFileSync(backup, "utf8"), original);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.deepEqual(tempFilesUnder(sb.appMemory), [], "no .bak or temp file in the memory folder");
  assert.deepEqual(readdirSync(sb.appMemory).filter((name) => !name.endsWith(".md")), []);
});

test("backups are pruned to the setting's count per file", async () => {
  await fresh();
  settings({ backupsToKeep: 2 });
  const paseo = fakePaseo(sb).api;
  const path = join(sb.appMemory, "flat.md");
  for (let round = 0; round < 4; round += 1) {
    const result = await claudeUpdate(paseo, { sourceId: sb.appMemory, key: "flat.md", expected: stampOf(path), body: `\nRound ${round}.\n` });
    assert.equal(result.ok, true, result.message);
  }
  const copies = readdirSync(backupsRoot()).filter((stamp) => existsSync(join(backupsRoot(), stamp, mirrored(path))));
  assert.equal(copies.length, 2);
});

test("writes are atomic, keep the file's mode, and leave no temp file behind", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const path = join(sb.app, "CLAUDE.md");
  chmodSync(path, 0o640);
  const inode = statSync(path).ino;
  const result = await instructionWrite(paseo, { path, text: "# App\n\nNew rules.\n", expected: stampOf(path) });
  assert.equal(result.ok, true, result.message);
  assert.equal(statSync(path).mode & 0o777, 0o640);
  assert.notEqual(statSync(path).ino, inode, "replaced by rename, not rewritten in place");
  assert.deepEqual(tempFilesUnder(sb.app), []);
  // A folder that cannot be written: the save fails cleanly and the file is untouched.
  const locked = join(sb.home, ".pi", "agent");
  const guide = join(locked, "AGENTS.md");
  const before = readFileSync(guide, "utf8");
  chmodSync(locked, 0o555);
  try {
    const failed = await instructionWrite(paseo, { path: guide, text: "changed", expected: stampOf(guide) });
    assert.equal(failed.ok, false);
    assert.match(failed.message, /permission/i);
    assert.equal(readFileSync(guide, "utf8"), before);
  } finally {
    chmodSync(locked, 0o755);
  }
  assert.deepEqual(tempFilesUnder(sb.app), []);
  assert.deepEqual(tempFilesUnder(locked), []);
});

test("new files: 0600 in agent folders, 0644 in repos; version-controlled targets are flagged", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const rule = join(sb.claude, "rules", "new-rule.md");
  const user = await instructionWrite(paseo, { path: rule, text: "Rule.\n", expected: null });
  assert.equal(user.ok, true, user.message);
  assert.equal(statSync(rule).mode & 0o777, 0o600);
  const projectRule = join(sb.app, ".claude", "rules", "sub", "new.md");
  const project = await instructionWrite(paseo, { path: projectRule, workspaceId: "ws-app", text: "Project rule.\n", expected: null });
  assert.equal(project.ok, true, project.message);
  assert.equal(statSync(projectRule).mode & 0o777, 0o644);
  assert.equal(project.reports[0]!.versionControlled, true);
  assert.ok(project.warnings.some((warning) => warning.includes("git")));
  const agents = join(sb.plain, "CLAUDE.md");
  const created = await instructionWrite(paseo, { path: agents, workspaceId: "ws-plain", text: "Plain rules.\n", expected: null });
  assert.equal(created.ok, true, created.message);
  assert.equal(created.reports[0]!.versionControlled, false, "no .git above code/plain");
  const local = await instructionWrite(paseo, { path: join(sb.app, "CLAUDE.local.md"), text: "mine\n", expected: stampOf(join(sb.app, "CLAUDE.local.md")) });
  assert.equal(local.reports[0]!.versionControlled, false, "CLAUDE.local.md is never flagged");
});

test("a file that changed since it was opened is not overwritten", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const path = join(sb.appMemory, "flat.md");
  const seen = stampOf(path);
  writeFileSync(path, readFileSync(path, "utf8").replace("Flat body.", "Changed by another agent."));
  const result = await claudeUpdate(paseo, { sourceId: sb.appMemory, key: "flat.md", expected: seen, body: "\nMine.\n" });
  assert.equal(result.ok, false);
  assert.match(result.message, /changed since you opened it/);
  assert.ok(readFileSync(path, "utf8").includes("Changed by another agent."));
  const same = { ...seen, hash: undefined };
  const sizeOnly = await instructionWrite(paseo, { path: join(sb.claude, "CLAUDE.md"), text: "x", expected: { ...same, size: same.size + 1 } });
  assert.equal(sizeOnly.ok, false);
  const exists = await instructionWrite(paseo, { path: join(sb.claude, "CLAUDE.md"), text: "x", expected: null });
  assert.equal(exists.ok, false, "create refuses an existing file");
});

test("read-only sources are refused on the server, whatever the app sends", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const targets = [
    join(sb.managed, "CLAUDE.md"),
    join(sb.codex, "memories", "raw_memories.md"),
    join(sb.codex, "memories", "phase2_workspace_diff.md"),
    join(sb.codex, "memories_1.sqlite"),
    join(sb.codex, "memories", "MEMORY.md"),
    join(sb.codex, "config.toml"),
    join(sb.home, ".config", "opencode", "opencode.json"),
    join(sb.home, ".omp", "agent", "memories", "MEMORY.md"),
    join(sb.codex, "memories", ".git", "HEAD"),
    join(sb.home, ".bashrc"),
    "relative/CLAUDE.md",
  ];
  for (const path of targets) {
    const before = existsSync(path) ? readFileSync(path) : null;
    const result = await instructionWrite(paseo, { path, text: "overwrite", expected: existsSync(path) ? stampOf(path) : null });
    assert.equal(result.ok, false, path);
    if (before) assert.deepEqual(readFileSync(path), before, path);
  }
});

test("a save that still carries masked secrets is refused", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const shown = await read.handleEntryBody({ sourceId: sb.appMemory, key: "secret.md" }, { paseo });
  assert.ok(shown.body.includes(MASK_FILL));
  const result = await claudeUpdate(paseo, { sourceId: sb.appMemory, key: "secret.md", expected: shown.stamp!, body: `${shown.body}\nOne more line.\n` });
  assert.equal(result.ok, false);
  assert.match(result.message, /masked/);
  const revealed = await read.handleEntryBody({ sourceId: sb.appMemory, key: "secret.md", reveal: true }, { paseo });
  const ok = await claudeUpdate(paseo, { sourceId: sb.appMemory, key: "secret.md", expected: revealed.stamp!, body: `${revealed.body}One more line.\n` });
  assert.equal(ok.ok, true, ok.message);
});

test("read-back mismatch is reported, not hidden", async () => {
  await fresh();
  const path = join(sb.app, "docs", "guide.md");
  const report = await safeWrite(newSession(5), path, "new text\n", { newMode: 0o644, check: () => false });
  assert.equal(report.ok, false);
  assert.equal(report.readBack, "mismatch");
  assert.ok(report.backupPath);
});

// ------------------------------------------------------------------ instruction files

test("instruction files: edit one section, create a missing layer, other agents' files", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const user = join(sb.claude, "CLAUDE.md");
  const before = readFileSync(user, "utf8");
  const section = await instructionWrite(paseo, { path: user, text: "## Style\n\nLong sentences are fine.\n", expected: stampOf(user), sectionKey: "1:style" });
  assert.equal(section.ok, true, section.message);
  assert.equal(readFileSync(user, "utf8"), before.replace("Short sentences.", "Long sentences are fine."));
  for (const path of [
    join(sb.app, "AGENTS.override.md"),
    join(sb.home, ".pi", "agent", "AGENTS.md"),
    join(sb.home, ".omp", "agent", "RULES.md"),
    join(sb.home, ".copilot", "copilot-instructions.md"),
  ]) {
    const result = await instructionWrite(paseo, { path, workspaceId: "ws-app", text: "Edited.\n", expected: stampOf(path) });
    assert.equal(result.ok, true, `${path}: ${result.message}`);
    assert.equal(readFileSync(path, "utf8"), "Edited.\n");
  }
  // Reached only through @import and OpenCode's instructions[]: read-only per SPEC.
  const shared = join(sb.home, "shared-rules.md");
  const sharedResult = await instructionWrite(paseo, { path: shared, workspaceId: "ws-app", text: "Edited.\n", expected: stampOf(shared) });
  assert.equal(sharedResult.ok, false);
  const opencode = join(sb.home, ".config", "opencode", "AGENTS.md");
  const created = await instructionWrite(paseo, { path: opencode, text: "OpenCode user file.\n", expected: null });
  assert.equal(created.ok, true, created.message);
  const deep = await instructionWrite(paseo, { path: join(sb.app, "packages", "web", "CLAUDE.md"), workspaceId: "ws-app", text: "Web.\n", expected: stampOf(join(sb.app, "packages", "web", "CLAUDE.md")) });
  assert.equal(deep.ok, true, "a subfolder file known from the workspace plan");
  const noWorkspace = await instructionWrite(paseo, { path: join(sb.app, "packages", "web", "AGENTS.md"), text: "x", expected: stampOf(join(sb.app, "packages", "web", "AGENTS.md")) });
  assert.equal(noWorkspace.ok, false, "without a workspace, a file no agent reads at a project root is unknown");
});

// ------------------------------------------------------------------ Paseo appended prompt

test("appendSystemPrompt: smallest patch, read back, backup; stale, rejected and mismatched saves reported", async () => {
  await fresh();
  const fake = fakePaseo(sb, { prompt: "Old prompt." });
  const ok = await promptSet(fake.api, { text: "New prompt.", expected: "Old prompt." });
  assert.equal(ok.ok, true, ok.message);
  assert.deepEqual(fake.patches, [{ appendSystemPrompt: "New prompt." }]);
  assert.equal(fake.config.appendSystemPrompt, "New prompt.");
  assert.equal(readFileSync(ok.reports[0]!.backupPath!, "utf8"), "Old prompt.");
  assert.equal(ok.reports[0]!.readBack, "ok");

  const stale = await promptSet(fake.api, { text: "Mine.", expected: "Old prompt." });
  assert.equal(stale.ok, false);
  assert.match(stale.message, /changed since you opened it/);
  assert.equal(fake.patches.length, 1);

  const same = await promptSet(fake.api, { text: "New prompt.", expected: "New prompt." });
  assert.equal(same.ok, true);
  assert.equal(fake.patches.length, 1, "no change, no patch");

  fake.patchBehaviour = "ignore";
  const mismatch = await promptSet(fake.api, { text: "Ignored.", expected: "New prompt." });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reports[0]!.readBack, "mismatch");

  fake.patchBehaviour = "throw";
  const rejected = await promptSet(fake.api, { text: "Rejected.", expected: "New prompt." });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /did not accept/);
});

test.after(() => sb.cleanup());
