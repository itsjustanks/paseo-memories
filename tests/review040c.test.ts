/**
 * Release pass on 0f95755 (review-040.md "Release pass"): D-G, each written
 * to fail before its fix.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applyFormat } from "../shared/md-edit";
import { History } from "../shared/md-history";
import { parseInline, parseMarkdown } from "../shared/md-parse";
import { skillMdRunsCommands } from "../shared/skill-md";
import { fastest } from "./timing";

const header = (lines: string) => `---\nname: a\ndescription: "d"\n${lines}---\nBody.\n`;

test("040c-D the code check fails closed: only known, plain header lines count as harmless", () => {
  const closed = [
    '"ho\\x6fks":\n  Stop: []\n', // an escape YAML decodes to hooks
    '"ho\\U0000006fks": x\n',
    '"license": MIT\n', // any quoted key
    "unknown-setting: x\n", // keys this plugin doesn't know
    "Name: x\n", // not lower case
    "license: &a MIT\n", // anchors
    "license: *a\n", // aliases
    "license: !!str MIT\n", // tags
    "metadata: {a: b}\n", // flow maps
    "? hooks\n: x\n",
    "<<: *base\n",
    "license:\tMIT\n", // tabs
    "metadata:\n\tversion: 1\n",
    "...\nhooks: x\n", // a document end before the closing ---
  ];
  for (const lines of closed) assert.ok(skillMdRunsCommands(header(lines)), JSON.stringify(lines));
  const plain = [
    "",
    "license: Complete terms in LICENSE.txt\n",
    "when_to_use: >\n  Before a release,\n  or when asked.\n",
    "argument-hint: '[file]'\n",
    "metadata:\n  version: 1.2\n  author: Sam\n",
    "paths:\n  - src/**\n  - docs/*.md\n",
    'paths: ["src/**", "docs"]\n',
    "disable-model-invocation: true\nuser-invocable: false\nmodel: sonnet\neffort: high\n",
    "allowed-tools: Read, Grep\n",
    "# a comment\ncompatibility: Claude Code 2.1+\n",
  ];
  for (const lines of plain) assert.equal(skillMdRunsCommands(header(lines)), null, JSON.stringify(lines));
  // The explicit checks still say what they found.
  assert.match(skillMdRunsCommands(header("hooks:\n  Stop: []\n"))!, /hooks/);
  assert.match(skillMdRunsCommands(header("allowed-tools: Bash(git *)\n"))!, /without asking/);
  assert.match(skillMdRunsCommands("---\nname: a\ndescription: d\n---\nToday: !`date`\n")!, /!`/);
  assert.equal(skillMdRunsCommands("No header, just text.\n"), null);
});

test("040c-E parsing is linear: 2 MB of multi-line paragraphs, 1 MB of nested quotes, a 150 KB note", () => {
  const lines = "word word word  \nmore words here\n".repeat(Math.ceil((2 * 1024 * 1024) / 32));
  // Each timing is the fastest of up to three runs (tests/timing.ts).
  const big = fastest(() => parseMarkdown(lines), 1000);
  assert.ok(big < 1000, `2 MB multi-line paragraph took ${big.toFixed(0)} ms`);
  const inline = fastest(() => parseInline("word word word\n".repeat(40_000)), 300);
  assert.ok(inline < 300, `586 KB inline took ${inline.toFixed(0)} ms`);
  const quotes = fastest(() => parseMarkdown(">>>> x\n".repeat(150_000)), 1000);
  assert.ok(quotes < 1000, `1 MB of nested quotes took ${quotes.toFixed(0)} ms`);
  const ticks = fastest(() => parseInline("`a ``b ```c ".repeat(30_000)), 500);
  assert.ok(ticks < 500, `unmatched code marks took ${ticks.toFixed(0)} ms`);
  // A 150 KB note, parsed again as on a keystroke: well under 100 ms.
  const note = ("## Section\n\nSome **bold** text with `code` and a [link](https://example.com).\n- item one\n- item two\n\n").repeat(1700);
  parseMarkdown(note);
  const key = fastest((attempt) => parseMarkdown(`${note}${"x".repeat(attempt + 1)}`), 100);
  assert.ok(key < 100, `150 KB re-parse took ${key.toFixed(0)} ms`);
  // Still right: two trailing spaces are a hard break, one line end a space.
  assert.deepEqual(parseInline("a  \nb\nc"), [{ t: "text", v: "a" }, { t: "br" }, { t: "text", v: "b c" }]);
});

test("040c-F Undo steps back one change at a time, typing included", () => {
  const history = new History();
  let text = "Start.";
  let now = 0;
  // A button press.
  history.button(text, { start: 6, end: 6 });
  text = "Start.**bold text**";
  // Typing a paragraph in bursts: each pause starts a new step.
  for (const piece of [" One", " two", " three."]) {
    now += 2000;
    for (const ch of piece) {
      history.typing(text, { start: text.length, end: text.length }, text + ch, (now += 50));
      text += ch;
    }
  }
  const steps: string[] = [];
  for (let step = history.undo(text); step; step = history.undo(text)) {
    text = step.text;
    steps.push(text);
  }
  assert.deepEqual(steps, ["Start.**bold text** One two", "Start.**bold text** One", "Start.**bold text**", "Start."], "typing, then the button, one step each");
  // Word boundaries split a long burst too.
  const words = new History();
  let typed = "";
  let at = 0;
  for (const ch of "alpha beta gamma") {
    words.typing(typed, { start: typed.length, end: typed.length }, typed + ch, (at += 30));
    typed += ch;
  }
  assert.equal(words.undo(typed)?.text, "alpha beta ");
});

test("040c-G Italic inside bold keeps the bold, and Italic on italic takes it off", () => {
  const text = "Keep **bold** here.";
  const start = text.indexOf("bold");
  const inside = applyFormat(text, { start, end: start + 4 }, "italic");
  assert.equal(inside.text, "Keep **_bold_** here.");
  assert.equal(applyFormat(inside.text, inside.selection, "italic").text, text, "and back");
  const italic = "an *italic* word";
  const at = italic.indexOf("italic");
  assert.equal(applyFormat(italic, { start: at, end: at + 6 }, "italic").text, "an italic word");
  const under = "an _italic_ word";
  assert.equal(applyFormat(under, { start: 4, end: 10 }, "italic").text, "an italic word");
  assert.equal(applyFormat("plain word", { start: 6, end: 10 }, "italic").text, "plain *word*");
});
