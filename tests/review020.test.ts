/**
 * Regression tests for the 0.2.0 review (memories-research/review-020.md),
 * one or more per finding. Each failed before its fix.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { fakePaseo, makeSandbox, violations, type Sandbox } from "./helpers";

let sb: Sandbox = await makeSandbox();
const { forgetAllFiles, sha256 } = await import("../server/files");
const { forgetDiscovery } = await import("../server/discover");
const { resetDaemonCache } = await import("../server/daemon");
const { notePreview, noteAdd } = await import("../server/add-note");
const { instructionWrite } = await import("../server/instructions");
const { readMemoriesSettings } = await import("../server/settings");
const { planNote, noteCards, cardReplacement, cardRemoval, planCardAdd, noteFromSection, sectionReplacement } = await import("../shared/notes");
const { splitSections, sectionText, removeSection, replaceSection } = await import("../shared/markdown");
const { plainReadOnly } = await import("../shared/plain");
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

const expectedOf = (preview: { targets: Array<{ id: string; stamp: { size: number; mtimeMs: number; hash?: string } | null }> }) => preview.targets.map((target) => ({ id: target.id, stamp: target.stamp }));

// ------------------------------------------------------------------ 1. read limits

test("review 1: a Codex note past the 32 KiB project budget is not saved, and the preview says so", async () => {
  await fresh();
  const paseo = fakePaseo(sb, { extra: [{ id: "ws-big", path: sb.big }] }).api;
  const file = join(sb.big, "AGENTS.md");
  const before = readFileSync(file, "utf8");
  assert.ok(before.length > 32 * 1024, "the fixture is already past the budget");
  const preview = await notePreview(paseo, { text: "Ship on Tuesdays.", who: "codex", workspaceId: "ws-big" });
  assert.equal(preview.targets.length, 1);
  assert.match(preview.targets[0]!.blocked ?? "", /Codex only reads the start of this project's instructions/);
  const saved = await noteAdd(paseo, { text: "Ship on Tuesdays.", who: "codex", workspaceId: "ws-big", expected: expectedOf(preview) });
  assert.equal(saved.ok, false);
  assert.doesNotMatch(saved.message, /^Saved/);
  assert.equal(readFileSync(file, "utf8"), before, "nothing written");
});

test("review 1: a Codex note that would cross the budget (file not cut yet) is not saved either", async () => {
  await fresh();
  const near = join(sb.home, "code", "near");
  mkdirSync(join(near, ".git"), { recursive: true });
  writeFileSync(join(near, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(near, "AGENTS.md"), `# Rules\n\n${"x".repeat(32_700)}\n`);
  forgetAllFiles();
  const paseo = fakePaseo(sb, { extra: [{ id: "ws-near", path: near }] }).api;
  const preview = await notePreview(paseo, { text: "A note that lands past the cut.", who: "codex", workspaceId: "ws-near" });
  assert.match(preview.targets[0]!.blocked ?? "", /Shorten them first/);
});

test("review 1: a Claude note whose list line would land past line 200 is not saved", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const index = join(sb.appMemory, "MEMORY.md");
  writeFileSync(index, `${readFileSync(index, "utf8")}${Array.from({ length: 210 }, (_, n) => `- [Filler ${n}](filler_${n}.md) — filler`).join("\n")}\n`);
  forgetAllFiles();
  const names = readdirSync(sb.appMemory).sort();
  const preview = await notePreview(paseo, { text: "Invoices go out on the 1st.", who: "claude", workspaceId: "ws-app" });
  assert.match(preview.targets[0]!.blocked ?? "", /Claude's list of notes for this project is full/);
  const saved = await noteAdd(paseo, { text: "Invoices go out on the 1st.", who: "claude", workspaceId: "ws-app", expected: expectedOf(preview) });
  assert.equal(saved.ok, false);
  assert.deepEqual(readdirSync(sb.appMemory).sort(), names, "no new note file");
});

test("review 1: with one target blocked, the other is still saved and the message names both", async () => {
  await fresh();
  const index = join(sb.appMemory, "MEMORY.md");
  writeFileSync(index, `${Array.from({ length: 205 }, (_, n) => `- [Filler ${n}](filler_${n}.md) — filler`).join("\n")}\n`);
  forgetAllFiles();
  const paseo = fakePaseo(sb).api;
  const override = join(sb.app, "AGENTS.override.md");
  const preview = await notePreview(paseo, { text: "Invoices go out on the 1st.", who: "all", workspaceId: "ws-app" });
  assert.equal(preview.targets.filter((target) => target.blocked).length, 1);
  const saved = await noteAdd(paseo, { text: "Invoices go out on the 1st.", who: "all", workspaceId: "ws-app", expected: expectedOf(preview) });
  assert.match(readFileSync(override, "utf8"), /Invoices go out on the 1st\./);
  assert.match(saved.message, /Saved to Project instructions · app \(shared with the team\)\./);
  assert.match(saved.message, /Couldn't save to Claude's notes for app: Claude's list of notes for this project is full/);
});

// ------------------------------------------------------------------ 2. dedupe

test("review 2: a note that differs only in punctuation is a near match, still saved", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const file = join(sb.codex, "AGENTS.md");
  const first = await notePreview(paseo, { text: "Node must be >= 18.", who: "codex" });
  assert.equal((await noteAdd(paseo, { text: "Node must be >= 18.", who: "codex", expected: expectedOf(first) })).ok, true);
  forgetAllFiles();
  forgetDiscovery();
  const second = await notePreview(paseo, { text: "Node must be <= 18.", who: "codex" });
  assert.equal(second.targets[0]!.duplicate, "near", "not 'already there'");
  const saved = await noteAdd(paseo, { text: "Node must be <= 18.", who: "codex", expected: expectedOf(second) });
  assert.equal(saved.ok, true, saved.message);
  assert.match(readFileSync(file, "utf8"), /Node must be <= 18\./);
  forgetAllFiles();
  forgetDiscovery();
  const same = await notePreview(paseo, { text: "  Node must be <= 18.\r\n", who: "codex" });
  assert.equal(same.targets[0]!.duplicate, "exact", "identical after trimming and line endings");
});

// ------------------------------------------------------------------ 3. per-target saves and rollback

test("review 3: a failed list update rolls the Claude note back, and the Codex target is still tried", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const index = join(sb.appMemory, "MEMORY.md");
  rmSync(index);
  mkdirSync(index);
  forgetAllFiles();
  const names = readdirSync(sb.appMemory).sort();
  const override = join(sb.app, "AGENTS.override.md");
  const preview = await notePreview(paseo, { text: "Invoices go out on the 1st.", who: "all", workspaceId: "ws-app" });
  const saved = await noteAdd(paseo, { text: "Invoices go out on the 1st.", who: "all", workspaceId: "ws-app", expected: expectedOf(preview) });
  assert.equal(saved.ok, false);
  assert.match(saved.message, /Saved to Project instructions · app/);
  assert.match(saved.message, /Couldn't save to Claude's notes for app/);
  assert.deepEqual(readdirSync(sb.appMemory).sort(), names, "the unlisted note file was removed");
  assert.match(readFileSync(override, "utf8"), /Invoices go out on the 1st\./);
});

test("review 3: a Claude note file that isn't in the list doesn't count as already there", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  writeFileSync(join(sb.appMemory, "orphan.md"), "---\nname: Orphan\ndescription: x\ntype: project\n---\n\nInvoices go out on the 1st.\n");
  forgetAllFiles();
  forgetDiscovery();
  const preview = await notePreview(paseo, { text: "Invoices go out on the 1st.", who: "claude", workspaceId: "ws-app" });
  assert.notEqual(preview.targets[0]!.duplicate, "exact");
});

// ------------------------------------------------------------------ 4. masked dots

test("review 4: Add a note refuses text with hidden characters, in plain words", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const text = `Deploy with ghp_${MASK_FILL}`;
  await assert.rejects(() => notePreview(paseo, { text, who: "claude" }), /hidden characters \(••••\)\. Press Show on the original note/);
  const refused = await noteAdd(paseo, { text, who: "claude", expected: [] });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /hidden characters/);
  assert.ok(!readFileSync(join(sb.claude, "CLAUDE.md"), "utf8").includes(MASK_FILL));
});

test("review 4: card saves refuse hidden characters before writing", () => {
  const plan = planCardAdd({ text: `Token ${MASK_FILL}`, seen: { size: 1, mtimeMs: 1 }, preview: { duplicate: "none" } });
  assert.ok("skip" in plan && /hidden characters/.test(plan.skip));
});

// ------------------------------------------------------------------ 5. headers are never cards

const FM = { frontmatter: true };
const RULE = '---\npaths:\n  - "src/**/*.tsx"\n---\n\nIntro for components.\n\n# Frontend\n\nUse React.\n';
const COPILOT = "---\napplyTo: \"**/*.go\"\n---\n# Go\n\nUse gofmt.\n\n## Tests\n\nTable tests.\n";

test("review 5: a rule's paths: header and Copilot's applyTo: are never a card", () => {
  assert.deepEqual(noteCards(RULE, FM).map((card) => card.note.title || card.note.body), ["Intro for components.", "Frontend"]);
  assert.deepEqual(noteCards(COPILOT, FM).map((card) => card.note.title), ["Go", "Tests"]);
  assert.deepEqual(noteCards("---\npaths: x\n---\n# Only\n\nText.\n", FM).map((card) => card.note.title), ["Only"]);
});

test("review 5: every card action keeps the header byte for byte", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const path = join(sb.claude, "rules", "front.md");
  writeFileSync(path, RULE);
  forgetAllFiles();
  forgetDiscovery();
  const header = '---\npaths:\n  - "src/**/*.tsx"\n---\n';
  const [intro] = noteCards(RULE, FM);
  const edited = await instructionWrite(paseo, { path, text: cardReplacement(intro!, { title: "", body: "New intro." }), expected: stampOf(path), sectionKey: intro!.key });
  assert.equal(edited.ok, true, edited.message);
  assert.ok(readFileSync(path, "utf8").startsWith(`${header}\nNew intro.\n`));
  const now = readFileSync(path, "utf8");
  const removal = cardRemoval(noteCards(now, FM)[0]!);
  const removed = await instructionWrite(paseo, { path, expected: stampOf(path), sectionKey: noteCards(now, FM)[0]!.key, ...removal });
  assert.equal(removed.ok, true, removed.message);
  assert.ok(readFileSync(path, "utf8").startsWith(header), "header kept after removing the intro card");
  assert.deepEqual(noteCards(readFileSync(path, "utf8"), FM).map((card) => card.note.title), ["Frontend"]);
  const copilot = join(sb.home, ".copilot", "instructions", "go.instructions.md");
  writeFileSync(copilot, COPILOT);
  forgetAllFiles();
  forgetDiscovery();
  const go = noteCards(COPILOT, FM)[0]!;
  const changed = await instructionWrite(paseo, { path: copilot, text: cardReplacement(go, { title: "Go", body: "Use gofmt and vet." }), expected: stampOf(copilot), sectionKey: go.key });
  assert.equal(changed.ok, true, changed.message);
  assert.equal(readFileSync(copilot, "utf8"), COPILOT.replace("Use gofmt.", "Use gofmt and vet."));
  const goNow = noteCards(readFileSync(copilot, "utf8"), FM)[0]!;
  const gone = await instructionWrite(paseo, { path: copilot, expected: stampOf(copilot), sectionKey: goNow.key, ...cardRemoval(goNow) });
  assert.equal(gone.ok, true, gone.message);
  assert.ok(readFileSync(copilot, "utf8").startsWith('---\napplyTo: "**/*.go"\n---\n'));
});

// ------------------------------------------------------------------ 6. card Add a note

test("review 6: a card's Add a note uses the stamp the user saw and honours an identical note", () => {
  const seen = { size: 10, mtimeMs: 5, hash: "a" };
  const plan = planCardAdd({ text: "New rule.", seen, preview: { duplicate: "none" } });
  assert.ok("expected" in plan);
  assert.deepEqual(plan.expected, seen, "the file as the user saw it, so a newer file is refused");
  const same = planCardAdd({ text: "New rule.", seen, preview: { duplicate: "exact", duplicateOf: "Rules", identical: true } });
  assert.ok("skip" in same && /already there/.test(same.skip));
  const near = planCardAdd({ text: "New rule!", seen, preview: { duplicate: "near", duplicateOf: "Rules" } });
  assert.ok("expected" in near && /almost the same/.test(near.warning ?? ""));
});

test("review 6: the stale-write guard fires when the file changed after the user saw it", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const { importApply } = await import("../server/transfer");
  const path = join(sb.claude, "CLAUDE.md");
  const seen = stampOf(path);
  writeFileSync(path, `${readFileSync(path, "utf8")}\nChanged elsewhere.\n`);
  forgetAllFiles();
  const plan = planCardAdd({ text: "New rule.", seen, preview: { duplicate: "none" } });
  assert.ok("expected" in plan);
  const result = await importApply(paseo, { items: [{ id: "new", title: "New rule", body: "New rule.", masked: false, format: "note", warnings: [] }], target: { kind: "append", path }, selected: ["new"], expected: plan.expected });
  assert.equal(result.ok, false);
});

// ------------------------------------------------------------------ 7. settings per field

test("review 7: one bad settings value resets only that field", async () => {
  await fresh();
  const dir = join(sb.paseoHome, "plugin-settings", "paseo-memories");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memories.json"), JSON.stringify({ version: 1, values: { codexEdits: false, maskSecrets: false, technicalDetails: "yes", backupsToKeep: 50 } }));
  forgetAllFiles();
  const settings = await readMemoriesSettings();
  assert.equal(settings.technicalDetails, false, "the bad field takes its default");
  assert.equal(settings.codexEdits, false, "good fields are kept");
  assert.equal(settings.maskSecrets, false);
  assert.equal(settings.backupsToKeep, 50);
  writeFileSync(join(dir, "memories.json"), JSON.stringify({ version: 2, values: { codexEdits: false } }));
  forgetAllFiles();
  assert.equal((await readMemoriesSettings()).codexEdits, true, "another version is still ignored whole");
});

// ------------------------------------------------------------------ 8. CRLF

test("review 8: card edits and removing the last card keep CRLF line endings", () => {
  const text = "# A\r\n\r\nOne.\r\n\r\n## B\r\n\r\nTwo.\r\n";
  const [a, b] = splitSections(text);
  const original = sectionText(text, a!);
  assert.equal(replaceSection(text, a!, sectionReplacement(original, noteFromSection(original, false), false)), text, "unchanged save: same bytes");
  const edited = replaceSection(text, a!, sectionReplacement(original, { title: "A", body: "One.\nMore." }, false));
  assert.equal(edited, "# A\r\n\r\nOne.\r\nMore.\r\n\r\n## B\r\n\r\nTwo.\r\n");
  assert.equal(removeSection(text, b!), "# A\r\n\r\nOne.\r\n");
});

// ------------------------------------------------------------------ 9. indentation and hard breaks

test("review 9: card edits keep the first line's indentation and trailing double spaces", () => {
  const text = "## Code\n\n    code block line\nline two  \n\n## Next\n\nX.\n";
  const [code] = splitSections(text);
  const original = sectionText(text, code!);
  const note = noteFromSection(original, false);
  assert.equal(note.body, "    code block line\nline two  ");
  assert.equal(replaceSection(text, code!, sectionReplacement(original, note, false)), text);
});

// ------------------------------------------------------------------ 10. "Only you see this one"

test("review 10: your own instructions in a git folder are not called private", async () => {
  const facts = { claude: { items: [{ kind: "claude-md", scope: "user", path: "/h/.claude/CLAUDE.md", when: "launch", access: "editable", versionControlled: true }] } };
  const [target] = planNote("claude", { kind: "everywhere" }, facts).targets;
  assert.equal(target!.private, false);
  assert.equal(target!.shared, true);
  await fresh();
  mkdirSync(join(sb.claude, ".git"), { recursive: true });
  writeFileSync(join(sb.claude, ".git", "HEAD"), "ref: refs/heads/main\n");
  forgetAllFiles();
  forgetDiscovery();
  const preview = await notePreview(fakePaseo(sb).api, { text: "Keep it short.", who: "claude" });
  assert.equal(preview.targets[0]!.private, false);
  assert.deepEqual(preview.targets[0]!.warnings, ["Everyone who works on this project will see this note."]);
});

// ------------------------------------------------------------------ 11. read-only reasons

test("review 11: plain mode keeps the host's reason when there is no plain one", () => {
  assert.equal(plainReadOnly({ kind: "claude-md", access: "read-only", reason: "Inside a folder this plugin never writes to (node_modules)." }), "Inside a folder this plugin never writes to (node_modules).");
  assert.equal(plainReadOnly({ kind: "claude-managed", access: "read-only", reason: "Managed by your organisation; Claude Code cannot exclude it." }), "Your organisation sets this, so it can't be changed here.");
  assert.equal(plainReadOnly({ kind: "claude-md", access: "read-only" }), "This can't be changed here.");
});

void existsSync;
