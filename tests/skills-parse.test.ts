/**
 * The pure skills pieces: SKILL.md headers and checks, names in any
 * spelling, GitHub links, the npx skills lock file, Codex's switches in
 * config.toml, file kinds, plan hashes, and reading skill uses out of chat
 * log lines shaped like the real ones (checked on 2026-10-04).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { codexSkillEnabled, readSkillSwitches, setSkillEnabled, unsafeReason } from "../shared/codex-skills-toml";
import { parseGithubLink } from "../shared/github-link";
import { readLock, serializeLock, withEntry, withoutEntry } from "../shared/skill-lock";
import { cleanText, cutText, fileKind, planHash, safeRelativePath } from "../shared/skill-files";
import { buildSkillMd, claudeBudgetChars, claudeContextTokens, claudeListingChars, nameKey, parseSkillMd, skillNameOk, skillProblems, suggestName } from "../shared/skill-md";
import { CATALOG, catalogName } from "../shared/skills-catalog";
import { addUse, claudeUsesInLine, codexLine, dayOf, summarizeUsage, type LogTally } from "../shared/skill-usage";
import { claudeCommandLine, claudeSkillLine, codexListingLine, codexMetaLine, codexReadLine, codexSkillBlockLine, codexTurnLine, skillMd } from "./skills-helpers";

test("SKILL.md headers: plain, quoted, folded and broken", () => {
  const plain = parseSkillMd(skillMd("alpha", "Plans the work.", "Body\n\n\n", "when_to_use: before coding\ndisable-model-invocation: true\n"));
  assert.equal(plain.name, "alpha");
  assert.equal(plain.description, "Plans the work.");
  assert.equal(plain.whenToUse, "before coding");
  assert.equal(plain.disableModelInvocation, true);
  assert.equal(plain.bodyLines, 2);
  const folded = parseSkillMd("---\nname: x\ndescription: >\n  one\n  two\nmetadata:\n  nested: true\n---\nBody");
  assert.equal(folded.description, "one two");
  assert.equal(folded.headerBroken, false);
  assert.equal(parseSkillMd("No header\n").hasHeader, false);
  assert.equal(parseSkillMd("---\nname: x\nthis is not yaml\n---\n").headerBroken, true);
  assert.equal(parseSkillMd("---\nname: x\n").hasHeader, false, "an unclosed header is no header");
});

test("the spec's checks, in plain sentences", () => {
  const codes = (text: string, folder: string) => skillProblems(parseSkillMd(text), folder).map((problem) => problem.code);
  assert.deepEqual(codes(skillMd("alpha", "Fine."), "alpha"), []);
  assert.deepEqual(codes("Just text\n", "x"), ["no-header"]);
  assert.deepEqual(codes(skillMd("other", "Fine."), "alpha"), ["name-differs"]);
  assert.deepEqual(codes(skillMd("Bad_Name", "Fine."), "Bad_Name"), ["name-invalid"]);
  assert.deepEqual(codes("---\nname: a\n---\n", "a"), ["no-description"]);
  assert.ok(codes(skillMd("a", "x".repeat(1100)), "a").includes("description-too-long"));
  assert.ok(codes(skillMd("a", "x".repeat(1600)), "a").includes("listing-cut-claude"));
  assert.ok(codes(skillMd("a", "Fine.", "line\n".repeat(600)), "a").includes("body-long"));
  for (const problem of skillProblems(parseSkillMd("Just text\n"), "x")) assert.ok(problem.message.endsWith("."));
});

test("names: the spec's rule, any spelling, and suggestions", () => {
  assert.ok(skillNameOk("weekly-report"));
  for (const bad of ["", "-a", "a-", "a--b", "A", "a_b", "x".repeat(65)]) assert.equal(skillNameOk(bad), false, bad);
  assert.equal(nameKey("My_Skill"), nameKey("my-skill"));
  assert.equal(nameKey("my.skill"), nameKey("MYSKILL"));
  assert.equal(suggestName("  Weekly Report!! "), "weekly-report");
  assert.equal(claudeListingChars("a", { description: "abc" }), 1 + 3 + 4);
  assert.equal(claudeListingChars("a", { description: "abc", disableModelInvocation: true }), 0);
  assert.equal(claudeListingChars("a", { description: "abc" }, "name-only"), 5);
  assert.equal(claudeListingChars("a", { description: "x".repeat(5000) }), 1 + 1536 + 4);
  const built = buildSkillMd("weekly-report", "When it's  Friday\nafternoon", "Steps.\r\n");
  assert.equal(parseSkillMd(built).description, "When it's Friday afternoon");
  assert.equal(skillProblems(parseSkillMd(built), "weekly-report").length, 0);
});

test("GitHub links: the shapes people paste, and refusals", () => {
  assert.deepEqual(parseGithubLink("acme/skills"), { owner: "acme", repo: "skills" });
  assert.deepEqual(parseGithubLink("acme/skills/skills/alpha@v2"), { owner: "acme", repo: "skills", ref: "v2", path: "skills/alpha" });
  assert.deepEqual(parseGithubLink("https://github.com/acme/skills/tree/main/skills/alpha"), { owner: "acme", repo: "skills", ref: "main", path: "skills/alpha" });
  assert.deepEqual(parseGithubLink("https://github.com/acme/skills/blob/main/skills/alpha/SKILL.md"), { owner: "acme", repo: "skills", ref: "main", path: "skills/alpha" });
  assert.deepEqual(parseGithubLink("http://github.com/acme/skills.git"), { owner: "acme", repo: "skills" });
  for (const bad of ["", "https://gitlab.com/a/b", "acme", "acme/skills/../x", "https://github.com/acme/skills/issues/3", "acme/skills@..", "a b/c"]) assert.ok("error" in parseGithubLink(bad), bad);
});

test("the lock file: v3 kept as it is, other versions never rewritten", () => {
  const text = JSON.stringify({ version: 3, skills: { a: { source: "o/r", sourceType: "github", sourceUrl: "u", skillFolderHash: "h", installedAt: "t0", updatedAt: "t0", pluginName: "p" } }, dismissed: { findSkillsPrompt: true }, lastSelectedAgents: ["codex"] }, null, 2);
  const read = readLock(text);
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.equal(serializeLock(read.lock), text, "round trip byte for byte");
  const added = withEntry(read.lock, "b", { source: "o/r", sourceType: "github", sourceUrl: "u", skillFolderHash: "h2", installedAt: "t1", updatedAt: "t1" });
  assert.deepEqual(Object.keys(added.skills), ["a", "b"]);
  assert.deepEqual(added.dismissed, { findSkillsPrompt: true });
  assert.equal(withEntry(added, "a", { ...added.skills.a!, skillFolderHash: "h3", installedAt: "t9", updatedAt: "t9" }).skills.a!.installedAt, "t0", "first install time kept");
  assert.equal(withEntry(added, "a", { ...added.skills.a!, updatedAt: "t9" }).skills.a!.pluginName, "p", "unknown entry keys kept");
  assert.deepEqual(Object.keys(withoutEntry(added, "a").skills), ["b"]);
  assert.equal(readLock(null).ok, true);
  for (const bad of ["{", "[]", JSON.stringify({ version: 2, skills: {} }), JSON.stringify({ version: 3 })]) assert.equal(readLock(bad).ok, false, bad);
});

test("Codex switches: off, on and back, every other byte kept", () => {
  const original = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "home", ".codex", "config.toml"), "utf8");
  const off = setSkillEnabled(original, "alpha", false);
  assert.ok("text" in off);
  if (!("text" in off)) return;
  assert.ok(off.text.startsWith(original.trimEnd()), "appended, nothing above changed");
  assert.equal(codexSkillEnabled(off.text, "alpha"), false);
  assert.equal(codexSkillEnabled(off.text, "beta"), true);
  assert.deepEqual(setSkillEnabled(off.text, "alpha", false), { text: off.text }, "already off: unchanged");
  const on = setSkillEnabled(off.text, "alpha", true);
  assert.ok("text" in on);
  if ("text" in on) assert.equal(on.text.trimEnd(), original.trimEnd(), "our own block taken out again");
  // A block the user wrote with more in it is switched, not removed.
  const theirs = `${original}\n[[skills.config]]\npath = "/x/alpha/SKILL.md"\n\n[[skills.config]]\nname = "alpha" # mine\nenabled = false\nnote = "keep"\n`;
  const back = setSkillEnabled(theirs, "alpha", true);
  assert.ok("text" in back);
  if ("text" in back) {
    assert.match(back.text, /name = "alpha" # mine\nenabled = true\nnote = "keep"/);
    assert.equal(readSkillSwitches(back.text).length, 2);
  }
  // CRLF files stay CRLF.
  const crlf = setSkillEnabled("model = \"x\"\r\n", "a", false);
  assert.ok("text" in crlf && crlf.text === 'model = "x"\r\n\r\n[[skills.config]]\r\nname = "a"\r\nenabled = false\r\n');
  // Shapes that can't take a block safely are refused.
  for (const unsafe of ['skills = { config = [] }\n', '[skills]\nconfig = [{ name = "a", enabled = false }]\n', 'skills.config = []\n', '[skills.config]\nname = "a"\n']) {
    assert.ok(unsafeReason(unsafe), unsafe);
    assert.ok("error" in setSkillEnabled(unsafe, "a", false), unsafe);
  }
  assert.equal(unsafeReason('[skills]\ninclude_instructions = true\n[[skills.config]]\nname = "a"\nenabled = false\n'), null);
  assert.equal(unsafeReason('x = """\nskills = {}\n"""\n'), null, "inside a multi-line string is not a key");
  assert.equal(codexSkillEnabled('[[skills.config]]\npath = "/p/SKILL.md"\nenabled = false\n', "a", "/p/SKILL.md"), false, "by path");
});

test("file kinds, safe paths, plan hashes and cleaned text", () => {
  assert.equal(fileKind("SKILL.md", false, null), "instructions");
  assert.equal(fileKind("LICENSE", false, null), "instructions");
  assert.equal(fileKind("LICENSE.txt", false, null), "instructions");
  assert.equal(fileKind("notes.md", true, null), "script", "executable bit");
  assert.equal(fileKind("tool", false, Buffer.from("#!")), "script", "shebang");
  assert.equal(fileKind("metadata.json", false, null), "script", "anything else may be run");
  assert.equal(fileKind("helper.py", false, null), "script");
  assert.ok(safeRelativePath("scripts/run.sh"));
  for (const bad of ["../x", "/abs", "a//b", "a/./b", "a\\b", ".git/config/x"]) assert.equal(safeRelativePath(bad), false, bad);
  const files = [{ path: "SKILL.md", bytes: 3, kind: "instructions" as const, executable: false, sha256: "h" }];
  const base = planHash({ source: "s", commit: "c", name: "n", files, targets: ["canonical:/a"] });
  assert.equal(base, planHash({ source: "s", commit: "c", name: "n", files, targets: ["canonical:/a"] }));
  assert.notEqual(base, planHash({ source: "s", commit: "c", name: "n", files: [{ ...files[0]!, sha256: "h2" }], targets: ["canonical:/a"] }));
  assert.notEqual(base, planHash({ source: "s", commit: "c", name: "n", files, targets: ["canonical:/a", "link:/b"] }));
  assert.equal(cleanText("A‮B​\nC"), "AB C");
  assert.equal(cutText("abcdef", 4), "abc…");
});

test("the curated list is pinned and consistent", () => {
  assert.ok(CATALOG.length >= 6 && CATALOG.length <= 10);
  const ids = new Set<string>();
  for (const entry of CATALOG) {
    assert.match(entry.commit, /^[0-9a-f]{40}$/);
    assert.match(entry.tree, /^[0-9a-f]{40}$/);
    assert.ok(skillNameOk(catalogName(entry)), entry.id);
    assert.equal(entry.id, catalogName(entry));
    assert.ok(!ids.has(entry.id));
    ids.add(entry.id);
  }
  assert.deepEqual(CATALOG.filter((entry) => entry.scripts).map((entry) => entry.id).sort(), ["systematic-debugging", "webapp-testing"]);
});

test("Claude log lines: the model's Skill calls and typed /commands", () => {
  const use = claudeUsesInLine(claudeSkillLine("alpha", "2026-10-01T10:00:00.000Z", "s1", "/w/app"));
  assert.deepEqual(use, { uses: [{ at: Date.parse("2026-10-01T10:00:00.000Z"), skill: "alpha", typed: false }], cwd: "/w/app", sessionId: "s1" });
  assert.equal(claudeUsesInLine(claudeCommandLine("beta", "2026-10-01T10:00:00.000Z", "s1", "/w"))!.uses[0]!.typed, true);
  assert.equal(claudeUsesInLine(claudeCommandLine("beta", "2026-10-01T10:00:00.000Z", "s1", "/w", true))!.uses[0]!.skill, "beta");
  assert.equal(claudeUsesInLine('{"type":"user","isMeta":true,"message":{"content":"<command-name>/x</command-name>"},"timestamp":"2026-10-01T00:00:00Z"}'), null, "meta lines are the skill's own text");
  assert.equal(claudeUsesInLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"skill":"x"}}]},"timestamp":"2026-10-01T00:00:00Z"} "Skill"'), null);
  assert.equal(claudeUsesInLine('{"type":"assistant", "Skill" truncated'), null, "a cut line is skipped");
  assert.equal(claudeUsesInLine(claudeSkillLine("bad name", "2026-10-01T10:00:00.000Z", "s", "/w")), null);
});

test("Codex log lines: meta, turns, <skill> blocks and SKILL.md reads", () => {
  assert.deepEqual(codexLine(codexMetaLine("th-1", "/w/app", "2026-10-01T10:00:00Z")), { kind: "meta", cwd: "/w/app", threadId: "th-1" });
  assert.deepEqual(codexLine(codexTurnLine("/w/app", "2026-10-01T10:00:00Z")), { kind: "turn", cwd: "/w/app" });
  assert.deepEqual(codexLine(codexSkillBlockLine("alpha", "2026-10-01T10:00:00Z")), { kind: "uses", at: Date.parse("2026-10-01T10:00:00Z"), skills: ["alpha"], typed: true });
  assert.deepEqual((codexLine(codexReadLine("beta", "2026-10-01T10:00:00Z")) as { skills: string[] }).skills, ["beta"]);
  assert.deepEqual((codexLine(codexReadLine("legacy-x", "2026-10-01T10:00:00Z", "custom_tool_call")) as { skills: string[] }).skills, ["legacy-x"]);
  assert.equal(codexLine(codexListingLine("2026-10-01T10:00:00Z")), null, "a developer message listing skills is not a use");
});

test("tallies: windows, typed commands that name no skill, plugin prefixes", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const skills = new Map();
  addUse(skills, "alpha", now - 2 * 86_400_000, false, false);
  addUse(skills, "alpha", now - 40 * 86_400_000, false, true);
  addUse(skills, "model", now, true, false);
  addUse(skills, "toolkit:deploy", now, false, false);
  addUse(skills, "removed-one", now, false, false);
  const logs: LogTally[] = [{ agent: "claude", cwd: "/w/app", session: "s1", skills }];
  const week = summarizeUsage(logs, ["alpha", "deploy"], 7, now);
  assert.deepEqual(week.rows.map((row) => [row.name, row.total, row.installed]), [["alpha", 1, true], ["deploy", 1, true], ["removed-one", 1, false]]);
  assert.equal(week.rows[0]!.perDay.length, 7);
  assert.equal(week.rows[0]!.perDay[4], 1);
  assert.equal(summarizeUsage(logs, ["alpha"], 90, now).rows.find((row) => row.name === "alpha")!.total, 2);
  assert.deepEqual(summarizeUsage(logs, ["alpha", "zeta"], 7, now).neverUsed, ["zeta"]);
  assert.equal(dayOf(now) - dayOf(now - 86_400_000), 1);
});

test("Claude's window by model (code.claude.com/docs/en/model-config)", () => {
  const cases: Array<[string | null, number | null]> = [
    [null, null], ["", null], ["gpt-5", null],
    ["opus[1m]", 1_000_000], ["claude-opus-4-6[1m]", 1_000_000], ["sonnet", 1_000_000], ["fable", 1_000_000], ["haiku", 200_000],
    ["claude-opus-4-6", 200_000], ["claude-opus-4-7", 1_000_000], ["claude-opus-5-5", 1_000_000], ["claude-opus-4-20250514", 200_000],
    ["claude-sonnet-4-5-20250929", 200_000], ["claude-sonnet-5-5", 1_000_000], ["claude-fable-5-1", 1_000_000], ["claude-haiku-4-5-20251001", 200_000], ["claude-3-5-sonnet-20241022", 200_000],
  ];
  for (const [model, tokens] of cases) assert.equal(claudeContextTokens(model), tokens, String(model));
  assert.equal(claudeContextTokens("opus[1m]", true), 200_000, "1M turned off");
  assert.equal(claudeBudgetChars(200_000), 8_000);
  assert.equal(claudeBudgetChars(1_000_000), 40_000);
});
