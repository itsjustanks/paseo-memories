/**
 * Review of ux/0.5.1 (7aae3bd): Fix all never copies a secret into Claude's
 * list, never acts on items the person didn't confirm, runs one at a time
 * (a second press says "already done"); groups key on a stable field, not
 * message words; the sidebar's summaries never go back to an older one and
 * its reads happen only while the app is in front; the README states the
 * Paseo the manifest needs. Synthetic only; secrets are built at run time.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { fakePaseo, makeSandbox, violations, type Sandbox } from "./helpers";
import { addSkills } from "./skills-helpers";

let sb: Sandbox = await makeSandbox();
const { forgetAllFiles } = await import("../server/files");
const { forgetDiscovery } = await import("../server/discover");
const { resetDaemonCache } = await import("../server/daemon");
const { findingsFor } = await import("../server/tidy");
const { tidyFixAll } = await import("../server/tidy-fix");
const { readSidebarState, recordMemories, recordSkills, resetSidebarState } = await import("../server/sidebar-cache");
const { parseIndex, renameIndexLine, upsertIndexLine } = await import("../shared/memory-index");
const { BACKUPS_PLACE, fixAllConfirm, fixAllEffect, fixAllMoves, memoryGroupKey } = await import("../shared/finding-groups");
const { jargonIn } = await import("../shared/plain");
const { findSecrets } = await import("../shared/secrets");
const status = await import("../client/sidebar-status");

async function fresh(): Promise<Sandbox> {
  sb.cleanup();
  sb = await makeSandbox();
  forgetAllFiles();
  forgetDiscovery();
  resetDaemonCache();
  resetSidebarState();
  return sb;
}

afterEach(() => assert.deepEqual(violations, [], "no write outside the sandbox"));

const note = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\ntype: project\n---\n\n${description}, in full.\n`;
/** A GitHub-token-shaped value, built here so no key-shaped string sits in the repository. */
const SECRET = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0", "K1l2M3n4O5p6Q7r8"].join("");

// ------------------------------------------------------------------ 1. never a secret in Claude's list

test("a line written to Claude's list never carries a secret: hook left off, title falls back to the file name", () => {
  assert.ok(findSecrets(SECRET).length, "the test value is flagged");
  const hookOnly = upsertIndexLine("", "ci_token.md", "CI token", `use ${SECRET} for the bot`);
  assert.equal(hookOnly.includes(SECRET), false);
  assert.deepEqual(parseIndex(hookOnly).map((line) => [line.title, line.hook]), [["CI token", ""]]);
  const titleToo = upsertIndexLine("", "ci_token.md", `token ${SECRET}`, SECRET);
  assert.deepEqual(parseIndex(titleToo).map((line) => [line.title, line.hook]), [["ci_token", ""]]);
  const nameToo = upsertIndexLine("", `${SECRET}.md`, SECRET, SECRET);
  assert.equal(nameToo.includes(`[${SECRET}`), false);
  assert.equal(parseIndex(nameToo)[0]!.title, "A note");
  // Updating an existing line, and renaming one, go through the same rule.
  const existing = "- [CI token](ci_token.md) — old words\n";
  assert.equal(upsertIndexLine(existing, "ci_token.md", "CI token", SECRET).includes(SECRET), false);
  assert.equal(renameIndexLine(existing, "ci_token.md", "ci.md", SECRET, SECRET).includes(SECRET), false);
  // Ordinary words are kept as they are.
  assert.equal(parseIndex(upsertIndexLine("", "deploy.md", "Deploy", "when deploys go out"))[0]!.hook, "when deploys go out");
});

test("Fix all adds notes to Claude's list without copying a password from a description", async () => {
  await fresh();
  writeFileSync(join(sb.appMemory, "ci_token.md"), note("CI token", `use ${SECRET} for the CI bot`));
  writeFileSync(join(sb.appMemory, "deploy.md"), note("Deploy", "when deploys go out"));
  const fake = fakePaseo(sb);
  const { findings } = await findingsFor(fake.api as never, true);
  assert.ok(findings.some((finding) => finding.kind === "secret"), "the page flags the secret");
  const ids = findings.filter((finding) => memoryGroupKey(finding) === "index-missing" && finding.sourceIds?.[0] === sb.appMemory).map((finding) => finding.id);
  const done = await tidyFixAll(fake.api as never, { group: "index-missing", findingIds: ids });
  assert.equal(done.ok, true, done.message);
  const index = readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8");
  assert.equal(index.includes(SECRET), false, "the secret stays in the note only");
  const lines = parseIndex(index);
  assert.ok(lines.some((line) => line.file === "ci_token.md" && line.title === "CI token" && line.hook === ""), "listed by title alone");
  assert.ok(lines.some((line) => line.file === "deploy.md" && line.hook === "when deploys go out"));
});

// ------------------------------------------------------------------ 2. only what the person confirmed

test("Fix all changes only the items the person confirmed, and nothing without that list", async () => {
  await fresh();
  writeFileSync(join(sb.appMemory, "one.md"), note("One", "first"));
  writeFileSync(join(sb.appMemory, "two.md"), note("Two", "second"));
  const fake = fakePaseo(sb);
  const indexPath = join(sb.appMemory, "MEMORY.md");
  const before = readFileSync(indexPath, "utf8");
  for (const findingIds of [undefined, []]) {
    const refused = await tidyFixAll(fake.api as never, { group: "index-missing", ...(findingIds ? { findingIds } : {}) });
    assert.equal(refused.ok, false, "no list, no change");
    assert.match(refused.message, /Nothing was changed/);
  }
  assert.equal(readFileSync(indexPath, "utf8"), before);
  const { findings } = await findingsFor(fake.api as never, true);
  const one = findings.find((finding) => finding.entryKeys?.[0] === "one.md" && memoryGroupKey(finding) === "index-missing")!;
  const done = await tidyFixAll(fake.api as never, { group: "index-missing", findingIds: [one.id] });
  assert.equal(done.ok, true, done.message);
  const files = parseIndex(readFileSync(indexPath, "utf8")).map((line) => line.file);
  assert.ok(files.includes("one.md"));
  assert.equal(files.includes("two.md"), false, "the one not confirmed is left alone");
});

test("Skills Fix all needs the confirmed list too", async () => {
  await fresh();
  const skills = addSkills(sb);
  const { handleSkillsFixAll } = await import("../server/skill-handlers");
  for (const findingIds of [undefined, []]) {
    const refused = await handleSkillsFixAll({ kind: "broken-link", ...(findingIds ? { findingIds } : {}) }, { paseo: fakePaseo(skills).api as never });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /Nothing was changed/);
  }
});

test("the confirm's words: every kind says what happens to each item and where the backup goes, with no jargon", () => {
  for (const [page, keys] of [["memories", ["index-missing", "index-gone"]], ["skills", ["broken-link", "empty-folder", "stray-file", "paseo-orphan", "lock-missing"]]] as const) {
    for (const key of keys) {
      for (const count of [1, 4, 58]) {
        const words = fixAllConfirm(page, key, count);
        for (const text of [words.question, words.backup, words.yes, fixAllEffect(page, key)]) assert.deepEqual(jargonIn(text), [], `${page} ${key}: ${text}`);
        assert.ok(words.backup.includes(BACKUPS_PLACE), `${page} ${key} says where the backup goes`);
        assert.equal(words.yes, count === 1 ? "Fix it" : `Fix all ${count}`);
      }
    }
  }
  assert.equal(fixAllMoves("skills", "stray-file"), true);
  assert.equal(fixAllMoves("skills", "lock-missing"), true);
  assert.equal(fixAllMoves("memories", "index-missing"), false);
  assert.match(fixAllConfirm("skills", "stray-file", 4).backup, /Nothing is deleted/);
});

// ------------------------------------------------------------------ 3. one at a time

test("two Fix alls at once: the first fixes, the second says it was already done", async () => {
  await fresh();
  writeFileSync(join(sb.appMemory, "a1.md"), note("A one", "first"));
  writeFileSync(join(sb.appMemory, "a2.md"), note("A two", "second"));
  const fake = fakePaseo(sb);
  const { findings } = await findingsFor(fake.api as never, true);
  const ids = findings.filter((finding) => memoryGroupKey(finding) === "index-missing" && ["a1.md", "a2.md"].includes(finding.entryKeys?.[0] ?? "")).map((finding) => finding.id);
  assert.equal(ids.length, 2);
  const [first, second] = await Promise.all([tidyFixAll(fake.api as never, { group: "index-missing", findingIds: ids }), tidyFixAll(fake.api as never, { group: "index-missing", findingIds: ids })]);
  assert.equal(first.ok, true, first.message);
  assert.match(first.message, /^Added 2 notes/);
  assert.equal(second.ok, true, second.message);
  assert.match(second.message, /^Already done/);
  const files = parseIndex(readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8")).map((line) => line.file);
  assert.equal(files.filter((file) => file === "a1.md").length, 1, "never a line twice");
});

test("two Skills Fix alls at once: the second says it was already done, not a failure", async () => {
  await fresh();
  const skills = addSkills(sb);
  const fake = fakePaseo(skills);
  const { handleSkillsFixAll, handleSkillsInventory } = await import("../server/skill-handlers");
  const { forgetSkillCaches } = await import("../server/skills");
  forgetSkillCaches();
  const inventory = await handleSkillsInventory({ refresh: true }, { paseo: fake.api as never });
  const kind = ["broken-link", "stray-file", "empty-folder"].find((key) => inventory.findings.filter((finding) => finding.kind === key && finding.action?.kind === "fix").length > 0)!;
  const ids = inventory.findings.filter((finding) => finding.kind === kind).map((finding) => finding.id);
  assert.ok(ids.length > 0, "the fixture has something to fix");
  const [first, second] = await Promise.all([handleSkillsFixAll({ kind, findingIds: ids }, { paseo: fake.api as never }), handleSkillsFixAll({ kind, findingIds: ids }, { paseo: fake.api as never })]);
  assert.equal(first.ok, true, first.message);
  assert.equal(second.ok, true, second.message);
  assert.match(second.message, /^Already done/);
});

// ------------------------------------------------------------------ 6. stable group keys; summaries never go back

test("a note called \"does not exist\" missing from Claude's list is grouped as missing, not as gone", async () => {
  await fresh();
  writeFileSync(join(sb.appMemory, "does not exist.md"), note("does not exist", "a name that reads like a message"));
  const fake = fakePaseo(sb);
  const { findings } = await findingsFor(fake.api as never, true);
  const odd = findings.find((finding) => finding.kind === "index-drift" && finding.entryKeys?.[0] === "does not exist.md")!;
  assert.ok(odd, "found");
  assert.equal(odd.group, "index-missing");
  assert.equal(memoryGroupKey(odd), "index-missing");
  // Without the field, a finding is its own kind (Fix all isn't offered), whatever its words.
  assert.equal(memoryGroupKey({ kind: "index-drift", message: "x.md does not exist" } as never), "index-drift");
});

test("the dots' summaries: an older answer landing late never wins, and the two dots never undo each other", async () => {
  await fresh();
  const summary = (count: number) => ({ tone: "attention" as const, count, groups: [] });
  await recordMemories(summary(5), summary(5), 2);
  await recordMemories(summary(9), summary(9), 1);
  assert.equal((await readSidebarState()).memories?.plain.count, 5, "the newer answer stays");
  await Promise.all([recordMemories(summary(7), summary(7), 3), recordSkills(summary(4), 3)]);
  const state = await readSidebarState();
  assert.equal(state.memories?.plain.count, 7);
  assert.equal(state.skills?.summary.count, 4, "both kept");
  // The client's seed: an older server answer arriving later is ignored.
  status.resetSidebarStatus();
  status.seedSidebarStatus("memories", "h9", summary(3), "2026-10-06T10:00:00.000Z");
  status.seedSidebarStatus("memories", "h9", summary(8), "2026-10-06T09:00:00.000Z");
  assert.equal(status.sidebarSummary("memories", "h9")?.count, 3);
});

// ------------------------------------------------------------------ 5. the sidebar asks only while the app is in front

test("the sidebar's reads happen only while the app is in front", () => {
  assert.equal(status.appInForeground("active", "visible"), true);
  assert.equal(status.appInForeground("background", "visible"), false);
  assert.equal(status.appInForeground("inactive", null), false);
  assert.equal(status.appInForeground("active", "hidden"), false);
  assert.equal(status.appInForeground(undefined, undefined), true, "unknown counts as in front");
  const popover = readFileSync(join(import.meta.dirname, "..", "client", "popover.tsx"), "utf8");
  assert.match(popover, /appInForeground\(AppState\?\.currentState/, "the timer checks before each read");
});

// ------------------------------------------------------------------ 4. the Paseo it needs, said the same everywhere

test("README, manifest and CHANGELOG agree on the Paseo it needs", () => {
  const root = join(import.meta.dirname, "..");
  const manifest = JSON.parse(readFileSync(join(root, "paseo-plugin.json"), "utf8")) as { requirements: { paseo: string } };
  assert.equal(manifest.requirements.paseo, ">=0.9.0");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.match(readme, /Needs Paseo 0\.9 or later; best on 0\.11/);
  assert.equal(/Paseo 0\.8 or later/.test(readme), false);
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const start = changelog.indexOf("\n## ");
  const current = changelog.slice(start, changelog.indexOf("\n## ", start + 1));
  assert.match(current, /Needs Paseo 0\.9 or later now/);
});
