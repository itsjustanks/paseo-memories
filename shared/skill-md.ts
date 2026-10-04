/**
 * SKILL.md: the header every agent reads, parsed as far as this plugin needs
 * it, and checked against the Agent Skills spec (agentskills.io/specification)
 * and what Claude Code and Codex do with it. Pure; no filesystem.
 *
 * Top-level keys only: plain, quoted and block (`>`, `|`) strings, plain
 * strings that run on over indented lines, and booleans. Nested maps
 * (`metadata:`) are skipped. A line the parser can't read is reported as a
 * header problem, never guessed. (Shape after the read-only paseo-skills
 * scaffold `shared/skill-md.ts`, copied and trimmed.)
 */

export type SkillHeader = {
  /** The file starts with a `---` header that is closed again. */
  hasHeader: boolean;
  /** A header line this parser (and probably YAML) can't read. */
  headerBroken: boolean;
  name?: string;
  description?: string;
  whenToUse?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  /** Lines after the header, trailing blank lines left out. */
  bodyLines: number;
};

/** Claude Code cuts description + when_to_use at this many characters in its listing (code.claude.com/docs/en/skills). */
export const CLAUDE_DESC_CAP = 1536;
/** Codex cuts each description in its catalogue here (codex `ext/skills/src/render.rs`). */
export const CODEX_DESC_CAP = 1024;
/** Agent Skills spec limits. */
export const SKILL_SPEC = { nameMax: 64, descriptionMax: 1024, bodyLines: 500, compatibilityMax: 500 } as const;

/**
 * Claude keeps its skill list within 1% of the model's context window
 * (code.claude.com/docs/en/skills), about 4 characters a token. The window
 * depends on the model (code.claude.com/docs/en/model-config, 2026-10-04):
 * 1M for any `[1m]` model, the `opus`, `sonnet`, `fable` and `opusplan`
 * aliases, Fable, Sonnet 5 and later, and Opus 4.7 and later; 200K for
 * everything else Claude, and for all of them when
 * CLAUDE_CODE_DISABLE_1M_CONTEXT is set. Null when the model is unknown, so
 * nothing is called "over budget" on a guess.
 */
export function claudeContextTokens(model: string | null | undefined, disable1m = false): number | null {
  if (disable1m) return 200_000;
  const id = (model ?? "").trim().toLowerCase();
  if (!id) return null;
  if (id.endsWith("[1m]")) return 1_000_000;
  if (["opus", "sonnet", "fable", "opusplan", "best"].includes(id)) return 1_000_000;
  if (id === "haiku") return 200_000;
  const match = /claude-(opus|sonnet|fable|haiku)-(\d+)(?:[-.](\d+))?/.exec(id);
  if (!match) return /claude/.test(id) ? 200_000 : null;
  const [, family, majorText, minorText] = match;
  const major = Number(majorText);
  const minor = minorText && minorText.length <= 2 ? Number(minorText) : 0;
  if (family === "fable") return 1_000_000;
  if (family === "sonnet" && major >= 5) return 1_000_000;
  if (family === "opus" && (major >= 5 || (major === 4 && minor >= 7))) return 1_000_000;
  return 200_000;
}

/** The characters Claude keeps whole in its skill list for a window of `contextTokens`. */
export function claudeBudgetChars(contextTokens: number): number {
  return Math.round(contextTokens * 0.01 * 4);
}

const TEXT_KEYS = new Set(["name", "description", "when_to_use", "license", "compatibility", "argument-hint", "model"]);
const BOOL_KEYS = new Set(["disable-model-invocation", "user-invocable"]);
const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_-]*)\s*:(?:\s+(.*)|\s*)$/;

function unquote(raw: string): string | null {
  const text = raw.trim();
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) return null;
    try {
      return JSON.parse(text.replace(/\\\//g, "/")) as string;
    } catch {
      // YAML allows escapes JSON does not (\x, \e): keep what is between the quotes.
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) return null;
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text.replace(/\s+#.*$/, "");
}

function boolOf(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const text = value.trim().toLowerCase();
  if (text === "true" || text === "yes" || text === "on") return true;
  if (text === "false" || text === "no" || text === "off") return false;
  return undefined;
}

function foldLines(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length) paragraphs.push(current.join(" "));
      current = [];
    } else current.push(line.trim());
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs.join("\n").trim();
}

function countBody(lines: string[]): number {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  return end;
}

/** The header lines and where the body starts; null when there is no closed `---` header on line 1. */
function headerLines(lines: string[]): { lines: string[]; bodyStart: number } | null {
  if (lines[0]?.trimEnd() !== "---") return null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!.trimEnd();
    if (line === "---" || line === "...") return { lines: lines.slice(1, i), bodyStart: i + 1 };
  }
  return null;
}

export function parseSkillMd(text: string): SkillHeader {
  const all = text.replace(/^﻿/, "").split(/\r?\n/);
  const found = headerLines(all);
  if (!found) return { hasHeader: false, headerBroken: false, bodyLines: countBody(all) };
  const values: Record<string, string> = {};
  let broken = false;
  const lines = found.lines;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#") || /^\s/.test(line)) continue;
    const match = KEY_LINE.exec(line);
    if (!match) {
      broken = true;
      continue;
    }
    const key = match[1]!;
    const rest = (match[2] ?? "").trim();
    // Everything indented under this key belongs to it.
    const block: string[] = [];
    let j = i + 1;
    while (j < lines.length && (lines[j]!.trim() === "" || /^\s/.test(lines[j]!))) {
      block.push(lines[j]!);
      j += 1;
    }
    while (block.length && block[block.length - 1]!.trim() === "") block.pop();
    i += block.length;
    if (!TEXT_KEYS.has(key) && !BOOL_KEYS.has(key)) continue;
    if (/^[>|][+-]?$/.test(rest)) {
      const indent = Math.min(...block.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), 1000);
      const body = block.map((l) => l.slice(Math.min(indent, l.length - l.trimStart().length)));
      values[key] = rest.startsWith("|") ? body.join("\n").trim() : foldLines(body);
      continue;
    }
    if (rest === "") {
      if (block.some((l) => /^\s+-\s/.test(l))) {
        broken = broken || key === "name" || key === "description";
        continue;
      }
      values[key] = block.length ? foldLines(block.map((l) => l.trim())) : "";
      continue;
    }
    const first = unquote(rest);
    if (first === null) {
      // A quoted value over several lines: join up to the closing quote.
      const closed = unquote([rest, ...block.map((l) => l.trim())].join(" "));
      if (closed === null) broken = true;
      else values[key] = closed;
      continue;
    }
    values[key] = block.length && !/^["']/.test(rest) ? [first, ...block.map((l) => l.trim())].join(" ").trim() : first;
  }
  const header: SkillHeader = { hasHeader: true, headerBroken: broken, bodyLines: countBody(all.slice(found.bodyStart)) };
  if (values.name !== undefined) header.name = values.name.trim();
  if (values.description !== undefined) header.description = values.description.trim();
  if (values.when_to_use !== undefined) header.whenToUse = values.when_to_use.trim();
  const dmi = boolOf(values["disable-model-invocation"]);
  if (dmi !== undefined) header.disableModelInvocation = dmi;
  const ui = boolOf(values["user-invocable"]);
  if (ui !== undefined) header.userInvocable = ui;
  return header;
}

/** The spec's name rule: 1–64 of a-z, 0-9 and single hyphens, none at either end. */
export function skillNameOk(name: string): boolean {
  return name.length >= 1 && name.length <= SKILL_SPEC.nameMax && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/**
 * The same name in any spelling: case, hyphens, underscores, dots and spaces
 * ignored. `My_Skill`, `my-skill` and `myskill` are one name here, so an add
 * never lands beside a skill a person would call the same thing.
 */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Claude refuses these as skill folder names (code.claude.com/docs/en/skills). */
export const RESERVED_NAMES = new Set(["synced", "anthropic-skills"]);

export type SkillProblemCode =
  | "no-header"
  | "header-broken"
  | "no-description"
  | "name-differs"
  | "name-invalid"
  | "description-too-long"
  | "listing-cut-claude"
  | "body-long";

export type SkillProblem = { code: SkillProblemCode; severity: "warn" | "info"; message: string };

/** What the header and body get wrong, for a skill in a folder named `folder`. Messages are plain sentences. */
export function skillProblems(header: SkillHeader, folder: string): SkillProblem[] {
  const out: SkillProblem[] = [];
  if (!header.hasHeader) out.push({ code: "no-header", severity: "warn", message: "Its instructions don't start with the short header (name and description) agents read to know when to use it." });
  else if (header.headerBroken) out.push({ code: "header-broken", severity: "warn", message: "Its header has a line agents may not be able to read, so its name or description may be ignored." });
  if (header.hasHeader && !header.description) out.push({ code: "no-description", severity: "warn", message: "It has no description, so agents can't tell when to use it." });
  const name = header.name;
  if (name && name !== folder) out.push({ code: "name-differs", severity: "warn", message: `Its own name (${name}) differs from its folder's (${folder}); agents may list it under either.` });
  else if (!skillNameOk(name || folder)) out.push({ code: "name-invalid", severity: "info", message: "Its name uses characters outside lower-case letters, digits and single hyphens, which some agents refuse." });
  if ((header.description ?? "").length > SKILL_SPEC.descriptionMax) out.push({ code: "description-too-long", severity: "info", message: `Its description is over ${SKILL_SPEC.descriptionMax.toLocaleString("en-US")} characters; Codex cuts it there.` });
  if (listedText(header).length > CLAUDE_DESC_CAP) out.push({ code: "listing-cut-claude", severity: "info", message: `Its description is over ${CLAUDE_DESC_CAP.toLocaleString("en-US")} characters; Claude cuts it there.` });
  if (header.bodyLines > SKILL_SPEC.bodyLines) out.push({ code: "body-long", severity: "info", message: `Its instructions run past ${SKILL_SPEC.bodyLines} lines; the spec suggests moving detail into separate files.` });
  return out;
}

/** What Claude lists beside the name: the description, then " - " and when_to_use. */
export function listedText(header: Pick<SkillHeader, "description" | "whenToUse">): string {
  const description = header.description ?? "";
  return header.whenToUse ? `${description} - ${header.whenToUse}` : description;
}

/** Claude's listing state for one skill: `skillOverrides` value, or "model-off" when the skill says only a person may run it. */
export type ClaudeListing = "on" | "name-only" | "user-invocable-only" | "off" | "model-off";

/** Characters one skill adds to Claude's listing every turn: name, capped description, a little punctuation. */
export function claudeListingChars(name: string, header: Pick<SkillHeader, "description" | "whenToUse" | "disableModelInvocation">, state: ClaudeListing = "on"): number {
  if (header.disableModelInvocation || state === "off" || state === "user-invocable-only" || state === "model-off") return 0;
  if (state === "name-only") return name.length + 4;
  return name.length + Math.min(listedText(header).length, CLAUDE_DESC_CAP) + 4;
}

/** Characters one skill adds to Codex's catalogue: name, description (cut at 1,024) and its path. */
export function codexListingChars(name: string, description: string | undefined, path: string): number {
  return name.length + Math.min((description ?? "").length, CODEX_DESC_CAP) + path.length + 12;
}

/** ≈ tokens for a character count (4 characters a token, as the rest of the plugin counts). */
export function tokensForChars(chars: number): number {
  return Math.ceil(chars / 4);
}

/** A header and body for a skill written here: description as one quoted line (valid YAML), body as given. */
export function buildSkillMd(name: string, description: string, instructions: string): string {
  const oneLine = description.replace(/\s+/g, " ").trim();
  const body = instructions.replace(/\r\n/g, "\n").trim();
  return `---\nname: ${name}\ndescription: ${JSON.stringify(oneLine)}\n---\n\n${body}\n`;
}

/** A folder name made from a name a person typed: lower case, runs of anything else become one hyphen. */
export function suggestName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_SPEC.nameMax)
    .replace(/-+$/g, "");
}
