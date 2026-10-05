/**
 * The editor saves only the note that changed: a formatting button acts on
 * the selection, the card's text replaces its own section, and every other
 * byte of the file (the BOM, CRLF line ends, other notes, odd spacing) stays
 * as it was. Instruction files go through the section write; Codex's own
 * notes through the guarded Codex save, with the whole file spliced the same
 * way.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { fakePaseo, makeSandbox } from "./helpers";

const sb = await makeSandbox();
const { instructionWrite } = await import("../server/instructions");
const { codexWrite } = await import("../server/codex-memory");
const { readCurrent } = await import("../server/write");
const { forgetDiscovery } = await import("../server/discover");
const { applyFormat } = await import("../shared/md-edit");
const { noteCards, cardReplacement } = await import("../shared/notes");
const { replaceSection, splitSections } = await import("../shared/markdown");
const paseo = fakePaseo(sb).api;
after(() => sb.cleanup());

test("one card changed with a button: the rest of a BOM + CRLF file is byte-identical", async () => {
  const path = join(sb.claude, "rules", "crlf-rules.md");
  const original = "﻿Intro line  \r\n\r\n## First\r\nKeep answers short.\r\n\r\n## Second\r\nUse   pnpm,\tnot npm.  \r\n\r\n## Third\r\n- one\r\n- two\r\n";
  writeFileSync(path, original);
  forgetDiscovery();
  const before = await readCurrent(path);
  const card = noteCards(before.text).find((entry) => entry.note.title === "Second")!;
  // What the editor holds is the card's body; Bold on "pnpm".
  const body = card.note.body;
  const at = body.indexOf("pnpm");
  const edit = applyFormat(body, { start: at, end: at + 4 }, "bold");
  const result = await instructionWrite(paseo, { path, text: cardReplacement(card, { title: card.note.title, body: edit.text }), expected: before.stamp!, sectionKey: card.key });
  assert.equal(result.ok, true, result.message);
  const after = readFileSync(path, "utf8");
  assert.equal(after, original.replace("Use   pnpm,", "Use   **pnpm**,"), "only the formatted word changed");
  assert.ok(after.startsWith("﻿"));
  assert.equal(after.split("\r\n").length, original.split("\r\n").length, "every line end is still CRLF");
  assert.ok(result.reports[0]!.backupPath, "backed up first");
});

test("a Codex note changed card by card keeps the rest of its file", async () => {
  const path = join(sb.codex, "memories", "MEMORY.md");
  const before = await readCurrent(path);
  const cards = noteCards(before.text);
  const card = cards[1]!;
  const section = splitSections(before.text).find((entry) => entry.key === card.key)!;
  const bullets = applyFormat(card.note.body, { start: 0, end: card.note.body.length }, "bullets").text;
  const whole = replaceSection(before.text, section, cardReplacement(card, { title: card.note.title, body: bullets }));
  const result = await codexWrite(paseo, { sourceId: path, text: whole, expected: before.stamp!, confirmPending: true });
  assert.equal(result.ok, true, result.message);
  const after = readFileSync(path, "utf8");
  const outside = (text: string) => text.split("\n").filter((_, index) => index < section.start || index >= section.end);
  assert.deepEqual(outside(after).slice(0, section.start), outside(before.text).slice(0, section.start), "everything above is unchanged");
  assert.equal(after.endsWith(before.text.split("\n").slice(section.end).join("\n")), true, "everything below is unchanged");
});
