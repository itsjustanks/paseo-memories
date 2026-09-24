/**
 * Regression tests for the 0.2.0 re-check (memories-research/review-020.md,
 * "Re-check at 1e9fe59"): N1-N3, the rest of #8 and the #3 wording. Each
 * failed before its fix.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { fakePaseo, makeSandbox, violations, type Sandbox } from "./helpers";

let sb: Sandbox = await makeSandbox();
const { forgetAllFiles } = await import("../server/files");
const { forgetDiscovery } = await import("../server/discover");
const { resetDaemonCache } = await import("../server/daemon");
const { inventoryFor } = await import("../server/read");
const { notePreview, noteAdd } = await import("../server/add-note");
const { noteCards, cardRemoval, usesFrontmatter } = await import("../shared/notes");
const { replaceSection, splitSections } = await import("../shared/markdown");
const { isCodexInternal, plainFindings } = await import("../shared/plain");
const { claudeSlug } = await import("../shared/slug");

async function fresh(): Promise<Sandbox> {
  sb.cleanup();
  sb = await makeSandbox();
  forgetAllFiles();
  forgetDiscovery();
  resetDaemonCache();
  return sb;
}

afterEach(() => assert.deepEqual(violations, [], "no write outside the sandbox"));

const expectedOf = (preview: { targets: Array<{ id: string; stamp: { size: number; mtimeMs: number; hash?: string } | null }> }) => preview.targets.map((target) => ({ id: target.id, stamp: target.stamp }));

// ------------------------------------------------------------------ N1

test("N1: only Codex's generated working files are internal, by kind or by their place in its memories folder", () => {
  const codex = (kind: string, path: string, access = "read-only") => ({ kind, agent: "codex", access, path });
  assert.equal(isCodexInternal(codex("agents-md", "/p/RULES.txt")), false, "a read-only instruction file Codex reads stays");
  assert.equal(isCodexInternal(codex("codex-config", "/h/.codex/config.toml")), false, "developer_instructions stays");
  assert.equal(isCodexInternal(codex("agents-md", "/p/node_modules/x/AGENTS.md")), false);
  for (const path of ["/h/.codex/memories/raw_memories.md", "/h/.codex/memories/rollout_summaries", "/h/.codex/memories/extensions", "/h/.codex/memories/phase2_workspace_diff.md", "/h/.codex/memories_1.sqlite"]) {
    assert.equal(isCodexInternal({ kind: "codex-generated", agent: "codex", access: "read-only", path }), true, path);
    assert.equal(isCodexInternal({ kind: "something-new", agent: "codex", access: "read-only", path }), true, `by place: ${path}`);
  }
  assert.equal(isCodexInternal(codex("codex-memory", "/h/.codex/memories/MEMORY.md", "editable")), false, "what Codex has learned stays");
});

test("N1: secret warnings are never dropped; other findings about working files are", () => {
  const sources = [
    { id: "/h/.codex/memories/raw_memories.md", kind: "codex-generated", agent: "codex", access: "read-only", path: "/h/.codex/memories/raw_memories.md" },
    { id: "/p/RULES.txt", kind: "agents-md", agent: "codex", access: "read-only", path: "/p/RULES.txt" },
  ];
  const findings = [
    { id: "a", kind: "secret", sourceIds: ["/h/.codex/memories/raw_memories.md"] },
    { id: "b", kind: "over-limit", sourceIds: ["/h/.codex/memories/raw_memories.md"] },
    { id: "c", kind: "secret", sourceIds: ["/p/RULES.txt"] },
    { id: "d", kind: "duplicate", sourceIds: ["/p/RULES.txt", "/h/.codex/memories/raw_memories.md"] },
  ];
  assert.deepEqual(plainFindings(findings, sources).map((finding) => finding.id), ["a", "c", "d"]);
});

test("N1: a read-only fallback instruction file Codex reads is not internal in the real inventory", async () => {
  await fresh();
  const rules = join(sb.home, "code", "rules-only");
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, "RULES.txt"), "Use the staging account.\n");
  const config = join(sb.codex, "config.toml");
  writeFileSync(config, readFileSync(config, "utf8").replace('project_doc_fallback_filenames = ["TEAM.md"]', 'project_doc_fallback_filenames = ["TEAM.md", "RULES.txt"]'));
  forgetAllFiles();
  const inventory = await inventoryFor(fakePaseo(sb, { extra: [{ id: "ws-rules", path: rules }] }).api);
  const source = inventory.sources.find((entry) => entry.path === join(rules, "RULES.txt"));
  assert.ok(source, "Codex reads RULES.txt here");
  assert.equal(source.access, "read-only", "the case the old rule hid: read-only and Codex's");
  assert.equal(source.agent, "codex");
  assert.equal(isCodexInternal(source), false);
});

// ------------------------------------------------------------------ N2

const DIVIDER = "---\n\nThanks for reading. Rules below.\n\n---\n\n# Rules\n\nBe kind.\n";

test("N2: a leading --- divider in a CLAUDE.md or AGENTS.md is not a header", () => {
  assert.equal(usesFrontmatter({ kind: "claude-md", path: "/p/CLAUDE.md" }), false);
  assert.equal(usesFrontmatter({ kind: "agents-md", path: "/p/AGENTS.md" }), false);
  assert.equal(usesFrontmatter({ kind: "claude-rule", path: "/h/.claude/rules/x.md" }), true);
  assert.equal(usesFrontmatter({ kind: "copilot-md", path: "/p/.github/instructions/go.instructions.md" }), true);
  assert.equal(usesFrontmatter({ kind: "copilot-md", path: "/p/.github/copilot-instructions.md" }), false);
  assert.equal(usesFrontmatter({ kind: "claude-rule", path: "/p/.cursor/rules/x.mdc" }), true);
  const cards = noteCards(DIVIDER, { frontmatter: usesFrontmatter({ kind: "claude-md", path: "/p/CLAUDE.md" }) });
  assert.match(cards[0]!.note.body, /Thanks for reading/);
  assert.equal(cards[0]!.header, "");
});

test("N2: even where headers are allowed, a --- block that isn't key: value lines is text, not a header", () => {
  const cards = noteCards(DIVIDER, { frontmatter: true });
  assert.match(cards[0]!.note.body, /Thanks for reading/);
  const real = noteCards('---\npaths:\n  - "src/**"\nalwaysApply: false\n---\nIntro.\n', { frontmatter: true });
  assert.equal(real[0]!.header, '---\npaths:\n  - "src/**"\nalwaysApply: false\n---\n');
  assert.equal(real[0]!.note.body, "Intro.");
});

// ------------------------------------------------------------------ N3

test("N3: when the shared project file won't be read, Claude keeps its own note, and the preview says so", async () => {
  await fresh();
  const agents = join(sb.plain, "AGENTS.md");
  writeFileSync(agents, `# Team\n\n${"y".repeat(40_000)}\n`);
  forgetAllFiles();
  const paseo = fakePaseo(sb).api;
  const preview = await notePreview(paseo, { text: "Demos use the staging account.", who: "all", workspaceId: "ws-plain" });
  const claude = preview.targets.find((target) => target.agent === "claude");
  const codex = preview.targets.find((target) => target.agent === "codex");
  assert.ok(codex?.blocked, "Codex won't read that far");
  assert.ok(claude, "Claude gets its own note");
  assert.match(claude.warnings.join(" "), /Claude gets its own note, because Codex won't read the project instructions this far/);
  assert.equal(preview.skipped.some((entry) => entry.covered), false);
  const saved = await noteAdd(paseo, { text: "Demos use the staging account.", who: "all", workspaceId: "ws-plain", expected: expectedOf(preview) });
  const memory = join(sb.claude, "projects", claudeSlug(sb.plain), "memory");
  assert.ok(readdirSync(memory).some((name) => name.startsWith("demos_use")), saved.message);
  assert.match(saved.message, /Saved to Claude's notes for plain\./);
  assert.match(saved.message, /Couldn't save to Project instructions · plain: Codex only reads the start/);
});

// ------------------------------------------------------------------ #8, the rest

test("#8: removing the top card from a CRLF file with a header leaves CRLF everywhere", () => {
  const text = "---\r\npaths: x\r\n---\r\n\r\nIntro.\r\n\r\n# A\r\n\r\nText.\r\n";
  const [intro] = noteCards(text, { frontmatter: true });
  assert.equal(intro!.header, "---\r\npaths: x\r\n---\r\n");
  const section = splitSections(text).find((entry) => entry.key === intro!.key)!;
  const after = replaceSection(text, section, cardRemoval(intro!).text);
  assert.equal(after, "---\r\npaths: x\r\n---\r\n\r\n# A\r\n\r\nText.\r\n");
  assert.doesNotMatch(after, /(^|[^\r])\n/, "no LF-only line");
});

// ------------------------------------------------------------------ #3 wording

test("#3: a failed Claude note says so in plain words, per place", async () => {
  await fresh();
  const index = join(sb.appMemory, "MEMORY.md");
  rmSync(index);
  mkdirSync(index);
  forgetAllFiles();
  const paseo = fakePaseo(sb).api;
  const preview = await notePreview(paseo, { text: "Invoices go out on the 1st.", who: "all", workspaceId: "ws-app" });
  const saved = await noteAdd(paseo, { text: "Invoices go out on the 1st.", who: "all", workspaceId: "ws-app", expected: expectedOf(preview) });
  assert.match(saved.message, /Couldn't save to Claude's notes for app: Claude's list of notes couldn't be updated, so this note was taken back out\./);
  assert.doesNotMatch(saved.message, /0 of 1|see the report/);
});

// ------------------------------------------------------------------ headers with comments

test("a rule header with a # comment and a blank line is still a header, and survives removing the top card", async () => {
  await fresh();
  const { instructionWrite } = await import("../server/instructions");
  const { sha256 } = await import("../server/files");
  const { statSync } = await import("node:fs");
  const header = '---\n# Only for components\npaths:\n\n  - "src/**/*.tsx"\n---\n';
  const text = `${header}\nIntro for components.\n\n# Frontend\n\nUse React.\n`;
  const cards = noteCards(text, { frontmatter: true });
  assert.equal(cards[0]!.header, header, "the comment does not end the header");
  assert.deepEqual(cards.map((card) => card.note.title || card.note.body), ["Intro for components.", "Frontend"]);
  const path = join(sb.claude, "rules", "components.md");
  writeFileSync(path, text);
  forgetAllFiles();
  forgetDiscovery();
  const stamp = () => ({ size: statSync(path).size, mtimeMs: statSync(path).mtimeMs, hash: sha256(readFileSync(path)) });
  const removed = await instructionWrite(fakePaseo(sb).api, { path, expected: stamp(), sectionKey: cards[0]!.key, ...cardRemoval(cards[0]!) });
  assert.equal(removed.ok, true, removed.message);
  assert.equal(readFileSync(path, "utf8"), `${header}\n# Frontend\n\nUse React.\n`);
});
