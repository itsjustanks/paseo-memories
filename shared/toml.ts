/**
 * Enough TOML to read Codex's `config.toml` settings this plugin needs:
 * top-level keys, `[table]` keys, strings (basic, literal, multi-line),
 * booleans, integers and string arrays (also over several lines). Anything
 * richer is skipped rather than guessed. Read-only; this plugin never writes
 * TOML. `tomlScalar` is paseo-mcp 0.11.0 `server/mcpjson.ts`'s, copied.
 */

export type TomlTables = Record<string, Record<string, unknown>>;

export function tomlScalar(raw: string): unknown {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^[+-]?\d[\d_]*$/.test(text)) return Number.parseInt(text.replace(/_/g, ""), 10);
  if (/^[+-]?\d*\.\d+$/.test(text)) return Number.parseFloat(text);
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return undefined;
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    const quoted = [...inner.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'/g)].map((match) => tomlScalar(match[0]));
    if (quoted.some((value) => typeof value !== "string")) return undefined;
    if (inner.split(",").filter((part) => part.trim() !== "").length !== quoted.length) return undefined;
    return quoted;
  }
  return undefined;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function tableName(raw: string): string {
  return [...raw.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([^.\s]+)/g)].map((m) => m[1] ?? m[2] ?? m[3]).join(".");
}

/** Tables by dotted name; "" is the root. Array-of-tables headers are skipped with their keys. */
export function parseToml(text: string): TomlTables {
  const tables: TomlTables = { "": {} };
  let current: Record<string, unknown> | null = tables[""]!;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[[")) {
      current = null;
      continue;
    }
    const header = /^\[\s*(.+?)\s*\]\s*(?:#.*)?$/.exec(trimmed);
    if (header) {
      const name = tableName(header[1]!);
      tables[name] ??= {};
      current = tables[name]!;
      continue;
    }
    const pair = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(trimmed);
    if (!pair) continue;
    const key = pair[1]!.startsWith('"') || pair[1]!.startsWith("'") ? pair[1]!.slice(1, -1) : pair[1]!;
    let value = pair[2]!;
    const multi = value.startsWith('"""') ? '"""' : value.startsWith("'''") ? "'''" : null;
    if (multi) {
      let body = value.slice(3);
      while (!body.includes(multi) && i + 1 < lines.length) {
        i += 1;
        body += `\n${lines[i]}`;
      }
      const end = body.indexOf(multi);
      let inner = end >= 0 ? body.slice(0, end) : body;
      if (inner.startsWith("\n")) inner = inner.slice(1);
      if (multi === '"""') inner = inner.replace(/\\\n\s*/g, "").replace(/\\(["\\ntr])/g, (_, c: string) => ({ n: "\n", t: "\t", r: "\r" } as Record<string, string>)[c] ?? c);
      if (current) current[key] = inner;
      continue;
    }
    value = stripComment(value).trim();
    if (value.startsWith("[") && !value.endsWith("]")) {
      while (i + 1 < lines.length && !value.endsWith("]")) {
        i += 1;
        value += ` ${stripComment(lines[i]!).trim()}`;
      }
      value = value.replace(/,\s*]$/, "]");
    }
    const parsed = tomlScalar(value);
    if (parsed !== undefined && current) current[key] = parsed;
  }
  return tables;
}
