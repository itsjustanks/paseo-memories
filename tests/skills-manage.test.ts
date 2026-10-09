/**
 * Changing skills: adding (the curated list, a GitHub link, one written
 * here) bound to its preview, never over anything; turning off and on for
 * Claude and Codex with every other setting kept; removing into the backups
 * (restorable) and link-only removal; the "Worth a look" fixes; and every
 * refusal the host makes whatever the app asks.
 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fakePaseo, makeSandbox, violations } from "./helpers";
import { addSkills, fakeGithub, LOCK_EXTRA, skillMd, writeSkill, type FakeRepo } from "./skills-helpers";

const sb = addSkills(await makeSandbox());
const { handleSkillsPreview, handleSkillsAdd, handleSkillsToggle, handleSkillsRemove, handleSkillsFix } = await import("../server/skill-handlers");
const { discoverSkills, forgetSkillCaches } = await import("../server/skills");
const { setGithubFetch } = await import("../server/github");
const { forgetPrepared, PLAN_CHANGED } = await import("../server/skill-add");
const { moveToBackup, installSkillFolder, newSession, backupsRoot } = await import("../server/write");
const { CATALOG } = await import("../shared/skills-catalog");

const fake = fakePaseo(sb);
const ctx = { paseo: fake.api };
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("no real network in tests");
}) as typeof fetch;
after(() => {
  globalThis.fetch = originalFetch;
  setGithubFetch(null);
  sb.cleanup();
});

const C1 = "c".repeat(40);
const C2 = "d".repeat(40);
const entry = (id: string) => CATALOG.find((item) => item.id === id)!;
const repos: FakeRepo[] = [
  { owner: "obra", repo: "superpowers", commit: entry("writing-plans").commit, files: { "skills/writing-plans/SKILL.md": { text: skillMd("writing-plans", "Plans first.") } }, folderTrees: { "skills/writing-plans": entry("writing-plans").tree } },
  {
    owner: "anthropics",
    repo: "skills",
    commit: entry("webapp-testing").commit,
    files: { "skills/webapp-testing/SKILL.md": { text: skillMd("webapp-testing", "Tests web apps.") }, "skills/webapp-testing/scripts/with_server.py": { text: "#!/usr/bin/env python3\nprint('hi')\n", mode: "100755" }, "skills/webapp-testing/LICENSE.txt": { text: "Apache\n" } },
    folderTrees: { "skills/webapp-testing": entry("webapp-testing").tree },
  },
  { owner: "acme", repo: "tools", commit: C1, files: { "skills/lint-fix/SKILL.md": { text: skillMd("lint-fix", "Fixes lint.") }, "skills/lint-fix/notes.md": { text: "More.\n" }, "skills/other/SKILL.md": { text: skillMd("other", "Other.") } } },
];
let github = fakeGithub(repos);
beforeEach(() => {
  github = fakeGithub(repos);
  setGithubFetch(github.fetchImpl as never);
  forgetPrepared();
  forgetSkillCaches();
});

const lockJson = () => JSON.parse(readFileSync(sb.lock, "utf8")) as { version: number; skills: Record<string, Record<string, unknown>>; dismissed: unknown; lastSelectedAgents: unknown };
/** Every backup this plugin made, in the `.memories-backup` folders beside what it backed up (0.6.0). */
const backups = () => readdirSync(sb.home, { recursive: true }).map(String).filter((path) => path.includes(".memories-backup/") && !path.endsWith(".gitignore"));
async function skillNamed(name: string) {
  forgetSkillCaches();
  return (await discoverSkills(fake.api, { refresh: true })).skills.find((skill) => skill.name === name);
}

// ------------------------------------------------------------------ add

test("write your own: preview, add, linked for every Claude account (pi reads the shared copy), recorded for npx skills", async () => {
  const source = { kind: "write", name: "weekly-report", whenToUse: "When asked for the weekly report.", instructions: "1. Gather.\n2. Write." };
  const preview = await handleSkillsPreview({ source }, ctx);
  assert.equal(preview.ok, true, preview.problem);
  assert.deepEqual(preview.targets.map((target) => target.kind), ["canonical", "link", "link", "lock"]);
  assert.equal(preview.targets.some((target) => target.path.startsWith(sb.piSkills)), false, "no link for pi");
  assert.equal(preview.scripts, false);
  assert.equal(github.calls.length, 0, "no network for a skill written here");
  const added = await handleSkillsAdd({ source, planHash: preview.planHash }, ctx);
  assert.equal(added.ok, true, added.message);
  assert.ok(added.skillId);
  const folder = join(sb.shared, "weekly-report");
  assert.match(readFileSync(join(folder, "SKILL.md"), "utf8"), /^---\nname: weekly-report\ndescription: "When asked for the weekly report."\n---\n\n1\. Gather\.\n2\. Write\.\n$/);
  assert.equal(existsSync(join(sb.piSkills, "weekly-report")), false);
  for (const dir of [sb.claudeSkills, sb.slotSkills]) {
    const link = join(dir, "weekly-report");
    assert.ok(lstatSync(link).isSymbolicLink(), dir);
    assert.ok(!readlinkSync(link).startsWith("/"), "relative, like npx skills");
    assert.equal(realpathSync(link), realpathSync(folder));
  }
  const lock = lockJson();
  assert.equal(lock.version, 3);
  assert.deepEqual({ dismissed: lock.dismissed, lastSelectedAgents: lock.lastSelectedAgents }, LOCK_EXTRA, "keys this plugin doesn't set are kept");
  assert.ok(lock.skills.alpha && lock.skills.ghost, "other entries kept");
  assert.equal(lock.skills["weekly-report"]!.sourceType, "local");
  const skill = await skillNamed("weekly-report");
  assert.equal(skill!.provenance, "added-here");
  assert.equal(skill!.locations.length, 3);
});

test("a changed plan is refused, and nothing is written", async () => {
  const source = { kind: "write", name: "plan-check", whenToUse: "Checking plans.", instructions: "Check." };
  const preview = await handleSkillsPreview({ source }, ctx);
  // Another Claude account appears after the preview: the places change.
  mkdirSync(join(sb.home, ".claude-accounts", "late"), { recursive: true });
  try {
    const added = await handleSkillsAdd({ source, planHash: preview.planHash }, ctx);
    assert.equal(added.ok, false);
    assert.equal(added.message, PLAN_CHANGED);
    assert.equal(existsSync(join(sb.shared, "plan-check")), false);
    assert.equal((await handleSkillsAdd({ source, planHash: "" }, ctx)).message, PLAN_CHANGED, "no hash, no add");
  } finally {
    renameSync(join(sb.home, ".claude-accounts"), join(sb.root, "claude-accounts-moved"));
  }
  // A GitHub branch that moved to new files between preview and add.
  const link = { kind: "github", link: "https://github.com/acme/tools/tree/main/skills/lint-fix" };
  const first = await handleSkillsPreview({ source: link }, ctx);
  assert.equal(first.ok, true, first.problem);
  repos[2]!.commit = C2;
  repos[2]!.files["skills/lint-fix/SKILL.md"] = { text: skillMd("lint-fix", "Fixes lint, now differently.") };
  forgetPrepared();
  try {
    const added = await handleSkillsAdd({ source: link, planHash: first.planHash }, ctx);
    assert.equal(added.message, PLAN_CHANGED);
    assert.equal(existsSync(join(sb.shared, "lint-fix")), false);
  } finally {
    repos[2]!.commit = C1;
    repos[2]!.files["skills/lint-fix/SKILL.md"] = { text: skillMd("lint-fix", "Fixes lint.") };
  }
});

test("a name clash in any spelling, or anything already at the place, is never overwritten", async () => {
  for (const name of ["own-skill", "ownskill", "bad-name", "alpha"]) {
    const preview = await handleSkillsPreview({ source: { kind: "write", name, whenToUse: "x", instructions: "y" } }, ctx);
    assert.equal(preview.ok, false, name);
    assert.ok(preview.clash, name);
    assert.equal(preview.planHash, "");
    assert.equal((await handleSkillsAdd({ source: { kind: "write", name, whenToUse: "x", instructions: "y" }, planHash: "anything" }, ctx)).ok, false);
  }
  mkdirSync(join(sb.shared, "squatter"));
  writeFileSync(join(sb.shared, "squatter", "notes.txt"), "mine");
  const squat = await handleSkillsPreview({ source: { kind: "write", name: "squatter", whenToUse: "x", instructions: "y" } }, ctx);
  assert.equal(squat.ok, false);
  assert.equal(readFileSync(join(sb.shared, "squatter", "notes.txt"), "utf8"), "mine");
  // The writer itself refuses an existing folder, whatever the caller checked.
  const report = await installSkillFolder(sb.shared, "squatter", [{ path: "SKILL.md", bytes: Buffer.from("x"), executable: false }]);
  assert.equal(report.ok, false);
  assert.equal(readFileSync(join(sb.shared, "squatter", "notes.txt"), "utf8"), "mine");
  for (const bad of [{ name: "Bad Name" }, { name: "ok-name", whenToUse: "" }, { name: "ok-name", instructions: "" }]) {
    const preview = await handleSkillsPreview({ source: { kind: "write", whenToUse: "x", instructions: "y", ...bad } }, ctx);
    assert.equal(preview.ok, false);
    assert.ok(preview.problem.endsWith("."), preview.problem);
  }
});

test("from the curated list: pinned, checked, and code needs a confirm", async () => {
  const plans = await handleSkillsPreview({ source: { kind: "catalog", id: "writing-plans" } }, ctx);
  assert.equal(plans.ok, true, plans.problem);
  assert.equal(plans.commit, entry("writing-plans").commit);
  assert.equal(plans.scripts, false);
  assert.ok(github.calls.every((url) => url.startsWith("https://api.github.com/") || url.startsWith("https://raw.githubusercontent.com/")));
  assert.equal(github.calls.some((url) => url.includes("/commits/")), false, "a pinned commit needs no lookup");
  const callsAfterPreview = github.calls.length;
  assert.equal((await handleSkillsAdd({ source: { kind: "catalog", id: "writing-plans" }, planHash: plans.planHash }, ctx)).ok, true);
  assert.equal(github.calls.length, callsAfterPreview, "the add reuses the preview's download");
  assert.equal(lockJson().skills["writing-plans"]!.skillFolderHash, entry("writing-plans").tree);
  assert.equal(lockJson().skills["writing-plans"]!.source, "obra/superpowers");

  const web = await handleSkillsPreview({ source: { kind: "catalog", id: "webapp-testing" } }, ctx);
  assert.equal(web.ok, true, web.problem);
  assert.equal(web.scripts, true);
  assert.deepEqual(web.files.map((file) => [file.path, file.kind]).sort(), [["LICENSE.txt", "instructions"], ["SKILL.md", "instructions"], ["scripts/with_server.py", "script"]]);
  const refused = await handleSkillsAdd({ source: { kind: "catalog", id: "webapp-testing" }, planHash: web.planHash }, ctx);
  assert.equal(refused.ok, false);
  assert.equal(refused.needsScriptsConfirm, true);
  assert.equal(existsSync(join(sb.shared, "webapp-testing")), false);
  const ok = await handleSkillsAdd({ source: { kind: "catalog", id: "webapp-testing" }, planHash: web.planHash, confirmScripts: true }, ctx);
  assert.equal(ok.ok, true, ok.message);
  assert.equal(statSync(join(sb.shared, "webapp-testing", "scripts", "with_server.py")).mode & 0o777, 0o755);
  // A catalogue folder that isn't what was checked is refused.
  const saved = repos[0]!.folderTrees!["skills/writing-plans"];
  repos[0]!.folderTrees!["skills/writing-plans"] = "e".repeat(40);
  try {
    await handleSkillsRemove({ skillId: (await skillNamed("writing-plans"))!.id }, ctx);
    forgetPrepared();
    const changed = await handleSkillsPreview({ source: { kind: "catalog", id: "writing-plans" } }, ctx);
    assert.equal(changed.ok, false);
    assert.match(changed.problem, /not what this plugin checked/);
  } finally {
    repos[0]!.folderTrees!["skills/writing-plans"] = saved!;
  }
});

test("from a GitHub link: one skill picked, pinned to the resolved commit, size-capped, checked against GitHub's record", async () => {
  const several = await handleSkillsPreview({ source: { kind: "github", link: "acme/tools" } }, ctx);
  assert.equal(several.ok, false);
  assert.deepEqual(several.choices.map((choice) => choice.name).sort(), ["lint-fix", "other"]);
  const one = await handleSkillsPreview({ source: { kind: "github", link: "acme/tools/skills/lint-fix@main" } }, ctx);
  assert.equal(one.ok, true, one.problem);
  assert.equal(one.commit, C1);
  assert.equal((await handleSkillsAdd({ source: { kind: "github", link: "acme/tools/skills/lint-fix@main" }, planHash: one.planHash }, ctx)).ok, true);
  const lock = lockJson().skills["lint-fix"]!;
  assert.equal(lock.ref, "main");
  assert.equal(lock.skillPath, "skills/lint-fix/SKILL.md");
  assert.match(String(lock.skillFolderHash), /^[0-9a-f]{40}$/);
  // Too many files.
  const big: FakeRepo = { owner: "acme", repo: "big", commit: C1, files: Object.fromEntries([["SKILL.md", { text: skillMd("big", "Big.") }], ...Array.from({ length: 205 }, (_, i) => [`f${i}.md`, { text: "x" }])]) };
  setGithubFetch(fakeGithub([big]).fetchImpl as never);
  assert.match((await handleSkillsPreview({ source: { kind: "github", link: "acme/big" } }, ctx)).problem, /at most 200/);
  // A download that doesn't match GitHub's own record.
  const honest = fakeGithub([repos[2]!]);
  setGithubFetch((async (url: string) => (url.includes("raw.githubusercontent.com") ? new Response("tampered", { status: 200 }) : honest.fetchImpl(url))) as never);
  forgetPrepared();
  assert.match((await handleSkillsPreview({ source: { kind: "github", link: "acme/tools/skills/other" } }, ctx)).problem, /did not match GitHub's own record/);
  // Not GitHub at all.
  assert.match((await handleSkillsPreview({ source: { kind: "github", link: "https://example.com/a/b" } }, ctx)).problem, /Only github.com/);
});

test("a lock file in another version is left alone; the skill is still added", async () => {
  const saved = readFileSync(sb.lock, "utf8");
  writeFileSync(sb.lock, JSON.stringify({ version: 2, skills: {} }));
  try {
    const source = { kind: "write", name: "old-lock", whenToUse: "x.", instructions: "y" };
    const preview = await handleSkillsPreview({ source }, ctx);
    assert.ok(preview.warnings.some((warning) => warning.includes("version 2")));
    assert.equal(preview.targets.some((target) => target.kind === "lock"), false);
    assert.equal((await handleSkillsAdd({ source, planHash: preview.planHash }, ctx)).ok, true);
    assert.equal(readFileSync(sb.lock, "utf8"), JSON.stringify({ version: 2, skills: {} }));
  } finally {
    writeFileSync(sb.lock, saved);
  }
});

// ------------------------------------------------------------------ turn off / on

test("Claude: off and back on, everything else in its settings kept", async () => {
  const path = join(sb.claude, "settings.json");
  const original = readFileSync(path, "utf8");
  const alpha = (await skillNamed("alpha"))!;
  const off = await handleSkillsToggle({ skillId: alpha.id, agent: "claude", on: false, accountId: `claude:${sb.claude}` }, ctx);
  assert.equal(off.ok, true, off.message);
  const settings = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(settings.skillOverrides, { alpha: "off" });
  assert.equal(settings.theme, "dark");
  assert.deepEqual(settings.enabledPlugins, { "toolkit@market": true, "off@market": false });
  assert.ok(off.reports[0]!.backupPath && existsSync(off.reports[0]!.backupPath));
  const after = (await skillNamed("alpha"))!;
  assert.equal(after.state.claude, "off");
  assert.equal(after.listing.claude, 0);
  const on = await handleSkillsToggle({ skillId: alpha.id, agent: "claude", on: true }, ctx);
  assert.equal(on.ok, true, on.message);
  assert.equal(readFileSync(path, "utf8"), original, "byte for byte as before");
});

test("Codex: off and back on, the rest of config.toml untouched", async () => {
  const path = join(sb.codex, "config.toml");
  const original = readFileSync(path, "utf8");
  const legacy = (await skillNamed("legacy-x"))!;
  assert.equal((await handleSkillsToggle({ skillId: legacy.id, agent: "codex", on: false }, ctx)).ok, true);
  assert.ok(readFileSync(path, "utf8").startsWith(original.trimEnd()));
  assert.match(readFileSync(path, "utf8"), /\[\[skills\.config\]\]\nname = "legacy-x"\nenabled = false\n$/);
  assert.equal((await skillNamed("legacy-x"))!.state.codex, "off");
  assert.equal((await handleSkillsToggle({ skillId: legacy.id, agent: "codex", on: true }, ctx)).ok, true);
  assert.equal(readFileSync(path, "utf8").trimEnd(), original.trimEnd());
  // A settings file in a shape that can't take a switch safely is refused and left alone.
  writeFileSync(path, `${original}\n[skills]\nconfig = []\n`);
  const shape = readFileSync(path, "utf8");
  const refused = await handleSkillsToggle({ skillId: legacy.id, agent: "codex", on: false }, ctx);
  assert.equal(refused.ok, false);
  assert.equal(readFileSync(path, "utf8"), shape);
  writeFileSync(path, original);
});

test("turning off is refused for Paseo's, plugins', claude.ai's and built-in skills, and for agents that don't read it", async () => {
  for (const [name, agent] of [["paseo", "codex"], ["toolkit:deploy", "claude"], ["drawing", "claude"], ["openai-docs", "codex"], ["own-skill", "codex"]] as const) {
    const skill = (await skillNamed(name))!;
    const before = readFileSync(join(sb.claude, "settings.json"), "utf8");
    const result = await handleSkillsToggle({ skillId: skill.id, agent, on: false }, ctx);
    assert.equal(result.ok, false, name);
    assert.ok(result.message.length > 10, name);
    assert.equal(readFileSync(join(sb.claude, "settings.json"), "utf8"), before);
  }
});

// ------------------------------------------------------------------ remove

test("remove: the folder goes to the backups with its links and lock entry, and can be put back", async () => {
  const skill = (await skillNamed("weekly-report"))!;
  const removed = await handleSkillsRemove({ skillId: skill.id }, ctx);
  assert.equal(removed.ok, true, removed.message);
  assert.equal(existsSync(join(sb.shared, "weekly-report")), false);
  for (const dir of [sb.claudeSkills, sb.slotSkills]) assert.equal(existsSync(join(dir, "weekly-report")) || (() => { try { lstatSync(join(dir, "weekly-report")); return true; } catch { return false; } })(), false, dir);
  assert.equal(lockJson().skills["weekly-report"], undefined);
  assert.ok(lockJson().skills.alpha, "other entries kept");
  const folderBackup = removed.reports.find((report) => report.target === join(sb.shared, "weekly-report"))!.backupPath!;
  assert.ok(folderBackup.endsWith("/weekly-report.bak") && existsSync(join(folderBackup, "SKILL.md")), "kept whole, nothing inside renamed");
  assert.ok(removed.reports.filter((report) => report.backupPath?.endsWith("/weekly-report.bak") && lstatSync(report.backupPath).isSymbolicLink()).length === 2, "each link kept as itself");
  // Put it back by hand: it is a skill again.
  // Putting it back: move the folder back without its .bak (Help says so).
  renameSync(folderBackup, join(sb.shared, "weekly-report"));
  assert.ok(await skillNamed("weekly-report"));
});

test("(0.6.0) removal never copies across disks: the backup is beside it; a failed rename removes nothing", async () => {
  const fsp = (await import("node:fs/promises")).default as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const { syncBuiltinESMExports } = await import("node:module");
  const realRename = fsp.rename!;
  writeSkill(join(sb.shared, "far-away"), skillMd("far-away", "Stays put."), { "scripts/x.sh": { text: "#!/bin/sh\n", mode: 0o755 } });
  fsp.rename = (...args: unknown[]) => (String(args[1]).includes("/.memories-backup/") ? Promise.reject(Object.assign(new Error("cross-device"), { code: "EXDEV" })) : realRename(...args));
  syncBuiltinESMExports();
  try {
    const report = await moveToBackup(newSession(5), join(sb.shared, "far-away"));
    assert.equal(report.ok, false);
    assert.ok(existsSync(join(sb.shared, "far-away", "SKILL.md")), "nothing removed");
    assert.equal(readFileSync(join(sb.shared, "far-away", "scripts", "x.sh"), "utf8"), "#!/bin/sh\n");
  } finally {
    fsp.rename = realRename;
    syncBuiltinESMExports();
  }
  const report = await moveToBackup(newSession(5), join(sb.shared, "far-away"));
  assert.equal(report.ok, true, String(report.error));
  assert.ok(report.backupPath!.startsWith(join(sb.shared, ".memories-backup") + "/"), String(report.backupPath));
  assert.equal(readFileSync(join(report.backupPath!, "scripts", "x.sh"), "utf8"), "#!/bin/sh\n");
});

test("a link to a folder elsewhere: only the link goes", async () => {
  const elsewhere = join(sb.root, "elsewhere", "ext-skill");
  writeSkill(elsewhere, skillMd("ext-skill", "Lives in another folder."));
  symlinkSync(elsewhere, join(sb.claudeSkills, "ext-skill"));
  const skill = (await skillNamed("ext-skill"))!;
  assert.equal(skill.can.remove, true);
  const removed = await handleSkillsRemove({ skillId: skill.id }, ctx);
  assert.equal(removed.ok, true, removed.message);
  assert.match(removed.message, /link/);
  assert.ok(existsSync(join(elsewhere, "SKILL.md")), "the folder it pointed to is untouched");
});

test("remove is refused whole when a project links to the skill", async () => {
  writeSkill(join(sb.shared, "linked-in"), skillMd("linked-in", "A project links to it."));
  mkdirSync(join(sb.app, ".agents", "skills"), { recursive: true });
  symlinkSync(join(sb.shared, "linked-in"), join(sb.app, ".agents", "skills", "linked-in"));
  const skill = (await skillNamed("linked-in"))!;
  const result = await handleSkillsRemove({ skillId: skill.id }, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.reports.length, 0, "nothing touched");
  assert.ok(existsSync(join(sb.shared, "linked-in", "SKILL.md")));
  assert.ok(lstatSync(join(sb.app, ".agents", "skills", "linked-in")).isSymbolicLink());
});

test("remove is refused for read-only skills, and the writer refuses places outside the user's skills folders", async () => {
  for (const name of ["paseo", "drawing", "toolkit:deploy", "openai-docs", "corp-policy", "app-helper", "pi-only"]) {
    const skill = (await skillNamed(name))!;
    const result = await handleSkillsRemove({ skillId: skill.id }, ctx);
    assert.equal(result.ok, false, name);
    assert.ok(existsSync(skill.path), name);
  }
  const session = newSession(5);
  for (const path of [join(sb.claudeSkills, "synced", "org1_acct1", "drawing"), join(sb.shared, "paseo"), join(sb.app, ".claude", "skills", "app-helper"), join(sb.codexSkills, ".system", "openai-docs"), sb.home]) {
    const report = await moveToBackup(session, path);
    assert.equal(report.action, "refused", path);
    assert.ok(existsSync(path), path);
  }
  assert.equal((await installSkillFolder(sb.claudeSkills, "sneaky", [{ path: "SKILL.md", bytes: Buffer.from("x"), executable: false }])).action, "refused", "installs go to the shared folder only");
  assert.equal((await installSkillFolder(sb.shared, "escape", [{ path: "SKILL.md", bytes: Buffer.from("x"), executable: false }, { path: "../x", bytes: Buffer.from("x"), executable: false }])).action, "refused");
  assert.equal(existsSync(join(sb.shared, "escape")), false);
});

// ------------------------------------------------------------------ fixes

test("each 'Worth a look' fix does its one thing, backed up", async () => {
  forgetSkillCaches();
  const d = await discoverSkills(fake.api, { refresh: true });
  const find = (kind: string, match: string) => d.findings.find((finding) => finding.kind === kind && (finding.detail ?? finding.message).includes(match))!;
  const before = backups().length;
  for (const [kind, match] of [["broken-link", "broken"], ["stray-file", "pack.zip"], ["empty-folder", "empty-one"], ["lock-missing", "ghost"], ["paseo-orphan", "paseo-loop"], ["broken-link", "gstack-a"]] as const) {
    const finding = find(kind, match);
    assert.ok(finding, `${kind} ${match}`);
    const result = await handleSkillsFix({ findingId: finding.id }, ctx);
    assert.equal(result.ok, true, `${kind}: ${result.message}`);
  }
  assert.equal(existsSync(join(sb.claudeSkills, "pack.zip")), false);
  assert.equal(existsSync(join(sb.claudeSkills, "empty-one")), false);
  assert.equal(existsSync(join(sb.shared, "paseo-loop")), false);
  assert.ok(existsSync(join(sb.shared, "paseo")), "Paseo's current skill stays");
  assert.equal(lockJson().skills.ghost, undefined);
  assert.ok(backups().length > before);
  const again = await handleSkillsFix({ findingId: find("stray-file", "pack.zip").id }, ctx);
  assert.equal(again.ok, false, "a fix that's done can't run twice");
  assert.deepEqual(violations, [], "nothing written outside the sandbox");
});
