/**
 * Regression tests for the 0.6.0 review (GPT-6.1 Sol on cefc29b). Each fails
 * on cefc29b. Fixture sandbox only: never the real ~/.claude or ~/.codex.
 *
 * 1. A Move acts only on what the preview showed: a replaced origin is
 *    refused by name, and no original is removed unless byte-identical.
 * 2. One Save is one write: a repeated request id gets the first answer.
 * 3. Result words are redacted on the host, whatever "Hide secrets" says.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { afterEach } from "node:test";
import { fakePaseo, makeSandbox, violations, type Sandbox } from "./helpers";

let sb: Sandbox = await makeSandbox();
const { forgetAllFiles } = await import("../server/files");
const { forgetDiscovery } = await import("../server/discover");
const { resetDaemonCache } = await import("../server/daemon");
const { importPreview, importApply } = await import("../server/transfer");
const receipts = await import("../server/receipts");
const { handleWorkspacePlan } = await import("../server/read");
const { redactResult } = await import("../shared/redact");
const { SaveTickets, saveOutcome } = await import("../client/host-extras");
const { splitSections } = await import("../shared/markdown");

async function fresh(): Promise<Sandbox> {
  sb.cleanup();
  sb = await makeSandbox();
  forgetAllFiles();
  forgetDiscovery();
  resetDaemonCache();
  receipts.forgetInMemory();
  return sb;
}

afterEach(() => assert.deepEqual(violations, [], "no write outside the sandbox"));
test.after(() => sb.cleanup());

const seenOf = (preview: { items: Array<{ id: string; fingerprint?: string }> }) => Object.fromEntries(preview.items.flatMap((item) => (item.fingerprint ? [[item.id, item.fingerprint]] : [])));

async function plainMemoryFolder(paseo: never): Promise<string> {
  const { plans } = await handleWorkspacePlan({ workspaceId: "ws-plain" }, { paseo });
  return plans.find((plan) => plan.agent === "claude")!.items.find((item) => item.kind === "claude-auto-memory")!.path!;
}

// ------------------------------------------------------------------ 1. stale Move

test("1: a memory replaced after the preview is refused by name; the replacement stays and nothing is copied", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const flat = join(sb.appMemory, "flat.md");
  const target = join(sb.codex, "AGENTS.md");
  const from = [{ sourceId: sb.appMemory, key: "flat.md" }];
  const preview = await importPreview(paseo, { from, target: { kind: "append", path: target } });
  assert.match(preview.items[0]!.fingerprint ?? "", /^file:[0-9a-f]{64}$/);
  // Someone replaces the file between Preview and Save.
  const replacement = "---\nname: Flat memory\ndescription: Replaced\ntype: feedback\n---\n\nA DIFFERENT body nobody previewed.\n";
  writeFileSync(flat, replacement);
  const before = readFileSync(target, "utf8");
  for (const move of [true, false]) {
    const result = await importApply(paseo, { from, target: { kind: "append", path: target }, selected: preview.items.map((item) => item.id), expected: preview.target.stamp, move, seen: seenOf(preview) });
    assert.equal(result.ok, false, `move=${move}`);
    assert.match(result.message, /"Flat memory" changed since the preview/);
    assert.match(result.message, /Nothing was copied or moved/);
    assert.equal(readFileSync(flat, "utf8"), replacement, "the replacement is untouched");
    assert.equal(readFileSync(target, "utf8"), before, "nothing was copied");
  }
});

test("1: a section edited after the preview is refused; an unchanged one still moves", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const origin = join(sb.app, "CLAUDE.md");
  const target = join(sb.codex, "AGENTS.md");
  const from = [{ sourceId: origin, key: "1:testing" }];
  const preview = await importPreview(paseo, { from, target: { kind: "append", path: target } });
  assert.match(preview.items[0]!.fingerprint ?? "", /^section:[0-9a-f]{64}$/);
  const original = readFileSync(origin, "utf8");
  writeFileSync(origin, original.replace("Run pnpm test.", "Run pnpm test --coverage."));
  const refused = await importApply(paseo, { from, target: { kind: "append", path: target }, selected: preview.items.map((item) => item.id), expected: preview.target.stamp, move: true, seen: seenOf(preview) });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /changed since the preview/);
  assert.ok(readFileSync(origin, "utf8").includes("--coverage"), "the edited section stays");
  // Previewed again: it moves.
  const again = await importPreview(paseo, { from, target: { kind: "append", path: target } });
  const moved = await importApply(paseo, { from, target: { kind: "append", path: target }, selected: again.items.map((item) => item.id), expected: again.target.stamp, move: true, seen: seenOf(again) });
  assert.equal(moved.ok, true, moved.message);
  assert.ok(!splitSections(readFileSync(origin, "utf8")).some((section) => section.key === "1:testing"));
});

test("1: a copy or move without the preview's fingerprints is refused before anything is written", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const target = join(sb.codex, "AGENTS.md");
  const before = readFileSync(target, "utf8");
  const from = [{ sourceId: sb.appMemory, key: "flat.md" }];
  const preview = await importPreview(paseo, { from, target: { kind: "append", path: target } });
  const result = await importApply(paseo, { from, target: { kind: "append", path: target }, selected: preview.items.map((item) => item.id), expected: preview.target.stamp, move: true });
  assert.equal(result.ok, false);
  assert.match(result.message, /Preview first/);
  assert.equal(readFileSync(target, "utf8"), before);
  assert.ok(existsSync(join(sb.appMemory, "flat.md")));
});

// ------------------------------------------------------------------ 2. one Save, one write

test("2: the same request id twice, even at once, writes one file and gets the same answer", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const folder = await plainMemoryFolder(paseo as never);
  const target = { kind: "claude-memory", sourceId: folder, workspaceId: "ws-plain" };
  const items = [{ id: "d", title: "Review duplicate press", body: "Pressed twice.\n", masked: false, format: "markdown", warnings: [] }];
  const request = { items, target, selected: ["d"], requestId: "press-0001" };
  const [first, second] = await Promise.all([importApply(paseo, request), importApply(paseo, request)]);
  assert.equal(first.ok, true, first.message);
  assert.deepEqual(second, first);
  const third = await importApply(paseo, request);
  assert.deepEqual(third, first);
  const files = readdirSync(folder).filter((name) => name.startsWith("review_duplicate_press"));
  assert.deepEqual(files, ["review_duplicate_press.md"]);
  // The same id for a different request is refused and writes nothing.
  const other = await importApply(paseo, { ...request, items: [{ ...items[0]!, title: "Something else" }] });
  assert.equal(other.ok, false);
  assert.match(other.message, /already used/);
  assert.ok(!readdirSync(folder).some((name) => name.startsWith("something_else")));
  // A new id is a new save.
  const fresh2 = await importApply(paseo, { ...request, requestId: "press-0002" });
  assert.equal(fresh2.ok, true);
  assert.equal(readdirSync(folder).filter((name) => name.startsWith("review_duplicate_press")).length, 2);
});

test("2: the app's Save ticket: one press per preview; a dropped call retries with the same id; a refusal gets a new one", () => {
  let n = 0;
  const tickets = new SaveTickets(() => `id-${++n}`);
  assert.equal(tickets.take(), null, "no preview, no save");
  tickets.issue();
  assert.equal(tickets.take(), "id-1");
  assert.equal(tickets.take(), null, "a second press while the first is out");
  tickets.settle("retry");
  assert.equal(tickets.take(), "id-1", "a dropped call retries with the same id");
  tickets.settle("refused");
  assert.equal(tickets.take(), "id-2", "nothing was written: a new request");
  tickets.settle("done");
  assert.equal(tickets.take(), null, "written: Save needs a new preview");
  tickets.issue();
  assert.equal(tickets.take(), "id-3");
  assert.equal(saveOutcome({ ok: false, reports: [{ ok: true }, { ok: false }] }), "done", "partly written counts as written");
  assert.equal(saveOutcome({ ok: false, reports: [] }), "refused");
});

// ------------------------------------------------------------------ 3. redacted results

test("3: result words are redacted on the host: message, warnings and every report's error", async () => {
  const raw = {
    ok: false,
    message: "Could not save token=hunter22.zip",
    warnings: ["password: hunter22 is wrong"],
    reports: [{ target: "/tmp/x", ok: false, action: "refused", readBack: "skipped", error: "EACCES: open token=hunter22.zip" }],
  };
  const safe = redactResult(raw);
  assert.ok(!JSON.stringify(safe).includes("hunter22"), JSON.stringify(safe));
  assert.equal(safe.reports[0]!.target, "/tmp/x");
  assert.deepEqual(redactResult({ items: [1] }), { items: [1] }, "not a result: untouched");
  // A real refusal that quotes a title holding a key.
  await fresh();
  const paseo = fakePaseo(sb).api;
  const flat = join(sb.appMemory, "flat.md");
  writeFileSync(flat, "---\nname: token=hunter22.zip\ndescription: d\ntype: feedback\n---\n\nBody.\n");
  const target = join(sb.codex, "AGENTS.md");
  const from = [{ sourceId: sb.appMemory, key: "flat.md" }];
  const preview = await importPreview(paseo, { from, target: { kind: "append", path: target } });
  writeFileSync(flat, readFileSync(flat, "utf8") + "Changed.\n");
  const refused = redactResult(await importApply(paseo, { from, target: { kind: "append", path: target }, selected: preview.items.map((item) => item.id), expected: preview.target.stamp, seen: seenOf(preview) }));
  assert.equal(refused.ok, false);
  assert.ok(!refused.message.includes("hunter22"), refused.message);
});

// ------------------------------------------------------------------ 0.6.0 final review: one race-free way files change

const { swapHooks, safeDelete, safeWrite, moveToBackup, newSession, readCurrent, LOCAL_BACKUP_DIR } = await import("../server/write");
const { claudeCreate } = await import("../server/claude-memory");
const { STATE_LIMITS, statePath } = await import("../server/state-file");

/** Every file under `.memories-backup` beside `dir`. */
function backups(dir: string): string[] {
  const root = join(dir, LOCAL_BACKUP_DIR);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name !== ".gitignore").flatMap((stamp) => readdirSync(join(root, stamp)).filter((name) => name !== ".paseo-memories-backup.json").map((name) => join(root, stamp, name)));
}
const texts = (dir: string) => backups(dir).map((path) => (lstatSync(path).isSymbolicLink() ? `link→${readlinkSync(path)}` : readFileSync(path, "utf8"))).sort();
function hooks(set: Partial<typeof swapHooks>) {
  Object.assign(swapHooks, set);
  return () => {
    swapHooks.beforeSetAside = undefined;
    swapHooks.afterSetAside = undefined;
    swapHooks.beforeInstall = undefined;
  };
}

// H1: removing (and restoring) a file -----------------------------------------------------------

test("H1 remove: an edit right before the set-aside is caught and put back; nothing removed, the user told", async () => {
  await fresh();
  const flat = join(sb.appMemory, "flat.md");
  const seen = await readCurrent(flat);
  const done = hooks({ beforeSetAside: () => writeFileSync(flat, "edited\n") });
  const report = await safeDelete(newSession(5), flat, seen).finally(done);
  assert.equal(report.ok, false);
  assert.match(String(report.error), /changed while it was being removed/);
  assert.equal(readFileSync(flat, "utf8"), "edited\n");
});

test("H1 remove: a new file made right after the set-aside stays; the checked one is removed into the backup", async () => {
  await fresh();
  const flat = join(sb.appMemory, "flat.md");
  const original = readFileSync(flat, "utf8");
  const done = hooks({ afterSetAside: () => writeFileSync(flat, "brand new\n") });
  const report = await safeDelete(newSession(5), flat, await readCurrent(flat)).finally(done);
  assert.equal(report.ok, true, String(report.error));
  assert.equal(readFileSync(flat, "utf8"), "brand new\n", "theirs stays");
  assert.deepEqual(texts(sb.appMemory), [original]);
});

test("H1 restore: an edit before AND a new file after the set-aside: both kept, the user told exactly where (never overwritten)", async () => {
  await fresh();
  const flat = join(sb.appMemory, "flat.md");
  const seen = await readCurrent(flat);
  const done = hooks({ beforeSetAside: () => writeFileSync(flat, "edited\n"), afterSetAside: () => writeFileSync(flat, "brand new\n") });
  const report = await safeDelete(newSession(5), flat, seen).finally(done);
  assert.equal(report.ok, false);
  assert.equal(readFileSync(flat, "utf8"), "brand new\n");
  assert.equal(readFileSync(report.keptAt!, "utf8"), "edited\n");
  assert.match(String(report.error), /a new flat\.md appeared at its place meanwhile.*Kept: the version found in ~\//);
  assert.deepEqual(report.kept, [report.keptAt], "only what exists is listed");
});

test("H1 remove: no backup folder (EACCES), nothing removed", async () => {
  await fresh();
  const flat = join(sb.appMemory, "flat.md");
  const original = readFileSync(flat, "utf8");
  mkdirSync(join(sb.appMemory, LOCAL_BACKUP_DIR), { mode: 0o500 });
  try {
    const report = await safeDelete(newSession(5), flat, await readCurrent(flat));
    assert.equal(report.ok, false);
    assert.match(String(report.error), /Couldn't make a backup folder/);
  } finally {
    chmodSync(join(sb.appMemory, LOCAL_BACKUP_DIR), 0o700);
  }
  assert.equal(readFileSync(flat, "utf8"), original);
});

// H2: replacing a file (Move's section trims, Import, Fix all, every save) ------------------------

for (const step of ["beforeSetAside", "afterSetAside", "beforeInstall"] as const) {
  test(`H2 replace: an editor at ${step}: nothing lost, never overwritten, the user told`, async () => {
    await fresh();
    const path = join(sb.app, "CLAUDE.md");
    const original = readFileSync(path, "utf8");
    const current = await readCurrent(path);
    const theirs = step === "beforeSetAside" ? `${original}Edited.\n` : "Theirs, written meanwhile.\n";
    const done = hooks({ [step]: () => writeFileSync(path, theirs) });
    const report = await safeWrite(newSession(5), path, "# Ours\n", { newMode: 0o644, current }).finally(done);
    assert.equal(report.ok, false);
    assert.equal(readFileSync(path, "utf8"), theirs, "theirs is in place");
    if (step === "beforeSetAside") {
      assert.match(String(report.error), /changed while it was being saved/);
      assert.deepEqual(backups(sb.app), [], "put back; nothing else changed");
    } else {
      assert.match(String(report.error), /Someone saved CLAUDE\.md while this was saving\. Theirs is kept/);
      assert.deepEqual(texts(sb.app), ["# Ours\n", original].sort(), "ours as .paseo-new and the version before as .bak");
    }
  });
}

test("H2 replace: a Move's section trim with an editor right after the set-aside keeps everything; the copy stays", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const origin = join(sb.app, "CLAUDE.md");
  const target = join(sb.codex, "AGENTS.md");
  const original = readFileSync(origin, "utf8");
  const from = [{ sourceId: origin, key: "1:testing" }];
  const preview = await importPreview(paseo, { from, target: { kind: "append", path: target } });
  const done = hooks({ afterSetAside: (path) => void (path === origin && writeFileSync(origin, original.replace("Project rules.", "Project RULES."))) });
  const result = await importApply(paseo, { from, target: { kind: "append", path: target }, selected: preview.items.map((item) => item.id), expected: preview.target.stamp, move: true, seen: seenOf(preview) }).finally(done);
  assert.equal(result.ok, false);
  assert.match(result.message, /changed during the move/);
  assert.ok(readFileSync(origin, "utf8").includes("Project RULES.") && readFileSync(origin, "utf8").includes("## Testing"));
  assert.ok(readFileSync(target, "utf8").includes("## Testing"), "the copy stays");
  assert.ok(texts(sb.app).includes(original), "the version before is in the backup");
});

test("H2 install fails (EIO): the old file goes back, never left missing", async () => {
  await fresh();
  const path = join(sb.app, "CLAUDE.md");
  const original = readFileSync(path, "utf8");
  const done = hooks({ beforeInstall: () => { throw Object.assign(new Error("disk said no"), { code: "EIO" }); } });
  const report = await safeWrite(newSession(5), path, "# Ours\n", { newMode: 0o644, current: await readCurrent(path) }).finally(done);
  assert.equal(report.ok, false);
  assert.equal(readFileSync(path, "utf8"), original);
});

// H3: removing a skill link ------------------------------------------------------------------

async function linkFixture() {
  await fresh();
  const home = join(sb.home, ".agents", "skills");
  mkdirSync(join(home, "linked-target"), { recursive: true });
  writeFileSync(join(home, "linked-target", "SKILL.md"), "---\nname: linked-target\ndescription: d\n---\n\nBody.\n");
  const link = join(sb.claude, "skills", "linked-one");
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(join(home, "linked-target"), link);
  return { link, dir: dirname(link) };
}

test("H3 link: replaced by a regular file right before the set-aside: put back, nothing removed, the user told", async () => {
  const { link } = await linkFixture();
  const done = hooks({ beforeSetAside: (path) => void (path === link && (rmSync(link), writeFileSync(link, "a real file now\n"))) });
  const report = await moveToBackup(newSession(5), link).finally(done);
  assert.equal(report.ok, false);
  assert.match(String(report.error), /changed while it was being removed.*Nothing was changed/);
  assert.equal(readFileSync(link, "utf8"), "a real file now\n");
});

test("H3 link: pointed elsewhere right before the set-aside: put back as it now is", async () => {
  const { link } = await linkFixture();
  const done = hooks({ beforeSetAside: (path) => void (path === link && (rmSync(link), symlinkSync("/somewhere/else", link))) });
  const report = await moveToBackup(newSession(5), link).finally(done);
  assert.equal(report.ok, false);
  assert.equal(readlinkSync(link), "/somewhere/else");
});

test("H3 link: a new file right after the set-aside stays; the checked link is removed into the backup", async () => {
  const { link, dir } = await linkFixture();
  const done = hooks({ afterSetAside: (path) => void (path === link && writeFileSync(link, "made meanwhile\n")) });
  const report = await moveToBackup(newSession(5), link).finally(done);
  assert.equal(report.ok, true, String(report.error));
  assert.equal(readFileSync(link, "utf8"), "made meanwhile\n");
  assert.ok(texts(dir).some((text) => text.startsWith("link→")), "the link itself is in the backup");
});

test("H3 link: retargeted before AND a new file after: both kept, said exactly", async () => {
  const { link } = await linkFixture();
  const done = hooks({ beforeSetAside: (path) => void (path === link && (rmSync(link), symlinkSync("/somewhere/else", link))), afterSetAside: (path) => void (path === link && writeFileSync(link, "made meanwhile\n")) });
  const report = await moveToBackup(newSession(5), link).finally(done);
  assert.equal(report.ok, false);
  assert.equal(readFileSync(link, "utf8"), "made meanwhile\n");
  assert.equal(readlinkSync(report.keptAt!), "/somewhere/else");
});

// Notes: the index -------------------------------------------------------------------------

test("an index (MEMORY.md) that can't be updated keeps the new note and says so", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const index = join(sb.appMemory, "MEMORY.md");
  rmSync(index);
  mkdirSync(index);
  forgetAllFiles();
  const result = await claudeCreate(paseo, { sourceId: sb.appMemory, name: "Kept note", description: "stays", body: "Kept.\n" });
  assert.equal(result.ok, false);
  assert.match(result.message, /^Saved kept_note\.md but couldn't update the index \(MEMORY\.md\)/);
  assert.ok(readFileSync(join(sb.appMemory, "kept_note.md"), "utf8").includes("Kept."), "the note was kept");
});

// Receipts --------------------------------------------------------------------------------

test("receipts: the intent is on disk before the work runs; a retry after a restart gets the same answer (no _2)", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const folder = await plainMemoryFolder(paseo as never);
  const target = { kind: "claude-memory", sourceId: folder, workspaceId: "ws-plain" };
  const items = [{ id: "r", title: "Restart replay", body: "Once.\n", masked: false, format: "markdown", warnings: [] }];
  let startedBeforeWork = false;
  const first = await receipts.once("app-session-one", "press-intent", "s", async () => {
    startedBeforeWork = JSON.parse(readFileSync(statePath("import-receipts"), "utf8")).receipts && (await receipts.receiptCounts()).started === 1;
    return importApply(paseo, { items, target, selected: ["r"] });
  });
  assert.equal(first.ok, true, first.message);
  assert.equal(startedBeforeWork, true, "a started receipt was on disk before the work");
  const request = { items, target, selected: ["r"], requestId: "press-restart", clientId: "app-session-one" };
  const saved = await importApply(paseo, request);
  receipts.forgetInMemory();
  assert.deepEqual(await importApply(paseo, request), JSON.parse(JSON.stringify(saved)));
  assert.equal(readdirSync(folder).filter((name) => name.startsWith("restart_replay") && name !== "restart_replay.md").length, 1, "one from each press id, no _3");
});

test("receipts: no receipt, no work: a read-only state folder or the size limit refuses the import", async () => {
  await fresh();
  let runs = 0;
  const work = async () => (runs += 1, { ok: true, message: "ran", reports: [], warnings: [] });
  const state = dirname(statePath("import-receipts"));
  mkdirSync(state, { recursive: true });
  chmodSync(state, 0o500);
  try {
    const refused = await receipts.once("app-a", "press-ro", "s", work);
    assert.equal(refused.message, receipts.NO_RECORD);
  } finally {
    chmodSync(state, 0o700);
  }
  receipts.forgetInMemory();
  const limit = STATE_LIMITS.maxBytes;
  STATE_LIMITS.maxBytes = 50;
  try {
    const refused = await receipts.once("app-a", "press-big", "s", work);
    assert.equal(refused.message, receipts.NO_RECORD);
  } finally {
    STATE_LIMITS.maxBytes = limit;
  }
  assert.equal(runs, 0, "nothing ran without a receipt");
});

test("receipts: a crash after 'started' (restart, no 'finished'): the retry says it may have run, and doesn't run it", async () => {
  await fresh();
  let runs = 0;
  void receipts.once("app-a", "press-crash", "s", () => (runs += 1, new Promise(() => undefined)), "~/.codex/AGENTS.md");
  for (let i = 0; i < 100 && runs === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runs, 1);
  receipts.forgetInMemory();
  const retry = await receipts.once("app-a", "press-crash", "s", async () => (runs += 1, { ok: true, message: "ran again", reports: [], warnings: [] }));
  assert.equal(runs, 1, "not run again");
  assert.equal(retry.ok, false);
  assert.match(retry.message, /may have already run.*Check ~\/\.codex\/AGENTS\.md before trying again/);
});

test("receipts: at most 10 run at once (more are told to try again); a running one is joined, not run twice", async () => {
  await fresh();
  const resolvers: Array<() => void> = [];
  let runs = 0;
  const slow = () => {
    runs += 1;
    return new Promise<{ ok: boolean; message: string; reports: never[]; warnings: never[] }>((resolve) => resolvers.push(() => resolve({ ok: true, message: "done", reports: [], warnings: [] })));
  };
  const running = Array.from({ length: receipts.PENDING_MAX }, (_, i) => receipts.once("app-a", `press-${i}`, "s", slow));
  const busy = await receipts.once("app-a", "press-extra", "s", slow);
  assert.equal(busy.message, receipts.BUSY);
  for (let i = 0; i < 300 && runs < receipts.PENDING_MAX; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const joined = receipts.once("app-a", "press-0", "s", slow);
  assert.equal(runs, receipts.PENDING_MAX, "the repeat joined the running one");
  resolvers.forEach((resolve) => resolve());
  await Promise.all([...running, joined]);
  assert.equal((await receipts.receiptCounts()).running, 0);
});

test("receipts: kept 24 hours, at most 500, pruned on write", async () => {
  await fresh();
  const now = Date.now();
  await receipts.rememberAt("old", now - receipts.RECEIPT_TTL_MS - 1000);
  for (let i = 0; i < receipts.RECEIPTS_MAX + 10; i += 1) await receipts.rememberAt(`k${i}`, now - (receipts.RECEIPTS_MAX + 10 - i));
  assert.equal((await receipts.receiptCounts()).kept, receipts.RECEIPTS_MAX);
});

// ------------------------------------------------------------------ 0.6.0 final gate: the four blockers

const { installSkillFolder, installHooks, createExclusive, removeOwned } = await import("../server/write");

test("B1 (repro): removing a skill folder holding SKILL.md AND SKILL.md.bak keeps both, byte for byte", async () => {
  await fresh();
  const shared = join(sb.home, ".agents", "skills");
  const skill = join(shared, "two-files");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: two-files\ndescription: d\n---\n\nCurrent.\n");
  writeFileSync(join(skill, "SKILL.md.bak"), "An older copy the user kept.\n");
  const report = await moveToBackup(newSession(5), skill);
  assert.equal(report.ok, true, String(report.error));
  assert.equal(readFileSync(join(report.backupPath!, "SKILL.md.bak"), "utf8"), "An older copy the user kept.\n");
  assert.match(readFileSync(join(report.backupPath!, "SKILL.md"), "utf8"), /Current\./);
});

test("B1: every operation sets aside into its own fresh folder, so two quick saves never share one", async () => {
  await fresh();
  const path = join(sb.app, "CLAUDE.md");
  const one = await safeWrite(newSession(5), path, "# One\n", { newMode: 0o644, current: await readCurrent(path) });
  const two = await safeWrite(newSession(5), path, "# Two\n", { newMode: 0o644, current: await readCurrent(path) });
  assert.ok(one.ok && two.ok);
  assert.notEqual(dirname(one.backupPath!), dirname(two.backupPath!));
  assert.equal(readFileSync(two.backupPath!, "utf8"), "# One\n");
});

test("B2 (repro): a user's SKILL.md made before the install's own survives; only what the install made is taken back", async () => {
  await fresh();
  const parent = join(sb.home, ".agents", "skills");
  mkdirSync(parent, { recursive: true });
  const files = [
    { path: "scripts/run.sh", bytes: Buffer.from("#!/bin/sh\n"), executable: true },
    { path: "SKILL.md", bytes: Buffer.from("---\nname: racing\ndescription: d\n---\n\nOurs.\n"), executable: false },
  ];
  installHooks.beforePlace = (path) => void (path.endsWith("/racing/SKILL.md") && writeFileSync(path, "The user's own.\n"));
  const report = await installSkillFolder(parent, "racing", files).finally(() => (installHooks.beforePlace = undefined));
  assert.equal(report.ok, false);
  assert.match(String(report.error), /SKILL\.md appeared in the new folder.*left as it is/);
  assert.equal(readFileSync(join(parent, "racing", "SKILL.md"), "utf8"), "The user's own.\n", "theirs survives");
  assert.equal(existsSync(join(parent, "racing", "scripts")), false, "what the install made is gone");
  assert.deepEqual(report.kept, [join(parent, "racing")]);
});

test("B2: removeOwned takes back only entries still ours, never recursively, and says what it left", async () => {
  await fresh();
  const base = join(sb.home, "owned-test");
  mkdirSync(base);
  const made: Parameters<typeof removeOwned>[0] extends readonly (infer T)[] ? T[] : never = [];
  await createExclusive(join(base, "dir"), { dir: true, mode: 0o755 }, made);
  await createExclusive(join(base, "dir", "ours.txt"), { bytes: "ours\n", mode: 0o644 }, made);
  await createExclusive(join(base, "dir", "replaced.txt"), { bytes: "ours\n", mode: 0o644 }, made);
  // Someone replaces one of ours (a new inode) and adds a file of their own.
  rmSync(join(base, "dir", "replaced.txt"));
  writeFileSync(join(base, "dir", "replaced.txt"), "theirs\n");
  writeFileSync(join(base, "dir", "extra.txt"), "theirs too\n");
  const left = await removeOwned(made);
  assert.equal(existsSync(join(base, "dir", "ours.txt")), false);
  assert.equal(readFileSync(join(base, "dir", "replaced.txt"), "utf8"), "theirs\n");
  assert.equal(readFileSync(join(base, "dir", "extra.txt"), "utf8"), "theirs too\n");
  assert.deepEqual(left.sort(), [join(base, "dir"), join(base, "dir", "replaced.txt")].sort());
  assert.ok(readdirSync(base).every((name) => !name.startsWith(".paseo-memories-tmp-")), "no temp folders left");
});

test("B3 (repro): a 'finished' receipt too big for the file keeps 'started'; a retry never runs again", async () => {
  await fresh();
  const limit = STATE_LIMITS.maxBytes;
  STATE_LIMITS.maxBytes = 4000;
  let runs = 0;
  // Each message is cut to 400 characters when redacted, so many warnings make an answer bigger than the file allows.
  const work = async () => (runs += 1, { ok: true, message: "done", reports: [], warnings: Array.from({ length: 20 }, (_, i) => `warning ${i} ${"x".repeat(380)}`) });
  try {
    const first = await receipts.once("app-a", "press-big-answer", "s", work, "~/.codex/AGENTS.md");
    assert.equal(first.ok, true, "the work ran once and answered");
    assert.equal((await receipts.receiptCounts()).started, 1, "'started' kept in memory");
    const retry = await receipts.once("app-a", "press-big-answer", "s", work);
    assert.match(retry.message, /may have already run/);
    receipts.forgetInMemory();
    const afterRestart = await receipts.once("app-a", "press-big-answer", "s", work);
    assert.match(afterRestart.message, /may have already run.*~\/\.codex\/AGENTS\.md/);
  } finally {
    STATE_LIMITS.maxBytes = limit;
  }
  assert.equal(runs, 1);
});

test("B3: old receipts are trimmed before 'started' is written, and a 'started' one is never trimmed", async () => {
  await fresh();
  const now = Date.now();
  for (let i = 0; i < 20; i += 1) await receipts.rememberAt(`old-${i}`, now - 1000 + i);
  const limit = STATE_LIMITS.maxBytes;
  STATE_LIMITS.maxBytes = 3000;
  try {
    void receipts.once("app-a", "press-hang", "s", () => new Promise(() => undefined));
    for (let i = 0; i < 100 && (await receipts.receiptCounts()).started === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const counts = await receipts.receiptCounts();
    assert.equal(counts.started, 1, "the new 'started' got in by trimming old finished ones");
    assert.ok(counts.kept < 21);
    for (let i = 0; i < 10; i += 1) await receipts.rememberAt(`newer-${i}`, now + i);
    assert.equal((await receipts.receiptCounts()).started, 1, "still there after more saves");
  } finally {
    STATE_LIMITS.maxBytes = limit;
  }
});

test("B4: ENOSPC while putting the new version in place: the old one is back, nothing else claimed", async () => {
  await fresh();
  const path = join(sb.app, "CLAUDE.md");
  const original = readFileSync(path, "utf8");
  const done = hooks({ beforeInstall: () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); } });
  const report = await safeWrite(newSession(5), path, "# Ours\n", { newMode: 0o644, current: await readCurrent(path) }).finally(done);
  assert.equal(report.ok, false);
  assert.equal(readFileSync(path, "utf8"), original);
  assert.equal(report.error, "CLAUDE.md couldn't be saved (The disk is full.). Nothing was changed.");
  assert.equal(report.kept, undefined, "no path that doesn't exist");
  assert.deepEqual(backups(sb.app), []);
});

test("B4: EACCES on the backup folder: refused, nothing claimed", async () => {
  await fresh();
  const path = join(sb.app, "CLAUDE.md");
  mkdirSync(join(sb.app, LOCAL_BACKUP_DIR), { mode: 0o500 });
  try {
    const report = await safeWrite(newSession(5), path, "# Ours\n", { newMode: 0o644, current: await readCurrent(path) });
    assert.equal(report.ok, false);
    assert.match(String(report.error), /^Couldn't make a backup folder beside CLAUDE\.md \(No permission.*\), so it wasn't saved\. Nothing was changed\.$/);
    assert.equal(report.kept, undefined);
  } finally {
    chmodSync(join(sb.app, LOCAL_BACKUP_DIR), 0o700);
  }
});

test("B4: a collision names both kept versions, both of which exist, each to copy", async () => {
  await fresh();
  const path = join(sb.app, "CLAUDE.md");
  const original = readFileSync(path, "utf8");
  const done = hooks({ afterSetAside: () => writeFileSync(path, "Theirs.\n") });
  const report = await safeWrite(newSession(5), path, "# Ours\n", { newMode: 0o644, current: await readCurrent(path) }).finally(done);
  assert.equal(report.ok, false);
  assert.equal(report.kept?.length, 2);
  assert.ok(report.kept!.every((kept) => existsSync(kept)));
  assert.equal(readFileSync(report.kept!.find((kept) => kept.endsWith(".paseo-new"))!, "utf8"), "# Ours\n");
  assert.equal(readFileSync(report.kept!.find((kept) => kept.endsWith(".bak"))!, "utf8"), original);
  assert.match(String(report.error), /^Someone saved CLAUDE\.md while this was saving\. Theirs is kept\. Kept: this change in ~\/.*CLAUDE\.md\.paseo-new, and the version found in ~\/.*CLAUDE\.md\.bak\.$/);
  assert.equal(readFileSync(path, "utf8"), "Theirs.\n");
});

// ------------------------------------------------------------------ 0.6.0 final gate 2: pruning and rename reports

const { renameInPlace, BACKUP_MARKER } = await import("../server/write");

/** The backup folders under `.memories-backup` beside `dir` (names only). */
const folders = (dir: string) => (existsSync(join(dir, LOCAL_BACKUP_DIR)) ? readdirSync(join(dir, LOCAL_BACKUP_DIR)).filter((name) => name !== ".gitignore").sort() : []);

test("P1 (repro): a user folder named like a backup, without this plugin's signed marker, is never pruned", async () => {
  await fresh();
  const path = join(sb.app, "CLAUDE.md");
  const user = join(sb.app, LOCAL_BACKUP_DIR, "2001-01-01T00-00-00-000Z-ABC123");
  mkdirSync(user, { recursive: true });
  writeFileSync(join(user, "SKILL.md"), "The user's own file.\n");
  // A copied or forged marker isn't trusted either.
  const forged = join(sb.app, LOCAL_BACKUP_DIR, "2001-01-02T00-00-00-000Z-XYZ789");
  mkdirSync(forged);
  writeFileSync(join(forged, "notes.md"), "Also theirs.\n");
  writeFileSync(join(forged, BACKUP_MARKER), JSON.stringify({ version: 1, instance: "x", folder: "2001-01-02T00-00-00-000Z-XYZ789", created: "2001-01-02T00:00:00.000Z", entries: [{ path: "notes.md", dev: 1, ino: 1, type: "file" }], signature: "00" }));
  for (const text of ["# One\n", "# Two\n", "# Three\n"]) {
    const report = await safeWrite(newSession(1), path, text, { newMode: 0o644, current: await readCurrent(path) });
    assert.equal(report.ok, true, String(report.error));
  }
  assert.equal(readFileSync(join(user, "SKILL.md"), "utf8"), "The user's own file.\n");
  assert.equal(readFileSync(join(forged, "notes.md"), "utf8"), "Also theirs.\n");
});

test("P1: a normal prune keeps the newest signed folders and takes back exactly what each listed", async () => {
  await fresh();
  const path = join(sb.app, "CLAUDE.md");
  for (const text of ["# One\n", "# Two\n", "# Three\n", "# Four\n"]) await safeWrite(newSession(2), path, text, { newMode: 0o644, current: await readCurrent(path) });
  const left = folders(sb.app);
  assert.equal(left.length, 2, left.join(", "));
  const kept = left.map((name) => readFileSync(join(sb.app, LOCAL_BACKUP_DIR, name, "CLAUDE.md.bak"), "utf8")).sort();
  assert.deepEqual(kept, ["# Three\n", "# Two\n"], "the two newest earlier versions");
  for (const name of left) assert.ok(existsSync(join(sb.app, LOCAL_BACKUP_DIR, name, BACKUP_MARKER)));
});

test("P1: a signed folder holding something this plugin didn't put there is left whole", async () => {
  await fresh();
  const path = join(sb.app, "CLAUDE.md");
  await safeWrite(newSession(1), path, "# One\n", { newMode: 0o644, current: await readCurrent(path) });
  const [first] = folders(sb.app);
  writeFileSync(join(sb.app, LOCAL_BACKUP_DIR, first!, "mine.txt"), "The user's.\n");
  await safeWrite(newSession(1), path, "# Two\n", { newMode: 0o644, current: await readCurrent(path) });
  assert.equal(readFileSync(join(sb.app, LOCAL_BACKUP_DIR, first!, "mine.txt"), "utf8"), "The user's.\n");
  assert.ok(existsSync(join(sb.app, LOCAL_BACKUP_DIR, first!, "CLAUDE.md.bak")), "nothing in it taken");
});

test("P1: a set-aside skill folder is pruned entry by entry (children first), never recursively", async () => {
  await fresh();
  const shared = join(sb.home, ".agents", "skills");
  for (const name of ["old-one", "old-two"]) {
    mkdirSync(join(shared, name, "scripts"), { recursive: true });
    writeFileSync(join(shared, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
    writeFileSync(join(shared, name, "scripts", "x.sh"), "#!/bin/sh\n");
  }
  const one = await moveToBackup(newSession(1), join(shared, "old-one"));
  const two = await moveToBackup(newSession(1), join(shared, "old-two"));
  assert.ok(one.ok && two.ok);
  assert.equal(existsSync(one.backupPath!), false, "the older backup was taken back entry by entry");
  assert.ok(existsSync(join(two.backupPath!, "scripts", "x.sh")), "the newest is kept");
  assert.equal(folders(shared).length, 1);
});

test("P1: a folder an operation left empty (the change was put back) is removed at once", async () => {
  await fresh();
  const flat = join(sb.appMemory, "flat.md");
  const seen = await readCurrent(flat);
  const done = hooks({ beforeSetAside: () => writeFileSync(flat, "edited\n") });
  await safeDelete(newSession(5), flat, seen).finally(done);
  assert.deepEqual(folders(sb.appMemory), []);
});

test("P2 (repro): a rename whose new name is taken meanwhile reports what is really there, .paseo-new included", async () => {
  await fresh();
  const from = join(sb.appMemory, "flat.md");
  const to = join(sb.appMemory, "Rename.md");
  const original = readFileSync(from, "utf8");
  const done = hooks({ beforeInstall: (path) => void (path === to && writeFileSync(to, "Theirs.\n")) });
  const report = await renameInPlace(newSession(5), from, to, await readCurrent(from)).finally(done);
  assert.equal(report.ok, false);
  assert.equal(readFileSync(from, "utf8"), original, "the original is where it was");
  assert.equal(readFileSync(to, "utf8"), "Theirs.\n");
  assert.ok(report.kept?.some((path) => path.endsWith("Rename.md.paseo-new") && existsSync(path)), JSON.stringify(report.kept));
  assert.ok((report.kept ?? []).every((path) => existsSync(path)), "only paths that exist");
  assert.equal(report.backupPath, undefined, "the .bak went back to its name, so it isn't named");
  assert.match(String(report.error), /^Rename\.md appeared in that folder meanwhile, so nothing was renamed\. flat\.md is where it was\. Kept: this change in ~\/.*Rename\.md\.paseo-new\.$/);
});

test("P2 (repro): ENOSPC making the new name: the original is back, and nothing false is said", async () => {
  await fresh();
  const from = join(sb.appMemory, "flat.md");
  const to = join(sb.appMemory, "Rename.md");
  const original = readFileSync(from, "utf8");
  const done = hooks({ beforeInstall: (path) => { if (path === to) throw Object.assign(new Error("no space"), { code: "ENOSPC" }); } });
  const report = await renameInPlace(newSession(5), from, to, await readCurrent(from)).finally(done);
  assert.equal(report.ok, false);
  assert.equal(readFileSync(from, "utf8"), original);
  assert.equal(existsSync(to), false);
  assert.equal(report.error, "Rename.md couldn't be made (The disk is full.), so nothing was renamed. flat.md is where it was. Nothing was changed.");
  assert.equal(report.backupPath, undefined);
  assert.equal(report.kept, undefined);
});

// ------------------------------------------------------------------ 0.6.0 narrow gate: replaced ancestors, and restores that didn't happen

test("G1 (repro): a backup moved back into live skills and replaced by a link is never pruned through that link", async () => {
  await fresh();
  const shared = join(sb.home, ".agents", "skills");
  for (const name of ["one", "two"]) {
    mkdirSync(join(shared, name, "scripts"), { recursive: true });
    writeFileSync(join(shared, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n\nLive ${name}.\n`);
    writeFileSync(join(shared, name, "scripts", "x.sh"), "#!/bin/sh\n");
  }
  const first = await moveToBackup(newSession(5), join(shared, "one"));
  assert.equal(first.ok, true, String(first.error));
  // The user puts `one` back by hand, and something replaces `one.bak` with a link to the restored, live skill.
  renameSync(first.backupPath!, join(shared, "one"));
  symlinkSync(join(shared, "one"), first.backupPath!);
  const second = await moveToBackup(newSession(1), join(shared, "two"));
  assert.equal(second.ok, true, String(second.error));
  assert.match(readFileSync(join(shared, "one", "SKILL.md"), "utf8"), /Live one\./, "the live skill survives");
  assert.ok(existsSync(join(shared, "one", "scripts", "x.sh")));
  assert.ok(lstatSync(first.backupPath!).isSymbolicLink(), "the old backup folder is left untouched");
  assert.equal(readdirSync(join(shared, LOCAL_BACKUP_DIR)).some((name) => name.startsWith(".trash-")), false, "no trash left behind");
});

test("G1: a backup folder that was itself swapped for another (or for a link) is left whole", async () => {
  await fresh();
  const path = join(sb.app, "CLAUDE.md");
  await safeWrite(newSession(5), path, "# One\n", { newMode: 0o644, current: await readCurrent(path) });
  const root = join(sb.app, LOCAL_BACKUP_DIR);
  const [first] = folders(sb.app);
  // Same name, a different folder (new inode) holding a copy of the marker and a user file.
  renameSync(join(root, first!), join(sb.app, "elsewhere"));
  mkdirSync(join(root, first!));
  writeFileSync(join(root, first!, "CLAUDE.md.bak"), "The user's file, same name.\n");
  writeFileSync(join(root, first!, BACKUP_MARKER), readFileSync(join(sb.app, "elsewhere", BACKUP_MARKER)));
  await safeWrite(newSession(1), path, "# Two\n", { newMode: 0o644, current: await readCurrent(path) });
  assert.equal(readFileSync(join(root, first!, "CLAUDE.md.bak"), "utf8"), "The user's file, same name.\n");
});

test("G2 (repro): different content at the original AND the new name: never 'where it was'; the original kept, both named", async () => {
  await fresh();
  const from = join(sb.appMemory, "flat.md");
  const to = join(sb.appMemory, "Rename.md");
  const original = readFileSync(from, "utf8");
  const done = hooks({ beforeInstall: (path) => void (path === to && (writeFileSync(from, "Someone else's flat.\n"), writeFileSync(to, "Theirs.\n"))) });
  const report = await renameInPlace(newSession(5), from, to, await readCurrent(from)).finally(done);
  assert.equal(report.ok, false);
  assert.equal(readFileSync(from, "utf8"), "Someone else's flat.\n");
  assert.doesNotMatch(String(report.error), /is where it was/);
  assert.match(String(report.error), /^Rename\.md appeared in that folder meanwhile, so nothing was renamed\. Your original is kept at ~\/.*flat\.md\.bak; flat\.md now holds a different version\./);
  const bak = report.kept!.find((path) => path.endsWith("flat.md.bak"))!;
  assert.equal(readFileSync(bak, "utf8"), original, "the original's bytes, in the .bak");
  assert.ok(report.kept!.includes(from), "what's at its name now, to copy too");
  assert.ok(report.kept!.every((path) => existsSync(path)));
  assert.equal(report.backupPath, bak);
});
