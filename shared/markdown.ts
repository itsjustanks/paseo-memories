import { maskSecrets } from "./secrets";

/**
 * Markdown instruction files as sections, and the `@path` imports Claude
 * follows. Pure; path resolution happens on the server.
 */

export type Section = {
  /** Stable while the headings above it do not change: `<index>:<heading slug>`. */
  key: string;
  title: string;
  level: number;
  /** 0-based first line (the heading) and line after the last. */
  start: number;
  end: number;
};

function slugify(raw: string): string {
  // A secret in a heading must not reach the key, which is sent unmasked.
  const text = maskSecrets(raw).text;
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/** ATX headings outside fenced code split the file; text before the first heading is section 0 when not blank. */
export function splitSections(text: string): Section[] {
  const lines = text.split("\n");
  const heads: Array<{ line: number; level: number; title: string }> = [];
  let fence: string | null = null;
  lines.forEach((raw, line) => {
    const t = raw.replace(/\r$/, "");
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(t);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]![0]!;
      else if (fenceMatch[1]![0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const match = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(t);
    if (match) heads.push({ line, level: match[1]!.length, title: match[2]! });
  });
  const out: Section[] = [];
  const total = text.endsWith("\n") ? lines.length - 1 : lines.length;
  const firstHead = heads[0]?.line ?? total;
  if (lines.slice(0, firstHead).some((line) => line.trim() !== "")) {
    out.push({ key: "0:", title: "(top of file)", level: 0, start: 0, end: firstHead });
  }
  heads.forEach((head, index) => {
    const end = heads[index + 1]?.line ?? total;
    out.push({ key: `${out.length}:${slugify(head.title)}`, title: head.title, level: head.level, start: head.line, end });
  });
  return out;
}

export function sectionText(text: string, section: Section): string {
  return text.split("\n").slice(section.start, section.end).join("\n");
}

/**
 * `@path` references Claude expands: at the start of a line or after
 * whitespace, outside code spans and fenced blocks. Emails and `@scope/pkg`
 * mentions also match; the server keeps only those that exist.
 */
export function importRefs(text: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const raw of text.split("\n")) {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const line = raw.replace(/`[^`]*`/g, " ");
    for (const match of line.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[^\s@`)\]]+)/g)) {
      const ref = match[1]!.replace(/[.,;:!?]+$/, "");
      if (ref && !out.includes(ref)) out.push(ref);
    }
  }
  return out;
}

/** Splice new text into one section, leaving the rest of the file untouched. */
export function replaceSection(text: string, section: Section, replacement: string): string {
  const lines = text.split("\n");
  const inner = replacement.endsWith("\n") ? replacement.slice(0, -1) : replacement;
  lines.splice(section.start, section.end - section.start, ...inner.split("\n"));
  return lines.join("\n");
}
