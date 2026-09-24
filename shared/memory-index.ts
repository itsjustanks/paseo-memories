/**
 * Claude's `MEMORY.md` index: one line per memory, `- [Title](file.md) — hook`.
 * There is no required format (memories-research/claude-code.md Q4), so lines
 * that do not look like this are kept as they are and never rewritten. Pure.
 */

export type IndexLine = {
  /** 0-based line number. */
  line: number;
  title: string;
  /** The link target as written. */
  target: string;
  /** The file it names, `./` and URL escapes removed. */
  file: string;
  hook: string;
  /** `- ` or `* ` with any indent. */
  prefix: string;
  /** ` — `, ` - `, `: ` or "" as written. */
  separator: string;
};

const LINE = /^(\s*[-*+]\s+)\[([^\]]*)\]\(([^)\s]+)\)(?:(\s+[—–-]\s+|:\s+|\s+)(.*))?\s*$/;

export function normalizeTarget(target: string): string {
  let file = target.replace(/^<|>$/g, "").replace(/^\.\//, "");
  try {
    file = decodeURI(file);
  } catch {
    // keep as written
  }
  return file;
}

export function parseIndex(text: string): IndexLine[] {
  const out: IndexLine[] = [];
  text.split("\n").forEach((raw, line) => {
    const match = LINE.exec(raw.replace(/\r$/, ""));
    if (!match) return;
    const target = match[3]!;
    if (/^[a-z]+:\/\//i.test(target)) return;
    out.push({
      line,
      prefix: match[1]!,
      title: match[2]!,
      target,
      file: normalizeTarget(target),
      separator: match[4] ?? "",
      hook: (match[5] ?? "").trim(),
    });
  });
  return out;
}

/** The separator most lines use, so a new line looks like its neighbours. */
function usualSeparator(lines: IndexLine[]): string {
  const counts = new Map<string, number>();
  for (const line of lines) if (line.separator.trim()) counts.set(line.separator, (counts.get(line.separator) ?? 0) + 1);
  let best = " — ";
  let most = 0;
  for (const [separator, count] of counts) if (count > most) [best, most] = [separator, count];
  return best;
}

function render(prefix: string, title: string, target: string, separator: string, hook: string): string {
  const cleanTitle = title.replace(/[\]\n\r]/g, " ").trim();
  const cleanHook = hook.replace(/[\n\r]+/g, " ").trim();
  return cleanHook ? `${prefix}[${cleanTitle}](${target})${separator.trim() ? separator : " — "}${cleanHook}` : `${prefix}[${cleanTitle}](${target})`;
}

function eolFor(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Add a line for `file`, or update the existing one's title and hook in place. */
export function upsertIndexLine(text: string, file: string, title: string, hook: string): string {
  const lines = parseIndex(text);
  const existing = lines.find((line) => line.file === file);
  const rows = text.split("\n");
  if (existing) {
    const cr = rows[existing.line]!.endsWith("\r") ? "\r" : "";
    rows[existing.line] = render(existing.prefix, title, existing.target, existing.separator, hook) + cr;
    return rows.join("\n");
  }
  const eol = eolFor(text);
  const line = render(lines[0]?.prefix ?? "- ", title, file, usualSeparator(lines), hook);
  if (text === "") return `${line}${eol}`;
  return text.endsWith("\n") ? `${text}${line}${eol}` : `${text}${eol}${line}${eol}`;
}

/** Point the line for `from` at `to`, with a new title/hook when given. */
export function renameIndexLine(text: string, from: string, to: string, title?: string, hook?: string): string {
  const existing = parseIndex(text).find((line) => line.file === from);
  if (!existing) return upsertIndexLine(text, to, title ?? to.replace(/\.md$/, ""), hook ?? "");
  const rows = text.split("\n");
  const cr = rows[existing.line]!.endsWith("\r") ? "\r" : "";
  const target = existing.target.startsWith("./") ? `./${to}` : to;
  rows[existing.line] = render(existing.prefix, title ?? existing.title, target, existing.separator, hook ?? existing.hook) + cr;
  return rows.join("\n");
}

/** Drop the line(s) naming `file`; everything else stays as written. */
export function removeIndexLine(text: string, file: string): string {
  const drop = new Set(parseIndex(text).filter((line) => line.file === file).map((line) => line.line));
  if (drop.size === 0) return text;
  return text
    .split("\n")
    .filter((_, index) => !drop.has(index))
    .join("\n");
}
