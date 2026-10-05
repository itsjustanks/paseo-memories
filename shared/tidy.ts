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

/** A 53-bit string hash (cyrb53): two different shingles share one about once in 2^53. */
export function hash53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * What the duplicate checks need from a text, worked out once per text and
 * kept by the caller (server/corpus.ts keeps them per file version): a key
 * for "the same once normalised", the word count, and the word 3-grams as
 * hashes, sorted (so two texts compare in one merge, with nothing built per
 * pair). Small: no copy of the text.
 */
export type TextFeatures = { key: string; words: number; shingles: Float64Array };

export function textFeatures(text: string): TextFeatures {
  const normal = normalizeText(text);
  const list = normal ? normal.split(" ") : [];
  const seen = new Set<number>();
  if (list.length < 3) {
    if (list.length) seen.add(hash53(list.join(" ")));
  } else for (let i = 0; i + 3 <= list.length; i += 1) seen.add(hash53(`${list[i]} ${list[i + 1]} ${list[i + 2]}`));
  return { key: `${normal.length}:${hash53(normal)}:${hash53(normal, 1)}`, words: list.length, shingles: Float64Array.from(seen).sort() };
}

/** Jaccard of two features' 3-grams (as `jaccard` on the strings). */
export function featureJaccard(a: TextFeatures, b: TextFeatures): number {
  const x = a.shingles;
  const y = b.shingles;
  if (x.length === 0 && y.length === 0) return 1;
  let i = 0;
  let j = 0;
  let inter = 0;
  while (i < x.length && j < y.length) {
    if (x[i]! < y[j]!) i += 1;
    else if (x[i]! > y[j]!) j += 1;
    else {
      inter += 1;
      i += 1;
      j += 1;
    }
  }
  return inter / (x.length + y.length - inter);
}

/** Text shorter than this is too generic to call a duplicate. */
export const MIN_DUPLICATE_WORDS = 6;
export const NEAR_DUPLICATE = 0.8;
export const CONFLICT_BELOW = 0.5;
/** A 3-gram held by more units than this is boilerplate: it suggests no pair. */
const COMMON_SHINGLE = 40;
/** Pieces of work between two pauses of a stepped run (`duplicateSteps`): about a millisecond. */
const STEP_UNITS = 16;

export type DuplicateGroup = { units: Unit[]; score: number; exact: boolean };
export type FeaturesOf = (unit: Unit) => TextFeatures;

const plainFeatures: FeaturesOf = (unit) => textFeatures(unit.text);

function byId(a: Unit, b: Unit): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Exact duplicates (same text once normalised) and near ones (shingled
 * Jaccard ≥ 0.8). No pair is compared all against all: exact copies share a
 * bucket and are indexed once, and near candidates come from an inverted
 * index of 3-grams (a pair must share two that at most 40 units hold,
 * copies counted); only those pairs are scored, and only when their sizes
 * allow 0.8. Linear in the text plus the candidate pairs.
 *
 * A generator: it pauses (`yield`) every few units, so a caller can
 * let other work in between (server/pace.ts `runSliced`); `findDuplicates`
 * runs it straight through.
 */
export function* duplicateSteps(units: Unit[], featuresOf: FeaturesOf = plainFeatures): Generator<void, DuplicateGroup[]> {
  // Exact copies: one bucket per normalised text, members in the order given.
  const buckets = new Map<string, { features: TextFeatures; members: Unit[] }>();
  for (let i = 0; i < units.length; i += 1) {
    if (i % STEP_UNITS === STEP_UNITS - 1) yield;
    const features = featuresOf(units[i]!);
    if (features.words < MIN_DUPLICATE_WORDS) continue;
    const bucket = buckets.get(features.key);
    if (bucket) bucket.members.push(units[i]!);
    else buckets.set(features.key, { features, members: [units[i]!] });
  }
  const groups: DuplicateGroup[] = [];
  const reps = [...buckets.values()];
  for (const bucket of reps) if (bucket.members.length > 1) groups.push({ units: bucket.members, score: 1, exact: true });
  // One entry per distinct text; a 3-gram's holders count every copy. Most 3-grams have one holder: a plain number for those.
  const n = reps.length;
  const single = new Map<number, number>();
  const holders = new Map<number, { reps: number[]; copies: number }>();
  for (let r = 0; r < n; r += 1) {
    yield;
    const copies = reps[r]!.members.length;
    for (const shingle of reps[r]!.features.shingles) {
      const hit = holders.get(shingle);
      if (hit) {
        hit.copies += copies;
        if (hit.copies <= COMMON_SHINGLE) hit.reps.push(r);
        continue;
      }
      const first = single.get(shingle);
      if (first === undefined) single.set(shingle, r);
      else {
        single.delete(shingle);
        holders.set(shingle, { reps: [first, r], copies: reps[first]!.members.length + copies });
      }
    }
  }
  single.clear();
  // Per text, the later texts it shares at least two such 3-grams with: one small count at a time, never a table of all pairs.
  const near: DuplicateGroup[] = [];
  const counts = new Map<number, number>();
  for (let r = 0; r < n; r += 1) {
    yield;
    const a = reps[r]!;
    for (const shingle of a.features.shingles) {
      const hit = holders.get(shingle);
      if (!hit || hit.copies > COMMON_SHINGLE) continue;
      for (const other of hit.reps) if (other > r) counts.set(other, (counts.get(other) ?? 0) + 1);
    }
    for (const [other, shared] of counts) {
      if (shared < 2) continue;
      const b = reps[other]!;
      const small = Math.min(a.features.shingles.length, b.features.shingles.length);
      const large = Math.max(a.features.shingles.length, b.features.shingles.length);
      // Jaccard is at most small / large.
      if (small < NEAR_DUPLICATE * large) continue;
      const score = featureJaccard(a.features, b.features);
      if (score < NEAR_DUPLICATE) continue;
      // Every copy of one text pairs with every copy of the other, lower id first.
      for (const x of a.members) for (const y of b.members) near.push({ units: byId(x, y) < 0 ? [x, y] : [y, x], score, exact: false });
    }
    counts.clear();
  }
  near.sort((p, q) => byId(p.units[0]!, q.units[0]!) || byId(p.units[1]!, q.units[1]!));
  return [...groups, ...near];
}

export function findDuplicates(units: Unit[], featuresOf: FeaturesOf = plainFeatures): DuplicateGroup[] {
  const steps = duplicateSteps(units, featuresOf);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** Headings too common to mean "the same topic". */
const GENERIC_TITLES = new Set(["overview", "notes", "testing", "tests", "setup", "usage", "style", "rules", "commands", "build", "development", "(top of file)", "summary", "introduction", "todo"]);

export type ConflictGroup = { title: string; units: Unit[]; score: number };

/**
 * Possible conflicts: the same name or heading in two places with different
 * text. A guess (the UI says so): same title is only a hint of same topic.
 */
export function findConflicts(units: Unit[], featuresOf: FeaturesOf = plainFeatures): ConflictGroup[] {
  const byTitle = new Map<string, Unit[]>();
  for (const unit of units) {
    const title = normalizeText(unit.title);
    if (!title || GENERIC_TITLES.has(title) || title.split(" ").length < 2) continue;
    const members = byTitle.get(title);
    if (members) members.push(unit);
    else byTitle.set(title, [unit]);
  }
  const out: ConflictGroup[] = [];
  for (const [title, members] of byTitle) {
    const keys = new Set<string>();
    const distinct = members.filter((unit) => {
      const key = `${unit.sourceId}\u0000${unit.key}`;
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    });
    if (distinct.length < 2 || new Set(distinct.map((unit) => unit.sourceId)).size < 2) continue;
    const [first, second] = distinct as [Unit, Unit];
    const a = featuresOf(first);
    const b = featuresOf(second);
    const score = featureJaccard(a, b);
    if (a.key === b.key || score >= CONFLICT_BELOW) continue;
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
