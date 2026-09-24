import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test, { afterEach } from "node:test";
import { FIXTURES, fakePaseo, makeSandbox, violations, type Sandbox } from "./helpers";

let sb: Sandbox = await makeSandbox();
const { forgetAllFiles, sha256 } = await import("../server/files");
const { forgetDiscovery } = await import("../server/discover");
const { resetDaemonCache } = await import("../server/daemon");
const { importParse, importPreview, importApply, exportMemories } = await import("../server/transfer");
const { handleWorkspacePlan } = await import("../server/read");
const { parseImport, detectFormat, BundleSchema } = await import("../shared/transfer");
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

/** Every file under the sandbox with its size and mtime, to prove a call wrote nothing. */
function snapshot(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(`${relative(sb.root, path)} ${statSync(path).size} ${statSync(path).mtimeMs}`);
    }
  };
  walk(sb.root);
  return out.sort();
}

async function plainMemoryFolder(paseo: never): Promise<string> {
  const { plans } = await handleWorkspacePlan({ workspaceId: "ws-plain" }, { paseo });
  return plans.find((plan) => plan.agent === "claude")!.items.find((item) => item.kind === "claude-auto-memory")!.path!;
}

// ------------------------------------------------------------------ formats

test("every import format parses", () => {
  const md = parseImport("# Notes\n\nIntro.\n\n## One\n\nFirst.\n\n### Deeper\n\nStill one.\n\n## Two\n\nSecond.\n", "notes.md");
  assert.equal(md.format, "markdown");
  assert.deepEqual(md.items.map((item) => item.title), ["Notes"]);
  const flat = parseImport("## One\n\nFirst.\n\n### Deeper\n\nStill one.\n\n## Two\n\nSecond.\n");
  assert.deepEqual(flat.items.map((item) => [item.title, item.body]), [["One", "First.\n\n### Deeper\n\nStill one.\n"], ["Two", "Second.\n"]]);

  for (const [name, shape] of [["nested.md", "Nested memory"], ["flat.md", "Flat memory"], ["flat_session.md", "Flat with session"]] as const) {
    const text = readFileSync(join(FIXTURES, "home", ".claude", "projects", "@app", "memory", name), "utf8");
    assert.equal(detectFormat(text, name), "claude-memory");
    const parsed = parseImport(text, name);
    assert.equal(parsed.items[0]!.title, shape);
    assert.equal(parsed.items[0]!.body, parseMemoryFile(text).body);
  }

  const ai = parseImport("[2026-09-01] - Prefers short answers.\n[unknown] - Works at Acme as an engineer.\n- [2026-08-02] - Uses pnpm.\n");
  assert.equal(ai.format, "claude-ai");
  assert.deepEqual(ai.items.map((item) => item.body), ["Prefers short answers.\n", "Works at Acme as an engineer.\n", "Uses pnpm.\n"]);
  assert.equal(ai.items[0]!.description, "From claude.ai, saved 2026-09-01");

  const mdc = parseImport("---\ndescription: React rules\nglobs: src/**/*.tsx\nalwaysApply: false\n---\nUse function components.\n", "react.mdc");
  assert.equal(mdc.format, "mdc");
  assert.equal(mdc.items[0]!.title, "React rules");
  assert.match(mdc.items[0]!.warnings[0]!, /only to src\/\*\*\/\*\.tsx/);

  const bad = parseImport('{"format":"paseo-memories","version":2,"items":[]}', "x.json", "bundle");
  assert.equal(bad.items.length, 0);
  assert.match(bad.warnings[0]!, /not a paseo-memories bundle/);
  const many = importParse({ text: "## A\n\nOne.\n", files: [{ name: "b.md", text: "## B\n\nTwo.\n" }, { name: "c.mdc", text: "---\ndescription: C\n---\nThree.\n" }] });
  assert.deepEqual(many.formats.map((entry) => entry.format), ["markdown", "markdown", "mdc"]);
  assert.equal(new Set(many.items.map((item) => item.id)).size, many.items.length, "ids are unique across files");
});

// ------------------------------------------------------------------ export and round trips

test("export → import: bodies byte-identical; masked items keep the mask with a warning", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const exported = await exportMemories(paseo, { selection: { sourceIds: [sb.appMemory] }, format: "bundle" });
  const bundle = BundleSchema.parse(JSON.parse(exported.text));
  assert.equal(bundle.items.length, 5);
  assert.equal(exported.masked, 1);
  const secretItem = bundle.items.find((item) => item.title === "Secret memory")!;
  assert.equal(secretItem.masked, true);
  assert.ok(secretItem.body.includes(MASK_FILL));
  assert.ok(!exported.text.includes("abcdefghijklmnopqrstuvwxyz0123456789ABCD"), "no secret leaves unless revealed");

  const parsed = importParse({ text: exported.text });
  assert.equal(parsed.items.length, 5);
  for (const item of parsed.items) assert.equal(item.body, bundle.items.find((entry) => entry.title === item.title)!.body);
  assert.ok(parsed.items.find((item) => item.title === "Secret memory")!.warnings.some((warning) => /masked/.test(warning)));

  const folder = await plainMemoryFolder(paseo);
  const target = { kind: "claude-memory", sourceId: folder, workspaceId: "ws-plain" };
  const preview = await importPreview(paseo, { items: parsed.items, target });
  const applied = await importApply(paseo, { items: parsed.items, target, selected: preview.items.map((item) => item.id) });
  assert.equal(applied.ok, true, applied.message);
  assert.ok(applied.warnings.some((warning) => /masked/.test(warning)));
  for (const name of ["nested.md", "flat.md", "flat_session.md", "unindexed.md"]) {
    const original = parseMemoryFile(readFileSync(join(sb.appMemory, name), "utf8"));
    const title = readFields(original).name!;
    const copy = readdirSync(folder).map((file) => join(folder, file)).find((path) => path.endsWith(".md") && !path.endsWith("MEMORY.md") && readFields(parseMemoryFile(readFileSync(path, "utf8"))).name === title)!;
    assert.equal(parseMemoryFile(readFileSync(copy, "utf8")).body, original.body, `${name} body is byte-identical`);
  }
  const lines = parseIndex(readFileSync(join(folder, "MEMORY.md"), "utf8"));
  assert.equal(lines.length, 5, "each import adds its MEMORY.md line");

  const revealed = await exportMemories(paseo, { selection: { sourceIds: [sb.appMemory] }, format: "bundle", reveal: [`${sb.appMemory}#secret.md`] });
  assert.equal(revealed.masked, 0);
  assert.ok(revealed.text.includes("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD"));
});

test("export: scopes, projects, entries and plain markdown", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const user = await exportMemories(paseo, { selection: { scope: "user" }, format: "bundle" });
  assert.ok(JSON.parse(user.text).items.every((item: { scope: string }) => item.scope === "user"));
  const project = await exportMemories(paseo, { selection: { scope: "project", projectPath: sb.app }, format: "bundle" });
  assert.ok(project.count > 5);
  assert.ok(JSON.parse(project.text).items.every((item: { projectHint?: string }) => item.projectHint === sb.app));
  const one = await exportMemories(paseo, { selection: { entries: [{ sourceId: join(sb.claude, "CLAUDE.md"), key: "1:style" }] }, format: "markdown" });
  assert.equal(one.count, 1);
  assert.equal(one.text, '# Style\n\n<!-- paseo-memories {"agent":"claude","scope":"user","kind":"claude-md","lines":2} -->\n\nShort sentences.\n');
  assert.match(one.fileName, /^paseo-memories-\d{4}-\d{2}-\d{2}\.md$/);
});

// ------------------------------------------------------------------ preview, dedupe, targets

test("previews never write, and they flag duplicates against the target and within the batch", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const flatBody = parseMemoryFile(readFileSync(join(sb.appMemory, "flat.md"), "utf8")).body;
  const items = [
    { id: "a", title: "Flat again", body: flatBody, masked: false, format: "markdown", warnings: [] },
    { id: "b", title: "New", body: "Brand new guidance about the payments service and its retry policy for failed webhooks.\n", masked: false, format: "markdown", warnings: [] },
    { id: "c", title: "New again", body: "Brand new guidance about the payments service and its retry policy for failed webhooks.\n", masked: false, format: "markdown", warnings: [] },
    { id: "d", title: "Has a key", body: "Use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD for tests.\n", masked: false, format: "markdown", warnings: [] },
  ];
  const before = snapshot();
  const memory = await importPreview(paseo, { items, target: { kind: "claude-memory", sourceId: sb.appMemory } });
  const append = await importPreview(paseo, { items, target: { kind: "append", path: join(sb.codex, "AGENTS.md") } });
  const copy = await importPreview(paseo, { from: [{ sourceId: sb.appMemory, key: "flat.md" }], target: { kind: "append", path: join(sb.app, "AGENTS.md") } });
  assert.deepEqual(snapshot(), before, "no preview wrote anything");
  assert.deepEqual(memory.items.map((item) => item.duplicate), ["exact", "none", "batch", "none"]);
  assert.equal(memory.items[0]!.duplicateOf, "Flat memory");
  assert.equal((memory.items[1] as { fileName?: string }).fileName, "new.md");
  assert.ok(memory.items[1]!.diff.every((line) => line.op === "+"));
  const keyDiff = memory.items[3]!.diff.map((line) => line.text).join("\n");
  assert.ok(keyDiff.includes(MASK_FILL) && !keyDiff.includes("abcdefghijklmnop"), "secrets are masked in previews");
  assert.ok(memory.items[3]!.warnings.some((warning) => /secret/.test(warning)));
  assert.equal(append.target.stamp!.hash, stampOf(join(sb.codex, "AGENTS.md")).hash);
  assert.ok(append.items[1]!.diff.some((line) => line.op === "+" && line.text === "## New"));
  assert.ok(append.items[1]!.warnings.some((warning) => /Codex reads AGENTS.md as instructions/.test(warning)));
  assert.equal(copy.items[0]!.title, "Flat memory");
  assert.match(memory.checked, /Compared with 5 memories/);
});

test("Copy into Codex goes to an AGENTS.md; generated Codex memory and extensions are never targets", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const items = [{ id: "x", title: "From Claude", body: "Prefer small diffs and explain each change.\n", masked: false, format: "markdown", warnings: [] }];
  for (const path of [join(sb.codex, "memories", "MEMORY.md"), join(sb.codex, "memories", "extensions", "ad_hoc", "instructions.md"), join(sb.codex, "memories", "raw_memories.md"), join(sb.managed, "CLAUDE.md")]) {
    const result = await importApply(paseo, { items, target: { kind: "append", path }, selected: ["x"], expected: existsSync(path) ? stampOf(path) : null });
    assert.equal(result.ok, false, path);
  }
  const agents = join(sb.codex, "AGENTS.md");
  const before = readFileSync(agents, "utf8");
  const ok = await importApply(paseo, { items, target: { kind: "append", path: agents }, selected: ["x"], expected: stampOf(agents) });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(readFileSync(agents, "utf8"), `${before}\n## From Claude\n\nPrefer small diffs and explain each change.\n`);
  assert.ok(ok.reports[0]!.backupPath);
  const stale = await importApply(paseo, { items, target: { kind: "append", path: agents }, selected: ["x"], expected: { size: 1, mtimeMs: 1 } });
  assert.equal(stale.ok, false, "a changed target needs a fresh preview");
  const unpreviewed = await importApply(paseo, { items, target: { kind: "append", path: agents }, selected: ["x"] });
  assert.equal(unpreviewed.ok, false);
  const none = await importApply(paseo, { items, target: { kind: "append", path: agents }, selected: [], expected: stampOf(agents) });
  assert.equal(none.ok, false);
});

test("copy and move between agents, scopes and projects", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  // Move a Claude memory into another project's (new) memory folder.
  const folder = await plainMemoryFolder(paseo);
  const target = { kind: "claude-memory", sourceId: folder, workspaceId: "ws-plain" };
  const from = [{ sourceId: sb.appMemory, key: "flat.md" }];
  const preview = await importPreview(paseo, { from, target });
  const moved = await importApply(paseo, { from, target, selected: preview.items.map((item) => item.id), move: true });
  assert.equal(moved.ok, true, moved.message);
  assert.equal(existsSync(join(sb.appMemory, "flat.md")), false, "the original is gone");
  assert.ok(!parseIndex(readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8")).some((line) => line.file === "flat.md"), "and its index line");
  assert.ok(existsSync(join(folder, "flat_memory.md")));
  // Move a section from a project CLAUDE.md into the user's Codex AGENTS.md.
  const claudeMd = join(sb.app, "CLAUDE.md");
  const sectionFrom = [{ sourceId: claudeMd, key: "1:testing" }];
  const agents = join(sb.codex, "AGENTS.md");
  const sectionPreview = await importPreview(paseo, { from: sectionFrom, target: { kind: "append", path: agents } });
  const sectionMoved = await importApply(paseo, { from: sectionFrom, target: { kind: "append", path: agents }, selected: sectionPreview.items.map((item) => item.id), expected: sectionPreview.target.stamp, move: true });
  assert.equal(sectionMoved.ok, true, sectionMoved.message);
  assert.ok(readFileSync(agents, "utf8").endsWith("## Testing\n\nRun pnpm test.\n"));
  assert.ok(!readFileSync(claudeMd, "utf8").includes("## Testing"));
  assert.ok(readFileSync(claudeMd, "utf8").startsWith("# App\n\nProject rules."));
  // Whole files can be copied, not moved.
  const whole = await importApply(paseo, { from: [{ sourceId: join(sb.home, ".pi", "agent", "AGENTS.md") }], target: { kind: "append", path: agents }, selected: [`${join(sb.home, ".pi", "agent", "AGENTS.md")}#`], expected: stampOf(agents), move: true });
  assert.equal(whole.ok, false);
});

test.after(() => sb.cleanup());
