/**
 * Regression tests for the 0.3.0 review (memories-research/review-030.md)
 * and the fix round after it: header status after a write, "Projects →",
 * stale-link and technical titles, and the popover's kept draft.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { findingsKey, headerStatus, refreshAfterWrite, writeKey } from "../client/freshness";
import { firstTimeStale, moveToTab, rememberTitleMode, screenTitle, toScreenParams } from "../client/navigate";
import { noteDrafts } from "../client/note-draft";

// ------------------------------------------------------------------ 1. header status

const sources = [{ id: "s1", kind: "claude-md", path: "/demo/CLAUDE.md" }];
const base = { hostLabel: "demo-host", plain: true, inventory: { sources, counts: { sources: 1 } }, inventoryError: false };
const tidy = { findings: [] };
const problem = { findings: [{ kind: "secret", severity: "error", sourceIds: ["s1"] }] };

test("review 1: findings read before the last write never show 'tidy'", () => {
  const before = headerStatus({ ...base, findings: tidy, findingsAt: 1_000, lastWrite: 2_000 });
  assert.equal(before.status, "neutral");
  assert.match(before.caption, /^Checking the notes on demo-host/);
  assert.doesNotMatch(before.caption, /tidy/);
  assert.equal(headerStatus({ ...base, findings: tidy, findingsAt: 3_000, lastWrite: 2_000 }).status, "ok", "fresh findings count again");
  assert.equal(headerStatus({ ...base, findings: problem, findingsAt: 3_000, lastWrite: 2_000 }).status, "error");
  assert.equal(headerStatus({ ...base, findings: tidy, findingsAt: 1_000, lastWrite: 0 }).caption, "Your agents' notes on demo-host · everything looks tidy", "no write since the page opened");
});

test("review 1: a write fetches the header's findings again even when the Overview is closed", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(findingsKey("h"), tidy);
  // The header's observer: cached only, never fetches on its own.
  const header = new QueryObserver(client, { queryKey: findingsKey("h"), queryFn: async () => tidy, enabled: false });
  const stop = header.subscribe(() => undefined);
  let fetches = 0;
  await refreshAfterWrite(client, "h", async () => {
    fetches += 1;
    return problem;
  }, 5_000);
  assert.equal(fetches, 1);
  assert.deepEqual(client.getQueryData(findingsKey("h")), problem, "the new problem reaches the header");
  assert.equal(client.getQueryData(writeKey("h")), 5_000);
  stop();
  client.clear();
});

test("review 1: with the Overview open, a write fetches the findings once, not twice", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let fetches = 0;
  const fetchFindings = async () => {
    fetches += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return problem;
  };
  const overview = new QueryObserver(client, { queryKey: findingsKey("h"), queryFn: fetchFindings });
  const stop = overview.subscribe(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 30));
  fetches = 0;
  await refreshAfterWrite(client, "h", fetchFindings);
  assert.equal(fetches, 1);
  stop();
  client.clear();
});

// ------------------------------------------------------------------ 2. Projects →

test("review 2: going to Projects or User closes a note left open, and the params lose `entry`", () => {
  const state = { tab: "overview" as const, sourceId: "/demo/memory", entryKey: "deploy_notes.md" };
  const moved = moveToTab(state, "projects");
  assert.deepEqual(moved, { tab: "projects", sourceId: "/demo/memory", entryKey: null });
  assert.deepEqual(toScreenParams({ tab: moved.tab, sourceId: moved.sourceId!, ...(moved.entryKey ? { entryKey: moved.entryKey } : {}) }), { tab: "projects", source: "/demo/memory" });
  assert.equal(moveToTab(state, "user").entryKey, null);
  assert.equal(moveToTab(state, "guide").entryKey, "deploy_notes.md", "other tabs don't show it, and keep it");
});

// ------------------------------------------------------------------ 4. stale-link title

test("caveat 4: a stale link moves to the Overview once (title follows); Back to it falls back quietly", () => {
  const link = { tab: "projects", source: "/demo/gone/CLAUDE.md" };
  assert.equal(firstTimeStale(link), true, "first time: new params, so the title says Memories");
  assert.equal(firstTimeStale({ ...link }), false, "seen again: quiet, so Back is never a loop");
  assert.equal(firstTimeStale({ tab: "user", source: "/demo/gone/CLAUDE.md" }), true, "another link is its own");
});

// ------------------------------------------------------------------ 5. technical titles

test("caveat 5: technical mode titles tabs with the technical names", () => {
  try {
    rememberTitleMode(true);
    assert.equal(screenTitle({ tab: "user" }), "Memories · User");
    assert.equal(screenTitle({ tab: "projects" }), "Memories · Projects");
    assert.equal(screenTitle({ add: "note" }), "Memories · Add a note");
    rememberTitleMode(false);
    assert.equal(screenTitle({ tab: "user" }), "Memories · Everywhere");
  } finally {
    rememberTitleMode(false);
  }
});

// ------------------------------------------------------------------ popover draft

test("the popover keeps typed text when closed, per host, until saved or cleared", () => {
  const drafts = noteDrafts("host-a");
  assert.equal(drafts.read(), null);
  drafts.write({ text: "Invoices go out on the 1st", who: "claude", where: "project", workspaceId: "ws-1" });
  assert.deepEqual(noteDrafts("host-a").read(), { text: "Invoices go out on the 1st", who: "claude", where: "project", workspaceId: "ws-1" }, "back on the next +");
  assert.equal(noteDrafts("host-b").read(), null, "another computer has its own");
  drafts.write({ text: "   ", who: "all", where: "everywhere", workspaceId: "" });
  assert.equal(drafts.read(), null, "nothing typed: nothing kept");
  drafts.write({ text: "Keep it short", who: "all", where: "everywhere", workspaceId: "" });
  drafts.write(null);
  assert.equal(drafts.read(), null, "saved: cleared");
});
