/**
 * A small Markdown reader for showing notes: headings, paragraphs, bold,
 * italic, strikethrough, inline code, fenced code, bulleted, numbered and
 * nested lists, task lists, quotes, links, simple tables and rules. The
 * header block at the top of a note (between `---` lines) is left out.
 *
 * It never produces HTML: raw HTML is plain text. It is bounded for hostile
 * input (nesting depth, block and table-row counts, and a linear search for
 * emphasis closers), and it is pure, so the app (web and mobile) and the
 * tests use the same code. Display only: saving never goes through here, so
 * the bytes of a note are never rewritten by reading it.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type ListItem = { task?: boolean; checked?: boolean; blocks: Block[] };
export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "heading"; level: number; c: Inline[] }
  | { t: "paragraph"; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "quote"; blocks: Block[] }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][]; more: number }
  | { t: "rule" };

export const MD_LIMITS = { depth: 6, blocks: 2000, tableRows: 200, tableColumns: 20, inlineDepth: 8 } as const;

// ------------------------------------------------------------------ blocks

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*)$/;
const TABLE_SEP = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4 - (n % 4);
    else break;
  }
  return n;
}

/** Removes up to `n` columns of leading spaces (tabs count as up to four). */
function dedent(line: string, n: number): string {
  let cols = 0;
  let i = 0;
  while (i < line.length && cols < n) {
    if (line[i] === " ") cols += 1;
    else if (line[i] === "\t") cols += 4 - (cols % 4);
    else break;
    i += 1;
  }
  return line.slice(i);
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function tableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let code = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "\\" && text[i + 1] === "|") {
      cell += "|";
      i += 1;
      continue;
    }
    if (ch === "`") code = !code;
    if (ch === "|" && !code) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

/** Does this line start a block that ends a paragraph? */
function interrupts(line: string, next: string | undefined): boolean {
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  const list = LIST.exec(line);
  if (list && list[3] !== undefined && list[3].trim() !== "" && (/[-*+]/.test(list[2]!) || /^1[.)]$/.test(list[2]!))) return true;
  return line.includes("|") && next !== undefined && TABLE_SEP.test(next) && next.includes("-");
}

type State = { blocks: number };

function parseBlocks(lines: string[], depth: number, state: State): Block[] {
  const out: Block[] = [];
  let i = 0;
  const push = (block: Block) => {
    state.blocks += 1;
    if (state.blocks <= MD_LIMITS.blocks) out.push(block);
  };
  while (i < lines.length) {
    if (state.blocks > MD_LIMITS.blocks) break;
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    // Fenced code: to the matching fence, or the end when it is never closed.
    const fence = FENCE.exec(line);
    if (fence && !(fence[1]![0] === "`" && fence[2]!.includes("`"))) {
      const mark = fence[1]!;
      const indent = indentOf(line);
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]!);
        if (close && close[1]![0] === mark[0] && close[1]!.length >= mark.length) {
          i += 1;
          break;
        }
        body.push(dedent(lines[i]!, indent));
        i += 1;
      }
      push({ t: "code", lang: fence[2]!.trim().split(/\s+/)[0] ?? "", v: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      push({ t: "heading", level: heading[1]!.length, c: parseInline(heading[2] ?? "") });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      push({ t: "rule" });
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !isBlank(lines[i]!)) {
        const quoted = QUOTE.exec(lines[i]!);
        if (quoted) inner.push(quoted[1]!);
        else if (inner.length && !interrupts(lines[i]!, lines[i + 1])) inner.push(lines[i]!);
        else break;
        i += 1;
      }
      push(depth >= MD_LIMITS.depth ? { t: "paragraph", c: parseInline(inner.join("\n")) } : { t: "quote", blocks: parseBlocks(inner, depth + 1, state) });
      continue;
    }
    // A table: a row with pipes over a separator line.
    const next = lines[i + 1];
    if (line.includes("|") && next !== undefined && TABLE_SEP.test(next) && next.includes("-")) {
      const head = tableRow(line).slice(0, MD_LIMITS.tableColumns);
      const align: Align[] = tableRow(next)
        .slice(0, head.length)
        .map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : null));
      i += 2;
      const rows: Inline[][][] = [];
      let more = 0;
      while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes("|")) {
        if (rows.length < MD_LIMITS.tableRows) rows.push(tableRow(lines[i]!).slice(0, head.length).map((cell) => parseInline(cell)));
        else more += 1;
        i += 1;
      }
      push({ t: "table", align, head: head.map((cell) => parseInline(cell)), rows, more });
      continue;
    }
    const list = LIST.exec(line);
    if (list) {
      const ordered = /\d/.test(list[2]!);
      const base = indentOf(line);
      const items: ListItem[] = [];
      let start = ordered ? Number.parseInt(list[2]!, 10) : 1;
      while (i < lines.length) {
        const head = LIST.exec(lines[i]!);
        if (!head || /\d/.test(head[2]!) !== ordered || indentOf(lines[i]!) > base + 3) break;
        const content = head[3] ?? "";
        // The item's content column: marker, then its spaces (1-4; more means the content is indented code, counted as 1).
        const gap = /^ *(?:[-*+]|\d{1,9}[.)])([ \t]*)/.exec(lines[i]!)![1]!.length;
        const width = indentOf(lines[i]!) + head[2]!.length + (content.length === 0 || gap > 4 ? 1 : gap);
        const itemLines = [content];
        i += 1;
        let blankRun = 0;
        while (i < lines.length) {
          const current = lines[i]!;
          if (isBlank(current)) {
            blankRun += 1;
            itemLines.push("");
            i += 1;
            continue;
          }
          const indent = indentOf(current);
          if (indent >= width) {
            itemLines.push(dedent(current, width));
            blankRun = 0;
            i += 1;
            continue;
          }
          if (blankRun === 0 && !LIST.test(current) && !interrupts(current, lines[i + 1])) {
            // A lazy line: it carries on the paragraph above.
            itemLines.push(current.trim());
            i += 1;
            continue;
          }
          break;
        }
        // Trailing blank lines belong between items, not to this one.
        while (itemLines.length > 1 && itemLines[itemLines.length - 1] === "") {
          itemLines.pop();
          i -= 1;
        }
        while (i < lines.length && isBlank(lines[i]!)) i += 1;
        let task: boolean | undefined;
        let checked: boolean | undefined;
        const box = /^\[([ xX])\][ \t]+/.exec(itemLines[0]!);
        if (box) {
          task = true;
          checked = box[1] !== " ";
          itemLines[0] = itemLines[0]!.slice(box[0].length);
        }
        const blocks = depth >= MD_LIMITS.depth ? [{ t: "paragraph" as const, c: parseInline(itemLines.join(" ")) }] : parseBlocks(itemLines, depth + 1, state);
        items.push({ ...(task ? { task, checked: Boolean(checked) } : {}), blocks });
        if (items.length === 1 && ordered) start = Number.parseInt(head[2]!, 10);
      }
      push({ t: "list", ordered, start, items });
      continue;
    }
    // A paragraph: up to a blank line or a line that starts another block.
    const para: string[] = [line];
    i += 1;
    while (i < lines.length && !isBlank(lines[i]!) && !interrupts(lines[i]!, lines[i + 1])) {
      para.push(lines[i]!);
      i += 1;
    }
    push({ t: "paragraph", c: parseInline(para.map((part, index) => (index === 0 ? part.replace(/^ {0,3}/, "") : part.trimStart())).join("\n")) });
  }
  return out;
}

/** The header block (`---` … `---`) at the very top, when there is one: its line count; else 0. */
export function frontmatterLines(lines: readonly string[]): number {
  if (lines[0]?.replace(/^﻿/, "").trimEnd() !== "---") return 0;
  for (let i = 1; i < Math.min(lines.length, 400); i += 1) {
    const line = lines[i]!.trimEnd();
    if (line === "---" || line === "...") return i + 1;
  }
  return 0;
}

export function parseMarkdown(text: string, { frontmatter = true }: { frontmatter?: boolean } = {}): Block[] {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const skip = frontmatter ? frontmatterLines(lines) : 0;
  return parseBlocks(lines.slice(skip), 0, { blocks: 0 });
}

// ------------------------------------------------------------------ inline

const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;

type Ctx = { depth: number; noClose: Map<string, number>; /** Code-mark run length → the first place no closer was found from. */ noTicks: Map<number, number> };

/** Where `marker` closes, from `from`: not escaped, not inside a code span, not after a space; -1 when it doesn't. */
function findClose(text: string, from: number, marker: string, ctx: Ctx, word: boolean): number {
  const known = ctx.noClose.get(marker);
  if (known !== undefined && from >= known) return -1;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "`") {
      let n = 0;
      while (text[i + n] === "`") n += 1;
      const end = text.indexOf("`".repeat(n), i + n);
      if (end >= 0) {
        i = end + n - 1;
        continue;
      }
      i += n - 1;
      continue;
    }
    if (text.startsWith(marker, i) && i > from && !/\s/.test(text[i - 1]!)) {
      // A single marker must not be half of a double one.
      if (marker.length === 1 && (text[i + 1] === marker || text[i - 1] === marker)) continue;
      if (word && WORD.test(text[i + marker.length] ?? "")) continue;
      return i;
    }
  }
  ctx.noClose.set(marker, Math.min(from, known ?? Number.POSITIVE_INFINITY));
  return -1;
}

function linkTarget(text: string, from: number): { href: string; end: number } | null {
  if (text[from] !== "(") return null;
  let depth = 0;
  for (let i = from; i < text.length && i < from + 2048; i += 1) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        const inner = text.slice(from + 1, i).trim();
        const href = (/^<([^>]*)>/.exec(inner)?.[1] ?? inner.split(/\s+/)[0] ?? "").trim();
        return { href, end: i + 1 };
      }
    } else if (ch === "\n" && depth === 1 && text[i - 1] === "\n") return null;
  }
  return null;
}

function closingBracket(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length && i < from + 4096; i += 1) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > 0) i = end;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Only web links open; anything else (javascript:, file:, data:) stays text. */
export function safeHref(href: string): string | null {
  const value = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(value) ? value : null;
}

function inline(text: string, ctx: Ctx): Inline[] {
  const out: Inline[] = [];
  // Plain text is collected as pieces (slices of `text`) and joined once per run: linear in the text's length.
  let pieces: string[] = [];
  let run = 0; // where the current slice of plain text starts
  const take = (until: number) => {
    if (until > run) pieces.push(text.slice(run, until));
  };
  const flush = () => {
    if (pieces.length) {
      const value = pieces.join("");
      if (value) out.push({ t: "text", v: value });
    }
    pieces = [];
  };
  const deeper = (inner: string): Inline[] => (ctx.depth >= MD_LIMITS.inlineDepth ? [{ t: "text", v: inner }] : inline(inner, { depth: ctx.depth + 1, noClose: new Map(), noTicks: new Map() }));
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const prev = i > 0 ? text[i - 1]! : " ";
    if (ch === "\\" && i + 1 < text.length) {
      const nextCh = text[i + 1]!;
      if (nextCh === "\n") {
        take(i);
        flush();
        out.push({ t: "br" });
        i += 1;
        run = i + 1;
        continue;
      }
      if (PUNCT.test(nextCh)) {
        take(i);
        pieces.push(nextCh);
        i += 1;
        run = i + 1;
        continue;
      }
    }
    if (ch === "\n") {
      // Two spaces before a line end is a hard break; any other line end is a space. Only the spaces just before it are looked at.
      let spaces = 0;
      while (i - spaces - 1 >= run && text[i - spaces - 1] === " ") spaces += 1;
      take(i - spaces);
      if (spaces >= 2) {
        flush();
        out.push({ t: "br" });
      } else pieces.push(" ");
      run = i + 1;
      continue;
    }
    if (ch === "`") {
      let n = 0;
      while (text[i + n] === "`") n += 1;
      const none = ctx.noTicks.get(n);
      const end = none !== undefined && i >= none ? -1 : text.indexOf("`".repeat(n), i + n);
      if (end < 0 && none === undefined) ctx.noTicks.set(n, i);
      if (end >= 0 && text[end + n] !== "`") {
        let code = text.slice(i + n, end).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
        take(i);
        flush();
        out.push({ t: "code", v: code });
        i = end + n - 1;
        run = i + 1;
        continue;
      }
      i += n - 1;
      continue;
    }
    if ((ch === "[" || (ch === "!" && text[i + 1] === "[")) && ctx.depth < MD_LIMITS.inlineDepth) {
      const open = ch === "!" ? i + 1 : i;
      const close = closingBracket(text, open);
      const target = close > 0 ? linkTarget(text, close + 1) : null;
      if (target) {
        const label = text.slice(open + 1, close);
        const href = safeHref(target.href);
        take(i);
        flush();
        const children = deeper(label.length ? label : target.href);
        out.push(href ? { t: "link", href, c: children } : { t: "em", c: children });
        i = target.end - 1;
        run = i + 1;
        continue;
      }
    }
    if (ch === "<") {
      const auto = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/i.exec(text.slice(i, i + 2100));
      if (auto) {
        take(i);
        flush();
        out.push({ t: "link", href: auto[1]!, c: [{ t: "text", v: auto[1]! }] });
        i += auto[0].length - 1;
        run = i + 1;
        continue;
      }
    }
    if ((ch === "h" || ch === "H") && !WORD.test(prev)) {
      const bare = /^https?:\/\/[^\s<>"'`]+/i.exec(text.slice(i, i + 2100));
      if (bare) {
        const url = bare[0].replace(/[.,;:!?)\]]+$/, "");
        take(i);
        flush();
        out.push({ t: "link", href: url, c: [{ t: "text", v: url }] });
        i += url.length - 1;
        run = i + 1;
        continue;
      }
    }
    const two = text.slice(i, i + 2);
    if ((two === "**" || two === "__" || two === "~~") && text[i + 2] !== undefined && !/\s/.test(text[i + 2]!)) {
      const word = two === "__";
      if (!word || !WORD.test(prev)) {
        const end = findClose(text, i + 2, two, ctx, word);
        if (end > i + 2) {
          take(i);
          flush();
          out.push({ t: two === "~~" ? "del" : "strong", c: deeper(text.slice(i + 2, end)) });
          i = end + 1;
          run = i + 1;
          continue;
        }
      }
    }
    if ((ch === "*" || ch === "_") && text[i + 1] !== ch && text[i + 1] !== undefined && !/\s/.test(text[i + 1]!)) {
      const word = ch === "_";
      if (!word || !WORD.test(prev)) {
        const end = findClose(text, i + 1, ch, ctx, word);
        if (end > i + 1) {
          take(i);
          flush();
          out.push({ t: "em", c: deeper(text.slice(i + 1, end)) });
          i = end;
          run = i + 1;
          continue;
        }
      }
    }
  }
  take(text.length);
  flush();
  return out;
}

export function parseInline(text: string): Inline[] {
  return inline(text, { depth: 0, noClose: new Map(), noTicks: new Map() });
}

/** The words of a run, without any formatting: for search snippets and accessibility labels. */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes.map((node) => (node.t === "text" || node.t === "code" ? node.v : node.t === "br" ? "\n" : inlineText(node.c))).join("");
}
