import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tilde } from "../shared/agents";
import { pendingMessage } from "../shared/codex";
import type { FindingAction, FindingInput } from "../shared/contracts";

type Finding = FindingInput & { severity: string };
import { CLAUDE_MD_ADVISORY_LINES, CODEX_MEMORY_SUMMARY_TOKENS, CODEX_PROJECT_DOC_MAX_BYTES, claudeIndexLoad } from "../shared/limits";
import { parseIndex } from "../shared/memory-index";
import { scanProgressNote } from "../shared/plain";
import { findSecrets } from "../shared/secrets";
import { duplicateSteps, findConflicts, nextStep, pathRefs, rankFindings, symbolRefs, type Unit } from "../shared/tidy";
import { pendingDiff } from "./codex-pending";
import { buildCorpus, featuresOf } from "./corpus";
import type { Paseo } from "./daemon";
import { discover, writeGeneration, type Discovery } from "./discover";
import { userHome } from "./env";
import { eachLimited, Probe, sha256 } from "./files";
import { runSliced, Slicer } from "./pace";
import { Revalidating } from "./revalidate";
import { requestScan, scanProgress, scanState, symbolIndex, symbolsVersion } from "./symbols";

/**
 * The tidy checks (SPEC "Tidy checks"), pure code, no LLM. Each finding
 * carries one suggested action. Nothing here opens Codex's database or
 * starts a process; stale code names come from the background scan's last
 * answer.
 */

const MAX_PATH_CHECKS = 3000;
/** Paths looked up at once. */
const STAT_CONCURRENCY = 32;

/** What the checks read from a unit's text, worked out once per unit (units are cached per file version). */
type UnitRefs = { paths: string[]; symbols: string[]; secrets: ReturnType<typeof findSecrets> };
const refs = new WeakMap<Unit, UnitRefs>();

function refsOf(unit: Unit): UnitRefs {
  let hit = refs.get(unit);
  if (!hit) refs.set(unit, (hit = { paths: pathRefs(unit.text), symbols: symbolRefs(unit.text), secrets: findSecrets(unit.text) }));
  return hit;
}

function id(kind: string, ...parts: string[]): string {
  return `${kind}:${sha256(parts.join("\u0000")).slice(0, 12)}`;
}

function where(unit: Unit): string {
  const home = userHome();
  return unit.projectPath ? `${basename(unit.projectPath)}: ${unit.title}` : `${tilde(unit.path, home)}: ${unit.title}`;
}

function editAction(label: string, unit: Unit): FindingAction {
  return { label, kind: "edit", sourceId: unit.sourceId, key: unit.key };
}

/** Where a unit is loaded: everywhere ("user"), or in one project (each project reads only its own Claude memory). */
function loadContext(unit: Unit): string {
  if (unit.scope === "user" || unit.scope === "managed" || unit.scope === "host") return "user";
  return unit.projectPath ?? `folder:${unit.sourceId}`;
}

async function duplicateFindings(units: Unit[], slicer: Slicer): Promise<Finding[]> {
  return (await runSliced(duplicateSteps(units, featuresOf), slicer)).map((group) => {
    // A Claude memory copy is the easiest to delete safely (its index line follows), so suggest that one.
    const copy = group.units.find((unit) => unit.kind === "claude-auto-memory") ?? group.units[group.units.length - 1]!;
    const keep = group.units.find((unit) => unit !== copy)!;
    // Deleting a copy only helps when another copy is loaded in the same place (the same project, or everywhere).
    const sameContext = group.units.some((unit) => unit !== copy && (loadContext(unit) === "user" || loadContext(unit) === loadContext(copy)));
    const acrossProjects = !sameContext && new Set(group.units.map(loadContext)).size === group.units.length;
    const action: FindingAction = acrossProjects
      ? group.exact
        ? { label: "Move to your user CLAUDE.md", kind: "review", sourceId: copy.sourceId, key: copy.key }
        : { label: "Keep both (each project loads only its own)", kind: "review", sourceId: copy.sourceId, key: copy.key }
      : sameContext && copy.kind === "claude-auto-memory"
        ? { label: `Delete the copy "${copy.title}"`, kind: "delete", sourceId: copy.sourceId, key: copy.key }
        : editAction(`Keep one copy of "${copy.title}"`, copy);
    const where2 = acrossProjects ? " Each project loads only its own copy." : "";
    return {
      id: id("duplicate", ...group.units.map((unit) => unit.id)),
      kind: "duplicate",
      severity: "info",
      sourceIds: [...new Set(group.units.map((unit) => unit.sourceId))],
      entryKeys: group.units.map((unit) => unit.key),
      message: group.exact
        ? `The same text is in ${group.units.length} places: ${group.units.slice(0, 3).map(where).join("; ")}.${where2}`
        : `Two places say nearly the same thing (${Math.round(group.score * 100)}% alike): ${where(keep)}; ${where(copy)}.${where2}`,
      action,
    };
  });
}

function conflictFindings(units: Unit[]): Finding[] {
  return findConflicts(units, featuresOf).map((group) => ({
    id: id("conflict", ...group.units.map((unit) => unit.id)),
    kind: "conflict",
    severity: "info",
    heuristic: true,
    sourceIds: [...new Set(group.units.map((unit) => unit.sourceId))],
    entryKeys: group.units.map((unit) => unit.key),
    message: `Possible conflict (a guess): "${group.title}" appears in ${group.units.length} places with different text: ${group.units.slice(0, 3).map(where).join("; ")}.`,
    action: { label: `Compare the "${group.title}" entries and keep one`, kind: "review", sourceId: group.units[0]!.sourceId, key: group.units[0]!.key },
  }));
}

function resolveRef(ref: string, unit: Unit): string | null {
  if (ref.startsWith("~/")) return join(userHome(), ref.slice(2));
  if (isAbsolute(ref)) return ref;
  // Claude memory for a project whose path is unknown: a relative path cannot be checked against anything.
  if (unit.kind === "claude-auto-memory" && !unit.projectPath) return null;
  const base = unit.projectPath ?? (unit.scope === "project" ? dirname(unit.path) : null);
  // A file that sits in HOME itself (~/AGENTS.md) talks about projects in general, not about HOME.
  if (!base || base === userHome()) return null;
  return resolve(base, ref);
}

/**
 * `/property/search` in a memory is far more often a URL route than a file.
 * An absolute mention counts as a path only when its top folder exists here.
 */
async function looksLocal(probe: Probe, target: string): Promise<boolean> {
  const top = target.split("/").filter(Boolean)[0];
  return Boolean(top) && (await probe.isDir(`/${top}`));
}

/** The first folder on the way to `target` that is missing: what a group of stale mentions has in common. */
async function missingTop(probe: Probe, target: string): Promise<string> {
  const parts = target.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i += 1) {
    const prefix = `/${parts.slice(0, i).join("/")}`;
    if (!(await probe.exists(prefix))) return prefix;
  }
  return target;
}

/**
 * Stale paths, grouped by the missing folder they share: fourteen memories
 * pointing into one deleted worktree are one finding, not fourteen.
 */
async function stalePathFindings(units: Unit[], probe: Probe, slicer: Slicer): Promise<{ findings: Finding[]; checked: number }> {
  // Look up every path the pass below may ask about, a few at a time, each once; the pass then reads the answers in order.
  const ahead = new Set<string>();
  prefetch: for (const unit of units) {
    await slicer.step();
    for (const ref of refsOf(unit).paths) {
      if (ahead.size >= MAX_PATH_CHECKS * 3) break prefetch;
      const target = resolveRef(ref, unit);
      if (!target) continue;
      ahead.add(target);
      if (isAbsolute(ref)) ahead.add(`/${target.split("/").filter(Boolean)[0] ?? ""}`);
      else if (unit.projectPath) ahead.add(unit.projectPath);
    }
  }
  await eachLimited([...ahead], STAT_CONCURRENCY, (path) => probe.exists(path));
  const groups = new Map<string, Array<{ unit: Unit; ref: string; target: string }>>();
  let checked = 0;
  outer: for (const unit of units) {
    // The answers are in the probe already, so these awaits never reach the event loop: step.
    await slicer.step();
    for (const ref of refsOf(unit).paths) {
      if (checked >= MAX_PATH_CHECKS) break outer;
      const target = resolveRef(ref, unit);
      if (!target) continue;
      if (isAbsolute(ref) && !(await looksLocal(probe, target))) continue;
      checked += 1;
      // A path relative to a project only counts when that project is on this machine.
      if (!isAbsolute(ref) && !ref.startsWith("~/") && unit.projectPath && !(await probe.isDir(unit.projectPath))) continue;
      if (await probe.exists(target)) continue;
      const top = await missingTop(probe, target);
      const hits = groups.get(top);
      if (hits) hits.push({ unit, ref, target });
      else groups.set(top, [{ unit, ref, target }]);
    }
  }
  const home = userHome();
  const out: Finding[] = [];
  for (const [top, hits] of groups) {
    const units = [...new Map(hits.map((hit) => [hit.unit.id, hit.unit])).values()];
    const first = hits[0]!;
    const one = hits.length === 1;
    out.push({
      id: id("stale-path", top, ...hits.map((hit) => `${hit.unit.id}:${hit.ref}`)),
      kind: "stale-path",
      severity: "info",
      sourceIds: [...new Set(units.map((unit) => unit.sourceId))],
      entryKeys: units.map((unit) => unit.key),
      message: one
        ? `${where(first.unit)} mentions \`${first.ref}\`, which no longer exists on this machine.`
        : `${units.length === 1 ? `${where(first.unit)} mentions` : `${units.length} memories mention`} ${tilde(top, home)}/…, which no longer exists on this machine.`,
      detail: hits.slice(0, 10).map((hit) => hit.ref).join(", "),
      action: editAction(one ? `Update or remove the mention of ${first.ref}` : `Update the mentions of ${tilde(top, home)}`, first.unit),
    });
  }
  return { findings: out, checked };
}

/** The units that name code, with the names, per project root: what the background scan is asked about. */
type SymbolMentions = { queries: Map<string, Set<string>>; mentions: Array<{ unit: Unit; names: string[] }> };

function symbolMentions(units: Unit[]): SymbolMentions {
  const queries = new Map<string, Set<string>>();
  const mentions: SymbolMentions["mentions"] = [];
  for (const unit of units) {
    if (!unit.projectPath) continue;
    const names = refsOf(unit).symbols;
    if (!names.length) continue;
    const query = queries.get(unit.projectPath) ?? new Set<string>();
    queries.set(unit.projectPath, query);
    for (const name of names) query.add(name);
    mentions.push({ unit, names });
  }
  return { queries, mentions };
}

/** Stale code names from the scan's answers as they are now (read time: a scan that finishes shows on the next read). */
async function staleSymbolFindings(mentions: SymbolMentions["mentions"]): Promise<Finding[]> {
  const out: Finding[] = [];
  const slicer = new Slicer();
  for (const { unit, names } of mentions) {
    await slicer.step();
    const index = symbolIndex(unit.projectPath!);
    if (!index || index.capped) continue;
    for (const name of names) {
      // A name the last scan was not asked about is unknown until the next one.
      if (!index.names.has(name) || index.found.has(name)) continue;
      out.push({
        id: id("stale-symbol", unit.id, name),
        kind: "stale-symbol",
        severity: "info",
        heuristic: true,
        sourceIds: [unit.sourceId],
        entryKeys: [unit.key],
        message: `${where(unit)} mentions \`${name}\`, which is not in the project's code any more (as of ${index.asOf.slice(0, 16).replace("T", " ")}).`,
        action: editAction(`Update or remove the mention of ${name}`, unit),
      });
    }
  }
  return out;
}

async function folderFindings(discovery: Discovery, probe: Probe): Promise<Finding[]> {
  const out: Finding[] = [];
  const home = userHome();
  for (const source of discovery.sources) {
    if (!source.exists) continue;
    if (source.kind === "claude-auto-memory") {
      const text = await probe.text(join(source.path, "MEMORY.md"));
      const names = new Set((await probe.list(source.path)).filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "MEMORY.md").map((entry) => entry.name));
      const lines = text === null ? [] : parseIndex(text);
      const where = source.projectPath ? basename(source.projectPath) : `other project (${source.slug})`;
      for (const line of lines) {
        if (names.has(line.file)) continue;
        out.push({ id: id("index-drift", source.id, line.file), kind: "index-drift", severity: "warn", sourceIds: [source.id], entryKeys: [line.file], message: `MEMORY.md in ${where} lists ${line.file}, which does not exist.`, action: { label: `Remove the MEMORY.md line for ${line.file}`, kind: "edit", sourceId: source.id, key: "MEMORY.md" } });
      }
      const named = new Set(lines.map((line) => line.file));
      for (const name of names) {
        if (named.has(name)) continue;
        out.push({ id: id("index-drift", source.id, name), kind: "index-drift", severity: "warn", sourceIds: [source.id], entryKeys: [name], message: `${name} in ${where} is not in MEMORY.md, so Claude does not know it is there.`, action: { label: `Add ${name} to MEMORY.md`, kind: "edit", sourceId: source.id, key: name } });
      }
      if (text !== null) {
        const load = claudeIndexLoad(text);
        if (load.truncated) out.push({ id: id("over-limit", source.id), kind: "over-limit", severity: "warn", sourceIds: [source.id], entryKeys: ["MEMORY.md"], message: `MEMORY.md in ${where} is over Claude's limit: only the first ${load.lines} lines load (200 lines or 25,000 bytes).`, action: { label: "Trim MEMORY.md below 200 lines", kind: "edit", sourceId: source.id, key: "MEMORY.md" } });
      }
      continue;
    }
    if (source.isDirectory) continue;
    if ((source.kind === "claude-md" || source.kind === "claude-local") && source.lines > CLAUDE_MD_ADVISORY_LINES) {
      out.push({ id: id("over-limit", source.id), kind: "over-limit", severity: "info", sourceIds: [source.id], message: `${tilde(source.path, home)} has ${source.lines} lines; Claude's docs suggest under 200.`, action: { label: `Shorten ${basename(source.path)}`, kind: "edit", sourceId: source.id } });
    }
    if (source.kind === "agents-md" && source.scope === "project" && source.bytes > CODEX_PROJECT_DOC_MAX_BYTES && source.readBy.includes("codex")) {
      out.push({ id: id("over-limit", source.id), kind: "over-limit", severity: "warn", sourceIds: [source.id], message: `${tilde(source.path, home)} is ${source.bytes.toLocaleString("en-US")} bytes; Codex reads only the first 32 KiB of project docs.`, action: { label: `Shorten ${basename(source.path)}`, kind: "edit", sourceId: source.id } });
    }
    if (source.kind === "codex-memory" && basename(source.path) === "memory_summary.md" && source.bytes > CODEX_MEMORY_SUMMARY_TOKENS * 4) {
      out.push({ id: id("over-limit", source.id), kind: "over-limit", severity: "info", sourceIds: [source.id], message: `Codex's memory_summary.md is about ${Math.round(source.bytes / 4).toLocaleString("en-US")} tokens; Codex injects only the first ≈2,500.`, action: { label: "Open Codex's memory summary", kind: "open", sourceId: source.id } });
    }
  }
  // Codex pending consolidation, from its working diff only (never the sqlite).
  for (const account of discovery.accounts.accounts.filter((entry) => entry.agent === "codex" && entry.exists)) {
    const pending = await pendingDiff(join(account.dir, "memories"));
    if (!pending) continue;
    const summary = join(account.dir, "memories", "MEMORY.md");
    out.push({ id: id("codex-pending", account.id), kind: "codex-pending", severity: "warn", sourceIds: [summary], message: pendingMessage(pending), action: { label: "Read this before editing Codex's memory", kind: "open", sourceId: summary } });
  }
  return out;
}

function secretFindings(units: Unit[]): Finding[] {
  const out: Finding[] = [];
  for (const unit of units) {
    const found = refsOf(unit).secrets;
    if (!found.length) continue;
    const kinds = [...new Set(found.map((match) => match.kind))];
    const holds = found.length === 1 ? "holds a value that looks like a secret" : `holds ${found.length} values that look like secrets`;
    const what =
      unit.kind === "claude-auto-memory"
        ? `A memory in ${unit.projectPath ? basename(unit.projectPath) : "a project whose path is unknown"}, "${unit.title}",`
        : unit.key === "0:"
          ? `The top of ${tilde(unit.path, userHome())}`
          : `The "${unit.title}" section of ${tilde(unit.path, userHome())}`;
    out.push({ id: id("secret", unit.id), kind: "secret", severity: "error", sourceIds: [unit.sourceId], entryKeys: [unit.key], message: `${what} ${holds}. Every agent that loads it can see it.`, detail: kinds.join(", "), action: editAction("Move the secret out of memory", unit) });
  }
  return out;
}

type Core = {
  /** Every finding but the stale code names, ranked. */
  findings: Finding[];
  checked: string[];
  notes: string[];
  stale: boolean;
  sources: number;
  /** Project roots asked about in the code-name scan. */
  roots: string[];
  /** The code names each unit mentions; their findings come from the scan's answers at read time. */
  mentions: SymbolMentions["mentions"];
};

/** Everything the findings depend on besides the files they read: the discovery and Codex's pending work. */
async function findingsInputs(discovery: Discovery): Promise<string> {
  const pending = [];
  for (const account of discovery.accounts.accounts) if (account.agent === "codex" && account.exists) pending.push(await pendingDiff(join(account.dir, "memories")));
  return JSON.stringify([discovery.version, pending]);
}

async function computeFindings(paseo: Paseo | null, refresh: boolean): Promise<{ value: Core; seen: Map<string, string>; inputs: string }> {
  const discovery = await discover(paseo, { refresh });
  const probe = new Probe();
  const slicer = new Slicer();
  const units = await buildCorpus(discovery, probe);
  // What each check reads from a text, worked out a slice at a time (kept per file version, so only new text costs anything).
  for (const unit of units) {
    featuresOf(unit);
    refsOf(unit);
    await slicer.step();
  }
  const stale = discovery.settings.staleChecks;
  const paths = stale ? await stalePathFindings(units, probe, slicer) : { findings: [], checked: 0 };
  const symbols = stale ? symbolMentions(units) : { queries: new Map<string, Set<string>>(), mentions: [] };
  const unknownFolders = new Set(units.filter((unit) => unit.kind === "claude-auto-memory" && !unit.projectPath && refsOf(unit).paths.some((ref) => !ref.startsWith("~/") && !isAbsolute(ref))).map((unit) => unit.sourceId));
  if (stale) requestScan(symbols.queries, refresh);
  const found = [...secretFindings(units), ...(await folderFindings(discovery, probe)), ...(await duplicateFindings(units, slicer))];
  await slicer.step();
  const conflicts = conflictFindings(units);
  await slicer.step();
  const findings = rankFindings([...found, ...paths.findings, ...conflicts]);
  const sources = discovery.sources.filter((source) => source.exists).length;
  await slicer.step();
  const value: Core = {
    findings,
    checked: [
      `Checked ${units.length.toLocaleString("en-US")} memories and sections in ${sources} sources${stale ? `, and ${paths.checked} path mentions` : ""}.`,
      ...discovery.checked,
    ],
    notes: stale && unknownFolders.size
      ? [`Relative paths in ${unknownFolders.size} Claude memory folder${unknownFolders.size === 1 ? "" : "s"} whose project path is unknown were not checked; only absolute paths were.`]
      : [],
    stale,
    sources,
    roots: [...symbols.queries.keys()],
    mentions: symbols.mentions,
  };
  return { value, seen: probe.seen, inputs: await findingsInputs(discovery) };
}

/** Re-checked at most every 10 s while a page asks; worked out again only when something it read changed. Tests may change these. */
export const FINDINGS_TIMING = { reuseMs: 2_000, checkEveryMs: 10_000 };
const cache = new Revalidating<Core>(writeGeneration, FINDINGS_TIMING);

/** For tests: how many times the findings were worked out. */
export function findingsComputations(): number {
  return cache.computations;
}

/** For tests: resolves once no check of the findings is running. */
export function findingsSettled(): Promise<void> {
  return cache.settled();
}

/** The last answer's findings with the scan's stale code names, kept until either changes. */
let merged: { core: Core; scan: number; findings: Finding[]; nextStep: ReturnType<typeof nextStep> } | null = null;

async function withSymbols(core: Core): Promise<{ findings: Finding[]; nextStep: ReturnType<typeof nextStep> }> {
  const scan = symbolsVersion();
  if (merged?.core === core && merged.scan === scan) return merged;
  const findings = core.stale ? rankFindings([...core.findings, ...(await staleSymbolFindings(core.mentions))]) : core.findings;
  const next = { core, scan, findings, nextStep: nextStep(findings, { sources: core.sources }) };
  // A read that started later may have stored a newer one meanwhile; it is no worse to keep this one.
  merged = next;
  return next;
}

/**
 * The findings. Straight from the last answer when there is one (checked
 * for changes in the background; `checking` says so); worked out now on
 * the first read, after a write, or on Refresh. Concurrent reads share one
 * computation. Stale code names come from the background scan's answers as
 * they are at the read.
 */
export async function findingsFor(paseo: Paseo | null, refresh = false) {
  const answer = await cache.get(
    { compute: () => computeFindings(paseo, refresh), inputs: async () => findingsInputs(await discover(paseo)) },
    refresh ? "fresh" : "stale-ok",
  );
  const core = answer.value;
  const { findings, nextStep } = await withSymbols(core);
  const scan: { state: string; asOf?: string; checked?: number; total?: number } = core.stale ? { ...scanState(), ...scanProgress(core.roots) } : { state: "off" };
  const partial = scanProgressNote(scan);
  return {
    checkedAt: new Date(answer.asOf).toISOString(),
    findings,
    nextStep,
    checked: core.checked,
    notes: core.notes,
    symbolScan: {
      ...scan,
      note: !core.stale
        ? "Stale-mention checks are off in settings."
        : partial
          ? partial
          : scan.state === "done"
            ? `Code names checked against ${core.roots.length} project${core.roots.length === 1 ? "" : "s"}.`
            : "Checking code names in the background; they show on the next refresh.",
    },
    checking: answer.checking,
  };
}

export const handleFindings = ({ refresh }: { refresh?: boolean }, { paseo }: PluginHandlerContext) => findingsFor(paseo, Boolean(refresh));
