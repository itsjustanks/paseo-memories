/**
 * Tidy checks that need no filesystem: duplicates, possible conflicts, and
 * the paths and code names a memory mentions. Pure; no LLM. The server adds
 * what needs the disk (does that path still exist? is that name still in the
 * code?).
 */

/** One memory (a Claude memory file) or one section of an instruction file. */
export type Unit = {
  id: string;
  sourceId: string;
  /** Memory file name or section key. */
  key: string;
  title: string;
  text: string;
  agent: string;
  scope: string;
  kind: string;
  path: string;
  projectPath?: string;
  /** Claude memory frontmatter, for export. */
  description?: string;
  type?: string;
};

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/[`]/g, ""))
    .replace(/[*_`#>|~\[\]()]/g, " ")
    .replace(/[^\p{L}\p{N}\s./-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function words(text: string): string[] {
  const normal = normalizeText(text);
  return normal ? normal.split(" ") : [];
}

/** Word 3-grams: robust to small edits, cheap to compare. */
export function shingles(text: string, size = 3): Set<string> {
  const list = words(text);
  const out = new Set<string>();
  if (list.length < size) {
    if (list.length) out.add(list.join(" "));
    return out;
  }
  for (let i = 0; i + size <= list.length; i += 1) out.add(list.slice(i, i + size).join(" "));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Text shorter than this is too generic to call a duplicate. */
export const MIN_DUPLICATE_WORDS = 6;
export const NEAR_DUPLICATE = 0.8;
export const CONFLICT_BELOW = 0.5;

export type DuplicateGroup = { units: Unit[]; score: number; exact: boolean };

/**
 * Exact duplicates (same text once normalised) and near ones (shingled
 * Jaccard ≥ 0.8). Candidate pairs come from an inverted index of shingles,
 * skipping ones shared by too many units, so a host with a thousand
 * sections is not compared all against all.
 */
export function findDuplicates(units: Unit[]): DuplicateGroup[] {
  const usable = units.filter((unit) => words(unit.text).length >= MIN_DUPLICATE_WORDS);
  const exact = new Map<string, Unit[]>();
  for (const unit of usable) {
    const key = normalizeText(unit.text);
    exact.set(key, [...(exact.get(key) ?? []), unit]);
  }
  const groups: DuplicateGroup[] = [];
  const inExact = new Set<string>();
  for (const members of exact.values()) {
    if (members.length < 2) continue;
    groups.push({ units: members, score: 1, exact: true });
    for (const member of members) inExact.add(member.id);
  }
  const sets = new Map(usable.map((unit) => [unit.id, shingles(unit.text)]));
  const index = new Map<string, string[]>();
  for (const unit of usable) for (const shingle of sets.get(unit.id)!) index.set(shingle, [...(index.get(shingle) ?? []), unit.id]);
  const overlap = new Map<string, number>();
  for (const ids of index.values()) {
    if (ids.length < 2 || ids.length > 40) continue;
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) {
      const pair = ids[i]! < ids[j]! ? `${ids[i]}\u0000${ids[j]}` : `${ids[j]}\u0000${ids[i]}`;
      overlap.set(pair, (overlap.get(pair) ?? 0) + 1);
    }
  }
  const byId = new Map(usable.map((unit) => [unit.id, unit]));
  for (const [pair, shared] of overlap) {
    if (shared < 2) continue;
    const [a, b] = pair.split("\u0000") as [string, string];
    if (inExact.has(a) && inExact.has(b) && normalizeText(byId.get(a)!.text) === normalizeText(byId.get(b)!.text)) continue;
    const score = jaccard(sets.get(a)!, sets.get(b)!);
    if (score >= NEAR_DUPLICATE) groups.push({ units: [byId.get(a)!, byId.get(b)!], score, exact: false });
  }
  return groups;
}

/** Headings too common to mean "the same topic". */
const GENERIC_TITLES = new Set(["overview", "notes", "testing", "tests", "setup", "usage", "style", "rules", "commands", "build", "development", "(top of file)", "summary", "introduction", "todo"]);

export type ConflictGroup = { title: string; units: Unit[]; score: number };

/**
 * Possible conflicts: the same name or heading in two places with different
 * text. A guess (the UI says so): same title is only a hint of same topic.
 */
export function findConflicts(units: Unit[]): ConflictGroup[] {
  const byTitle = new Map<string, Unit[]>();
  for (const unit of units) {
    const title = normalizeText(unit.title);
    if (!title || GENERIC_TITLES.has(title) || title.split(" ").length < 2) continue;
    byTitle.set(title, [...(byTitle.get(title) ?? []), unit]);
  }
  const out: ConflictGroup[] = [];
  for (const [title, members] of byTitle) {
    const distinct = members.filter((unit, index) => members.findIndex((other) => other.sourceId === unit.sourceId && other.key === unit.key) === index);
    if (distinct.length < 2 || new Set(distinct.map((unit) => unit.sourceId)).size < 2) continue;
    const [first, second] = distinct as [Unit, Unit];
    const score = jaccard(shingles(first.text), shingles(second.text));
    if (normalizeText(first.text) === normalizeText(second.text) || score >= CONFLICT_BELOW) continue;
    out.push({ title: first.title, units: distinct.slice(0, 5), score });
  }
  return out;
}

const PATH_EXT = /\.(?:[cm]?[jt]sx?|json|md|mdx|toml|ya?ml|py|go|rs|rb|java|kt|swift|vue|svelte|css|scss|html|sql|sh|env|lock|txt|cfg|ini|xml|gradle|proto|graphql)$/i;

function codeSpans(text: string): string[] {
  const spans: string[] = [];
  for (const match of text.matchAll(/`([^`\n]{2,200})`/g)) spans.push(match[1]!.trim());
  return spans;
}

/**
 * Paths a memory mentions: in backticks, or bare tokens that look like a
 * path (a slash and a known extension, or `./`, `../`, `~/`, `/…`). URLs,
 * globs, placeholders and `@scope/pkg` names are skipped.
 */
export function pathRefs(text: string): string[] {
  const out = new Set<string>();
  const consider = (raw: string) => {
    const token = raw.replace(/[),.;:!?'"]+$/, "").replace(/^['"(]+/, "").replace(/:\d+(?::\d+)?$/, "");
    if (!token || token.length > 240 || /\s/.test(token)) return;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token) || token.startsWith("@") || /[*?{}<>$|]/.test(token) || token.includes("…")) return;
    const pathy = token.startsWith("./") || token.startsWith("../") || token.startsWith("~/") || (token.startsWith("/") && token.length > 1 && token.split("/").length > 2) || (token.includes("/") && PATH_EXT.test(token));
    if (pathy && !/^\/\//.test(token)) out.add(token);
  };
  for (const span of codeSpans(text)) consider(span);
  for (const match of text.replace(/`[^`\n]*`/g, " ").matchAll(/(?:^|[\s(])((?:~|\.{1,2})?\/?[\w.@~-]+(?:\/[\w.@-]+)+)/g)) consider(match[1]!);
  return [...out];
}

/**
 * Code names a memory mentions in backticks: one identifier, maybe with
 * `()`, that looks like code (camelCase, snake_case, PascalCase with a lower
 * letter, or a call). Plain words are left alone.
 */
export function symbolRefs(text: string): string[] {
  const out = new Set<string>();
  for (const span of codeSpans(text)) {
    const match = /^([A-Za-z_$][\w$]*)(\(\))?$/.exec(span);
    if (!match) continue;
    const name = match[1]!;
    if (name.length < 4) continue;
    const codey = Boolean(match[2]) || /[a-z][A-Z]/.test(name) || (name.includes("_") && /[a-z]/i.test(name.replace(/_/g, "")) && !/^_+$/.test(name));
    if (codey) out.add(name);
  }
  return [...out];
}

// ------------------------------------------------------------------ next step

export type FindingLike = { kind: string; severity: string; message: string; action?: { label: string; kind: string; sourceId?: string; key?: string } };

const ORDER = ["secret", "codex-pending", "over-limit", "index-drift", "duplicate", "stale-path", "stale-symbol", "conflict"];
const SEVERITY = ["error", "warn", "info"];

/** Most urgent first: severity, then kind. */
export function rankFindings<T extends FindingLike>(findings: T[]): T[] {
  return [...findings].sort(
    (a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity) || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind),
  );
}

/** Exactly one next step for the Overview. */
export function nextStep(findings: FindingLike[], counts: { sources: number }): { title: string; detail: string; action?: FindingLike["action"] } {
  if (counts.sources === 0) return { title: "Nothing to show yet", detail: "No agent on this host has written memory or instruction files yet." };
  const top = rankFindings(findings)[0];
  if (!top) return { title: "Nothing needs tidying", detail: "No duplicates, stale mentions, secrets or over-limit files were found. Browse what your agents remember under User and Projects." };
  const more = findings.length - 1;
  return { title: top.action?.label ?? top.message, detail: `${top.message}${more > 0 ? ` ${more} more thing${more === 1 ? "" : "s"} to look at below.` : ""}`, ...(top.action ? { action: top.action } : {}) };
}
