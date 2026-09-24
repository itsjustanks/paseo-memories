/**
 * Regression tests for the round-2 review follow-ups (N1-N4). Each fails on
 * the round-2 commit.
 */
import assert from "node:assert/strict";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { claudeSlug } from "../shared/slug";
import { fakePaseo, makeSandbox, violations, type Sandbox } from "./helpers";

let sb: Sandbox = await makeSandbox();
const { forgetAllFiles, sha256 } = await import("../server/files");
const { forgetDiscovery } = await import("../server/discover");
const { resetDaemonCache } = await import("../server/daemon");
const { instructionWrite } = await import("../server/instructions");
const { claudeUpdate } = await import("../server/claude-memory");
const write = await import("../server/write");
const { inventoryFor } = await import("../server/read");
const contribute = (await import("../index.server")).default;

async function fresh(): Promise<Sandbox> {
  sb.cleanup();
  sb = await makeSandbox();
  forget();
  return sb;
}

function forget() {
  forgetAllFiles();
  forgetDiscovery();
  resetDaemonCache();
}

afterEach(() => assert.deepEqual(violations, [], "no write outside the sandbox"));

function stampOf(path: string) {
  const buffer = readFileSync(path);
  const stat = statSync(path);
  return { size: stat.size, mtimeMs: stat.mtimeMs, hash: sha256(buffer) };
}

function caseInsensitive(dir: string): boolean {
  const probe = join(dir, "case-probe");
  writeFileSync(probe, "");
  const result = existsSync(join(dir, "CASE-PROBE"));
  rmSync(probe);
  return result;
}

// ------------------------------------------------------------------ N1 case-only rename

test("N1: a case-only rename on a case-insensitive disk keeps the memory", async (t) => {
  await fresh();
  if (!caseInsensitive(sb.appMemory)) {
    t.skip("this temp folder is case-sensitive, so a case-only rename is two different files here; the same-file branch is covered by the next test");
    return;
  }
  const paseo = fakePaseo(sb).api;
  const path = join(sb.appMemory, "flat.md");
  const before = readFileSync(path, "utf8");
  const result = await claudeUpdate(paseo, { sourceId: sb.appMemory, key: "flat.md", rename: "Flat.md", expected: stampOf(path) });
  assert.equal(result.ok, true, result.message);
  const names = readdirSync(sb.appMemory);
  assert.ok(names.includes("Flat.md"), "the new spelling is on disk");
  assert.ok(!names.includes("flat.md"), "the old spelling is gone");
  assert.equal(readFileSync(join(sb.appMemory, "Flat.md"), "utf8"), before, "the memory is still there, unchanged");
  const index = readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8");
  assert.match(index, /\]\(Flat\.md\)/);
  assert.doesNotMatch(index, /\]\(flat\.md\)/);
  assert.deepEqual(names.filter((name) => name.startsWith(".paseo-memories-tmp-")), []);
});

test("N1: same-file branch: sameFile sees one file under two names; renameInPlace renames without copying", async () => {
  await fresh();
  const a = join(sb.appMemory, "flat.md");
  const other = join(sb.appMemory, "nested.md");
  const link = join(sb.root, "flat-link.md");
  linkSync(a, link);
  assert.equal(await write.sameFile(a, link), true, "a hard link is the same file");
  assert.equal(await write.sameFile(a, other), false);
  rmSync(link);

  const before = readFileSync(a, "utf8");
  const session = write.newSession(5);
  const renamed = await write.renameInPlace(session, a, join(sb.appMemory, "Flat.md"), await write.readCurrent(a));
  assert.equal(renamed.ok, true, renamed.error ?? "");
  assert.ok(readdirSync(sb.appMemory).includes("Flat.md"));
  assert.ok(!readdirSync(sb.appMemory).includes("flat.md"));
  assert.equal(readFileSync(join(sb.appMemory, "Flat.md"), "utf8"), before);
  assert.equal(readFileSync(renamed.backupPath!, "utf8"), before, "backed up first");

  // Onto a different file: refused, both kept.
  const keep = readFileSync(other, "utf8");
  const refused = await write.renameInPlace(session, join(sb.appMemory, "Flat.md"), other, await write.readCurrent(join(sb.appMemory, "Flat.md")));
  assert.equal(refused.ok, false);
  assert.equal(readFileSync(other, "utf8"), keep);
  assert.equal(readFileSync(join(sb.appMemory, "Flat.md"), "utf8"), before);
});

// ------------------------------------------------------------------ N2 masking scope

const CANARY = "sk-ant-api03-CANARYsecretVALUE0123456789abcdef";

test("N2: ids and paths that look like secrets round-trip; secrets in text stay masked", async () => {
  await fresh();
  const learn = join(sb.home, "code", "sk-learn-experiments-notebooks-2026");
  const team = join(sb.home, "code", "xoxb-team-notes-archive-2026");
  mkdirSync(learn, { recursive: true });
  mkdirSync(team, { recursive: true });
  writeFileSync(join(learn, "CLAUDE.md"), `# Notebooks\n\nThe key is ${CANARY}.\n`);
  writeFileSync(join(team, "CLAUDE.md"), "# Team notes\n\nKeep it short.\n");
  const memory = join(sb.claude, "projects", claudeSlug(learn), "memory");
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, "MEMORY.md"), "- [Datasets](datasets.md) — where the data lives\n");
  writeFileSync(join(memory, "datasets.md"), "---\nname: Datasets\ndescription: where the data lives\ntype: reference\n---\n\nIn ./data.\n");
  forget();
  const fake = fakePaseo(sb, { extra: [{ id: "ws-learn", path: learn }, { id: "ws-team", path: team }] });
  const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
  const server = { handle: (contract: { name: string }, fn: never) => handlers.set(contract.name, fn), registerSettings() {}, on() {}, before() {}, registerProvider() {} };
  const stop = contribute(server as never) as () => void;
  const rpc = async (name: string, input: unknown) => {
    const out = await handlers.get(`paseo-memories.${name}`)!(input, { paseo: fake.api });
    assert.ok(!JSON.stringify(out).includes(CANARY), `${name} leaked the secret`);
    return out as any;
  };
  try {
    const inventory = await rpc("inventory", { refresh: true });
    const learnMd = join(learn, "CLAUDE.md");
    const ids = inventory.sources.map((source: { id: string }) => source.id);
    assert.ok(ids.includes(learnMd), "the project file's id is its real path");
    assert.ok(ids.includes(memory), "the memory folder's id is its real path");
    assert.ok(inventory.sources.every((source: { id: string; path: string }) => !source.id.includes("•") && !source.path.includes("•")));

    const opened = await rpc("source", { sourceId: learnMd, workspaceId: "ws-learn" });
    assert.equal(opened.source.path, learnMd);
    const entry = await rpc("entry", { sourceId: memory, key: "datasets.md" });
    assert.match(JSON.stringify(entry), /In \.\/data\./);

    const saved = await rpc("instruction-write", { path: join(team, "CLAUDE.md"), workspaceId: "ws-team", text: "# Team notes\n\nShorter.\n", expected: stampOf(join(team, "CLAUDE.md")) });
    assert.equal(saved.ok, true, saved.message);
    assert.equal(readFileSync(join(team, "CLAUDE.md"), "utf8"), "# Team notes\n\nShorter.\n");

    const preview = await rpc("import-preview", { from: [{ sourceId: memory, key: "datasets.md" }], target: { kind: "append", path: join(team, "CLAUDE.md"), workspaceId: "ws-team" } });
    assert.equal(preview.target.path, join(team, "CLAUDE.md"));

    const findings = await rpc("findings", { refresh: true });
    const secret = findings.findings.find((finding: { kind: string; sourceIds: string[] }) => finding.kind === "secret" && finding.sourceIds.includes(learnMd));
    assert.ok(secret, "the secret in the project file is found");
    assert.equal(secret.action.sourceId, learnMd);
    const fromFinding = await rpc("source", { sourceId: secret.action.sourceId, workspaceId: "ws-learn" });
    assert.equal(fromFinding.source.path, learnMd);
    const body = await rpc("entry", { sourceId: learnMd, workspaceId: "ws-learn" });
    assert.match(JSON.stringify(body), /The key is sk-a/, "the secret in the text is masked, not dropped");
  } finally {
    stop();
  }
});

// ------------------------------------------------------------------ N3 symlinked HOME

test("N3: with HOME reached through a symlinked folder, saving CLAUDE.md that links to AGENTS.md works", async () => {
  await fresh();
  const linkHome = join(sb.root, "link-home");
  symlinkSync(sb.home, linkHome);
  const via = (path: string) => path.replace(sb.home, linkHome);
  const viaLink = Object.fromEntries(Object.entries(sb).map(([key, value]) => [key, typeof value === "string" ? via(value) : value])) as Sandbox;
  const real = join(sb.app, "AGENTS.md");
  rmSync(join(sb.app, "CLAUDE.md"));
  symlinkSync("AGENTS.md", join(sb.app, "CLAUDE.md"));
  const realHome = process.env.HOME;
  process.env.HOME = linkHome;
  process.env.PASEO_HOME = join(linkHome, ".paseo");
  forget();
  try {
    const paseo = fakePaseo(viaLink).api;
    const link = join(viaLink.app, "CLAUDE.md");
    const result = await instructionWrite(paseo, { path: link, workspaceId: "ws-app", text: "# Shared\n\nThrough a linked home.\n", expected: stampOf(link) });
    assert.equal(result.ok, true, result.message);
    assert.equal(readFileSync(real, "utf8"), "# Shared\n\nThrough a linked home.\n");
    assert.equal(lstatSync(join(sb.app, "CLAUDE.md")).isSymbolicLink(), true);
  } finally {
    process.env.HOME = realHome;
    process.env.PASEO_HOME = join(realHome!, ".paseo");
    forget();
  }
});

// ------------------------------------------------------------------ N4 one editable rule

test("N4: OpenCode instructions[] files are read-only; every editable source is saveable", async () => {
  await fresh();
  writeFileSync(join(sb.home, "rules.txt"), "Plain text rules.\n");
  writeFileSync(join(sb.home, ".config", "opencode", "opencode.json"), JSON.stringify({ instructions: ["~/shared-rules.md", "~/rules.txt"] }));
  forget();
  const paseo = fakePaseo(sb).api;
  const inventory = await inventoryFor(paseo, true);
  for (const name of ["shared-rules.md", "rules.txt"]) {
    const source = inventory.sources.find((entry) => entry.path === join(sb.home, name));
    assert.ok(source, `${name} is listed`);
    assert.equal(source.access, "read-only", `${name} is listed read-only`);
  }
  const editable = inventory.sources.filter((source) => source.access === "editable" && source.path.startsWith("/") && !source.isDirectory && source.kind !== "claude-auto-memory");
  assert.ok(editable.length > 5);
  for (const source of editable) assert.equal(await write.writableReason(source.path), null, `${source.path} is listed editable, so it must be saveable`);
  const refused = await instructionWrite(paseo, { path: join(sb.home, "shared-rules.md"), workspaceId: "ws-app", text: "x\n", expected: stampOf(join(sb.home, "shared-rules.md")) });
  assert.equal(refused.ok, false);
});

test("N4: Codex generated-file names are refused only inside a real Codex home", async () => {
  await fresh();
  const session = write.newSession(5);
  const notes = join(sb.home, "code", "notes", "memories");
  mkdirSync(join(notes, "extensions"), { recursive: true });
  for (const path of [join(notes, "extensions", "ideas.md"), join(notes, "raw_memories.md")]) {
    const report = await write.safeWrite(session, path, "# Mine\n", { newMode: 0o644 });
    assert.equal(report.ok, true, `${path}: ${report.error ?? ""}`);
  }
  for (const path of [join(sb.codex, "memories", "raw_memories.md"), join(sb.codex, "memories", "extensions", "x.md")]) {
    assert.notEqual(await write.writableReason(path), null, `${path} stays Codex's`);
  }
});
