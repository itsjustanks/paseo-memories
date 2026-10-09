/**
 * Rendered (react-test-renderer), in an app WITHOUT Paseo's dialog, toasts or
 * copyText (before 0.10): the same jobs fall back to the in-place confirm,
 * the inline words and React Native's clipboard.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { clipboard, playApp } from "./component/harness";

await playApp({});
const { React, ui, wrap, fixAll, render, press, dialogs, text, unmount } = await (await import("./component/shared")).load();

test("in place: Fix all confirms in the group; a double press acts once; Cancel acts never", async () => {
  const sent: string[][] = [];
  const r = await render(fixAll((ids) => sent.push(ids)));
  await press(r, "Fix all");
  assert.equal(dialogs(r).length, 0, "no dialog in this app");
  assert.match(text(r), /Add these 3 notes to Claude's list\?/);
  await press(r, "Cancel");
  assert.doesNotMatch(text(r), /Add these 3 notes/);
  assert.deepEqual(sent, []);
  await press(r, "Fix all");
  await press(r, "Fix all 3", 2);
  assert.deepEqual(sent, [["a", "b", "c"]]);
  assert.doesNotMatch(text(r), /Add these 3 notes/);
});

test("in place: Copy uses React Native's clipboard, and says Couldn't copy when it fails", async () => {
  const link = wrap(React.createElement(ui.CopyLink, { text: "$release-notes", accessibilityLabel: "Copy $release-notes" }));
  clipboard.mode = "ok";
  let r = await render(link);
  await press(r, "Copy $release-notes");
  assert.equal(clipboard.last, "$release-notes");
  assert.match(text(r), /Copied/);
  clipboard.mode = "throw";
  await unmount(r);
  r = await render(link);
  await press(r, "Copy $release-notes");
  assert.match(text(r), /Couldn't copy/);
  await unmount(r);
});

test("in place: no toasts in this app; the hook is a quiet no-op", async () => {
  let seen: { available: boolean } | null = null;
  function Says() {
    const toast = ui.useHostToast();
    seen = toast;
    toast.show("Saved.");
    toast.error("Failed.");
    return null;
  }
  await render(React.createElement(Says));
  assert.equal(seen!.available, false);
});
