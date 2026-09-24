/**
 * Regression tests for the C+D review (memories-research/review-cd.md), one
 * or more per finding. Each fails on the code before the fix.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { fakePaseo, makeSandbox, violations, type Sandbox } from "./helpers";

let sb: Sandbox = await makeSandbox();
const { forgetAllFiles, sha256 } = await import("../server/files");
const { forgetDiscovery } = await import("../server/discover");
const { resetDaemonCache } = await import("../server/daemon");
const { claudeCreate, claudeUpdate } = await import("../server/claude-memory");
const { importParse, importPreview, importApply, exportMemories } = await import("../server/transfer");
const { handleWorkspacePlan } = await import("../server/read");
const { findingsFor } = await import("../server/tidy");
const { codexLockState } = await import("../server/codex-lock");
const { parseImport } = await import("../shared/transfer");
const { splitSections } = await import("../shared/markdown");
const { parseIndex } = await import("../shared/memory-index");
const { parseMemoryFile, readFields } = await import("../shared/frontmatter");

async function fresh(options: Parameters<typeof makeSandbox>[0] = {}): Promise<Sandbox> {
  sb.cleanup();
  sb = await makeSandbox(options);
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

async function plainMemoryFolder(paseo: never): Promise<string> {
  const { plans } = await handleWorkspacePlan({ workspaceId: "ws-plain" }, { paseo });
  return plans.find((plan) => plan.agent === "claude")!.items.find((item) => item.kind === "claude-auto-memory")!.path!;
}

// ------------------------------------------------------------------ 1. the index under another case

test("1: a memory named Memory never becomes the index, however it is spelt or made", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  // A project with no MEMORY.md yet: on a case-insensitive disk memory.md would BE the index.
  const folder = await plainMemoryFolder(paseo);
  const first = await claudeCreate(paseo, { sourceId: folder, workspaceId: "ws-plain", name: "Memory", description: "a note called Memory", body: "Body one.\n" });
  assert.equal(first.ok, true, first.message);
  const names = readdirSync(folder);
  assert.ok(!names.some((name) => name !== "MEMORY.md" && name.toLowerCase() === "memory.md"), `no second index: ${names.join(", ")}`);
  assert.ok(names.includes("memory_2.md"));
  assert.equal(readFields(parseMemoryFile(readFileSync(join(folder, "memory_2.md"), "utf8"))).name, "Memory");
  assert.deepEqual(parseIndex(readFileSync(join(folder, "MEMORY.md"), "utf8")).map((line) => line.file), ["memory_2.md"]);
  // With an index already there, and for a typed name or a rename.
  const upper = await claudeCreate(paseo, { sourceId: sb.appMemory, name: "MEMORY", description: "shouting", body: "x\n" });
  assert.equal(upper.ok, true);
  assert.ok(existsSync(join(sb.appMemory, "memory_2.md")));
  assert.ok(parseIndex(readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8")).some((line) => line.file === "nested.md"), "the index kept its lines");
  const typed = await claudeCreate(paseo, { sourceId: sb.appMemory, fileName: "memory.md", name: "X", description: "y", body: "z\n" });
  assert.equal(typed.ok, false);
  const renamed = await claudeUpdate(paseo, { sourceId: sb.appMemory, key: "flat.md", expected: stampOf(join(sb.appMemory, "flat.md")), rename: "Memory.md" });
  assert.equal(renamed.ok, false);
  // Import picks the same way.
  const items = [{ id: "m", title: "memory", body: "Imported.\n", masked: false, format: "markdown", warnings: [] }];
  const preview = await importPreview(paseo, { items, target: { kind: "claude-memory", sourceId: sb.appMemory } });
  assert.notEqual((preview.items[0] as { fileName?: string }).fileName!.toLowerCase(), "memory.md");
});

// ------------------------------------------------------------------ 2. Move

test("2: moving every section of a file removes them all, in one write", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const origin = join(sb.app, "CLAUDE.md");
  const target = join(sb.codex, "AGENTS.md");
  const from = splitSections(readFileSync(origin, "utf8")).map((section) => ({ sourceId: origin, key: section.key }));
  assert.ok(from.length >= 2);
  const preview = await importPreview(paseo, { from, target: { kind: "append", path: target } });
  const moved = await importApply(paseo, { from, target: { kind: "append", path: target }, selected: preview.items.map((item) => item.id), expected: preview.target.stamp, move: true });
  assert.equal(moved.ok, true, moved.message);
  const left = readFileSync(origin, "utf8");
  assert.ok(!left.includes("## Testing") && !left.includes("# App"), `originals removed: ${JSON.stringify(left)}`);
  assert.ok(readFileSync(target, "utf8").includes("## Testing"));
  assert.equal(moved.reports.filter((report) => report.target === origin).length, 1, "one write to the origin");
});

test("2: Move is refused up front when an original cannot be removed, or into the same file", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const target = join(sb.codex, "AGENTS.md");
  const before = readFileSync(target, "utf8");
  const cases = [
    { sourceId: join(sb.managed, "CLAUDE.md"), key: "0:managed" },
    { sourceId: join(sb.codex, "memories", "MEMORY.md"), key: "1:tooling" },
  ];
  for (const ref of cases) {
    const preview = await importPreview(paseo, { from: [ref], target: { kind: "append", path: target } });
    const result = await importApply(paseo, { from: [ref], target: { kind: "append", path: target }, selected: preview.items.map((item) => item.id), expected: preview.target.stamp, move: true });
    assert.equal(result.ok, false, ref.sourceId);
    assert.match(result.message, /copied but not moved/);
    assert.equal(readFileSync(target, "utf8"), before, `nothing written for ${ref.sourceId}`);
  }
  const self = join(sb.app, "CLAUDE.md");
  const ref = { sourceId: self, key: "1:testing" };
  const preview = await importPreview(paseo, { from: [ref], target: { kind: "append", path: self } });
  const same = await importApply(paseo, { from: [ref], target: { kind: "append", path: self }, selected: preview.items.map((item) => item.id), expected: preview.target.stamp, move: true });
  assert.equal(same.ok, false);
  assert.match(same.message, /already in/);
});

test("2: an original that cannot be removed after the copy is a failure, said plainly", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const origin = join(sb.app, "CLAUDE.md");
  const target = join(sb.codex, "AGENTS.md");
  const from = [{ sourceId: origin, key: "1:testing" }];
  const preview = await importPreview(paseo, { from, target: { kind: "append", path: target } });
  // Someone edits the origin while the copy is being saved.
  const original = fsp.rename;
  (fsp as unknown as { rename: unknown }).rename = async (a: unknown, b: unknown) => {
    const out = await (original as (x: unknown, y: unknown) => Promise<void>)(a, b);
    if (String(b) === target) appendFileSync(origin, "\nAn agent added this.\n");
    return out;
  };
  try {
    const result = await importApply(paseo, { from, target: { kind: "append", path: target }, selected: preview.items.map((item) => item.id), expected: preview.target.stamp, move: true });
    assert.equal(result.ok, false);
    assert.match(result.message, /could not be removed, so it is now in both places/);
  } finally {
    (fsp as unknown as { rename: unknown }).rename = original;
  }
  assert.ok(readFileSync(origin, "utf8").includes("## Testing"), "the original stays where it was");
});

// ------------------------------------------------------------------ 3. markdown

test("3: text before the first top-level heading is its own item, even under a deeper heading", () => {
  const parsed = parseImport("### Context\nWe deploy on Fridays.\n# Rules\nUse the test runner.\n");
  assert.deepEqual(parsed.items.map((item) => [item.title, item.body]), [["Context", "We deploy on Fridays.\n"], ["Rules", "Use the test runner.\n"]]);
  const loose = parseImport("Loose words first.\n\n## Only\n\nSection.\n", "notes.md");
  assert.deepEqual(loose.items.map((item) => item.title), ["notes", "Only"]);
});

test("3: a markdown export imports back with the same items and bodies", async () => {
  await fresh();
  writeFileSync(join(sb.appMemory, "headings.md"), "---\nname: Has headings\ndescription: headings inside\ntype: project\n---\n\n# Big heading\n\ntext -> here\n\n```\n# not a heading\n```\n\n###### deepest\n");
  appendFileSync(join(sb.appMemory, "MEMORY.md"), "- [Has headings](headings.md) — headings inside\n");
  forgetAllFiles();
  forgetDiscovery();
  const paseo = fakePaseo(sb).api;
  const selection = { scope: "project", projectPath: sb.app };
  const reference = JSON.parse((await exportMemories(paseo, { selection, format: "bundle", revealAll: true })).text).items as Array<{ title: string; body: string }>;
  const markdown = await exportMemories(paseo, { selection, format: "markdown", revealAll: true });
  const back = importParse({ text: markdown.text });
  assert.equal(back.items.length, reference.length);
  back.items.forEach((item, index) => {
    assert.equal(item.title, reference[index]!.title.replace(/[\r\n]+/g, " "));
    assert.equal(item.body, reference[index]!.body, `body of "${item.title}"`);
  });
});

// ------------------------------------------------------------------ 4. claude.ai

test("4: claude.ai continuation lines stay with their entry; stray lines are reported", () => {
  const parsed = parseImport("[2026-01-01] - Works at Acme:\n  - team lead for payments\n  - on call in March\n[2026-01-02] - Likes tea.\n", undefined, "claude-ai");
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0]!.body, "Works at Acme:\n  - team lead for payments\n  - on call in March\n");
  const stray = parseImport("Here is what I remember:\n[2026-01-01] - Likes tea.\n", undefined, "claude-ai");
  assert.equal(stray.items.length, 1);
  assert.ok(stray.warnings.some((warning) => /1 line before the first/.test(warning)), stray.warnings.join(" | "));
});

// ------------------------------------------------------------------ 5. stale paths, project unknown

test("5: relative paths are not checked for memory whose project path is unknown", async () => {
  await fresh();
  const folder = join(sb.claude, "projects", "-old-deleted-project", "memory");
  writeFileSync(join(folder, "paths.md"), "---\nname: Paths\ndescription: paths\ntype: project\n---\n\nSee `src/index.ts` and `~/gone-folder/notes.md`.\n");
  appendFileSync(join(folder, "MEMORY.md"), "- [Paths](paths.md) — paths\n");
  forgetAllFiles();
  forgetDiscovery();
  const result = await findingsFor(fakePaseo(sb).api, true);
  const stale = result.findings.filter((finding) => finding.kind === "stale-path").map((finding) => finding.message);
  assert.ok(!stale.some((message) => message.includes("src/index.ts")), stale.join("\n"));
  assert.ok(stale.some((message) => message.includes("gone-folder")), "absolute paths are still checked");
  assert.ok(result.notes.some((note) => /Relative paths in 1 Claude memory folder whose project path is unknown were not checked/.test(note)));
});

// ------------------------------------------------------------------ 7. the expired lease message

test("7: an old expired lease counts as free and says why, with the lease time", async () => {
  await fresh({ job: "running-stale" });
  const state = await codexLockState(sb.codex);
  assert.equal(state.lock, "free");
  assert.match(state.reason, /^A Codex clean-up is marked as running, but its lease ran out at \d{4}-\d{2}-\d{2}T[\d:.]+Z, over an hour ago\. Codex reclaims expired leases itself, so this counts as free\.$/);
});

// ------------------------------------------------------------------ 8. BOM

test("8: a byte-order mark does not stop a bundle (or any format) from importing", () => {
  const bundle = `﻿${JSON.stringify({ format: "paseo-memories", version: 1, exportedAt: "2026-01-01T00:00:00Z", host: "h", items: [{ agent: "claude", scope: "user", kind: "claude-md", title: "T", body: "B\n", masked: false }] })}`;
  const parsed = importParse({ files: [{ name: "export.json", text: bundle }] });
  assert.equal(parsed.items.length, 1);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parseImport("﻿# Heading\n\nText.\n").items[0]!.title, "Heading");
});

// ------------------------------------------------------------------ 9. duplicates across projects

test("9: duplicates in different projects' memory are never 'delete the copy'", async () => {
  await fresh();
  const text = "Payment webhooks retry three times and then stop, so the handler must answer within five seconds every time.";
  writeFileSync(join(sb.appMemory, "retries.md"), `---\nname: Retries\ndescription: retries\ntype: project\n---\n\n${text}\n`);
  writeFileSync(join(sb.longMemory, "retries.md"), `---\nname: Retries too\ndescription: retries\ntype: project\n---\n\n${text}\n`);
  forgetAllFiles();
  forgetDiscovery();
  const result = await findingsFor(fakePaseo(sb).api, true);
  const group = result.findings.find((finding) => finding.kind === "duplicate" && finding.entryKeys!.includes("retries.md"))!;
  assert.ok(group, "found");
  assert.equal(group.action!.label, "Move to your user CLAUDE.md");
  assert.notEqual(group.action!.kind, "delete");
  assert.match(group.message, /Each project loads only its own copy/);
});

// ------------------------------------------------------------------ 6. drafts (pure)

test("6: an unsaved draft survives a reload of the same file and is flagged when the file changed", async () => {
  const { receive, reload, keepEditing, edit, isDirty } = await import("../client/draft");
  const one = { size: 1, mtimeMs: 1, hash: "a" };
  const two = { size: 2, mtimeMs: 2, hash: "b" };
  let draft = receive(null, { value: "old", stamp: one });
  draft = receive(draft, { value: "newer", stamp: two });
  assert.equal(draft.value, "newer", "an untouched draft follows the file");
  draft = edit(draft, "my edit");
  draft = receive(draft, { value: "newer", stamp: two });
  assert.equal(draft.value, "my edit", "a refetch of the same file keeps the draft");
  assert.equal(draft.newer, undefined);
  draft = receive(draft, { value: "someone else", stamp: { size: 3, mtimeMs: 3, hash: "c" } });
  assert.equal(draft.value, "my edit", "never overwritten");
  assert.equal(draft.newer?.value, "someone else", "flagged: changed on disk");
  assert.equal(draft.stamp?.hash, "b", "the save still carries the old stamp, so the host refuses it");
  const kept = keepEditing(draft);
  assert.equal(receive(kept, { value: "someone else", stamp: { size: 3, mtimeMs: 3, hash: "c" } }).newer, undefined, "not flagged again after Keep editing");
  const fresh2 = reload(draft);
  assert.equal(fresh2.value, "someone else");
  assert.equal(isDirty(fresh2), false);
});

test.after(() => sb.cleanup());
