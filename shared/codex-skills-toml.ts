/**
 * Codex's per-skill switches in `config.toml`: `[[skills.config]]` blocks
 * with `name` (or `path`) and `enabled`; a later block wins
 * (codex `config/src/skills_config.rs`). Read and changed as text, line by
 * line, so every other byte of the file stays as it was. Pure.
 *
 * Only shapes this module can change safely are touched. A file that sets
 * skills switches another way (`skills = {…}`, `config = [...]` under
 * `[skills]`, a dotted `skills.config = …`, or a plain `[skills.config]`
 * table) is refused with a sentence: appending a block there would make the
 * file invalid TOML, and Codex would not start.
 */

export type SkillSwitch = { name?: string; path?: string; enabled?: boolean; start: number; end: number; onlyNameAndEnabled: boolean };

const ARRAY_HEADER = /^\s*\[\[\s*skills\s*\.\s*config\s*\]\]\s*(?:#.*)?$/;
const ANY_HEADER = /^\s*\[/;
const SKILLS_TABLE = /^\s*\[\s*skills\s*\]\s*(?:#.*)?$/;
const PLAIN_CONFIG_TABLE = /^\s*\[\s*skills\s*\.\s*config\s*\]\s*(?:#.*)?$/;
const KEY = /^\s*(name|path|enabled)\s*=\s*(.*?)\s*(?:#.*)?$/;

function stringValue(raw: string): string | undefined {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return undefined;
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return undefined;
}

function lines(text: string): string[] {
  return text.split("\n");
}

/**
 * For each line: is it inside a multi-line string (triple double or single quotes)?
 * The line that opens one is a key line and is false; the lines after it,
 * up to and including the closing one, are true. Nothing in a string is a
 * header, a key or a switch (review-040 #8).
 */
export function inMultilineString(all: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let open: string | null = null;
  for (const raw of all) {
    const line = raw.replace(/\r$/, "");
    if (open) {
      out.push(true);
      if (line.includes(open)) open = null;
      continue;
    }
    out.push(false);
    const opens = /=\s*("""|\'\'\')/.exec(line);
    if (opens && line.split(opens[1]!).length === 2) open = opens[1]!;
  }
  return out;
}

/** Why this file can't take a switch safely; null when it can. */
export function unsafeReason(text: string): string | null {
  let table = "";
  const all = lines(text);
  const quoted = inMultilineString(all);
  for (let i = 0; i < all.length; i += 1) {
    if (quoted[i]) continue;
    const line = all[i]!.replace(/\r$/, "");
    if (PLAIN_CONFIG_TABLE.test(line)) return "Codex's settings file sets skill switches as one table, a shape this plugin doesn't change. Turn it off in Codex instead.";
    if (ANY_HEADER.test(line)) {
      table = SKILLS_TABLE.test(line) ? "skills" : ARRAY_HEADER.test(line) ? "skills.config[]" : line.trim();
      continue;
    }
    if (table === "" && /^\s*(skills\s*=|skills\s*\.\s*config\s*=|"skills"\s*=)/.test(line)) return "Codex's settings file sets skills on one line, a shape this plugin doesn't change. Turn it off in Codex instead.";
    if (table === "skills" && /^\s*config\s*=/.test(line)) return "Codex's settings file lists skill switches on one line, a shape this plugin doesn't change. Turn it off in Codex instead.";
  }
  return null;
}

/** Every `[[skills.config]]` block, in file order, outside multi-line strings. */
export function readSkillSwitches(text: string): SkillSwitch[] {
  const all = lines(text);
  const quoted = inMultilineString(all);
  const out: SkillSwitch[] = [];
  let current: SkillSwitch | null = null;
  let others = 0;
  const close = (end: number) => {
    if (current) {
      current.end = end;
      current.onlyNameAndEnabled = others === 0 && (current.name === undefined) !== (current.path === undefined);
      out.push(current);
    }
    current = null;
    others = 0;
  };
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i]!.replace(/\r$/, "");
    if (quoted[i]) {
      if (current) others += 1;
      continue;
    }
    if (ANY_HEADER.test(line)) {
      close(i);
      if (ARRAY_HEADER.test(line)) current = { start: i, end: i + 1, onlyNameAndEnabled: true };
      continue;
    }
    if (!current) continue;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const key = KEY.exec(line);
    if (!key) {
      others += 1;
      continue;
    }
    const block: SkillSwitch = current;
    if (key[1] === "name") block.name = stringValue(key[2]!);
    else if (key[1] === "path") block.path = stringValue(key[2]!);
    else if (key[2] === "true" || key[2] === "false") block.enabled = key[2] === "true";
    else others += 1;
  }
  close(all.length);
  // Trailing blank and comment lines belong to what comes next (a comment heading the next section), not to the block (review-040 #7).
  for (const block of out) {
    while (block.end > block.start + 1 && (all[block.end - 1]!.trim() === "" || all[block.end - 1]!.trim().startsWith("#"))) block.end -= 1;
  }
  return out;
}

/** A block names this skill: by its name, or by the path of one of its SKILL.md files (Codex's own writer keys by path). */
function matches(block: SkillSwitch, name: string, paths: readonly string[]): boolean {
  return block.name === name || (block.path !== undefined && paths.includes(block.path));
}

function asList(paths: string | readonly string[] | undefined): readonly string[] {
  return paths === undefined ? [] : typeof paths === "string" ? [paths] : paths;
}

/** Whether Codex has this skill turned off by name or by one of its SKILL.md paths (the last matching block wins). */
export function codexSkillEnabled(text: string, name: string, paths?: string | readonly string[]): boolean {
  const list = asList(paths);
  let enabled = true;
  for (const block of readSkillSwitches(text)) {
    if (block.enabled === undefined) continue;
    if (matches(block, name, list)) enabled = block.enabled;
  }
  return enabled;
}

/**
 * The file with this skill turned on or off. Off: the last block naming it
 * (by name or path) is set to `enabled = false`, or a new block keyed by
 * name is added at the end. On: blocks that hold only the key and a switch
 * are taken out; any other block naming it is set to `enabled = true`.
 * Returns the text unchanged when nothing needs doing, or a reason when the
 * file's shape isn't safe to change.
 */
export function setSkillEnabled(text: string, name: string, enabled: boolean, paths: readonly string[] = []): { text: string } | { error: string } {
  const unsafe = unsafeReason(text);
  if (unsafe) return { error: unsafe };
  const crlf = /\r\n/.test(text);
  const all = lines(text.replace(/\r\n/g, "\n"));
  const blocks = readSkillSwitches(all.join("\n")).filter((block) => matches(block, name, paths));
  const value = `enabled = ${enabled}`;
  const setIn = (block: SkillSwitch) => {
    for (let i = block.start + 1; i < block.end; i += 1) {
      if (/^\s*enabled\s*=/.test(all[i]!)) {
        all[i] = all[i]!.replace(/^(\s*)enabled\s*=\s*(true|false)/, `$1${value}`);
        return;
      }
    }
    const keyLine = all.findIndex((line, i) => i > block.start && i < block.end && /^\s*(name|path)\s*=/.test(line));
    all.splice(keyLine + 1, 0, value);
  };
  if (!enabled) {
    if (codexSkillEnabled(all.join("\n"), name, paths) === false) return { text };
    const last = blocks[blocks.length - 1];
    if (last) setIn(last);
    else {
      while (all.length && all[all.length - 1] === "") all.pop();
      all.push(...(all.length ? [""] : []), "[[skills.config]]", `name = ${JSON.stringify(name)}`, value, "");
    }
  } else {
    if (codexSkillEnabled(all.join("\n"), name, paths)) return { text };
    // Bottom up, so earlier line numbers stay right.
    for (const block of [...blocks].reverse()) {
      if (block.onlyNameAndEnabled) {
        let end = block.end;
        while (end < all.length && all[end]!.trim() === "") end += 1;
        all.splice(block.start, end - block.start);
      } else setIn(block);
    }
  }
  let out = all.join("\n");
  if (out !== "" && !out.endsWith("\n")) out += "\n";
  // Leading blank lines left by removing the first block go too.
  if (enabled && !/^\s*$/.test(out)) out = text.startsWith("\n") ? out : out.replace(/^\n+/, "");
  return { text: crlf ? out.replace(/\n/g, "\r\n") : out };
}
