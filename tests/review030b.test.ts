/**
 * Regression tests for the "0.11 review" (memories-research/review-030.md),
 * one per finding. Each failed before its fix.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { makeSandbox } from "./helpers";

const sb = await makeSandbox();
const { forgetAllFiles } = await import("../server/files");
const { adoptSettingsHandle, readMemoriesSettings } = await import("../server/settings");
const nav = await import("../client/navigate");
const { headerStatus } = await import("../client/freshness");

test.after(() => sb.cleanup());

// ------------------------------------------------------------------ 1. settings race

test("0.11 review 1: a change during the first read is not overwritten by the older read", async () => {
  mkdirSync(join(sb.paseoHome, "plugin-settings", "paseo-memories"), { recursive: true });
  writeFileSync(join(sb.paseoHome, "plugin-settings", "paseo-memories", "memories.json"), JSON.stringify({ version: 1, values: {} }));
  forgetAllFiles();
  let resolveRead: (state: { status: string; values?: unknown }) => void = () => undefined;
  let listener: (state: { status: string; values?: unknown }) => void = () => undefined;
  const handle = {
    read: () => new Promise<{ status: string; values?: unknown }>((resolve) => (resolveRead = resolve)),
    subscribe: (next: typeof listener) => {
      listener = next;
      return () => undefined;
    },
  };
  const stop = adoptSettingsHandle(handle);
  try {
    const first = readMemoriesSettings();
    listener({ status: "ready", values: { codexEdits: false } }); // the user turns Codex edits off
    resolveRead({ status: "ready", values: { codexEdits: true } }); // the older read lands late
    assert.equal((await first).codexEdits, false, "the in-flight read answers with the newer values");
    assert.equal((await readMemoriesSettings()).codexEdits, false, "and the newer values stay");
  } finally {
    stop();
  }
});

// ------------------------------------------------------------------ 2. unknown source keeps its tab

test("0.11 review 2: a source the list doesn't have keeps the tab and drops only the source", () => {
  assert.deepEqual(nav.unknownSourceLanding({ tab: "projects", sourceId: "x", entryKey: "a.md" }), { tab: "projects", sourceId: null, entryKey: null });
  assert.deepEqual(nav.unknownSourceLanding({ tab: "user", sourceId: "x", entryKey: null }), { tab: "user", sourceId: null, entryKey: null });
});

// ------------------------------------------------------------------ 3. managed file is not "this project's"

test("0.11 review 3: Open Memories skips the organisation's managed CLAUDE.md", () => {
  const managed = { when: "launch", scope: "managed", kind: "claude-md", sourceId: "managed-id" } as never;
  const project = { when: "launch", scope: "project", kind: "claude-md", sourceId: "project-id" } as never;
  assert.deepEqual(nav.panelDestination([{ items: [managed, project] }]), { tab: "projects", sourceId: "project-id" });
  assert.deepEqual(nav.panelDestination([{ items: [managed] }]), { tab: "projects" });
  assert.equal(nav.itemDestination(managed)?.tab, "user", "a managed row opens on the User tab");
});

// ------------------------------------------------------------------ 4. opaque links

const PROJECT = "acme-web";
const SOURCE = `${sb.home}/.claude/projects/-Users-demo-code-${PROJECT}/memory`;
const ENTRY = "payments_retry_limit.md";
const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

test("0.11 review 4: params carry opaque ids, never paths, user, project or file names", () => {
  const params = nav.toScreenParams({ tab: "projects", sourceId: SOURCE, entryKey: ENTRY, addNote: { workspaceId: "ws-1" } });
  assert.deepEqual(params, { tab: "projects", source: short(SOURCE), entry: short(`${SOURCE}#${ENTRY}`), add: "note", workspace: "ws-1" });
  for (const value of Object.values(params)) {
    assert.ok(!value.includes("/"), value);
    for (const name of [PROJECT, ENTRY, "payments", "demo", ".claude", "memory", sb.home]) assert.ok(!value.includes(name), `${value} names ${name}`);
  }
  for (const title of [nav.screenTitle(params), nav.screenTitle({ tab: "user", source: short(SOURCE) })]) assert.doesNotMatch(title, /\/|acme|payments|demo/);
});

test("0.11 review 4: opaque ids resolve against the current list; unknown or old-style ones don't", () => {
  const landing = nav.fromScreenParams(nav.toScreenParams({ tab: "projects", sourceId: SOURCE, entryKey: ENTRY }));
  assert.deepEqual(landing, { tab: "projects", sourceRef: short(SOURCE), entryRef: short(`${SOURCE}#${ENTRY}`) });
  assert.equal(nav.resolveSource(landing.sourceRef, [{ id: "/other" }, { id: SOURCE }]), SOURCE);
  assert.equal(nav.resolveSource(landing.sourceRef, [{ id: "/other" }]), null, "gone: item 2's landing");
  assert.equal(nav.resolveEntry(SOURCE, landing.entryRef, ["a.md", ENTRY]), ENTRY);
  assert.equal(nav.resolveEntry(SOURCE, landing.entryRef, ["a.md"]), null);
  assert.deepEqual(nav.fromScreenParams({ tab: "projects", source: SOURCE, entry: ENTRY }), { tab: "projects" }, "a 0.3 pre-release path link is dropped, not followed");
});

test("0.11 review 4: the plugin's own sha256 matches node:crypto", async () => {
  const { sha256Hex } = await import("../shared/hash");
  for (const text of ["", "abc", SOURCE, `${SOURCE}#${ENTRY}`, "naïve ✓ 日本語 🧠", "x".repeat(1000)]) assert.equal(sha256Hex(text), createHash("sha256").update(text).digest("hex"), text.slice(0, 20));
});

// ------------------------------------------------------------------ 5. failed re-check

test("0.11 review 5: a failed re-check says so with Try again, never 'Checking' forever or 'tidy'", () => {
  const base = { hostLabel: "demo-host", plain: true, inventory: { sources: [{ id: "s1", kind: "claude-md" }], counts: { sources: 1 } }, inventoryError: false, findings: { findings: [] } };
  const failed = headerStatus({ ...base, findingsAt: 1_000, lastWrite: 2_000, findingsErrorAt: 2_500 });
  assert.match(failed.caption, /Couldn't check just now/);
  assert.equal(failed.retry, true);
  assert.doesNotMatch(failed.caption, /tidy|Checking/);
  const running = headerStatus({ ...base, findingsAt: 1_000, lastWrite: 2_000, findingsErrorAt: 1_500 });
  assert.match(running.caption, /^Checking/, "an older error doesn't count: still checking");
  assert.equal(headerStatus({ ...base, findingsAt: 3_000, lastWrite: 2_000, findingsErrorAt: 2_500 }).caption.includes("tidy"), true, "a later success wins");
});
