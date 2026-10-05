/**
 * What the editor's formatting buttons do: each inserts or removes Markdown
 * at the selection and nothing else. Text outside the selection (or, for
 * line buttons, outside the selected lines) is never touched, so a save
 * still changes only what you changed; a second press undoes the first.
 * Line ends (`\n` or `\r\n`) are kept as they are. Pure.
 */

export type Selection = { start: number; end: number };
export type Edit = { text: string; selection: Selection };
export type Format = "bold" | "italic" | "code" | "heading" | "bullets" | "numbers" | "link";

const clamp = (sel: Selection, length: number): Selection => {
  const start = Math.max(0, Math.min(sel.start, sel.end, length));
  const end = Math.max(start, Math.min(Math.max(sel.start, sel.end), length));
  return { start, end };
};

/** Wraps the selection in `mark` (or takes it off when it is already there); with nothing selected, inserts a placeholder and selects it. */
function wrap(text: string, raw: Selection, mark: string, placeholder: string): Edit {
  const sel = clamp(raw, text.length);
  const inner = text.slice(sel.start, sel.end);
  // Already wrapped around the selection: unwrap. A one-character mark must stand alone (the `*` of `**bold**` is not italic).
  const alone = mark.length > 1 || (text[sel.start - mark.length - 1] !== mark && text[sel.end + mark.length] !== mark);
  if (alone && text.slice(sel.start - mark.length, sel.start) === mark && text.slice(sel.end, sel.end + mark.length) === mark && sel.start >= mark.length) {
    return { text: text.slice(0, sel.start - mark.length) + inner + text.slice(sel.end + mark.length), selection: { start: sel.start - mark.length, end: sel.end - mark.length } };
  }
  // The selection includes the marks: unwrap.
  if (inner.length >= mark.length * 2 && inner.startsWith(mark) && inner.endsWith(mark) && (mark.length > 1 || (inner[1] !== mark && inner[inner.length - 2] !== mark))) {
    const bare = inner.slice(mark.length, inner.length - mark.length);
    return { text: text.slice(0, sel.start) + bare + text.slice(sel.end), selection: { start: sel.start, end: sel.start + bare.length } };
  }
  const body = inner.length ? inner : placeholder;
  return { text: text.slice(0, sel.start) + mark + body + mark + text.slice(sel.end), selection: { start: sel.start + mark.length, end: sel.start + mark.length + body.length } };
}

/** The start of the line `at` is on, and the end of the last line the selection touches (before its line end). */
function lineSpan(text: string, sel: Selection): { from: number; to: number } {
  const from = text.lastIndexOf("\n", sel.start - 1) + 1;
  // A selection that ends right after a line end stops at the line before it.
  const last = sel.end > sel.start && text[sel.end - 1] === "\n" ? sel.end - 1 : sel.end;
  let to = text.indexOf("\n", last);
  if (to < 0) to = text.length;
  if (to > from && text[to - 1] === "\r") to -= 1;
  return { from, to: Math.max(from, to) };
}

/** Applies `change` to each selected line (keeping its indentation and line end), or `undo` when every line already has it. */
function eachLine(text: string, raw: Selection, has: (line: string) => boolean, add: (line: string, index: number) => string, remove: (line: string) => string): Edit {
  const sel = clamp(raw, text.length);
  const { from, to } = lineSpan(text, sel);
  const block = text.slice(from, to);
  // Split keeping each line's own `\r`.
  const lines = block.split("\n");
  const body = (line: string) => line.replace(/\r$/, "");
  const content = lines.filter((line) => body(line).trim() !== "");
  const undo = content.length > 0 && content.every((line) => has(body(line).replace(/^\s*/, "")));
  let n = 0;
  const next = lines
    .map((line) => {
      const cr = line.endsWith("\r") ? "\r" : "";
      const bare = body(line);
      if (bare.trim() === "" && content.length) return line;
      const lead = /^\s*/.exec(bare)![0];
      const rest = bare.slice(lead.length);
      const out = undo ? remove(rest) : add(has(rest) ? remove(rest) : rest, n);
      n += 1;
      return lead + out + cr;
    })
    .join("\n");
  const result = text.slice(0, from) + next + text.slice(to);
  const delta = next.length - block.length;
  // One empty line: put the cursor after what was added.
  if (sel.start === sel.end && block.trim() === "") return { text: result, selection: { start: from + next.length, end: from + next.length } };
  return { text: result, selection: { start: from, end: Math.max(from, to + delta) } };
}

const HEADING = /^#{1,6}[ \t]+/;
const BULLET = /^[-*+][ \t]+(?!\[[ xX]\])/;
const NUMBER = /^\d{1,9}[.)][ \t]+/;

export function applyFormat(text: string, selection: Selection, format: Format): Edit {
  switch (format) {
    case "bold":
      return wrap(text, selection, "**", "bold text");
    case "italic": {
      // Pressing Italic on italic text (either form) takes it off.
      const sel = clamp(selection, text.length);
      for (const mark of ["_", "*"]) {
        const edit = wrap(text, sel, mark, "italic text");
        if (edit.text.length < text.length) return edit;
      }
      // Next to `*` marks (inside **bold**), `*` would merge with them: use `_` there.
      const inner = text.slice(sel.start, sel.end);
      const nearStar = text[sel.start - 1] === "*" || text[sel.end] === "*" || inner.startsWith("*") || inner.endsWith("*");
      return wrap(text, sel, nearStar ? "_" : "*", "italic text");
    }
    case "code": {
      const sel = clamp(selection, text.length);
      const inner = text.slice(sel.start, sel.end);
      if (!inner.includes("\n")) return wrap(text, selection, "`", "code");
      // Several lines: a fenced block on lines of its own.
      const nl = inner.includes("\r\n") ? "\r\n" : "\n";
      const before = sel.start === 0 || text[sel.start - 1] === "\n" ? "" : nl;
      const block = `${before}\`\`\`${nl}${inner.replace(/\r?\n$/, "")}${nl}\`\`\``;
      return { text: text.slice(0, sel.start) + block + text.slice(sel.end), selection: { start: sel.start + before.length + 3 + nl.length, end: sel.start + before.length + 3 + nl.length + inner.replace(/\r?\n$/, "").length } };
    }
    case "heading":
      return eachLine(text, selection, (line) => HEADING.test(line), (line) => `## ${line}`, (line) => line.replace(HEADING, ""));
    case "bullets":
      // A numbered line becomes a bullet (the marker is swapped, not stacked), and back.
      return eachLine(text, selection, (line) => BULLET.test(line), (line) => `- ${line.replace(NUMBER, "")}`, (line) => line.replace(BULLET, ""));
    case "numbers":
      return eachLine(text, selection, (line) => NUMBER.test(line), (line, index) => `${index + 1}. ${line.replace(BULLET, "")}`, (line) => line.replace(NUMBER, ""));
    case "link": {
      const sel = clamp(selection, text.length);
      const inner = text.slice(sel.start, sel.end);
      if (/^https?:\/\/\S+$/.test(inner)) {
        const next = `[link text](${inner})`;
        return { text: text.slice(0, sel.start) + next + text.slice(sel.end), selection: { start: sel.start + 1, end: sel.start + 10 } };
      }
      const label = inner.length ? inner : "link text";
      const next = `[${label}](https://)`;
      // With text selected, the address is what's left to type; without, the label.
      const at = inner.length ? sel.start + label.length + 3 : sel.start + 1;
      return { text: text.slice(0, sel.start) + next + text.slice(sel.end), selection: inner.length ? { start: at, end: at + 8 } : { start: at, end: at + label.length } };
    }
  }
}
