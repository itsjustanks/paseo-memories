/**
 * Markdown for reading notes (shared/md-parse.ts) and the editor's
 * formatting buttons (shared/md-edit.ts): every construct, hostile input
 * that must stay bounded, and buttons that change only the selection.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applyFormat, type Format } from "../shared/md-edit";
import { MD_LIMITS, inlineText, parseInline, parseMarkdown, safeHref, type Block, type Inline } from "../shared/md-parse";

const kinds = (blocks: Block[]) => blocks.map((block) => block.t);

test("blocks: headings, paragraphs, code, quotes, rules, tables; the header is hidden", () => {
  const blocks = parseMarkdown("---\nname: x\ndescription: y\n---\n\n# Title\n\nOne line\nsame paragraph.\n\n## Sub ##\n\n```ts\nconst a = 1;\n```\n\n> quoted\n> more\n\n---\n\n| A | B |\n|:--|--:|\n| 1 | `x|y` |\n| 2 | 3 |\n");
  assert.deepEqual(kinds(blocks), ["heading", "paragraph", "heading", "code", "quote", "rule", "table"]);
  assert.equal((blocks[0] as { level: number }).level, 1);
  assert.equal(inlineText((blocks[1] as { c: Inline[] }).c), "One line same paragraph.");
  assert.equal(inlineText((blocks[2] as { c: Inline[] }).c), "Sub");
  assert.deepEqual(blocks[3], { t: "code", lang: "ts", v: "const a = 1;" });
  const table = blocks[6] as Extract<Block, { t: "table" }>;
  assert.deepEqual(table.align, ["left", "right"]);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0]![1], [{ t: "code", v: "x|y" }], "a pipe inside code stays in the cell");
  assert.deepEqual(kinds(parseMarkdown("---\nnot: closed\n\ntext")), ["rule", "paragraph", "paragraph"], "an unclosed header is not hidden");
  assert.deepEqual(kinds(parseMarkdown("#hashtag is text")), ["paragraph"]);
});

test("lists: bullets, numbers, nesting, tasks, lazy lines", () => {
  const [list] = parseMarkdown("- one\n- two\n  - nested\n    1. deep\n- [ ] todo\n- [x] done\nlazy\n") as [Extract<Block, { t: "list" }>];
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 4);
  const nested = list.items[1]!.blocks[1] as Extract<Block, { t: "list" }>;
  assert.equal(nested.t, "list");
  assert.equal((nested.items[0]!.blocks[1] as Extract<Block, { t: "list" }>).ordered, true);
  assert.deepEqual([list.items[2]!.task, list.items[2]!.checked, list.items[3]!.checked], [true, false, true]);
  assert.equal(inlineText((list.items[3]!.blocks[0] as { c: Inline[] }).c), "done lazy");
  const [numbered] = parseMarkdown("3. three\n4. four") as [Extract<Block, { t: "list" }>];
  assert.deepEqual([numbered.ordered, numbered.start, numbered.items.length], [true, 3, 2]);
  assert.deepEqual(kinds(parseMarkdown("Text\n- interrupts\n")), ["paragraph", "list"]);
  assert.deepEqual(kinds(parseMarkdown("Text\n2. does not interrupt\n")), ["paragraph"]);
});

test("inline: bold, italic, strike, code, links, breaks, escapes", () => {
  assert.deepEqual(parseInline("**b** *i* _u_ ~~s~~ `c`"), [
    { t: "strong", c: [{ t: "text", v: "b" }] },
    { t: "text", v: " " },
    { t: "em", c: [{ t: "text", v: "i" }] },
    { t: "text", v: " " },
    { t: "em", c: [{ t: "text", v: "u" }] },
    { t: "text", v: " " },
    { t: "del", c: [{ t: "text", v: "s" }] },
    { t: "text", v: " " },
    { t: "code", v: "c" },
  ]);
  assert.equal(parseInline("snake_case_name").length, 1, "underscores inside words are text");
  assert.deepEqual(parseInline("[docs](https://example.com/a_(b)) and <https://x.test>"), [
    { t: "link", href: "https://example.com/a_(b)", c: [{ t: "text", v: "docs" }] },
    { t: "text", v: " and " },
    { t: "link", href: "https://x.test", c: [{ t: "text", v: "https://x.test" }] },
  ]);
  assert.deepEqual(parseInline("see https://example.com/x."), [{ t: "text", v: "see " }, { t: "link", href: "https://example.com/x", c: [{ t: "text", v: "https://example.com/x" }] }, { t: "text", v: "." }]);
  assert.deepEqual(parseInline("[x](javascript:alert(1))"), [{ t: "em", c: [{ t: "text", v: "x" }] }], "only web links open");
  assert.equal(safeHref("file:///etc/passwd"), null);
  assert.deepEqual(parseInline("a  \nb"), [{ t: "text", v: "a" }, { t: "br" }, { t: "text", v: "b" }]);
  assert.deepEqual(parseInline("\\*not em\\*"), [{ t: "text", v: "*not em*" }]);
  assert.deepEqual(parseInline("`a ** b`"), [{ t: "code", v: "a ** b" }], "no emphasis inside code");
  assert.deepEqual(parseInline("tok_l••••••••"), [{ t: "text", v: "tok_l••••••••" }], "masked values stay masked text");
});

test("raw HTML is shown as text, never rendered", () => {
  const blocks = parseMarkdown("<script>alert(1)</script>\n\n<b>bold?</b> <img src=x onerror=y>");
  assert.deepEqual(kinds(blocks), ["paragraph", "paragraph"]);
  assert.equal(inlineText((blocks[0] as { c: Inline[] }).c), "<script>alert(1)</script>");
  assert.match(inlineText((blocks[1] as { c: Inline[] }).c), /<b>bold\?<\/b> <img/);
});

test("hostile input stays bounded and fast", () => {
  const time = (fn: () => unknown) => {
    const began = performance.now();
    fn();
    return performance.now() - began;
  };
  // Deep nesting: lists and quotes cap at the depth limit.
  const deepList = Array.from({ length: 200 }, (_, i) => `${"  ".repeat(i)}- level ${i}`).join("\n");
  const depthOf = (blocks: Block[]): number => Math.max(0, ...blocks.map((block) => (block.t === "list" ? 1 + Math.max(0, ...block.items.map((item) => depthOf(item.blocks))) : block.t === "quote" ? 1 + depthOf(block.blocks) : 0)));
  assert.ok(depthOf(parseMarkdown(deepList)) <= MD_LIMITS.depth + 1);
  assert.ok(depthOf(parseMarkdown(">".repeat(500) + " deep")) <= MD_LIMITS.depth + 1);
  // A huge table is cut, and says how much.
  const table = parseMarkdown(`| ${Array.from({ length: 50 }, (_, i) => `c${i}`).join(" | ")} |\n|${"---|".repeat(50)}\n${Array.from({ length: 5000 }, (_, i) => `| ${i} | x |`).join("\n")}`)[0] as Extract<Block, { t: "table" }>;
  assert.equal(table.head.length, MD_LIMITS.tableColumns);
  assert.equal(table.rows.length, MD_LIMITS.tableRows);
  assert.equal(table.more, 5000 - MD_LIMITS.tableRows);
  // Thousands of blocks are capped.
  assert.ok(parseMarkdown("p\n\n".repeat(10_000)).length <= MD_LIMITS.blocks);
  // Unclosed fences run to the end; a very long line is one paragraph.
  assert.deepEqual(kinds(parseMarkdown("```\nnever closed\n# not a heading")), ["code"]);
  assert.equal(parseMarkdown("x".repeat(200_000)).length, 1);
  // Unmatched markers (the slow case for naive parsers) stay linear.
  assert.ok(time(() => parseInline("*a _b ~~c `d [e ".repeat(20_000))) < 1500, "unmatched markers");
  assert.ok(time(() => parseMarkdown("**".repeat(50_000))) < 1500, "runs of markers");
  assert.ok(time(() => parseInline("[".repeat(20_000))) < 1500, "open brackets");
});

// ------------------------------------------------------------------ the buttons

const at = (text: string, start: number, end = start) => ({ text, selection: { start, end } });
const press = (input: { text: string; selection: { start: number; end: number } }, format: Format) => applyFormat(input.text, input.selection, format);

test("bold, italic and code wrap the selection, insert a placeholder when empty, and undo on a second press", () => {
  const text = "Keep answers short.";
  const bold = press(at(text, 5, 12), "bold");
  assert.equal(bold.text, "Keep **answers** short.");
  assert.equal(bold.text.slice(bold.selection.start, bold.selection.end), "answers");
  assert.equal(press(bold, "bold").text, text, "pressing again takes it off");
  const empty = press(at(text, 4), "italic");
  assert.equal(empty.text, "Keep*italic text* answers short.");
  assert.equal(empty.text.slice(empty.selection.start, empty.selection.end), "italic text");
  assert.equal(press(at("x `y` z", 2, 5), "code").text, "x y z", "selected marks are taken off");
  const fenced = press(at("a\nline 1\nline 2\nb", 2, 15), "code");
  assert.equal(fenced.text, "a\n```\nline 1\nline 2\n```\nb");
  assert.equal(fenced.text.slice(fenced.selection.start, fenced.selection.end), "line 1\nline 2");
});

test("heading, bullets and numbers act on whole selected lines only, keep indentation and line ends", () => {
  const text = "intro\r\nfirst\r\n  second\r\n\r\nthird\r\noutro";
  const start = text.indexOf("first");
  const end = text.indexOf("third") + 5;
  const bullets = press(at(text, start, end), "bullets");
  assert.equal(bullets.text, "intro\r\n- first\r\n  - second\r\n\r\n- third\r\noutro");
  assert.equal(press(bullets, "bullets").text, text, "a second press takes them off");
  const numbers = press(at(text, start, end), "numbers");
  assert.equal(numbers.text, "intro\r\n1. first\r\n  2. second\r\n\r\n3. third\r\noutro");
  // Bullets to numbers swaps the marker rather than stacking it.
  assert.equal(press(at(bullets.text, bullets.selection.start, bullets.selection.end), "numbers").text, numbers.text);
  const heading = press(at("one\ntwo", 5), "heading");
  assert.equal(heading.text, "one\n## two");
  assert.equal(press(heading, "heading").text, "one\ntwo");
  // A selection that ends just after a line end leaves the next line alone.
  assert.equal(press(at("a\nb\n", 0, 2), "bullets").text, "- a\nb\n");
  // On an empty line, the cursor lands after the marker.
  const fresh = press(at("a\n\nb", 2), "bullets");
  assert.equal(fresh.text, "a\n- \nb");
  assert.deepEqual(fresh.selection, { start: 4, end: 4 });
});

test("link: label and address, the part left to type selected", () => {
  const none = press(at("go ", 3), "link");
  assert.equal(none.text, "go [link text](https://)");
  assert.equal(none.text.slice(none.selection.start, none.selection.end), "link text");
  const label = press(at("read the docs now", 9, 13), "link");
  assert.equal(label.text, "read the [docs](https://) now");
  assert.equal(label.text.slice(label.selection.start, label.selection.end), "https://");
  const url = press(at("see https://x.test", 4, 18), "link");
  assert.equal(url.text, "see [link text](https://x.test)");
});

test("no button changes a byte outside the selected lines", () => {
  const before = "﻿# Notes\r\n\r\nKeep **this** exactly.  \r\n";
  const after = "\r\n\tTabs and trailing spaces   \r\n";
  for (const format of ["bold", "italic", "code", "heading", "bullets", "numbers", "link"] as const) {
    const text = `${before}target line${after}`;
    const start = before.length;
    const edit = press(at(text, start, start + 6), format);
    assert.ok(edit.text.startsWith(before), `${format}: text before is unchanged`);
    assert.ok(edit.text.endsWith(after), `${format}: text after is unchanged`);
  }
});
