import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { join } from "node:path";
import type { NoteTarget, WriteReport, WriteResult } from "../shared/contracts";
import { plainError } from "../shared/errors";
import { byteLength, CLAUDE_MD_MAX_BYTES, claudeIndexLoad } from "../shared/limits";
import { upsertIndexLine } from "../shared/memory-index";
import {
  CLAUDE_FILE_TOO_BIG,
  CLAUDE_LIST_FULL,
  CLAUDE_LIST_TOO_BIG,
  CODEX_PAST_LIMIT,
  HIDDEN_TEXT,
  NOTE_WHO,
  hasHiddenText,
  noteTargetWarning,
  noteTitle,
  planNote,
  type NoteFacts,
  type NoteTargetPlan,
  type NoteWho,
  type NoteWhere,
} from "../shared/notes";
import { PLAIN, plainMessage } from "../shared/plain";
import { findSecrets } from "../shared/secrets";
import { asSection, type ImportItem } from "../shared/transfer";
import { accountForProvider, providerDir } from "./accounts";
import { workspaceEntry, type Paseo } from "./daemon";
import { discover } from "./discover";
import { userHome } from "./env";
import { Probe } from "./files";
import { versionControlled } from "./git";
import { logWrite } from "./log";
import { planFor, type PlanCtx } from "./plans";
import { appendText, importApply, importPreview } from "./transfer";
import { readCurrent } from "./write";

/**
 * "Add a note": one piece of text to the files each chosen agent reads,
 * picked by `planNote` from that agent's load plan. Preview and save go
 * through the import path (dedupe, stale-write guard, safe write, backups),
 * so a note is an import of one item into each target. A target where the
 * agent would not read the note (past Codex's project budget, past the part
 * of MEMORY.md Claude loads, a CLAUDE.md so big Claude skips it) is shown
 * as blocked and never saved. Each target is saved and reported on its own.
 */

type Request = { text: string; who: string; workspaceId?: string };

function refuse(message: string): WriteResult {
  return { ok: false, message, reports: [], warnings: [] };
}

/** What each agent's plan says it reads, for the provider Paseo starts it with. */
async function gatherFacts(paseo: Paseo | null, agents: Array<"claude" | "codex">, directory: string): Promise<NoteFacts> {
  const discovery = await discover(paseo);
  const probe = new Probe();
  const facts: NoteFacts = {};
  for (const agent of agents) {
    const { account, env } = accountForProvider(discovery.accounts, agent);
    const dir = account?.dir ?? providerDir(agent, env);
    if (!(await probe.isDir(dir))) {
      facts[agent] = { unavailable: `${agent === "claude" ? "Claude" : "Codex"} isn't set up on this computer.` };
      continue;
    }
    const ctx: PlanCtx = { probe, home: userHome(), env, prompt: discovery.prompt, codexEdits: discovery.settings.codexEdits, subfolders: false };
    const raw = await planFor(agent, ctx, dir, directory);
    const items = [];
    for (const item of raw.items) {
      if (!item.path || item.path.includes(":")) continue;
      // In a git folder (a project, or a home folder kept in git): shared, never "only you".
      const shared = await versionControlled(probe, item.kind === "claude-auto-memory" ? join(item.path, "MEMORY.md") : item.path);
      items.push({ kind: item.kind, scope: item.scope, path: item.path, when: item.when, access: item.access, versionControlled: shared, ...(item.readLimit !== undefined ? { readLimit: item.readLimit } : {}) });
    }
    facts[agent] = { items, ...(account && account.origin !== "default" ? { account: account.email ?? account.label } : {}) };
  }
  return facts;
}

async function resolve(paseo: Paseo | null, input: Request) {
  if (!(NOTE_WHO as readonly string[]).includes(input.who)) throw new Error("Pick who should follow the note.");
  // Dots copied from a hidden value would be saved as dots.
  if (hasHiddenText(input.text)) throw new Error(HIDDEN_TEXT);
  const who = input.who as NoteWho;
  let where: NoteWhere = { kind: "everywhere" };
  let directory = userHome();
  if (input.workspaceId) {
    if (!paseo) throw new Error("Projects need Paseo's workspace list, which this host can't read.");
    const workspace = await workspaceEntry(paseo, input.workspaceId);
    where = { kind: "project", name: workspace.name };
    directory = workspace.directory;
  }
  const agents: Array<"claude" | "codex"> = who === "all" ? ["claude", "codex"] : [who];
  const plan = planNote(who, where, await gatherFacts(paseo, agents, directory));
  const text = input.text.replace(/\r\n/g, "\n").trim();
  const title = noteTitle(text);
  const item: ImportItem = {
    id: "note",
    title,
    description: (text.split("\n").find((line) => line.trim()) ?? title).replace(/^[-*#>\s]+/, "").slice(0, 150),
    type: where.kind === "project" ? "project" : "user",
    body: `${text}\n`,
    masked: false,
    format: "note",
    warnings: [],
  };
  return { plan, item, where, title };
}

function importTarget(target: NoteTargetPlan, workspaceId?: string) {
  return target.kind === "claude-memory" ? { kind: target.kind, sourceId: target.path, ...(workspaceId ? { workspaceId } : {}) } : { kind: target.kind, path: target.path, ...(workspaceId ? { workspaceId } : {}) };
}

/** Where the note would sit once saved, and whether the agent reads that far. A reason when it doesn't. */
async function blockedReason(target: NoteTargetPlan, item: ImportItem, fileName?: string): Promise<string | undefined> {
  if (target.kind === "append") {
    const current = await readCurrent(target.path);
    const after = byteLength(appendText(current.text, asSection(item)));
    if (target.agent === "codex" && target.readLimit !== undefined && after > target.readLimit) return CODEX_PAST_LIMIT;
    if (target.agent === "claude" && after > CLAUDE_MD_MAX_BYTES) return CLAUDE_FILE_TOO_BIG;
    return undefined;
  }
  if (!fileName) return undefined;
  const index = await readCurrent(join(target.path, "MEMORY.md")).catch(() => null);
  // An unreadable MEMORY.md is the save's problem to report (and roll back), not a read limit.
  if (!index) return undefined;
  const next = upsertIndexLine(index.text, fileName, item.title, item.description ?? item.title);
  const row = next.split("\n").findIndex((line) => line.includes(`(${fileName})`) || line.includes(`(./${fileName})`));
  const load = claudeIndexLoad(next);
  if (row < 0 || row < load.lines) return undefined;
  return load.reason === "bytes" ? CLAUDE_LIST_TOO_BIG : CLAUDE_LIST_FULL;
}

/** One target as the preview shows it and the save decides from it. */
async function inspect(paseo: Paseo | null, target: NoteTargetPlan, item: ImportItem, workspaceId?: string): Promise<NoteTarget> {
  const preview = await importPreview(paseo, { items: [item], target: importTarget(target, workspaceId) });
  const row = preview.items[0]!;
  const warning = noteTargetWarning(target);
  const blocked = await blockedReason(target, item, "fileName" in row ? row.fileName : undefined);
  // "Already there" only for the same text; a normalised match (">=" vs "<=") is near: warned, still saved.
  const duplicate = row.identical ? "exact" : row.duplicate === "exact" || row.duplicate === "near" ? "near" : "none";
  return {
    id: target.path,
    agent: target.agent,
    kind: target.kind,
    label: target.label,
    path: target.path,
    creates: target.creates,
    shared: target.shared,
    private: target.private,
    warnings: warning ? [warning] : [],
    duplicate,
    ...(row.duplicateOf && duplicate !== "none" ? { duplicateOf: row.duplicateOf } : {}),
    ...(blocked ? { blocked } : {}),
    stamp: preview.target.stamp,
  };
}

export async function notePreview(paseo: Paseo | null, input: Request) {
  const { plan, item, where, title } = await resolve(paseo, input);
  const targets: NoteTarget[] = [];
  for (const target of plan.targets) targets.push(await inspect(paseo, target, item, input.workspaceId));
  return {
    title,
    ...(where.kind === "project" ? { project: where.name } : {}),
    targets,
    skipped: plan.skipped,
    warnings: findSecrets(item.body).length ? [PLAIN.secretWarning] : [],
  };
}

export async function noteAdd(paseo: Paseo | null, input: Request & { expected: Array<{ id: string; stamp: NoteTarget["stamp"] }> }): Promise<WriteResult> {
  let resolved;
  try {
    resolved = await resolve(paseo, input);
  } catch (error) {
    return refuse(plainError(error));
  }
  const { plan, item } = resolved;
  const now = plan.targets.map((target) => target.path).sort();
  const seen = input.expected.map((entry) => entry.id).sort();
  if (now.length === 0) return refuse(plan.skipped.map((entry) => entry.reason).join(" ") || "There is nowhere to put this note.");
  if (now.join("\n") !== seen.join("\n")) return refuse("Where this note goes has changed since you checked it. Check it again; nothing was saved.");
  const reports: WriteReport[] = [];
  const warnings: string[] = [];
  const saved: string[] = [];
  const already: string[] = [];
  const notSaved: string[] = [];
  // Each target on its own: one that fails or won't be read never stops the others, and each is reported.
  for (const target of plan.targets) {
    try {
      const state = await inspect(paseo, target, item, input.workspaceId);
      if (state.blocked) {
        notSaved.push(`${target.label} (${state.blocked.replace(/\.$/, "")})`);
        continue;
      }
      if (state.duplicate === "exact") {
        already.push(target.label);
        continue;
      }
      const expected = input.expected.find((entry) => entry.id === target.path)!.stamp;
      const result = await importApply(paseo, { items: [item], target: importTarget(target, input.workspaceId), selected: [item.id], ...(target.kind === "append" ? { expected } : {}) });
      reports.push(...result.reports);
      warnings.push(...result.warnings.map(plainMessage));
      if (result.ok) {
        saved.push(target.label);
        const warning = noteTargetWarning(target);
        if (warning) warnings.push(warning);
      } else notSaved.push(`${target.label} (${plainMessage(result.message).replace(/\.$/, "")})`);
    } catch (error) {
      notSaved.push(`${target.label} (${plainError(error).replace(/\.$/, "")})`);
    }
  }
  logWrite("note-add", plan.targets.map((target) => target.path).join(", "), `${saved.length} saved, ${already.length} already there, ${notSaved.length} not saved`);
  const parts: string[] = [];
  if (saved.length && !notSaved.length) parts.push(PLAIN.saved);
  else if (saved.length) parts.push(`Saved to ${saved.join(" and ")}, but not to ${notSaved.join("; ")}. New agents will follow what was saved.`);
  else if (notSaved.length) parts.push(`Not saved to ${notSaved.join("; ")}.`);
  if (already.length) parts.push(`${already.join(" and ")} already had this note, so it wasn't added again.`);
  return { ok: notSaved.length === 0, message: parts.join(" "), reports, warnings: [...new Set(warnings)] };
}

type Ctx = PluginHandlerContext;
export const handleNotePreview = (input: Request, { paseo }: Ctx) => notePreview(paseo, input);
export const handleNoteAdd = (input: Parameters<typeof noteAdd>[1], { paseo }: Ctx) => noteAdd(paseo, input);
