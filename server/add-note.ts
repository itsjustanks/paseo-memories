import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { NoteTarget, WriteReport, WriteResult } from "../shared/contracts";
import { NOTE_WHO, noteTargetWarning, noteTitle, planNote, type NoteFacts, type NoteTargetPlan, type NoteWho, type NoteWhere } from "../shared/notes";
import { PLAIN } from "../shared/plain";
import { findSecrets } from "../shared/secrets";
import type { ImportItem } from "../shared/transfer";
import { accountForProvider, providerDir } from "./accounts";
import { workspaceEntry, type Paseo } from "./daemon";
import { discover } from "./discover";
import { userHome } from "./env";
import { Probe } from "./files";
import { versionControlled } from "./git";
import { logWrite } from "./log";
import { planFor, type PlanCtx } from "./plans";
import { importApply, importPreview } from "./transfer";

/**
 * "Add a note": one piece of text to the files each chosen agent reads,
 * picked by `planNote` from that agent's load plan. Preview and save go
 * through the import path (dedupe, stale-write guard, safe write, backups),
 * so a note is exactly an import of one item into each target.
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
      items.push({ kind: item.kind, scope: item.scope, path: item.path, when: item.when, access: item.access, ...(item.scope === "project" && item.kind !== "claude-auto-memory" ? { versionControlled: await versionControlled(probe, item.path) } : {}) });
    }
    facts[agent] = { items, ...(account && account.origin !== "default" ? { account: account.email ?? account.label } : {}) };
  }
  return facts;
}

async function resolve(paseo: Paseo | null, input: Request) {
  if (!(NOTE_WHO as readonly string[]).includes(input.who)) throw new Error("Pick who should follow the note.");
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

export async function notePreview(paseo: Paseo | null, input: Request) {
  const { plan, item, where, title } = await resolve(paseo, input);
  const targets: NoteTarget[] = [];
  for (const target of plan.targets) {
    const preview = await importPreview(paseo, { items: [item], target: importTarget(target, input.workspaceId) });
    const row = preview.items[0]!;
    const warning = noteTargetWarning(target);
    targets.push({
      id: target.path,
      agent: target.agent,
      kind: target.kind,
      label: target.label,
      path: target.path,
      creates: target.creates,
      shared: target.shared,
      private: target.private,
      warnings: warning ? [warning] : [],
      duplicate: row.duplicate === "exact" || row.duplicate === "near" ? row.duplicate : "none",
      ...(row.duplicateOf ? { duplicateOf: row.duplicateOf } : {}),
      stamp: preview.target.stamp,
    });
  }
  return {
    title,
    ...(where.kind === "project" ? { project: where.name } : {}),
    targets,
    skipped: plan.skipped,
    warnings: findSecrets(item.body).length ? [PLAIN.secretWarning] : [],
  };
}

export async function noteAdd(paseo: Paseo | null, input: Request & { expected: Array<{ id: string; stamp: NoteTarget["stamp"] }> }): Promise<WriteResult> {
  const { plan, item } = await resolve(paseo, input);
  const now = plan.targets.map((target) => target.path).sort();
  const seen = input.expected.map((entry) => entry.id).sort();
  if (now.length === 0) return refuse(plan.skipped.map((entry) => entry.reason).join(" ") || "There is nowhere to put this note.");
  if (now.join("\n") !== seen.join("\n")) return refuse("Where this note goes has changed since you checked it. Check it again; nothing was saved.");
  const reports: WriteReport[] = [];
  const warnings: string[] = [];
  const saved: string[] = [];
  const already: string[] = [];
  const failed: string[] = [];
  for (const target of plan.targets) {
    const destination = importTarget(target, input.workspaceId);
    // The same note already there: nothing to write for this one.
    const check = await importPreview(paseo, { items: [item], target: destination });
    if (check.items[0]?.duplicate === "exact") {
      already.push(target.label);
      continue;
    }
    const expected = input.expected.find((entry) => entry.id === target.path)!.stamp;
    const result = await importApply(paseo, { items: [item], target: destination, selected: [item.id], ...(target.kind === "append" ? { expected } : {}) });
    reports.push(...result.reports);
    if (result.ok) {
      saved.push(target.label);
      const warning = noteTargetWarning(target);
      if (warning) warnings.push(warning);
    } else failed.push(`${target.label} (${result.message.replace(/\.$/, "")})`);
  }
  logWrite("note-add", plan.targets.map((target) => target.path).join(", "), `${saved.length} saved, ${already.length} already there, ${failed.length} failed`);
  const parts: string[] = [];
  if (saved.length && !failed.length) parts.push(PLAIN.saved);
  else if (saved.length) parts.push(`Saved to ${saved.join(" and ")}, but not to ${failed.join("; ")}.`);
  else if (failed.length) parts.push(`Not saved: ${failed.join("; ")}.`);
  if (already.length) parts.push(`${already.join(" and ")} already had this note, so it wasn't added again.`);
  return { ok: failed.length === 0, message: parts.join(" "), reports, warnings: [...new Set(warnings)] };
}

type Ctx = PluginHandlerContext;
export const handleNotePreview = (input: Request, { paseo }: Ctx) => notePreview(paseo, input);
export const handleNoteAdd = (input: Parameters<typeof noteAdd>[1], { paseo }: Ctx) => noteAdd(paseo, input);
