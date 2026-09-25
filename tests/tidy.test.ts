import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { fakePaseo, makeSandbox, violations, type Sandbox } from "./helpers";

let sb: Sandbox = await makeSandbox();
const { forgetAllFiles } = await import("../server/files");
const { forgetDiscovery } = await import("../server/discover");
const { resetDaemonCache } = await import("../server/daemon");
const { findingsFor } = await import("../server/tidy");
const { searchFor } = await import("../server/search");
const { forgetScans, scanSettled, scanStats, PASS_LIMITS } = await import("../server/symbols");
const { pendingSettled, forgetPendingCounts } = await import("../server/codex-pending");
const { setSqliteLoader } = await import("../server/codex-lock");
const { handleInventory } = await import("../server/read");
const tidy = await import("../shared/tidy");
const { PLAIN, jargonIn, scanProgressNote } = await import("../shared/plain");
const { compactDiff, lineDiff } = await import("../shared/diff");

const LONG = "Deploys go out every Friday afternoon after the release checklist is signed off by two people, the staging smoke tests pass, the changelog is written, and the on-call engineer has confirmed they are around for the next four hours";

async function fresh(): Promise<Sandbox> {
  sb.cleanup();
  sb = await makeSandbox();
  forgetAllFiles();
  forgetDiscovery();
  resetDaemonCache();
  forgetScans();
  forgetPendingCounts();
  return sb;
}

/** Seeds: an exact and a near duplicate, a possible conflict, a stale path and a stale code name. */
function seed(): void {
  appendFileSync(join(sb.app, "CLAUDE.md"), `\n## Deploys\n\n${LONG}.\n`);
  writeFileSync(join(sb.appMemory, "deploys.md"), `---\nname: Deploy day\ndescription: when deploys happen\ntype: project\n---\n\n${LONG}.\n`);
  writeFileSync(join(sb.plain, "AGENTS.md"), `# Plain\n\n## Deploy days\n\n${LONG.replace("four hours", "three hours")}.\n`);
  appendFileSync(join(sb.appMemory, "MEMORY.md"), "- [Deploy day](deploys.md) — when deploys happen\n- [Release process](release.md) — how we release\n");
  writeFileSync(join(sb.appMemory, "release.md"), "---\nname: Release process\ndescription: how we release\ntype: project\n---\n\nTag the release on main, then publish with `pnpm release`. Helpers live in `src/old/removed.ts` and `src/index.ts`; call `oldHelperFn()` then `renderWidget`.\n");
  appendFileSync(join(sb.codex, "AGENTS.md"), "\n## Release process\n\nNever tag releases by hand; the CI pipeline tags and publishes every merge to the stable branch automatically.\n");
  writeFileSync(join(sb.app, "src", "index.ts"), "export function renderWidget() {\n  return 1;\n}\n");
}

afterEach(() => {
  setSqliteLoader(null);
  assert.deepEqual(violations, [], "no write outside the sandbox");
});

// ------------------------------------------------------------------ pure parts

test("path and code-name mentions are picked out; prose and URLs are not", () => {
  const text = "See `src/a.ts`, ./docs/guide.md and ~/notes/x.md. Not https://x.dev/a.ts, `@scope/pkg`, `src/**/*.ts`, `<path>` or and/or.\nCall `fetchUser()` and `user_id` and `HTTPClient`; `README` and `npm` are words.";
  assert.deepEqual(tidy.pathRefs(text).sort(), ["./docs/guide.md", "src/a.ts", "~/notes/x.md"].sort());
  assert.deepEqual(tidy.symbolRefs(text).sort(), ["fetchUser", "user_id"].sort());
});

test("duplicates: exact across places, near above 80%, and nothing for short text", () => {
  const unit = (id: string, sourceId: string, text: string, title = id) => ({ id, sourceId, key: id, title, text, agent: "claude", scope: "project", kind: "claude-md", path: sourceId });
  const groups = tidy.findDuplicates([unit("a", "/1", LONG), unit("b", "/2", `**${LONG}**`), unit("c", "/3", LONG.replace("four", "three")), unit("d", "/4", "Use pnpm."), unit("e", "/5", "Use pnpm.")]);
  const exact = groups.find((group) => group.exact)!;
  assert.deepEqual(exact.units.map((u) => u.id).sort(), ["a", "b"], "markdown emphasis does not hide a copy");
  assert.ok(groups.some((group) => !group.exact && group.units.some((u) => u.id === "c") && group.score >= 0.8));
  assert.ok(!groups.some((group) => group.units.some((u) => u.id === "d")), "short text is too generic to call a duplicate");
  const conflicts = tidy.findConflicts([unit("x", "/1", "Always squash merge pull requests before release.", "Merge policy"), unit("y", "/2", "Rebase and merge, never squash, keep every commit.", "Merge policy"), unit("z", "/3", "Other.", "Testing")]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.title, "Merge policy");
});

test("the next step is the single most urgent finding", () => {
  const step = tidy.nextStep(
    [
      { kind: "duplicate", severity: "info", message: "dup", action: { label: "Delete the copy", kind: "delete" } },
      { kind: "secret", severity: "error", message: "secret here", action: { label: "Move the secret out of memory", kind: "edit" } },
    ],
    { sources: 3 },
  );
  assert.equal(step.title, "Move the secret out of memory");
  assert.match(step.detail, /1 more thing/);
  assert.equal(tidy.nextStep([], { sources: 3 }).title, "Nothing needs tidying");
});

test("line diff: append and one changed line, compacted", () => {
  const diff = lineDiff("a\nb\nc\nd\ne\n", "a\nb\nC\nd\ne\nf\n");
  assert.deepEqual(diff.filter((line) => line.op !== " ").map((line) => `${line.op}${line.text}`), ["-c", "+C", "+f"]);
  const compact = compactDiff(lineDiff(Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n"), Array.from({ length: 30 }, (_, i) => (i === 15 ? "changed" : `l${i}`)).join("\n")), 1);
  assert.equal(compact[0]!.text, "… 14 unchanged lines");
  assert.equal(compact.length, 6, "skip, context, -, +, context, skip");
});

// ------------------------------------------------------------------ findings on the fixture

test("findings: every kind on the seeded fixture, each with one action", async () => {
  await fresh();
  seed();
  const paseo = fakePaseo(sb).api;
  await pendingSettled();
  const first = await findingsFor(paseo);
  const kinds = new Set(first.findings.map((finding) => finding.kind));
  for (const kind of ["secret", "duplicate", "conflict", "stale-path", "index-drift", "over-limit", "codex-pending"]) assert.ok(kinds.has(kind), `${kind} found`);
  for (const finding of first.findings) assert.ok(finding.action?.label, `${finding.kind} has an action`);
  assert.equal(first.findings[0]!.kind, "secret", "most urgent first");
  assert.equal(first.nextStep.title, first.findings[0]!.action!.label);

  const exact = first.findings.find((finding) => finding.kind === "duplicate" && finding.message.startsWith("The same text"))!;
  assert.equal(exact.action!.kind, "delete");
  assert.equal(exact.action!.key, "deploys.md", "the memory copy is the one to delete");
  assert.ok(first.findings.some((finding) => finding.kind === "duplicate" && /nearly the same/.test(finding.message)));
  const conflict = first.findings.find((finding) => finding.kind === "conflict")!;
  assert.equal(conflict.heuristic, true);
  assert.match(conflict.message, /^Possible conflict \(a guess\): "Release process"/);
  const paths = first.findings.filter((finding) => finding.kind === "stale-path").map((finding) => finding.message);
  assert.ok(paths.some((message) => message.includes("src/old/removed.ts")));
  assert.ok(!paths.some((message) => message.includes("src/index.ts")), "a path that exists is fine");
  const drift = first.findings.filter((finding) => finding.kind === "index-drift").map((finding) => finding.entryKeys!.join());
  assert.ok(drift.includes("missing.md") && drift.includes("unindexed.md"));
  assert.match(first.findings.find((finding) => finding.kind === "codex-pending")!.message, /hasn't finished its last clean-up/);
  assert.ok(first.findings.some((finding) => finding.kind === "over-limit" && finding.message.includes("first 200 lines")));

  // Code names: the first read asks for a background scan and does not wait.
  assert.notEqual(first.symbolScan.state, "done");
  const second = await findingsFor(paseo, true);
  await scanSettled();
  const third = await findingsFor(paseo);
  assert.equal(third.symbolScan.state, "done");
  const symbols = third.findings.filter((finding) => finding.kind === "stale-symbol").map((finding) => finding.message);
  assert.ok(symbols.some((message) => message.includes("oldHelperFn")), symbols.join("\n"));
  assert.ok(!symbols.some((message) => message.includes("renderWidget")), "a name still in the code is fine");
  void second;
});

test("a scan cut short by the read budget says how many projects were checked", async () => {
  await fresh();
  seed();
  // A second project whose memory names code: it has no source files, so it needs no reads.
  appendFileSync(join(sb.plain, "AGENTS.md"), "\n## Build\n\nRun `buildPlainThing()` before a release.\n");
  const paseo = fakePaseo(sb).api;
  const budget = PASS_LIMITS.readBytes;
  PASS_LIMITS.readBytes = 0;
  try {
    await findingsFor(paseo, true);
    await scanSettled();
    const stats = scanStats();
    assert.equal(stats.unfinished, true, "the app project needs reads the budget does not allow");
    assert.ok(stats.projects >= 1 && stats.projects < stats.wanted, `${stats.projects} of ${stats.wanted}`);
    const partial = await findingsFor(paseo);
    assert.equal(partial.symbolScan.checked, stats.projects);
    assert.equal(partial.symbolScan.total, stats.wanted);
    const note = `Code names checked in ${stats.projects} of ${stats.wanted} projects so far; the rest are still being scanned.`;
    assert.equal(partial.symbolScan.note, note, "technical mode");
    assert.equal(scanProgressNote(partial.symbolScan), note, "plain mode");
    assert.deepEqual(jargonIn(note), []);
    assert.ok(!partial.findings.some((finding) => finding.kind === "stale-symbol" && finding.message.includes("oldHelperFn")), "no answer yet for the project not read");
  } finally {
    PASS_LIMITS.readBytes = budget;
  }
  await findingsFor(paseo, true);
  await scanSettled();
  const done = await findingsFor(paseo);
  assert.equal(done.symbolScan.checked, done.symbolScan.total);
  assert.equal(scanProgressNote(done.symbolScan), null, "nothing to add once every project has an answer");
  assert.match(done.symbolScan.note, /^Code names checked against \d+ projects\.$/);
  assert.ok(done.findings.some((finding) => finding.kind === "stale-symbol" && finding.message.includes("oldHelperFn")));
  assert.equal(scanProgressNote({ state: "waiting", checked: 0, total: 3 }), PLAIN.tidy.scanWaiting);
  assert.equal(scanProgressNote({ state: "off" }), null);
});

test("stale checks can be switched off; nothing opens Codex's database", async () => {
  await fresh();
  seed();
  let opened = 0;
  setSqliteLoader(async () => {
    opened += 1;
    return (await import("node:sqlite")) as never;
  });
  mkdirSync(join(sb.paseoHome, "plugin-settings", "paseo-memories"), { recursive: true });
  writeFileSync(join(sb.paseoHome, "plugin-settings", "paseo-memories", "memories.json"), JSON.stringify({ version: 1, values: { staleChecks: false } }));
  const paseo = fakePaseo(sb).api;
  const result = await findingsFor(paseo, true);
  assert.equal(result.symbolScan.state, "off");
  assert.ok(!result.findings.some((finding) => finding.kind.startsWith("stale-")));
  await handleInventory({ refresh: true }, { paseo });
  await searchFor(paseo, "deploy");
  assert.equal(opened, 0, "findings, inventory and search never open the sqlite");
});

test("stale paths are grouped by the missing folder; the secret finding reads plainly", async () => {
  await fresh();
  for (const name of ["one", "two", "three"]) {
    writeFileSync(join(sb.appMemory, `${name}.md`), `---\nname: Old ${name}\ndescription: gone\ntype: project\n---\n\nSee \`~/old-worktrees/feature-x/${name}.ts\`.\n`);
  }
  appendFileSync(join(sb.appMemory, "MEMORY.md"), "- [Old one](one.md) — gone\n- [Old two](two.md) — gone\n- [Old three](three.md) — gone\n");
  const result = await findingsFor(fakePaseo(sb).api);
  const stale = result.findings.filter((finding) => finding.kind === "stale-path");
  const group = stale.find((finding) => finding.message.includes("old-worktrees"))!;
  assert.equal(stale.filter((finding) => finding.message.includes("old-worktrees")).length, 1, "one finding for the three");
  assert.equal(group.message, "3 memories mention ~/old-worktrees/…, which no longer exists on this machine.");
  assert.equal(group.entryKeys!.length, 3);
  const secret = result.findings.find((finding) => finding.kind === "secret")!;
  assert.equal(secret.message, 'A memory in app, "Secret memory", holds 3 values that look like secrets. Every agent that loads it can see it.');
});

// ------------------------------------------------------------------ search

test("search: titles and bodies, masked snippets, and what was checked when nothing matches", async () => {
  await fresh();
  seed();
  const paseo = fakePaseo(sb).api;
  const hits = await searchFor(paseo, "friday");
  assert.ok(hits.results.length >= 3);
  for (const hit of hits.results) assert.ok(hit.snippet.length < 260, "a snippet, not a body");
  const title = await searchFor(paseo, "release process");
  assert.equal(title.results[0]!.inTitle, true);
  const secret = await searchFor(paseo, "API key");
  const snippet = secret.results.find((hit) => hit.key === "secret.md")!.snippet;
  assert.ok(snippet.includes("sk-a••••••••"));
  assert.ok(!snippet.includes("abcdefghijklmnop"));
  const inside = await searchFor(paseo, "abcdefghijklmnopqrstuvwxyz0123456789ABCD");
  assert.equal(inside.results[0]!.snippet, "(the match is inside a hidden value)");
  const none = await searchFor(paseo, "zebra-crossing");
  assert.equal(none.results.length, 0);
  assert.match(none.checked, /^Checked 3 Claude projects, 2 Codex stores and \d+ other files: none mention 'zebra-crossing'\.$/);
});

test.after(() => sb.cleanup());
