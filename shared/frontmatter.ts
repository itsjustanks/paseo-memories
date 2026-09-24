/**
 * Claude memory file frontmatter, read and edited without disturbing what we
 * do not own. Three shapes exist on real machines (memories-research/claude-code.md Q6):
 *
 *   nested        name, description, metadata{node_type?, type, originSessionId?, modified?}
 *   flat          name, description, type
 *   flat-session  name, description, type, originSessionId
 *
 * The block is kept as raw lines grouped by top-level key. An edit replaces
 * only the lines of the key it changes, so unknown keys, comments, quoting and
 * key order stay byte-for-byte. Pure.
 */

export type FrontmatterShape = "nested" | "flat" | "flat-session" | "none" | "other";

type Line = { text: string; eol: string };

/** One top-level key with its own line and any indented lines under it. */
type Group = { key: string | null; lines: Line[] };

export type MemoryFile = {
  hasFrontmatter: boolean;
  /** Opening fence line ending included. */
  open: string;
  groups: Group[];
  /** Closing fence line ending included. */
  close: string;
  body: string;
};

export type MemoryFields = {
  name?: string;
  description?: string;
  type?: string;
  shape: FrontmatterShape;
  /** Every other key, parsed loosely for display (`metadata.node_type`, `originSessionId`, …). */
  extra: Record<string, unknown>;
};

const KEY_LINE = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s:#][^:]*?)\s*:(?:\s+(.*)|\s*)$/;

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  const re = /([^\r\n]*)(\r\n|\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[0] === "") break;
    out.push({ text: match[1]!, eol: match[2]! });
  }
  return out;
}

function joinLines(lines: Line[]): string {
  return lines.map((line) => line.text + line.eol).join("");
}

function unquoteKey(raw: string): string {
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw.trim();
}

export function parseMemoryFile(text: string): MemoryFile {
  const lines = splitLines(text);
  const first = lines[0];
  if (!first || first.text.replace(/^\uFEFF/, "").trimEnd() !== "---") {
    return { hasFrontmatter: false, open: "", groups: [], close: "", body: text };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const t = lines[i]!.text.trimEnd();
    if (t === "---" || t === "...") {
      end = i;
      break;
    }
  }
  if (end < 0) return { hasFrontmatter: false, open: "", groups: [], close: "", body: text };
  const groups: Group[] = [];
  for (const line of lines.slice(1, end)) {
    const top = !/^[\s]/.test(line.text) && line.text.trim() !== "" && !line.text.startsWith("#");
    const match = top ? KEY_LINE.exec(line.text) : null;
    if (match) groups.push({ key: unquoteKey(match[1]!), lines: [line] });
    else if (groups.length > 0) groups[groups.length - 1]!.lines.push(line);
    else groups.push({ key: null, lines: [line] });
  }
  const bodyStart = joinLines(lines.slice(0, end + 1)).length;
  return {
    hasFrontmatter: true,
    open: first.text + first.eol,
    groups,
    close: lines[end]!.text + lines[end]!.eol,
    body: text.slice(bodyStart),
  };
}

export function serializeMemoryFile(file: MemoryFile): string {
  if (!file.hasFrontmatter) return file.body;
  return file.open + file.groups.map((group) => joinLines(group.lines)).join("") + file.close + file.body;
}

/** A YAML scalar as a string, loosely: quotes, escapes and folded blocks. */
export function yamlScalar(raw: string, continuation: string[] = []): unknown {
  const text = raw.trim();
  if (text === "" && continuation.length === 0) return "";
  if (/^[|>][-+]?\d*$/.test(text)) {
    const indented = continuation.map((line) => line.replace(/^\s+/, ""));
    return text.startsWith("|") ? indented.join("\n") : indented.join(" ").trim();
  }
  if (text.startsWith('"')) {
    const whole = [text, ...continuation.map((line) => line.trim())].join(" ");
    try {
      return JSON.parse(whole) as string;
    } catch {
      return whole.replace(/^"|"$/g, "");
    }
  }
  if (text.startsWith("'")) {
    const whole = [text, ...continuation.map((line) => line.trim())].join(" ");
    return whole.replace(/^'|'$/g, "").replace(/''/g, "'");
  }
  const plain = [text.replace(/\s+#.*$/, ""), ...continuation.map((line) => line.trim())].join(" ").trim();
  if (plain === "true") return true;
  if (plain === "false") return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(plain)) return Number(plain);
  if (plain === "null" || plain === "~") return null;
  if (plain.startsWith("[") && plain.endsWith("]")) {
    return plain
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return plain;
}

function groupValue(group: Group): unknown {
  const match = KEY_LINE.exec(group.lines[0]!.text);
  // Comment lines belong to no value.
  const rest = group.lines.slice(1).map((line) => line.text).filter((line) => !line.trim().startsWith("#"));
  const inline = match?.[2] ?? "";
  if (inline.trim() === "" && rest.some((line) => /^\s+-\s/.test(line))) {
    return rest.filter((line) => /^\s+-\s/.test(line)).map((line) => String(yamlScalar(line.replace(/^\s+-\s/, ""))));
  }
  return yamlScalar(inline, rest.filter((line) => line.trim() !== ""));
}

/** Children of a mapping key such as `metadata:`, as groups of their own. */
function childGroups(group: Group): Group[] {
  const out: Group[] = [];
  const children = group.lines.slice(1);
  const indent = /^(\s+)/.exec(children.find((line) => line.text.trim() !== "")?.text ?? "")?.[1] ?? "";
  if (!indent) return out;
  for (const line of children) {
    const own = line.text.startsWith(indent) && !/^\s/.test(line.text.slice(indent.length));
    const match = own ? KEY_LINE.exec(line.text.slice(indent.length)) : null;
    if (match) out.push({ key: unquoteKey(match[1]!), lines: [{ text: line.text.slice(indent.length), eol: line.eol }] });
    else if (out.length > 0) out[out.length - 1]!.lines.push({ text: line.text.slice(Math.min(indent.length, line.text.length - line.text.trimStart().length)), eol: line.eol });
  }
  return out;
}

function isMapping(group: Group): boolean {
  const match = KEY_LINE.exec(group.lines[0]!.text);
  return (match?.[2] ?? "").trim() === "" && group.lines.slice(1).some((line) => /^\s+[^\s-]/.test(line.text) && KEY_LINE.test(line.text.trim()));
}

export function readFields(file: MemoryFile): MemoryFields {
  if (!file.hasFrontmatter) return { shape: "none", extra: {} };
  const out: MemoryFields = { shape: "other", extra: {} };
  const topKeys: string[] = [];
  const metadataKeys: string[] = [];
  for (const group of file.groups) {
    if (group.key === null) continue;
    topKeys.push(group.key);
    if (group.key === "metadata" && isMapping(group)) {
      for (const child of childGroups(group)) {
        if (child.key === null) continue;
        metadataKeys.push(child.key);
        const value = groupValue(child);
        if (child.key === "type" && typeof value === "string") out.type = value;
        else out.extra[`metadata.${child.key}`] = value;
      }
      continue;
    }
    const value = groupValue(group);
    if (group.key === "name" && typeof value === "string") out.name = value;
    else if (group.key === "description" && typeof value === "string") out.description = value;
    else if (group.key === "type" && typeof value === "string" && out.type === undefined) out.type = value;
    else out.extra[group.key] = value;
  }
  const top = new Set(topKeys);
  if (top.has("metadata") && metadataKeys.includes("type")) out.shape = "nested";
  else if (top.has("type") && top.has("originSessionId")) out.shape = "flat-session";
  else if (top.has("type")) out.shape = "flat";
  return out;
}

const RESERVED_PLAIN = /^(?:true|false|null|yes|no|on|off|~|[+-]?\d[\d.eE+-]*)$/i;

/** A value as YAML text. Keeps double quotes when the original used them. */
export function formatScalar(value: string, quoted = false): string {
  const plainOk =
    !quoted &&
    value !== "" &&
    !/[\n\r\t]/.test(value) &&
    !/^[\s'"#&*!|>%@`{}[\],?:-]/.test(value) &&
    !/:\s|\s#|:$|\s$/.test(value) &&
    !RESERVED_PLAIN.test(value);
  return plainOk ? value : JSON.stringify(value);
}

function wasQuoted(line: string): boolean {
  const match = KEY_LINE.exec(line);
  return (match?.[2] ?? "").trim().startsWith('"');
}

function replaceGroup(group: Group, key: string, value: string, indent = ""): void {
  const first = group.lines[0]!;
  const quoted = wasQuoted(first.text.slice(indent.length));
  // Comments and blank lines that follow the key belong to no value: keep them as they are.
  const kept = group.lines.slice(1).filter((line) => line.text.trim() === "" || /^#/.test(line.text.slice(indent.length)));
  group.lines = [{ text: `${indent}${key}: ${formatScalar(value, quoted)}`, eol: first.eol || "\n" }, ...kept];
}

function eolOf(file: MemoryFile): string {
  return file.open.endsWith("\r\n") ? "\r\n" : "\n";
}

/**
 * Set name, description or type in place. `type` goes where the file already
 * keeps it (under `metadata:` for the nested shape, top level otherwise). A
 * missing key is added next to its siblings. Other lines are not touched.
 */
export function setField(file: MemoryFile, field: "name" | "description" | "type", value: string): MemoryFile {
  const next: MemoryFile = { ...file, groups: file.groups.map((group) => ({ key: group.key, lines: group.lines.map((line) => ({ ...line })) })) };
  const eol = eolOf(file);
  if (!next.hasFrontmatter) {
    next.hasFrontmatter = true;
    next.open = `---${eol}`;
    next.close = `---${eol}`;
  }
  if (field === "type") {
    const metadata = next.groups.find((group) => group.key === "metadata" && isMapping(group));
    const topType = next.groups.find((group) => group.key === "type");
    if (!topType && metadata) {
      const indent = /^(\s+)/.exec(metadata.lines.slice(1).find((line) => line.text.trim() !== "")?.text ?? "")?.[1] ?? "  ";
      const index = metadata.lines.findIndex((line, i) => i > 0 && line.text.startsWith(`${indent}type:`));
      if (index > 0) {
        const quoted = wasQuoted(metadata.lines[index]!.text.slice(indent.length));
        metadata.lines[index] = { text: `${indent}type: ${formatScalar(value, quoted)}`, eol: metadata.lines[index]!.eol };
      } else {
        metadata.lines.push({ text: `${indent}type: ${formatScalar(value)}`, eol });
      }
      return next;
    }
    if (topType) {
      replaceGroup(topType, "type", value);
      return next;
    }
  } else {
    const existing = next.groups.find((group) => group.key === field);
    if (existing) {
      replaceGroup(existing, field, value);
      return next;
    }
  }
  // Missing: after name/description, else first.
  const order = ["name", "description", "type"];
  const wanted = order.indexOf(field);
  let at = 0;
  next.groups.forEach((group, index) => {
    if (group.key !== null && order.indexOf(group.key) > -1 && order.indexOf(group.key) < wanted) at = index + 1;
  });
  next.groups.splice(at, 0, { key: field, lines: [{ text: `${field}: ${formatScalar(value)}`, eol }] });
  return next;
}

export function setBody(file: MemoryFile, body: string): MemoryFile {
  return { ...file, body };
}

/** A new memory file in the shape given (nested is what the CLI writes today). */
export function newMemoryFile(
  fields: { name: string; description: string; type?: string },
  body: string,
  shape: FrontmatterShape = "nested",
): string {
  const lines = ["---", `name: ${formatScalar(fields.name)}`, `description: ${formatScalar(fields.description)}`];
  const type = fields.type ?? "project";
  if (shape === "flat" || shape === "flat-session") lines.push(`type: ${formatScalar(type)}`);
  else lines.push("metadata:", "  node_type: memory", `  type: ${formatScalar(type)}`);
  lines.push("---", "");
  // The body is kept as given (an import must round-trip byte for byte); only a missing final newline is added.
  return `${lines.join("\n")}${body}${body.endsWith("\n") || body === "" ? "" : "\n"}`;
}

/** Frontmatter keys of any markdown file (rules `paths:`, Copilot `applyTo:`), loosely. */
export function frontmatterKeys(text: string): Record<string, unknown> {
  const file = parseMemoryFile(text);
  const out: Record<string, unknown> = {};
  for (const group of file.groups) if (group.key !== null) out[group.key] = groupValue(group);
  return out;
}
