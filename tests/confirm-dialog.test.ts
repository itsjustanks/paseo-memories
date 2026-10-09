/**
 * Rendered (react-test-renderer), in an app WITH Paseo's dialog, toasts and
 * copyText (0.10+): Fix all's confirm, the in-place confirms, Copy and toasts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { copied, flush, playApp, setCopy, toasts } from "./component/harness";

await playApp({ toast: true, copy: "ok", modal: true });
const { React, act, ui, wrap, fixAll, render, press, pressables, dialogs, text, unmount } = await (await import("./component/shared")).load();

test("dialog: Confirm sends the three listed items once, even pressed twice before a render; the dialog closes", async () => {
  const sent: string[][] = [];
  const r = await render(fixAll((ids) => sent.push(ids)));
  assert.equal(dialogs(r).length, 0);
  await press(r, "Fix all");
  assert.equal(dialogs(r).length, 1, "Fix all opens Paseo's dialog");
  assert.match(text(r), /Add these 3 notes to Claude's list\?/);
  assert.ok(!text(r).includes("hunter22"), "names in the dialog are redacted");
  await press(r, "Fix all 3", 2);
  assert.deepEqual(sent, [["a", "b", "c"]]);
  assert.equal(dialogs(r).length, 0, "closed after Confirm");
});

test("dialog: Cancel and the close button send nothing and reset; reopening re-arms it", async () => {
  const sent: string[][] = [];
  const r = await render(fixAll((ids) => sent.push(ids)));
  await press(r, "Fix all");
  await press(r, "Cancel");
  assert.equal(dialogs(r).length, 0);
  await press(r, "Fix all");
  await act(async () => {
    dialogs(r)[0]!.props.onOpenChange(false);
    await flush();
  });
  assert.equal(dialogs(r).length, 0);
  assert.deepEqual(sent, []);
  // A confirm left over from a closed dialog can't act.
  await press(r, "Fix all");
  const staleYes = pressables(r, "Fix all 3")[0]!.props.onPress as () => void;
  await act(async () => {
    dialogs(r)[0]!.props.onOpenChange(false);
    await flush();
  });
  await act(async () => {
    staleYes();
    await flush();
  });
  assert.deepEqual(sent, []);
  await press(r, "Fix all");
  await press(r, "Fix all 3");
  assert.deepEqual(sent, [["a", "b", "c"]]);
});

test("in-place confirms act once per asking; Keep it acts never", async () => {
  let removed = 0;
  let deleted = 0;
  const r = await render(
    wrap(
      React.createElement(React.Fragment, null,
        React.createElement(ui.ConfirmLink, { label: "Remove", question: "Remove this note?", yes: "Yes, remove it", no: "Keep it", onConfirm: () => (removed += 1) }),
        React.createElement(ui.ConfirmButton, { label: "Delete", confirmLabel: "Delete it", onConfirm: () => (deleted += 1) }),
      ),
    ),
  );
  await press(r, "Remove");
  await press(r, "Keep it");
  assert.equal(removed, 0);
  await press(r, "Remove");
  await press(r, "Yes, remove it", 2);
  assert.equal(removed, 1);
  await press(r, "Delete");
  await press(r, "Delete it", 3);
  assert.equal(deleted, 1);
  await press(r, "Delete");
  await press(r, "Cancel");
  assert.equal(deleted, 1);
});

test("Copy: Paseo's copyText; false or a rejection says Couldn't copy in place", async () => {
  const link = wrap(React.createElement(ui.CopyLink, { text: "/release-notes", accessibilityLabel: "Copy /release-notes" }));
  setCopy("ok");
  let r = await render(link);
  await press(r, "Copy /release-notes");
  assert.deepEqual(copied, ["/release-notes"]);
  assert.match(text(r), /Copied/);
  for (const mode of ["false", "reject"] as const) {
    setCopy(mode);
    await unmount(r);
    r = await render(link);
    await press(r, "Copy /release-notes");
    assert.match(text(r), /Couldn't copy/, mode);
  }
  await unmount(r);
  setCopy("ok");
});

test("toasts: Paseo's, redacted", async () => {
  toasts.length = 0;
  function Says() {
    const toast = ui.useHostToast();
    React.useEffect(() => {
      assert.equal(toast.available, true);
      toast.error("Could not save token=hunter22.zip");
    }, []);
    return null;
  }
  await render(React.createElement(Says));
  assert.equal(toasts.length, 1);
  assert.ok(!toasts[0]!.text.includes("hunter22"), toasts[0]!.text);
});
