/**
 * 0.5.1, from a real-app audit: things worth a look grouped by kind with a
 * count and a safe "Fix all", every row naming its item; the Overview and the
 * tabs counting the same way; same-named projects told apart and empty ones
 * folded; and the sidebar dot showing from load from one cheap cached read.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fakePaseo, makeSandbox, violations, type Sandbox } from "./helpers";
import { addSkills } from "./skills-helpers";

let sb: Sandbox = await makeSandbox();
const { forgetAllFiles } = await import("../server/files");
const { forgetDiscovery } = await import("../server/discover");
const { resetDaemonCache } = await import("../server/daemon");
const { findingsFor } = await import("../server/tidy");
const { tidyFixAll } = await import("../server/tidy-fix");
const { inventoryFor } = await import("../server/read");
const { readSidebarState, resetSidebarState, sidebarStatePath } = await import("../server/sidebar-cache");
const { clientSeenWithin, resetPresence } = await import("../server/presence");
const { backupsRoot } = await import("../server/write");
const { parseIndex } = await import("../shared/memory-index");
const { canFixAll, groupFindings, groupSummary, groupTitle, memoryGroupKey, quickSummary } = await import("../shared/finding-groups");
const { PLAIN, jargonIn, plainFinding, plainGroupedRow, plainFindings } = await import("../shared/plain");
const { plainSkillFinding, skillSubject } = await import("../shared/skills-plain");
const { disambiguate, listedSources, notesIn, placeCounts, projectGroups, splitEmpty, userGroups } = await import("../shared/source-groups");
const { sidebarItem } = await import("../client/register");
const status = await import("../client/sidebar-status");
const contribute = (await import("../index.server")).default;

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

/** Three notes Claude's list doesn't name, and one line for a note that's gone. */
function seedListDrift(): void {
  writeFileSync(join(sb.appMemory, "testing_rules.md"), note("Testing rules", "how we test"));
  writeFileSync(join(sb.appMemory, "deploy_window.md"), note("Deploy window", "when deploys go out"));
  writeFileSync(join(sb.appMemory, "code_review.md"), note("Code review", "who reviews what"));
  writeFileSync(join(sb.appMemory, "MEMORY.md"), `${readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8")}- [Old plan](old_plan.md) — retired\n`);
}

// ------------------------------------------------------------------ grouping (pure)

test("findings group by kind in list order; Claude's list splits into missing notes and gone notes", () => {
  const f = (id: string, kind: string, message = "", severity = "warn", action?: { kind: string }) => ({ id, kind, message, severity, sourceIds: [], ...(action ? { action } : {}) });
  const findings = [f("s", "secret", "", "error"), f("m1", "index-drift", "a.md in x is not in MEMORY.md"), f("g1", "index-drift", "MEMORY.md in x lists b.md, which does not exist."), f("m2", "index-drift", "c.md in y is not in MEMORY.md"), f("d", "duplicate", "", "info")];
  const groups = groupFindings("memories", findings);
  assert.deepEqual(groups.map((group) => [group.key, group.findings.map((finding) => finding.id)]), [["secret", ["s"]], ["index-missing", ["m1", "m2"]], ["index-gone", ["g1"]], ["duplicate", ["d"]]]);
  assert.equal(groups[1]!.fixAll, true, "two missing notes: Fix all");
  assert.equal(groups[2]!.fixAll, false, "one item needs no Fix all, its own row does");
  assert.equal(groups[0]!.fixAll, false, "a password is never fixed in bulk");
  assert.equal(memoryGroupKey(findings[2]!), "index-gone");
  assert.equal(canFixAll("memories", "duplicate"), false);
  assert.equal(canFixAll("memories", "index-missing"), true);
});

test("skills: Fix all only for safe kinds, and only when every item has its own fix", () => {
  const f = (id: string, kind: string, fix = true) => ({ id, kind, message: `${id} points somewhere`, severity: "warn", ...(fix ? { action: { kind: "fix" } } : {}) });
  const groups = groupFindings("skills", [f("a", "broken-link"), f("b", "broken-link"), f("c", "empty-folder"), f("d", "empty-folder", false), f("e", "duplicate"), f("g", "duplicate")]);
  assert.deepEqual(groups.map((group) => [group.key, group.fixAll]), [["broken-link", true], ["empty-folder", false], ["duplicate", false]]);
});

test("group headings count in plain words, singular and plural, with no jargon", () => {
  assert.equal(groupTitle("memories", "index-missing", 58), "58 notes missing from Claude's list");
  assert.equal(groupTitle("memories", "index-missing", 1), "1 note missing from Claude's list");
  assert.equal(groupTitle("skills", "broken-link", 60), "60 links to skills that are gone");
  assert.equal(groupTitle("memories", "index-missing", 1234), "1,234 notes missing from Claude's list");
  for (const page of ["memories", "skills"] as const) {
    for (const key of ["secret", "index-missing", "index-gone", "over-limit", "duplicate", "stale-path", "stale-symbol", "conflict", "broken-link", "empty-folder", "stray-file", "invalid", "paseo-orphan", "lock-missing", "other"]) {
      for (const text of [groupTitle(page, key, 1), groupTitle(page, key, 7), groupSummary(page, key)]) assert.deepEqual(jargonIn(text), [], text);
    }
  }
});

test("plain words: no 'points to nothing'; every skill row names its skill", () => {
  const broken = plainSkillFinding({ kind: "broken-link", message: "web-browse points to a skill that no longer exists." });
  assert.equal(broken.title, "A link to a skill that's gone");
  assert.match(broken.detail, /^web-browse /);
  assert.equal(skillSubject({ message: "web-browse points to a skill that no longer exists." }), "web-browse");
  assert.ok(!/points to nothing|packed file/i.test(JSON.stringify(plainSkillFinding({ kind: "stray-file", message: "kit.zip is a packed file in a skills folder; agents don't read it." }))));
});

test("the sidebar's quick summary: biggest kinds first, at most three", () => {
  const f = (id: string, kind: string, message = "") => ({ id, kind, message, sourceIds: [] });
  const summary = quickSummary("memories", [f("a", "secret"), ...[1, 2, 3].map((n) => f(`m${n}`, "index-drift", "x is not in MEMORY.md")), f("d1", "duplicate"), f("d2", "duplicate"), f("c", "conflict")], "error");
  assert.deepEqual(summary, { tone: "error", count: 7, groups: [{ key: "index-missing", count: 3 }, { key: "duplicate", count: 2 }, { key: "secret", count: 1 }] });
});

// ------------------------------------------------------------------ naming and Fix all (server)

test("every finding about Claude's list names its note; plain rows say the name", async () => {
  await fresh();
  seedListDrift();
  const fake = fakePaseo(sb);
  const { findings } = await findingsFor(fake.api as never, true);
  const drift = findings.filter((finding) => finding.kind === "index-drift");
  const missing = drift.filter((finding) => memoryGroupKey(finding) === "index-missing").map((finding) => finding.subject).sort();
  assert.deepEqual(missing.filter((name) => ["Code review", "Deploy window", "Testing rules"].includes(name!)), ["Code review", "Deploy window", "Testing rules"], "named by each note's own title");
  const gone = drift.find((finding) => memoryGroupKey(finding) === "index-gone" && finding.entryKeys?.[0] === "old_plan.md");
  assert.equal(gone?.subject, "Old plan");
  const testing = drift.find((finding) => finding.subject === "Testing rules")!;
  const words = plainFinding(testing as never, () => "Claude's notes for app");
  assert.equal(words.title, `Claude may not find "Testing rules"`);
  assert.deepEqual(plainGroupedRow(testing as never, () => "Claude's notes for app"), { title: "Testing rules", detail: "Claude's notes for app" });
  for (const finding of findings) assert.ok(finding.kind === "codex-pending" || finding.subject, `${finding.kind} names its item`);
});

test("Fix all adds the missing notes to Claude's list (one write, a backup), then takes gone lines off", async () => {
  await fresh();
  seedListDrift();
  const fake = fakePaseo(sb);
  const index = join(sb.appMemory, "MEMORY.md");
  const before = readFileSync(index, "utf8");
  const refused = await tidyFixAll(fake.api as never, { group: "duplicate" });
  assert.equal(refused.ok, false, "only the safe groups");
  assert.equal(readFileSync(index, "utf8"), before);

  const { findings } = await findingsFor(fake.api as never, true);
  const shown = findings.filter((finding) => memoryGroupKey(finding) === "index-missing" && finding.sourceIds?.[0] === sb.appMemory).map((finding) => finding.id);
  const added = await tidyFixAll(fake.api as never, { group: "index-missing", findingIds: shown });
  assert.equal(added.ok, true, added.message);
  assert.ok(shown.length >= 3);
  assert.match(added.message, new RegExp(`^Added ${shown.length} notes to Claude's list\\.`));
  const files = parseIndex(readFileSync(index, "utf8"));
  for (const [file, title, hook] of [["testing_rules.md", "Testing rules", "how we test"], ["deploy_window.md", "Deploy window", "when deploys go out"], ["code_review.md", "Code review", "who reviews what"]]) {
    const line = files.find((entry) => entry.file === file);
    assert.ok(line, file);
    assert.equal(line.title, title);
    assert.equal(line.hook, hook);
  }
  assert.ok(added.reports.length === 1 && added.reports[0]!.backupPath && existsSync(added.reports[0]!.backupPath), "one write to the list, the old one kept");
  assert.ok(added.reports[0]!.backupPath!.startsWith(backupsRoot()));

  const gone = await tidyFixAll(fake.api as never, { group: "index-gone" });
  assert.equal(gone.ok, true, gone.message);
  assert.ok(!parseIndex(readFileSync(index, "utf8")).some((entry) => entry.file === "old_plan.md"), "the line for the gone note is off");
  const after = await findingsFor(fake.api as never, true);
  assert.ok(!after.findings.some((finding) => finding.kind === "index-drift" && finding.sourceIds?.[0] === sb.appMemory), "nothing left to fix in that folder");
  const again = await tidyFixAll(fake.api as never, { group: "index-missing", findingIds: shown });
  assert.equal(again.ok, true);
  assert.match(again.message, /already sorted/);
});

test("Fix all never adds a note that's gone by the time it runs, or a line whose note came back", async () => {
  await fresh();
  seedListDrift();
  const fake = fakePaseo(sb);
  await findingsFor(fake.api as never, true);
  const { claudeIndexFix } = await import("../server/claude-memory");
  writeFileSync(join(sb.appMemory, "old_plan.md"), note("Old plan", "back again"));
  const done = await claudeIndexFix(fake.api as never, { sourceId: sb.appMemory, add: ["nope.md", "../escape.md", "testing_rules.md"], remove: ["old_plan.md"] });
  assert.equal(done.added, 1);
  assert.equal(done.removed, 0, "old_plan.md is there again: its line stays");
  const files = parseIndex(readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8")).map((entry) => entry.file);
  assert.ok(files.includes("old_plan.md") && files.includes("testing_rules.md") && !files.includes("nope.md"));
});

test("skills Fix all: every broken link to the backups in one go; unsafe kinds refused", async () => {
  await fresh();
  const skills = addSkills(sb);
  const fake = fakePaseo(skills);
  const { handleSkillsFixAll, handleSkillsInventory } = await import("../server/skill-handlers");
  const { forgetSkillCaches } = await import("../server/skills");
  forgetSkillCaches();
  const inventory = await handleSkillsInventory({ refresh: true }, { paseo: fake.api as never });
  const broken = inventory.findings.filter((finding) => finding.kind === "broken-link");
  assert.ok(broken.length >= 2, "the fixture has two broken links");
  const refused = await handleSkillsFixAll({ kind: "duplicate" }, { paseo: fake.api as never });
  assert.equal(refused.ok, false);
  const fixed = await handleSkillsFixAll({ kind: "broken-link", findingIds: broken.map((finding) => finding.id) }, { paseo: fake.api as never });
  assert.equal(fixed.ok, true, fixed.message);
  assert.match(fixed.message, new RegExp(`^Fixed all ${broken.length}\\.`));
  assert.equal(existsSync(join(skills.claudeSkills, "broken")), false);
  const after = await handleSkillsInventory({ refresh: true }, { paseo: fake.api as never });
  assert.equal(after.findings.filter((finding) => finding.kind === "broken-link").length, 0);
});

// ------------------------------------------------------------------ counts that agree

test("the Overview's counts are the tabs' badges added up, from the same groups", async () => {
  await fresh();
  const fake = fakePaseo(sb);
  const inventory = await inventoryFor(fake.api as never, true);
  const workspaces = [{ name: "app", path: sb.app }];
  const listed = listedSources(inventory.sources as never, true);
  const counts = placeCounts(inventory.sources as never, inventory.accounts as never, workspaces, true);
  const everywhereBadges = userGroups(listed, inventory.accounts as never, true).reduce((sum, group) => sum + notesIn(group.sources), 0);
  const projectBadges = projectGroups(listed, workspaces, true).reduce((sum, group) => sum + notesIn(group.sources), 0);
  assert.equal(counts.everywhere.notes, everywhereBadges);
  assert.equal(counts.projects.notes, projectBadges);
  assert.ok(counts.projects.notes > 0 && counts.everywhere.notes > 0);
  assert.ok(counts.projects.projects >= 1);
});

test("same-named projects get their parent folder; folders inside a workspace keep their own name", () => {
  const src = (id: string, projectPath: string, files = 1) => ({ id, projectPath, scope: "project", exists: true, isDirectory: true, files, kind: "claude-auto-memory", agent: "claude", path: id, readBy: [], loaded: { tokens: 0 } });
  const sources = [src("1", "/home/u/code/acme-web"), src("2", "/home/u/archive/acme-web"), src("3", "/home/u/code/acme-web/tools"), src("4", "/home/u/code/solo")] as never;
  assert.deepEqual(projectGroups(sources, [], true).map((group) => group.title).sort(), ["acme-web (in archive)", "acme-web (in code)", "solo", "tools"]);
  // A workspace's own folder takes its name; a folder inside it keeps its own (0.5.0 called both by the workspace's name).
  assert.deepEqual(projectGroups(sources, [{ name: "My site", path: "/home/u/code/acme-web" }], true).map((group) => group.title).sort(), ["My site", "acme-web", "solo", "tools"]);
  assert.deepEqual(projectGroups([src("5", "/home/u")] as never, [{ name: "My site", path: "/home/u/code/acme-web" }], true, "/home/u").map((group) => group.title), ["Your home folder"], "a file in the home folder, not a workspace's name");
  const twins = disambiguate([{ title: "web", projectPath: "/a/x/client/web" }, { title: "web", projectPath: "/b/x/client/web" }]);
  assert.deepEqual(twins.map((group) => group.title), ["web (in a/x/client)", "web (in b/x/client)"], "more of the path until they differ");
});

test("empty projects fold behind Show empty; the open one always shows", () => {
  const src = (id: string, files: number, exists = true) => ({ id, exists, isDirectory: true, files });
  const groups = [{ key: "a", sources: [src("a1", 3)] }, { key: "b", sources: [src("b1", 0)] }, { key: "c", sources: [src("c1", 2, false)] }] as unknown as Array<{ key: string; sources: never[] }>;
  const split = splitEmpty(groups);
  assert.deepEqual(split.shown.map((group) => group.key), ["a"]);
  assert.deepEqual(split.empty.map((group) => group.key), ["b", "c"]);
  assert.deepEqual(splitEmpty(groups, "b1").shown.map((group) => group.key), ["a", "b"]);
  assert.equal(PLAIN.showEmpty(2), "Show 2 empty projects");
});

// ------------------------------------------------------------------ the dot from load

test("the findings leave a summary for the sidebar; a restart reads it back from the file", async () => {
  await fresh();
  seedListDrift();
  const fake = fakePaseo(sb);
  const { findings } = await findingsFor(fake.api as never, true);
  const state = await readSidebarState();
  assert.ok(state.memories, "recorded");
  const plain = plainFindings(findings as Array<{ kind: string; severity: string; sourceIds: string[] }>, (await inventoryFor(fake.api as never)).sources as never);
  assert.equal(state.memories.plain.count, plain.length, "the count the page header shows");
  assert.equal(state.memories.plain.tone, plain.some((finding) => finding.severity === "error") ? "error" : "attention");
  const text = readFileSync(sidebarStatePath(), "utf8");
  assert.ok(!/Testing rules|testing_rules|how we test/.test(text), "only counts and kinds, never a note's name or text");
  resetSidebarState();
  assert.deepEqual((await readSidebarState()).memories, state.memories, "read back after a restart");
});

test("asking for the dot works nothing out and doesn't count as someone looking", async () => {
  await fresh();
  resetPresence();
  const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
  const server = { handle: (contract: { name: string }, fn: never) => handlers.set(contract.name, fn), registerSettings() {}, on() {}, before() {}, registerProvider() {} };
  const stop = contribute(server as never) as () => void;
  try {
    const { findingsComputations } = await import("../server/tidy");
    const computed = findingsComputations();
    const answer = (await handlers.get("paseo-memories.sidebar-status")!({}, { paseo: fakePaseo(sb).api })) as { memories: unknown; skills: unknown };
    assert.deepEqual(answer, { memories: null, skills: null }, "nothing known yet: no dot, and no work to find out");
    assert.equal(findingsComputations(), computed);
    assert.equal(clientSeenWithin(), false, "a sidebar isn't a page: background work stays asleep");
    await handlers.get("paseo-memories.inventory")!({}, { paseo: fakePaseo(sb).api });
    assert.equal(clientSeenWithin(), true, "a page call still counts");
  } finally {
    stop();
  }
});

test("client: one call seeds both rows; a page's own report wins; no second call within the window", async () => {
  status.resetSidebarStatus();
  let calls = 0;
  const summary = (count: number, tone: "attention" | "error" | null) => ({ tone, count, groups: count ? [{ key: "index-missing", count }] : [] });
  const fetch = async () => {
    calls += 1;
    return { memories: { plain: summary(4, "attention"), technical: summary(6, "attention") }, skills: { summary: summary(0, null) } };
  };
  await Promise.all([status.seedFromServer("h1", fetch, false, 1000), status.seedFromServer("h1", fetch, false, 1001)]);
  assert.equal(calls, 1, "both rows, one call");
  assert.equal(status.sidebarStatus("memories", "h1"), "attention", "the dot shows before any page opened");
  assert.equal(status.sidebarSummary("memories", "h1")?.count, 4, "plain mode's count");
  assert.equal(status.sidebarStatus("skills", "h1"), null);
  await status.seedFromServer("h1", fetch, false, 1000 + status.SEED_EVERY_MS - 1);
  assert.equal(calls, 1);
  status.reportSidebarStatus("memories", "h1", null, summary(0, null));
  assert.equal(status.sidebarStatus("memories", "h1"), null, "the page says tidy: that wins");
  await status.seedFromServer("h1", fetch, false, 1000 + status.SEED_EVERY_MS);
  assert.equal(calls, 2);
  assert.equal(status.sidebarStatus("memories", "h1"), null, "an older seed never overrides the page");
  await status.seedFromServer("h2", async () => { throw new Error("offline"); }, false, 0);
  assert.equal(status.sidebarStatus("memories", "h2"), null, "a failed read leaves no dot");
});

test("the row draws the seed from load, and the dot opens the quick popover where the app has popovers", () => {
  status.resetSidebarStatus();
  const opened: unknown[] = [];
  const Row = ({ trailing }: { trailing?: React.ReactNode }) => React.createElement("row", null, trailing);
  const Quick = () => null;
  const parts = {
    Dot: ({ label, onPress }: { label: string; color: string; onPress?: () => void }) => {
      if (onPress) onPress();
      return React.createElement("dot", { title: label, "data-pressable": String(Boolean(onPress)) });
    },
    Group: ({ children }: { children?: React.ReactNode }) => React.createElement("group", null, children),
    Seed: ({ hostId }: { hostId: string }) => React.createElement("seed", { "data-host": hostId }),
    Quick: (screenId: string) => Object.assign(Quick, { screenId }),
  };
  const Plus = ({ label }: { label: string }) => React.createElement("plus", { title: label });
  const Item = sidebarItem({ id: "memories", title: "Memories", icon: "Brain", Component: () => null, quickAdd: { label: "Add a note", Button: Plus, params: { add: "note" } } }, Row as never, parts as never) as React.ComponentType<Record<string, unknown>>;
  const props = { currentScreen: null, openScreen: () => undefined, openPopover: (content: unknown) => opened.push(content), theme: { colors: {} }, host: { id: "h1", label: "h1" } };
  const calm = renderToStaticMarkup(React.createElement(Item, props));
  assert.match(calm, /<seed data-host="h1">/, "the seed is there from load, before any page");
  assert.ok(!calm.includes("<dot"));
  assert.ok(calm.includes('title="Add a note"'), "the + stays");
  status.seedSidebarStatus("memories", "h1", { tone: "attention", count: 3, groups: [] });
  const marked = renderToStaticMarkup(React.createElement(Item, props));
  assert.match(marked, /data-pressable="true"/);
  assert.equal(opened.length, 1, "pressing the dot opens the popover");
  const noPopovers = renderToStaticMarkup(React.createElement(Item, { ...props, openPopover: undefined }));
  assert.match(noPopovers, /data-pressable="false"/, "an app without popovers: a plain dot");
});

test("the manifest has a plain description and states the Paseo that accepts it", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "paseo-plugin.json"), "utf8")) as { id: string; description?: string; requirements: { paseo: string } };
  assert.equal(manifest.id, "paseo-memories");
  assert.ok(manifest.description && manifest.description.length < 200);
  assert.deepEqual(jargonIn(manifest.description), []);
  assert.equal(manifest.requirements.paseo, ">=0.9.0", "Paseo reads `description` from 0.9.0 and refuses unknown keys before");
  assert.deepEqual(Object.keys(manifest).sort(), ["description", "id", "requirements"]);
});
