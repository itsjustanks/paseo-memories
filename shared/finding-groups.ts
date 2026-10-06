/**
 * Things worth a look, grouped by kind (0.5.1). A long list of near-identical
 * rows ("Claude may not find one of its notes" × 58) becomes one row per kind
 * with a count, each item named inside it, and "Fix all" where every fix in
 * the group is safe and undoable. Memories and Skills share this; the server
 * uses it for the sidebar's quick summary, so both count the same way. Pure.
 */

type Groupable = { kind: string; message: string; severity?: string; action?: { kind: string } | undefined };

export type FindingGroup<F> = {
  /** The finding kind, split where one kind holds two different jobs (Claude's list: missing notes, lines for gone notes). */
  key: string;
  findings: F[];
  /** Every item can be fixed at once, safely (each fix is undoable). */
  fixAll: boolean;
};

export type Page = "memories" | "skills";

/** Memories: Claude's list holds two jobs (a note missing from it, a line for a note that's gone); the rest by kind. */
export function memoryGroupKey(finding: Pick<Groupable, "kind" | "message">): string {
  if (finding.kind === "index-drift") return /does not exist/.test(finding.message) ? "index-gone" : "index-missing";
  return finding.kind;
}

export function skillGroupKey(finding: Pick<Groupable, "kind">): string {
  return finding.kind;
}

/** Groups whose fixes only touch Claude's list (kept as a backup) or move things to the backups. */
const FIX_ALL: Record<Page, ReadonlySet<string>> = {
  memories: new Set(["index-missing", "index-gone"]),
  skills: new Set(["broken-link", "empty-folder", "stray-file", "paseo-orphan", "lock-missing"]),
};

export function canFixAll(page: Page, key: string): boolean {
  return FIX_ALL[page].has(key);
}

/**
 * Findings grouped by kind, in the order the list already has (most serious
 * first): a group sits where its first finding was. Skills offer Fix all only
 * when every item has its own Fix it.
 */
export function groupFindings<F extends Groupable>(page: Page, findings: readonly F[]): Array<FindingGroup<F>> {
  const keyOf = page === "memories" ? memoryGroupKey : skillGroupKey;
  const groups = new Map<string, FindingGroup<F>>();
  for (const finding of findings) {
    const key = keyOf(finding);
    const group = groups.get(key) ?? { key, findings: [], fixAll: false };
    group.findings.push(finding);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.fixAll = group.findings.length > 1 && canFixAll(page, group.key) && (page === "memories" || group.findings.every((finding) => finding.action?.kind === "fix"));
  }
  return [...groups.values()];
}

const n = (count: number) => count.toLocaleString("en-AU");

const SINGULAR: Record<Page, Record<string, string>> = {
  memories: {
    secret: "1 note holds something that looks like a password or key",
    "index-missing": "1 note missing from Claude's list",
    "index-gone": "1 line in Claude's list points to a note that's gone",
    "over-limit": "1 note is too long to read in full",
    duplicate: "1 note says the same as another note",
    "stale-path": "1 note mentions a file or folder that's gone",
    "stale-symbol": "1 note mentions something no longer in the project",
    conflict: "1 topic where notes may disagree",
    "codex-pending": "Codex is still tidying its notes",
  },
  skills: {
    "broken-link": "1 link to a skill that's gone",
    "empty-folder": "1 empty skill",
    "stray-file": "1 compressed file agents can't use",
    invalid: "1 skill agents may not read properly",
    duplicate: "1 name used by two different skills",
    "paseo-orphan": "1 old skill from Paseo",
    "lock-missing": "1 skill listed but not on this computer",
    unused: "Skills not used lately",
    "over-budget": "Claude's list of skills is too long",
  },
};

/** A group's heading with its count, in plain words: "58 notes missing from Claude's list". */
export function groupTitle(page: Page, key: string, count: number): string {
  if (count === 1) return SINGULAR[page][key] ?? "1 other thing to look at";
  const c = n(count);
  if (page === "memories") {
    switch (key) {
      case "secret":
        return `${c} notes hold something that looks like a password or key`;
      case "index-missing":
        return `${c} notes missing from Claude's list`;
      case "index-gone":
        return `${c} lines in Claude's list point to notes that are gone`;
      case "over-limit":
        return `${c} notes are too long to read in full`;
      case "duplicate":
        return `${c} notes say the same as another note`;
      case "stale-path":
        return `${c} notes mention a file or folder that's gone`;
      case "stale-symbol":
        return `${c} notes mention something no longer in the project`;
      case "conflict":
        return `${c} topics where notes may disagree`;
      case "codex-pending":
        return "Codex is still tidying its notes";
      default:
        return `${c} other things to look at`;
    }
  }
  switch (key) {
    case "broken-link":
      return `${c} links to skills that are gone`;
    case "empty-folder":
      return `${c} empty skills`;
    case "stray-file":
      return `${c} compressed files agents can't use`;
    case "invalid":
      return `${c} skills agents may not read properly`;
    case "duplicate":
      return `${c} names used by two different skills`;
    case "paseo-orphan":
      return `${c} old skills from Paseo`;
    case "lock-missing":
      return `${c} skills listed but not on this computer`;
    default:
      return `${c} other things to look at`;
  }
}

/** One line under a group's heading: why it matters, and what Fix all does. */
export function groupSummary(page: Page, key: string): string {
  if (page === "memories") {
    switch (key) {
      case "index-missing":
        return "Claude only looks for notes on its list. Fix all adds them; the old list is kept as a backup.";
      case "index-gone":
        return "The notes were deleted or renamed. Fix all takes those lines off the list; the old list is kept as a backup.";
      case "secret":
        return "Anyone whose agent reads these notes can see it.";
      case "duplicate":
        return "Keeping one copy is enough.";
      case "conflict":
        return "A guess: check before changing anything.";
      case "over-limit":
        return "The agent only reads the start of each.";
      default:
        return "Open each one to decide.";
    }
  }
  switch (key) {
    case "broken-link":
      return "Removing them changes nothing for your agents. Fix all moves them to the backups.";
    case "empty-folder":
      return "Nothing in them. Fix all moves them to the backups.";
    case "stray-file":
      return "Agents can't open compressed files. Fix all moves them to the backups.";
    case "paseo-orphan":
      return "Nothing updates them now. Fix all moves them to the backups.";
    case "lock-missing":
      return "Taking them off the installer's list changes nothing for your agents.";
    case "invalid":
      return "Agents may skip these. Open each one to see why.";
    case "duplicate":
      return "Agents may pick the wrong one. Rename or remove one of each pair.";
    default:
      return "Open each one to decide.";
  }
}

/** The quick summary the sidebar's popover shows: the tone, how many, and the biggest groups. */
export type GroupCount = { key: string; count: number };
export type QuickSummary = { tone: "attention" | "error" | null; count: number; groups: GroupCount[] };

export function quickSummary<F extends Groupable>(page: Page, findings: readonly F[], tone: QuickSummary["tone"], top = 3): QuickSummary {
  const groups = groupFindings(page, findings)
    .map((group) => ({ key: group.key, count: group.findings.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
  return { tone, count: findings.length, groups };
}
