import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
const { planNote, noteFromSection, sectionReplacement, noteTitle } = await import("../shared/notes");
const { splitSections, sectionText } = await import("../shared/markdown");
const { memoriesSettings, MEMORIES_DEFAULTS } = await import("../shared/settings");

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

// ------------------------------------------------------------------ the mapping (pure)

const HOME = "/home/demo";
const facts = {
  claude: {
    items: [
      { kind: "claude-md", scope: "user", path: `${HOME}/.claude/CLAUDE.md`, when: "launch", access: "editable" },
      { kind: "claude-md", scope: "project", path: `${HOME}/code/acme-web/CLAUDE.md`, when: "launch", access: "editable", versionControlled: true },
      { kind: "claude-auto-memory", scope: "project", path: `${HOME}/.claude/projects/-home-demo-code-acme-web/memory`, when: "missing", access: "editable" },
    ],
  },
  codex: {
    items: [
      { kind: "agents-md", scope: "user", path: `${HOME}/.codex/AGENTS.override.md`, when: "skipped", access: "editable" },
      { kind: "agents-md", scope: "user", path: `${HOME}/.codex/AGENTS.md`, when: "launch", access: "editable" },
      { kind: "agents-md", scope: "project", path: `${HOME}/code/acme-web/AGENTS.md`, when: "launch", access: "editable", versionControlled: true },
      { kind: "codex-memory", scope: "user", path: `${HOME}/.codex/memories/memory_summary.md`, when: "launch", access: "editable" },
    ],
  },
};
const project = { kind: "project" as const, name: "acme-web" };
const everywhere = { kind: "everywhere" as const };

test("add a note: every Who × Where goes only where that agent reads", () => {
  const paths = (who: "all" | "claude" | "codex", where: typeof project | typeof everywhere) => planNote(who, where, facts).targets.map((target) => `${target.agent} ${target.kind} ${target.path}`);
  assert.deepEqual(paths("all", everywhere), [`claude append ${HOME}/.claude/CLAUDE.md`, `codex append ${HOME}/.codex/AGENTS.md`]);
  assert.deepEqual(paths("claude", everywhere), [`claude append ${HOME}/.claude/CLAUDE.md`]);
  assert.deepEqual(paths("codex", everywhere), [`codex append ${HOME}/.codex/AGENTS.md`]);
  assert.deepEqual(paths("all", project), [`claude claude-memory ${HOME}/.claude/projects/-home-demo-code-acme-web/memory`, `codex append ${HOME}/code/acme-web/AGENTS.md`]);
  assert.deepEqual(paths("claude", project), [`claude claude-memory ${HOME}/.claude/projects/-home-demo-code-acme-web/memory`]);
  assert.deepEqual(paths("codex", project), [`codex append ${HOME}/code/acme-web/AGENTS.md`]);
  const all = [...planNote("all", everywhere, facts).targets, ...planNote("all", project, facts).targets];
  assert.ok(all.every((target) => !target.path.includes("memories/") && !target.path.startsWith("paseo:")), "never Codex's generated notes or Paseo's prompt");
  const labels = planNote("all", project, facts).targets.map((target) => target.label);
  assert.deepEqual(labels, ["Claude's notes for acme-web", "Project instructions · acme-web (shared with the team)"]);
  const [claude, codex] = planNote("all", project, facts).targets;
  assert.equal(claude!.private, true);
  assert.equal(claude!.creates, true, "a project with no Claude notes yet starts them");
  assert.equal(codex!.shared, true);
});

test("add a note: the override wins for Codex when it has text; disabled or missing agents are skipped in words", () => {
  const withOverride = { codex: { items: [{ kind: "agents-md", scope: "user", path: `${HOME}/.codex/AGENTS.override.md`, when: "launch", access: "editable" }, { kind: "agents-md", scope: "user", path: `${HOME}/.codex/AGENTS.md`, when: "skipped", access: "editable" }] } };
  assert.equal(planNote("codex", everywhere, withOverride).targets[0]!.path, `${HOME}/.codex/AGENTS.override.md`);
  const off = { claude: { items: [{ kind: "claude-auto-memory", scope: "project", path: "/x/memory", when: "skipped", access: "editable" }] } };
  const plan = planNote("all", project, off);
  assert.equal(plan.targets.length, 0);
  assert.deepEqual(plan.skipped.map((entry) => entry.agent), ["claude", "codex"]);
  assert.match(plan.skipped[0]!.reason, /turned off/);
  const full = { codex: { items: [{ kind: "agents-md", scope: "project", path: "/p/AGENTS.md", when: "skipped", access: "editable" }] } };
  assert.match(planNote("codex", project, full).skipped[0]!.reason, /already as long/);
});

// ------------------------------------------------------------------ server: preview and save

test("add a note everywhere: both user files get it, the rest of each file byte-identical, then it dedupes", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const claudeFile = join(sb.claude, "CLAUDE.md");
  const codexFile = join(sb.codex, "AGENTS.md");
  const before = { claude: readFileSync(claudeFile, "utf8"), codex: readFileSync(codexFile, "utf8") };
  const text = "Use the metric system, always.";
  const preview = await notePreview(paseo, { text, who: "all" });
  assert.deepEqual(preview.targets.map((target) => target.path), [claudeFile, codexFile]);
  assert.deepEqual(preview.targets.map((target) => target.label), ["Your instructions for Claude", "Your instructions for Codex"]);
  assert.ok(preview.targets.every((target) => target.duplicate === "none"));
  const saved = await noteAdd(paseo, { text, who: "all", expected: preview.targets.map((target) => ({ id: target.id, stamp: target.stamp })) });
  assert.equal(saved.ok, true, saved.message);
  assert.match(saved.message, /agents already running won't see it until they restart/);
  for (const [path, was] of [[claudeFile, before.claude], [codexFile, before.codex]] as const) {
    const now = readFileSync(path, "utf8");
    assert.ok(now.startsWith(was), "everything that was there stays byte for byte");
    assert.ok(now.endsWith(`${text}\n`));
  }
  forgetAllFiles();
  forgetDiscovery();
  const again = await notePreview(paseo, { text, who: "all" });
  assert.deepEqual(again.targets.map((target) => target.duplicate), ["exact", "exact"], "a note that is already there is found");
  const second = await noteAdd(paseo, { text, who: "all", expected: again.targets.map((target) => ({ id: target.id, stamp: target.stamp })) });
  assert.equal(second.ok, true);
  assert.match(second.message, /already had this note/);
  assert.equal(readFileSync(claudeFile, "utf8").split("## Use the metric system").length - 1, 1, "not written twice");
});

test("add a note to one project: a private Claude note plus the project's Codex file, with the git warning", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const override = join(sb.app, "AGENTS.override.md");
  const before = readFileSync(override, "utf8");
  const text = "Invoices go out on the 1st of each month.";
  const preview = await notePreview(paseo, { text, who: "all", workspaceId: "ws-app" });
  assert.equal(preview.project, "app");
  assert.deepEqual(preview.targets.map((target) => [target.agent, target.kind, target.path]), [["claude", "claude-memory", sb.appMemory], ["codex", "append", override]]);
  assert.equal(preview.targets[1]!.shared, true);
  assert.deepEqual(preview.targets[1]!.warnings, ["This is shared with your team through git."]);
  const saved = await noteAdd(paseo, { text, who: "all", workspaceId: "ws-app", expected: preview.targets.map((target) => ({ id: target.id, stamp: target.stamp })) });
  assert.equal(saved.ok, true, saved.message);
  assert.ok(saved.warnings.includes("This is shared with your team through git."));
  assert.ok(readFileSync(override, "utf8").startsWith(before));
  const created = readdirSync(sb.appMemory).find((name) => name.startsWith("invoices"));
  assert.ok(created, "a new Claude note file");
  assert.match(readFileSync(join(sb.appMemory, created!), "utf8"), /Invoices go out on the 1st/);
  assert.match(readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8"), new RegExp(created!.replace(".", "\\.")));
});

test("add a note to a project without an AGENTS.md creates it; Claude-only never touches it", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const agents = join(sb.long, "AGENTS.md");
  assert.equal(existsSync(agents), false);
  const onlyClaude = await notePreview(paseo, { text: "Use the staging database for demos.", who: "claude", workspaceId: "ws-long" });
  assert.deepEqual(onlyClaude.targets.map((target) => target.path), [sb.longMemory]);
  const preview = await notePreview(paseo, { text: "Use the staging database for demos.", who: "codex", workspaceId: "ws-long" });
  assert.deepEqual(preview.targets.map((target) => [target.path, target.creates, target.shared]), [[agents, true, false]]);
  const saved = await noteAdd(paseo, { text: "Use the staging database for demos.", who: "codex", workspaceId: "ws-long", expected: preview.targets.map((target) => ({ id: target.id, stamp: target.stamp })) });
  assert.equal(saved.ok, true, saved.message);
  assert.equal(readFileSync(agents, "utf8"), "## Use the staging database for demos\n\nUse the staging database for demos.\n");
});

test("add a note follows the account Paseo's Claude provider uses (its own config folder)", async () => {
  await fresh();
  const paseo = fakePaseo(sb, { providers: { claude: { env: { CLAUDE_CONFIG_DIR: sb.slot.claude } } } }).api;
  const preview = await notePreview(paseo, { text: "Reply in one paragraph.", who: "claude" });
  assert.deepEqual(preview.targets.map((target) => target.path), [join(sb.slot.claude, "CLAUDE.md")]);
  assert.match(preview.targets[0]!.label, /^Your instructions for Claude · slot@example\.com$/);
});

test("add a note refuses when the places changed since the preview, and warns about secrets", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const secret = await notePreview(paseo, { text: "Deploy with token ghp_abcdefghijklmnopqrstuvwxyz0123456789", who: "claude" });
  assert.equal(secret.warnings.length, 1);
  assert.match(secret.warnings[0]!, /password or key/);
  const refused = await noteAdd(paseo, { text: "Keep it short.", who: "all", expected: [{ id: join(sb.claude, "CLAUDE.md"), stamp: stampOf(join(sb.claude, "CLAUDE.md")) }] });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /changed since you checked it/);
  const user = join(sb.claude, "CLAUDE.md");
  const preview = await notePreview(paseo, { text: "Keep it short, please.", who: "claude" });
  writeFileSync(user, `${readFileSync(user, "utf8")}\nChanged meanwhile.\n`);
  forgetAllFiles();
  const stale = await noteAdd(paseo, { text: "Keep it short, please.", who: "claude", expected: preview.targets.map((target) => ({ id: target.id, stamp: target.stamp })) });
  assert.equal(stale.ok, false, "the stale-write guard still applies");
  assert.ok(!readFileSync(user, "utf8").includes("Keep it short, please."));
});

// ------------------------------------------------------------------ note cards: change, remove, add

const FILE = "# Team notes\n\nIntro line.\n\n## Style\n\nShort sentences.\n\n## Tools\n\nUse the shared calendar.\n\n## Last\n\nThe end.\n";

test("note cards: change one note keeps the rest of the file byte-identical", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const path = join(sb.claude, "CLAUDE.md");
  writeFileSync(path, FILE);
  forgetAllFiles();
  const sections = splitSections(FILE);
  const style = sections.find((section) => section.title === "Style")!;
  const original = sectionText(FILE, style);
  assert.deepEqual(noteFromSection(original, false), { title: "Style", body: "Short sentences.", level: 2, headless: false });
  assert.equal(sectionReplacement(original, { title: "Style", body: "Short sentences." }, false).slice(0, -1), original, "unchanged note: same bytes");
  const text = sectionReplacement(original, { title: "Style", body: "Short sentences.\nNo jargon." }, false);
  const result = await instructionWrite(paseo, { path, text, expected: stampOf(path), sectionKey: style.key });
  assert.equal(result.ok, true, result.message);
  assert.equal(readFileSync(path, "utf8"), FILE.replace("Short sentences.\n", "Short sentences.\nNo jargon.\n"));
  const renamed = sectionReplacement(sectionText(readFileSync(path, "utf8"), splitSections(readFileSync(path, "utf8")).find((section) => section.title === "Style")!), { title: "Writing style", body: "Short sentences.\nNo jargon." }, false);
  const again = await instructionWrite(paseo, { path, text: renamed, expected: stampOf(path), sectionKey: style.key });
  assert.equal(again.ok, true, again.message);
  assert.equal(readFileSync(path, "utf8"), FILE.replace("## Style\n\nShort sentences.\n", "## Writing style\n\nShort sentences.\nNo jargon.\n"));
});

test("note cards: remove a note from the middle or the end; the text above the first heading is a note too", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const path = join(sb.claude, "CLAUDE.md");
  writeFileSync(path, FILE);
  forgetAllFiles();
  const key = (title: string) => splitSections(readFileSync(path, "utf8")).find((section) => section.title === title)!.key;
  const middle = await instructionWrite(paseo, { path, text: "", expected: stampOf(path), sectionKey: key("Tools"), removeSection: true });
  assert.equal(middle.ok, true, middle.message);
  assert.equal(readFileSync(path, "utf8"), FILE.replace("## Tools\n\nUse the shared calendar.\n\n", ""));
  const last = await instructionWrite(paseo, { path, text: "", expected: stampOf(path), sectionKey: key("Last"), removeSection: true });
  assert.equal(last.ok, true, last.message);
  assert.equal(readFileSync(path, "utf8"), "# Team notes\n\nIntro line.\n\n## Style\n\nShort sentences.\n");
  const noKey = await instructionWrite(paseo, { path, text: "", expected: stampOf(path), removeSection: true });
  assert.equal(noKey.ok, false, "removing needs a section");

  const headless = "Top line.\n\n## One\n\nText.\n";
  const top = splitSections(headless)[0]!;
  assert.equal(top.key, "0:");
  const note = noteFromSection(sectionText(headless, top), true);
  assert.equal(note.body, "Top line.");
  writeFileSync(path, headless);
  forgetAllFiles();
  const changed = await instructionWrite(paseo, { path, text: sectionReplacement(sectionText(headless, top), { title: "", body: "New top line." }, true), expected: stampOf(path), sectionKey: "0:" });
  assert.equal(changed.ok, true, changed.message);
  assert.equal(readFileSync(path, "utf8"), "New top line.\n\n## One\n\nText.\n");
});

test("note titles are short and plain", () => {
  assert.equal(noteTitle("Use the metric system."), "Use the metric system");
  assert.equal(noteTitle("Invoices go out on the first business day of every single month without fail"), "Invoices go out on the first business day…");
  assert.equal(noteTitle("\n\n- Use the shared calendar"), "Use the shared calendar");
  assert.equal(noteTitle("   "), "Note");
});

// ------------------------------------------------------------------ the setting

test("technicalDetails defaults to off, and a settings file from 0.1 still loads", async () => {
  await fresh();
  assert.equal(MEMORIES_DEFAULTS.technicalDetails, false);
  assert.equal(memoriesSettings.version, 1);
  const dir = join(sb.paseoHome, "plugin-settings", "paseo-memories");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memories.json"), JSON.stringify({ version: 1, values: { showOtherAgents: false, staleChecks: true, maskSecrets: true, codexEdits: true, backupsToKeep: 50 } }));
  forgetAllFiles();
  const settings = await readMemoriesSettings();
  assert.equal(settings.showOtherAgents, false, "the old values are kept");
  assert.equal(settings.backupsToKeep, 50);
  assert.equal(settings.technicalDetails, false);
  writeFileSync(join(dir, "memories.json"), JSON.stringify({ version: 1, values: { technicalDetails: true } }));
  forgetAllFiles();
  assert.equal((await readMemoriesSettings()).technicalDetails, true);
});
