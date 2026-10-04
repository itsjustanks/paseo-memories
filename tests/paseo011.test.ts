/**
 * Paseo 0.11 features, each detected at runtime with a working fallback:
 * screen params (where the page is survives reload and back/forward), the
 * sidebar "+" (Add a note), and live settings from `registerSettings()`.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { makeSandbox } from "./helpers";

const sb = await makeSandbox();
const { forgetAllFiles } = await import("../server/files");
const { adoptSettingsHandle, readMemoriesSettings } = await import("../server/settings");
const nav = await import("../client/navigate");
const { landing } = nav;

test.after(() => sb.cleanup());

// ------------------------------------------------------------------ screen params

const SOURCE = `${sb.home}/code/app/CLAUDE.md`;

test("params round trip: tab, source and open entry come back after a reload", () => {
  const params = nav.toScreenParams({ tab: "projects", sourceId: SOURCE, entryKey: "deploy_notes.md" });
  assert.deepEqual(params, { tab: "projects", source: SOURCE, entry: "deploy_notes.md" });
  // A reload: nothing in memory, only the URL's params.
  assert.equal(nav.takeDestination(), null);
  assert.deepEqual(landing(params), { tab: "projects", sourceId: SOURCE, entryKey: "deploy_notes.md" });
  assert.deepEqual(nav.fromScreenParams(nav.toScreenParams({ tab: "guide" })), { tab: "guide" });
  assert.deepEqual(nav.toScreenParams({ tab: "overview" }), {}, "the Overview needs no params");
  assert.deepEqual(nav.fromScreenParams(nav.toScreenParams({ addNote: { workspaceId: "ws-1" } })), { addNote: { workspaceId: "ws-1" } });
});

test("params carry ids and keys only, never memory text", () => {
  const secretText = "Remember: the staging password lives in the vault";
  const params = nav.toScreenParams({ tab: "transfer", text: secretText, from: [{ sourceId: SOURCE, key: "a.md" }], target: { kind: "append", path: "/x" }, preview: true });
  assert.deepEqual(params, { tab: "transfer" });
  assert.ok(!JSON.stringify(params).includes("staging"));
});

test("unknown or stale params land on the Overview without crashing", () => {
  assert.deepEqual(nav.fromScreenParams({ tab: "settings", source: SOURCE }), {}, "an unknown tab: the Overview, and its source is dropped");
  assert.deepEqual(nav.fromScreenParams({ entry: "a.md" }), {}, "an entry without a source");
  assert.deepEqual(nav.fromScreenParams({ tab: "overview", source: SOURCE }), { tab: "overview" }, "a source only on User or Projects");
  assert.deepEqual(nav.fromScreenParams({ add: "yes" }), {});
  assert.deepEqual(nav.fromScreenParams(undefined), {}, "Paseo 0.10: no params at all");
  assert.deepEqual(nav.fromScreenParams(null as never), {});
  assert.deepEqual(nav.fromScreenParams({ tab: "" }), {});
  assert.equal(nav.isStaleSource(SOURCE, [{ id: "other" }]), true, "a source this host no longer has");
  assert.equal(nav.isStaleSource(SOURCE, [{ id: SOURCE }]), false);
  assert.equal(nav.isStaleSource(SOURCE, undefined), false, "not decided before the list loads");
  assert.equal(nav.isStaleSource(null, []), false);
});

test("the header title follows the params on Paseo 0.11", () => {
  assert.equal(nav.screenTitle({}), "Memories");
  assert.equal(nav.screenTitle({ tab: "projects" }), "Memories · Projects");
  assert.equal(nav.screenTitle({ tab: "user" }), "Memories · Everywhere");
  assert.equal(nav.screenTitle({ add: "note" }), "Memories · Add a note");
  assert.equal(nav.screenTitle({ tab: "nonsense" }), "Memories");
});

test("Paseo 0.11: openMemories opens the screen with params and hands over the rest in memory", () => {
  const opened: unknown[] = [];
  nav.registerSurfaceOpener((id, params) => opened.push([id, params]), { params: true });
  assert.equal(nav.screenParamsSupported(), true);
  const from = [{ sourceId: SOURCE, key: "a.md" }];
  nav.openMemories({ tab: "transfer", from });
  assert.deepEqual(opened, [["memories", { tab: "transfer" }]]);
  assert.deepEqual(landing({ tab: "transfer" }), { tab: "transfer", from }, "the new screen gets the entries to copy");
  assert.equal(nav.takeDestination(), null, "taken once");
  // A move inside the page records new params; the same params record nothing.
  nav.syncScreenParams({ tab: "user" }, { tab: "user" });
  assert.equal(opened.length, 1);
  nav.syncScreenParams({ tab: "user", source: SOURCE }, { tab: "user" });
  assert.deepEqual(opened.at(-1), ["memories", { tab: "user", source: SOURCE }]);
  nav.registerSurfaceOpener(null);
});

test("Paseo 0.10: today's behaviour, no params", () => {
  const opened: unknown[] = [];
  const heard: unknown[] = [];
  nav.registerSurfaceOpener((id, params) => opened.push([id, params]));
  assert.equal(nav.screenParamsSupported(), false);
  const stop = nav.onDestination((destination) => heard.push(destination));
  nav.openMemories({ tab: "projects", sourceId: SOURCE });
  assert.deepEqual(opened, [["memories", undefined]]);
  assert.deepEqual(heard, [{ tab: "projects", sourceId: SOURCE }], "a mounted page hears it");
  assert.deepEqual(landing(undefined), { tab: "projects", sourceId: SOURCE }, "a page that mounts takes it");
  nav.syncScreenParams({ tab: "user" }, undefined);
  assert.equal(opened.length, 1, "no params to record");
  stop();
  nav.registerSurfaceOpener(null);
});

test("a panel's Open Memories jumps straight to this project's file", () => {
  const item = (over: Record<string, unknown>) => ({ when: "start", scope: "project", kind: "claude-md", sourceId: SOURCE, ...over }) as never;
  assert.deepEqual(nav.panelDestination([{ items: [item({ scope: "user", sourceId: "u" }), item({})] }]), { tab: "projects", sourceId: SOURCE });
  assert.deepEqual(nav.panelDestination([{ items: [item({ when: "missing" })] }]), { tab: "projects" }, "nothing loads: the Projects tab");
  assert.deepEqual(nav.itemDestination(item({ kind: "paseo-prompt", scope: "project" })), { tab: "user", sourceId: SOURCE });
  assert.deepEqual(nav.toScreenParams(nav.panelDestination([{ items: [item({})] }])), { tab: "projects", source: SOURCE });
});

// ------------------------------------------------------------------ live settings

const settingsDir = () => join(sb.paseoHome, "plugin-settings", "paseo-memories");
function writeStored(values: Record<string, unknown>) {
  mkdirSync(settingsDir(), { recursive: true });
  writeFileSync(join(settingsDir(), "memories.json"), JSON.stringify({ version: 1, values }));
  forgetAllFiles();
}

function fakeHandle(initial: { status: string; values?: unknown }) {
  let state = initial;
  let reads = 0;
  const listeners = new Set<(state: { status: string; values?: unknown }) => void>();
  return {
    handle: {
      read: async () => {
        reads += 1;
        return state;
      },
      subscribe(listener: (state: { status: string; values?: unknown }) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    change(next: { status: string; values?: unknown }) {
      state = next;
      for (const listener of listeners) listener(next);
    },
    reads: () => reads,
    listeners: () => listeners.size,
  };
}

test("live settings: values come from the handle, and a change applies without a reload", async () => {
  writeStored({ technicalDetails: true });
  const fake = fakeHandle({ status: "ready", values: { technicalDetails: false, backupsToKeep: 7 } });
  const stop = adoptSettingsHandle(fake.handle);
  try {
    const first = await readMemoriesSettings();
    assert.equal(first.technicalDetails, false, "the handle, not the file");
    assert.equal(first.backupsToKeep, 7);
    assert.equal(first.maskSecrets, true, "defaults fill the rest");
    await readMemoriesSettings();
    assert.equal(fake.reads(), 1, "kept until it changes");
    fake.change({ status: "ready", values: { technicalDetails: true, backupsToKeep: 9 } });
    const next = await readMemoriesSettings();
    assert.equal(next.technicalDetails, true, "the change applies at once");
    assert.equal(next.backupsToKeep, 9);
  } finally {
    stop();
  }
  assert.equal(fake.listeners(), 0, "cleanup unsubscribes");
});

test("live settings: invalid stored settings fall back to the per-field rescue", async () => {
  writeStored({ codexEdits: false, technicalDetails: "yes", backupsToKeep: 50 });
  const fake = fakeHandle({ status: "invalid" });
  const stop = adoptSettingsHandle(fake.handle);
  try {
    const rescued = await readMemoriesSettings();
    assert.equal(rescued.codexEdits, false, "a good field is kept");
    assert.equal(rescued.technicalDetails, false, "the bad field takes its default");
    assert.equal(rescued.backupsToKeep, 50);
    fake.change({ status: "ready", values: { codexEdits: true } });
    assert.equal((await readMemoriesSettings()).codexEdits, true, "a fixed document applies at once");
  } finally {
    stop();
  }
});

test("live settings: a failed read or no handle (Paseo 0.8) reads the file as before", async () => {
  writeStored({ maskSecrets: false });
  const broken = { read: async () => Promise.reject(new Error("gone")), subscribe: () => () => undefined };
  let stop = adoptSettingsHandle(broken);
  assert.equal((await readMemoriesSettings()).maskSecrets, false);
  stop();
  stop = adoptSettingsHandle({ status: "ready", values: {} }); // a returned value that is not a handle
  assert.equal((await readMemoriesSettings()).maskSecrets, false);
  stop();
  stop = adoptSettingsHandle(undefined);
  assert.equal((await readMemoriesSettings()).maskSecrets, false);
  stop();
});
