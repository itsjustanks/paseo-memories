import { z } from "zod";
import { frontmatterKeys, parseMemoryFile, readFields } from "./frontmatter";
import { MASK_FILL } from "./secrets";
import { splitSections } from "./markdown";

/**
 * Import and export formats (SPEC "Import / export"). Pure: parsing text
 * into items and items into text. Where they get written is the server's
 * business, through the same safe-write path as every other save.
 */

export const BundleItemSchema = z.object({
  agent: z.string(),
  scope: z.string(),
  kind: z.string(),
  projectHint: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  type: z.string().optional(),
  body: z.string(),
  masked: z.boolean().default(false),
});
export type BundleItem = z.infer<typeof BundleItemSchema>;

export const BundleSchema = z.object({
  format: z.literal("paseo-memories"),
  version: z.literal(1),
  exportedAt: z.string(),
  host: z.string(),
  items: z.array(BundleItemSchema),
});
export type Bundle = z.infer<typeof BundleSchema>;

export const IMPORT_FORMATS = ["bundle", "markdown", "claude-memory", "claude-ai", "mdc"] as const;

export const ImportItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  type: z.string().optional(),
  body: z.string(),
  masked: z.boolean().default(false),
  /** bundle | markdown | claude-memory | claude-ai | mdc | entry (copied from an existing source) */
  format: z.string(),
  agent: z.string().optional(),
  scope: z.string().optional(),
  kind: z.string().optional(),
  projectHint: z.string().optional(),
  /** The file this came from, for display. */
  origin: z.string().optional(),
  warnings: z.array(z.string()).default([]),
});
export type ImportItem = z.infer<typeof ImportItemSchema>;

const MASKED_WARNING = "This text has hidden (masked) values: the secrets were not exported, so the dots will be saved as they are.";

function base(name?: string): string {
  return (name ?? "").split("/").pop()!.replace(/\.(md|mdc|json|txt)$/i, "") || "Imported";
}

function trimBody(text: string): string {
  const body = text.replace(/^\s*\n/, "").replace(/\s+$/, "");
  return body ? `${body}\n` : "";
}

function withMaskWarning(item: ImportItem): ImportItem {
  if (!item.body.includes(MASK_FILL) || item.warnings.includes(MASKED_WARNING)) return item;
  return { ...item, masked: true, warnings: [...item.warnings, MASKED_WARNING] };
}

/** Best guess of what was pasted or uploaded. */
export function detectFormat(text: string, name = ""): (typeof IMPORT_FORMATS)[number] {
  const trimmed = text.trimStart();
  if (/\.json$/i.test(name) || trimmed.startsWith("{")) {
    try {
      if ((JSON.parse(trimmed) as { format?: unknown }).format === "paseo-memories") return "bundle";
    } catch {
      // not JSON after all
    }
  }
  if (/\.mdc$/i.test(name)) return "mdc";
  if (trimmed.startsWith("---")) {
    const keys = frontmatterKeys(trimmed);
    if ("alwaysApply" in keys || "globs" in keys) return "mdc";
    if ("name" in keys || "metadata" in keys || ("description" in keys && "type" in keys)) return "claude-memory";
  }
  const lines = text.split("\n").filter((line) => line.trim());
  const dated = lines.filter((line) => /^\s*(?:[-*]\s*)?\[[^\]]{1,40}\]\s*-\s+\S/.test(line)).length;
  if (lines.length && dated / lines.length >= 0.6) return "claude-ai";
  return "markdown";
}

export function parseBundle(text: string): { items: ImportItem[]; warnings: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { items: [], warnings: ["That is not valid JSON."] };
  }
  const parsed = BundleSchema.safeParse(raw);
  if (!parsed.success) return { items: [], warnings: ["That JSON is not a paseo-memories bundle (version 1)."] };
  return {
    items: parsed.data.items.map((item, index) =>
      withMaskWarning({
        id: `bundle-${index}`,
        title: item.title,
        ...(item.description !== undefined ? { description: item.description } : {}),
        ...(item.type !== undefined ? { type: item.type } : {}),
        body: item.body,
        masked: item.masked,
        format: "bundle",
        agent: item.agent,
        scope: item.scope,
        kind: item.kind,
        ...(item.projectHint ? { projectHint: item.projectHint } : {}),
        warnings: item.masked ? [MASKED_WARNING] : [],
      }),
    ),
    warnings: [],
  };
}

/** A line that is an ATX heading, outside code fences, with its level. */
function headingLevels(lines: string[]): Array<number | null> {
  let fence: string | null = null;
  return lines.map((raw) => {
    const line = raw.replace(/\r$/, "");
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]![0]!;
      else if (fenceMatch[1]![0] === fence) fence = null;
      return null;
    }
    if (fence !== null) return null;
    const match = /^\s{0,3}(#{1,6})\s/.exec(line);
    return match ? match[1]!.length : null;
  });
}

/** Headings outside fences moved down (`by` > 0) or up (`by` < 0) by some levels. Past 6 they stop being headings; moving back restores them. */
export function shiftHeadings(text: string, by: number): string {
  if (by === 0) return text;
  let fence: string | null = null;
  return text
    .split("\n")
    .map((line) => {
      const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        if (fence === null) fence = fenceMatch[1]![0]!;
        else if (fenceMatch[1]![0] === fence) fence = null;
        return line;
      }
      if (fence !== null) return line;
      return line.replace(/^(\s{0,3})(#{1,12})(?=\s)/, (_all, indent: string, marks: string) => {
        const level = marks.length + by;
        return level >= 1 ? `${indent}${"#".repeat(level)}` : `${indent}${marks}`;
      });
    })
    .join("\n");
}

const EXPORT_META = /^<!-- paseo-memories (\{.*\}) -->$/;

type ExportMeta = { agent?: string; scope?: string; kind?: string; projectHint?: string; description?: string; type?: string; masked?: boolean; shift?: number; lines?: number };

/**
 * Markdown split at its top heading level. Text before the first top-level
 * heading (even under deeper headings) is an item of its own, named after
 * its first heading or the file. This plugin's own markdown export carries a
 * comment per item that restores each body exactly.
 */
export function parseMarkdown(text: string, name?: string): ImportItem[] {
  const lines = text.split("\n");
  const levels = headingLevels(lines);
  const present = levels.filter((level): level is number => level !== null);
  if (!present.length) return text.trim() ? [withMaskWarning({ id: "md-0", title: base(name), body: trimBody(text), masked: false, format: "markdown", warnings: [] })] : [];
  const top = Math.min(...present);
  const starts = levels.map((level, index) => (level === top ? index : -1)).filter((index) => index >= 0);
  const out: ImportItem[] = [];
  const titleOf = (line: string) => line.replace(/\r$/, "").replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\s+#*\s*$/, "").trim();
  const preface = lines.slice(0, starts[0]);
  if (preface.some((line) => line.trim())) {
    const firstHeading = preface.findIndex((_line, index) => levels[index] !== null);
    const leadsWithHeading = firstHeading >= 0 && preface.slice(0, firstHeading).every((line) => !line.trim());
    const title = leadsWithHeading ? titleOf(preface[firstHeading]!) : base(name);
    const body = leadsWithHeading ? preface.slice(firstHeading + 1).join("\n") : preface.join("\n");
    out.push({ id: `md-${out.length}`, title, body: trimBody(body), masked: false, format: "markdown", warnings: [] });
  }
  starts.forEach((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    const rest = lines.slice(start + 1, end);
    const metaAt = rest.findIndex((line) => line.trim() !== "");
    const meta = metaAt >= 0 ? EXPORT_META.exec(rest[metaAt]!.trim()) : null;
    if (meta) {
      let info: ExportMeta = {};
      try {
        info = JSON.parse(meta[1]!) as ExportMeta;
      } catch {
        info = {};
      }
      // Exactly the body the export wrote: `lines` lines after the blank line under the comment.
      const bodyLines = rest.slice(metaAt + 2, metaAt + 2 + (info.lines ?? rest.length));
      out.push({
        id: `md-${out.length}`,
        title: titleOf(lines[start]!),
        body: shiftHeadings(bodyLines.join("\n"), -(info.shift ?? 0)),
        masked: Boolean(info.masked),
        format: "markdown",
        ...(info.agent ? { agent: info.agent } : {}),
        ...(info.scope ? { scope: info.scope } : {}),
        ...(info.kind ? { kind: info.kind } : {}),
        ...(info.projectHint ? { projectHint: info.projectHint } : {}),
        ...(info.description !== undefined ? { description: info.description } : {}),
        ...(info.type ? { type: info.type } : {}),
        warnings: [],
      });
      return;
    }
    out.push({ id: `md-${out.length}`, title: titleOf(lines[start]!), body: trimBody(rest.join("\n")), masked: false, format: "markdown", warnings: [] });
  });
  return out.map(withMaskWarning);
}

/** A Claude memory file, any of the three frontmatter shapes. */
export function parseClaudeMemory(text: string, name?: string): ImportItem {
  const file = parseMemoryFile(text);
  const fields = readFields(file);
  return withMaskWarning({
    id: `claude-${base(name)}`,
    title: fields.name ?? base(name),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(fields.type !== undefined ? { type: fields.type } : {}),
    body: file.body,
    masked: false,
    format: "claude-memory",
    agent: "claude",
    ...(name ? { origin: name } : {}),
    warnings: fields.shape === "none" ? ["No frontmatter: imported as plain text."] : [],
  });
}

/**
 * claude.ai's memory export: `[date saved, if available] - memory content`
 * lines (support.claude.com/en/articles/12123587; marked experimental there).
 */
export function parseClaudeAi(text: string): { items: ImportItem[]; warnings: string[] } {
  const items: ImportItem[] = [];
  const skipped: number[] = [];
  let open: ImportItem | null = null;
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    const match = /^\s*(?:[-*]\s*)?\[([^\]]{1,40})\]\s*-\s+(.+?)\s*$/.exec(line);
    if (match) {
      const [, date, content] = match as unknown as [string, string, string];
      const title = content.split(/\s+/).slice(0, 8).join(" ").replace(/[.,;:]$/, "");
      open = { id: `claude-ai-${items.length}`, title, description: date === "unknown" ? "From claude.ai" : `From claude.ai, saved ${date}`, type: "user", body: `${content}\n`, masked: false, format: "claude-ai", warnings: [] };
      items.push(open);
      return;
    }
    if (!line.trim()) {
      if (open) open.body += "\n";
      return;
    }
    // A line that does not start a new "[date] - " entry belongs to the one above it.
    if (open) open.body += `${line}\n`;
    else skipped.push(index + 1);
  });
  for (const item of items) item.body = `${item.body.replace(/\n+$/, "")}\n`;
  const warnings = skipped.length
    ? [`${skipped.length} line${skipped.length === 1 ? "" : "s"} before the first "[date] - " entry ${skipped.length === 1 ? "was" : "were"} left out (line${skipped.length === 1 ? "" : "s"} ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? ", …" : ""}).`]
    : [];
  return { items: items.map(withMaskWarning), warnings };
}

/** A Cursor `.mdc` rule: frontmatter `description`, `globs`, `alwaysApply`. */
export function parseMdc(text: string, name?: string): ImportItem {
  const file = parseMemoryFile(text);
  const keys = frontmatterKeys(text);
  const warnings: string[] = [];
  if (keys.globs && keys.alwaysApply !== true) warnings.push(`In Cursor this rule applies only to ${String(keys.globs)}; appended to an instruction file it will always load.`);
  return withMaskWarning({
    id: `mdc-${base(name)}`,
    title: typeof keys.description === "string" && keys.description ? keys.description : base(name),
    ...(typeof keys.description === "string" ? { description: keys.description } : {}),
    body: trimBody(file.body),
    masked: false,
    format: "mdc",
    ...(name ? { origin: name } : {}),
    warnings,
  });
}

export function parseImport(raw: string, name?: string, format?: string): { format: string; items: ImportItem[]; warnings: string[] } {
  // A byte-order mark from Windows editors would otherwise break JSON and headings alike.
  const text = raw.replace(/^\uFEFF/, "");
  const chosen = format && format !== "auto" ? format : detectFormat(text, name);
  // Ids are unique within one parse: file (or format) and position.
  const tag = (items: ImportItem[]) => items.map((item, index) => ({ ...item, id: `${name ? base(name) : chosen}:${index}`, ...(name && !item.origin ? { origin: name } : {}) }));
  switch (chosen) {
    case "bundle": {
      const { items, warnings } = parseBundle(text);
      return { format: chosen, items: tag(items), warnings };
    }
    case "claude-memory":
      return { format: chosen, items: tag([parseClaudeMemory(text, name)]), warnings: [] };
    case "claude-ai": {
      const parsed = parseClaudeAi(text);
      return { format: chosen, items: tag(parsed.items), warnings: [...(parsed.items.length ? ["claude.ai's export format is experimental; check each line."] : ["No [date] - text lines found."]), ...parsed.warnings] };
    }
    case "mdc":
      return { format: chosen, items: tag([parseMdc(text, name)]), warnings: [] };
    default:
      return { format: "markdown", items: tag(parseMarkdown(text, name)), warnings: [] };
  }
}

// ------------------------------------------------------------------ export

export function buildBundle(items: BundleItem[], host: string, exportedAt = new Date().toISOString()): string {
  const bundle: Bundle = { format: "paseo-memories", version: 1, exportedAt, host, items };
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/**
 * Markdown to read, which this plugin can also read back exactly: each item
 * is a `#` heading, a comment with its details, then its body with any
 * headings moved down so none is `#`.
 */
export function renderMarkdown(items: BundleItem[]): string {
  return items
    .map((item) => {
      const levels = headingLevels(item.body.split("\n")).filter((level): level is number => level !== null);
      const shift = levels.length ? Math.max(0, 2 - Math.min(...levels)) : 0;
      const body = shiftHeadings(item.body, shift);
      const meta: ExportMeta = {
        agent: item.agent,
        scope: item.scope,
        kind: item.kind,
        ...(item.projectHint ? { projectHint: item.projectHint } : {}),
        ...(item.description !== undefined ? { description: item.description } : {}),
        ...(item.type ? { type: item.type } : {}),
        ...(item.masked ? { masked: true } : {}),
        ...(shift ? { shift } : {}),
        lines: body.split("\n").length,
      };
      const comment = JSON.stringify(meta).replace(/-->/g, "--\\u003e").replace(/>/g, "\\u003e");
      return `# ${item.title.replace(/[\r\n]+/g, " ")}\n\n<!-- paseo-memories ${comment} -->\n\n${body}${body.endsWith("\n") ? "" : "\n"}`;
    })
    .join("\n");
}

/** How an item reads when appended to an instruction file. */
export function asSection(item: Pick<ImportItem, "title" | "body">): string {
  return `## ${item.title.replace(/\n/g, " ")}\n\n${item.body.replace(/^\s*\n/, "").replace(/\s+$/, "")}\n`;
}

/** Kinds a Move may delete from: editable Claude memories and the instruction files this plugin edits. */
export const MOVABLE_KINDS = new Set(["claude-auto-memory", "claude-md", "claude-local", "claude-rule", "agents-md", "opencode-md", "pi-md", "omp-md", "copilot-md"]);

/** Why the original of a copy cannot be removed (so Move is not offered), or undefined when it can. */
export function moveBlocker(source: { kind: string; access: string; reason?: string; path: string }, key?: string): string | undefined {
  const name = source.path.split("/").pop() ?? source.path;
  if (source.access !== "editable") return `${name} is read-only here${source.reason ? ` (${source.reason.replace(/\.$/, "")})` : ""}`;
  if (source.kind === "codex-memory") return `${name} is Codex's generated memory, which only Codex rewrites`;
  if (!MOVABLE_KINDS.has(source.kind)) return `${name} is not a file this plugin edits`;
  if (key === undefined) return `${name} is a whole file; whole files can be copied but not moved`;
  return undefined;
}
