import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { tilde } from "../shared/agents";
import type { FileStamp, ImportTarget, WriteReport, WriteResult } from "../shared/contracts";
import { compactDiff, lineDiff, type DiffLine } from "../shared/diff";
import { newMemoryFile, parseMemoryFile, readFields } from "../shared/frontmatter";
import { parseIndex } from "../shared/memory-index";
import { replaceSection, sectionText, splitSections } from "../shared/markdown";
import { MASK_FILL, findSecrets, maskSecrets } from "../shared/secrets";
import { featureJaccard, NEAR_DUPLICATE, normalizeText, textFeatures, type Unit } from "../shared/tidy";
import { asSection, buildBundle, moveBlocker, parseImport, renderMarkdown, type BundleItem, type ImportItem } from "../shared/transfer";
import { claudeCreate, claudeDelete, fileNameFor, usualShape } from "./claude-memory";
import { buildCorpus, featuresOf, fileUnits, memoryFolderUnits, sectionBody } from "./corpus";
import type { Paseo } from "./daemon";
import { discover } from "./discover";
import { userHome } from "./env";
import { Probe, listDir } from "./files";
import { INSTRUCTION_KINDS, instructionWrite } from "./instructions";
import { logWrite } from "./log";
import { findSource } from "./read";
import { once } from "./receipts";
import { readCurrent, staleReason, type Current } from "./write";

/**
 * Import, export, copy and move. Every path goes parse → preview (never
 * writes) → apply through the same safe-write functions as a hand edit, with
 * one report per target. "Copy into Codex" means an AGENTS.md: append targets
 * must be instruction files, which Codex's generated folders (including
 * `extensions/`, pruned after 7 days) never are.
 */

const MAX_DIFF_LINES = 400;

function refuse(message: string): WriteResult {
  return { ok: false, message, reports: [], warnings: [] };
}

// ------------------------------------------------------------------ parse

export function importParse({ text, files, format }: { text?: string; files?: Array<{ name: string; text: string }>; format?: string }) {
  const inputs = [...(text?.trim() ? [{ name: "", text }] : []), ...(files ?? [])];
  const items: ImportItem[] = [];
  const formats: Array<{ name: string; format: string; items: number }> = [];
  const warnings: string[] = [];
  inputs.forEach((input, index) => {
    const parsed = parseImport(input.text, input.name || undefined, format);
    formats.push({ name: input.name || "pasted text", format: parsed.format, items: parsed.items.length });
    warnings.push(...parsed.warnings.map((warning) => (input.name ? `${input.name}: ${warning}` : warning)));
    items.push(...parsed.items.map((item) => ({ ...item, id: `${index}/${item.id}` })));
  });
  if (!inputs.length) warnings.push("Nothing to import: paste some text or pick a file.");
  return { items, formats, warnings };
}

// ------------------------------------------------------------------ targets and items

type Target =
  | { kind: "claude-memory"; sourceId: string; workspaceId?: string; path: string; label: string; exists: boolean; access: string; reason?: string; existing: Unit[]; names: Set<string>; listed: Set<string> }
  | { kind: "append"; path: string; workspaceId?: string; label: string; exists: boolean; access: string; reason?: string; existing: Unit[]; current: Current };

async function resolveTarget(paseo: Paseo | null, target: ImportTarget): Promise<Target | { error: string }> {
  const probe = new Probe();
  const home = userHome();
  if (target.kind === "claude-memory") {
    if (!target.sourceId) return { error: "Pick a Claude project to import into." };
    const found = await findSource(paseo, target.sourceId, target.workspaceId);
    if (!found || found.source.kind !== "claude-auto-memory") return { error: "That is not a Claude auto-memory folder." };
    const existing = found.source.exists ? await memoryFolderUnits(probe, found.source) : [];
    const names = new Set((await listDir(found.source.path)).map((entry) => entry.name));
    // Only files MEMORY.md lists are ones Claude finds; an unlisted copy is not "already there".
    const index = await readCurrent(join(found.source.path, "MEMORY.md")).catch(() => ({ exists: false, text: "" }) as Current);
    const listed = new Set(parseIndex(index.text).map((line) => line.file));
    return {
      kind: "claude-memory",
      sourceId: found.source.id,
      ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
      path: found.source.path,
      label: `Claude memory for ${found.source.projectPath ? basename(found.source.projectPath) : tilde(found.source.path, home)}`,
      exists: found.source.exists,
      access: found.source.access,
      ...(found.source.reason ? { reason: found.source.reason } : {}),
      existing,
      names,
      listed,
    };
  }
  if (target.kind === "append") {
    if (!target.path) return { error: "Pick a file to add to." };
    const found = await findSource(paseo, target.path, target.workspaceId);
    if (!found || !INSTRUCTION_KINDS.has(found.source.kind)) return { error: "Only instruction files (CLAUDE.md, AGENTS.md, rules and the like) can take imported sections. Codex's generated memory cannot." };
    const current = await readCurrent(found.source.path);
    return {
      kind: "append",
      path: found.source.path,
      ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
      label: tilde(found.source.path, home),
      exists: current.exists,
      access: found.source.access,
      ...(found.source.reason ? { reason: found.source.reason } : {}),
      existing: found.source.exists ? await fileUnits(probe, found.source) : [],
      current,
    };
  }
  return { error: `Unknown import target "${target.kind}".` };
}

type Origin = {
  sourceId: string;
  key?: string;
  workspaceId?: string;
  path: string;
  kind: "memory" | "section" | "file";
  stamp?: FileStamp;
  /** A section's own text as read, to find it again by content rather than by a key that shifts. */
  text?: string;
  /** Why the original cannot be removed (read-only, managed, Codex's), when it cannot. */
  unmovable?: string;
  /**
   * What the preview showed, as a hash (0.6.0): the whole file for a memory or
   * file, the section's own text for a section. Apply refuses an item whose
   * fingerprint changed, so nothing unpreviewed is copied and no original is
   * removed unless it is byte-identical to what was previewed.
   */
  fingerprint: string;
};

const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const fileFingerprint = (current: Current) => `file:${current.stamp?.hash ?? sha256(current.bytes ?? current.text)}`;

/** Existing entries as items, with their real text (it stays on the host; previews are masked). */
async function itemsFromEntries(paseo: Paseo | null, refs: Array<{ sourceId: string; key?: string; workspaceId?: string }>): Promise<{ items: ImportItem[]; origins: Map<string, Origin>; errors: string[] }> {
  const items: ImportItem[] = [];
  const origins = new Map<string, Origin>();
  const errors: string[] = [];
  for (const ref of refs) {
    const found = await findSource(paseo, ref.sourceId, ref.workspaceId);
    if (!found?.source.exists) {
      errors.push(`${ref.sourceId} is no longer there.`);
      continue;
    }
    const { source } = found;
    const id = `${source.id}#${ref.key ?? ""}`;
    const common = { agent: source.agent, scope: source.scope, kind: source.kind, ...(source.projectPath ? { projectHint: source.projectPath } : {}), format: "entry", masked: false, warnings: [] as string[] };
    if (source.kind === "claude-auto-memory") {
      if (!ref.key || !ref.key.endsWith(".md") || ref.key.includes("/")) {
        errors.push("Pick one memory in that folder.");
        continue;
      }
      const path = join(source.path, ref.key);
      const current = await readCurrent(path).catch(() => ({ exists: false, text: "" }) as Current);
      if (!current.exists) {
        errors.push(`${ref.key} is no longer there.`);
        continue;
      }
      const file = parseMemoryFile(current.text);
      const fields = readFields(file);
      items.push({ ...common, id, title: fields.name ?? ref.key.replace(/\.md$/, ""), ...(fields.description !== undefined ? { description: fields.description } : {}), ...(fields.type !== undefined ? { type: fields.type } : {}), body: file.body, origin: path });
      const why = moveBlocker(source, ref.key);
      origins.set(id, { sourceId: source.id, key: ref.key, ...(ref.workspaceId ? { workspaceId: ref.workspaceId } : {}), path, kind: "memory", ...(current.stamp ? { stamp: current.stamp } : {}), ...(why ? { unmovable: why } : {}), fingerprint: fileFingerprint(current) });
      continue;
    }
    if (!INSTRUCTION_KINDS.has(source.kind) && source.kind !== "codex-memory" && source.kind !== "claude-managed") {
      errors.push(`${tilde(source.path, userHome())} cannot be copied.`);
      continue;
    }
    const current = await readCurrent(source.path);
    if (ref.key) {
      const section = splitSections(current.text).find((entry) => entry.key === ref.key);
      if (!section) {
        errors.push("That section is no longer in the file.");
        continue;
      }
      items.push({ ...common, id, title: section.key === "0:" ? basename(source.path) : section.title, body: sectionBody(sectionText(current.text, section)), origin: source.path });
      const why = moveBlocker(source, ref.key);
      const text = sectionText(current.text, section);
      origins.set(id, { sourceId: source.id, key: ref.key, ...(ref.workspaceId ? { workspaceId: ref.workspaceId } : {}), path: source.path, kind: "section", text, ...(current.stamp ? { stamp: current.stamp } : {}), ...(why ? { unmovable: why } : {}), fingerprint: `section:${sha256(text)}` });
    } else {
      items.push({ ...common, id, title: basename(source.path), body: current.text, origin: source.path });
      origins.set(id, { sourceId: source.id, path: source.path, kind: "file", ...(current.stamp ? { stamp: current.stamp } : {}), unmovable: `${basename(source.path)} is a whole file; whole files can be copied but not moved`, fingerprint: fileFingerprint(current) });
    }
  }
  return { items, origins, errors };
}

function descriptionOf(item: ImportItem): string {
  if (item.description) return item.description;
  const first = item.body.split("\n").find((line) => line.trim()) ?? item.title;
  return first.replace(/^[-*#>\s]+/, "").slice(0, 150);
}

/** The same words: line endings and the blank space around them aside. Case and punctuation count. */
function sameText(a: string, b: string): boolean {
  return a.replace(/\r\n/g, "\n").trim() === b.replace(/\r\n/g, "\n").trim();
}

/**
 * `exact` / `near` / `batch` as before (normalised text, a heuristic);
 * `identical` only when the text is the same after line endings and outer
 * whitespace, in a place the agent finds (`listed`, for Claude's notes).
 */
function duplicateOf(item: ImportItem, existing: Unit[], earlier: ImportItem[], listed?: Set<string>): { duplicate: string; duplicateOf?: string; identical?: boolean } {
  const normal = normalizeText(item.body);
  if (!normal) return { duplicate: "none" };
  const found = (unit: Unit) => !listed || listed.has(unit.key);
  const same = existing.find((unit) => found(unit) && sameText(unit.text, item.body));
  if (same) return { duplicate: "exact", duplicateOf: same.title, identical: true };
  // The existing notes' features are kept per file version (server/corpus.ts): no note is re-read per item.
  const features = textFeatures(item.body);
  for (const unit of existing) if (featuresOf(unit).key === features.key) return { duplicate: "exact", duplicateOf: unit.title };
  for (const unit of existing) {
    if (featureJaccard(features, featuresOf(unit)) >= NEAR_DUPLICATE) return { duplicate: "near", duplicateOf: unit.title };
  }
  for (const other of earlier) if (normalizeText(other.body) === normal) return { duplicate: "batch", duplicateOf: other.title };
  return { duplicate: "none" };
}

export function appendText(current: string, section: string): string {
  if (!current) return section;
  if (current.endsWith("\n\n")) return current + section;
  return current.endsWith("\n") ? `${current}\n${section}` : `${current}\n\n${section}`;
}

function shown(diff: DiffLine[], reveal: boolean): DiffLine[] {
  const lines = diff.length > MAX_DIFF_LINES ? [...diff.slice(0, MAX_DIFF_LINES), { op: " " as const, text: `… ${diff.length - MAX_DIFF_LINES} more lines` }] : diff;
  return reveal ? lines : lines.map((line) => ({ ...line, text: maskSecrets(line.text).text }));
}

async function gatherItems(paseo: Paseo | null, items?: ImportItem[], from?: Array<{ sourceId: string; key?: string; workspaceId?: string }>) {
  if (from?.length) return itemsFromEntries(paseo, from);
  return { items: items ?? [], origins: new Map<string, Origin>(), errors: [] as string[] };
}

// ------------------------------------------------------------------ preview

export async function importPreview(
  paseo: Paseo | null,
  input: { items?: ImportItem[]; from?: Array<{ sourceId: string; key?: string; workspaceId?: string }>; target: ImportTarget; reveal?: boolean },
) {
  const target = await resolveTarget(paseo, input.target);
  if ("error" in target) throw new Error(target.error);
  const { items, origins, errors } = await gatherItems(paseo, input.items, input.from);
  const reveal = Boolean(input.reveal);
  // Copies and moves: what this preview showed, so Apply can refuse anything that changed since.
  const seen = (id: string) => {
    const fingerprint = origins.get(id)?.fingerprint;
    return fingerprint ? { fingerprint } : {};
  };
  const out = [];
  const taken = new Set([...(target.kind === "claude-memory" ? target.names : []), "memory.md"].map((name) => name.toLowerCase()));
  const shape = target.kind === "claude-memory" ? await usualShape(target.path) : "nested";
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const dup = duplicateOf(item, target.existing, items.slice(0, index), target.kind === "claude-memory" ? target.listed : undefined);
    const warnings = [...item.warnings];
    if (!reveal && findSecrets(item.body).length) warnings.push("Holds values that look like secrets; they are hidden here and saved as they are.");
    if (target.kind === "claude-memory") {
      // Same rule as the save: compared without case, never the index.
      let fileName = fileNameFor(item.title);
      for (let n = 2; taken.has(fileName.toLowerCase()); n += 1) fileName = fileNameFor(item.title).replace(/\.md$/, `_${n}.md`);
      taken.add(fileName.toLowerCase());
      const content = newMemoryFile({ name: item.title, description: descriptionOf(item), type: item.type ?? "project" }, item.body, shape);
      out.push({ id: item.id, title: item.title, action: "create", fileName, diff: shown(lineDiff("", content), reveal), ...dup, masked: item.masked || item.body.includes(MASK_FILL), warnings, ...seen(item.id) });
    } else {
      const before = target.current.text;
      if (item.agent === "codex" || basename(target.path).startsWith("AGENTS")) warnings.push("Codex reads AGENTS.md as instructions; it does not become Codex's generated memory.");
      out.push({ id: item.id, title: item.title, action: "append", diff: shown(compactDiff(lineDiff(before, appendText(before, asSection(item)))), reveal), ...dup, masked: item.masked || item.body.includes(MASK_FILL), warnings, ...seen(item.id) });
    }
  }
  return {
    target: {
      kind: target.kind,
      label: target.label,
      path: target.path,
      exists: target.exists,
      stamp: target.kind === "append" ? target.current.stamp ?? null : null,
      access: target.access as "editable" | "read-only" | "online",
      ...(target.reason ? { reason: target.reason } : {}),
    },
    items: out,
    checked: [`Compared with ${target.existing.length} ${target.kind === "claude-memory" ? "memories" : "sections"} already in ${target.label}.`, ...errors].join(" "),
  };
}

// ------------------------------------------------------------------ apply

/** Where an import was going, in words, for "check … before trying again". */
function destinationWords(target: ImportTarget): string {
  if (target.kind === "append" && target.path) return tilde(target.path, userHome());
  return "Claude's notes for that project";
}

/** What a request asks for, so a reused id with a different request is refused rather than answered. */
function requestShape(input: object): string {
  const { requestId: _id, clientId: _client, ...rest } = input as { requestId?: string; clientId?: string };
  return sha256(JSON.stringify(rest));
}

export async function importApply(
  paseo: Paseo | null,
  input: { items?: ImportItem[]; from?: Array<{ sourceId: string; key?: string; workspaceId?: string }>; target: ImportTarget; selected: string[]; expected?: FileStamp | null; move?: boolean; seen?: Record<string, string>; requestId?: string; clientId?: string },
): Promise<WriteResult> {
  // The same request twice (a double press, a retried call) is answered once: the second gets the first's result and writes nothing.
  // One Save press, one write: across restarts too (server/receipts.ts).
  if (input.requestId) return once(input.clientId, input.requestId, requestShape(input), () => importApplyNow(paseo, input), destinationWords(input.target));
  return importApplyNow(paseo, input);
}

async function importApplyNow(
  paseo: Paseo | null,
  input: { items?: ImportItem[]; from?: Array<{ sourceId: string; key?: string; workspaceId?: string }>; target: ImportTarget; selected: string[]; expected?: FileStamp | null; move?: boolean; seen?: Record<string, string> },
): Promise<WriteResult> {
  const target = await resolveTarget(paseo, input.target);
  if ("error" in target) return refuse(target.error);
  if (target.access !== "editable") return refuse(target.reason ?? "That target is read-only.");
  const { items, origins, errors } = await gatherItems(paseo, input.items, input.from);
  if (errors.length) return refuse(errors.join(" "));
  const chosen = items.filter((item) => input.selected.includes(item.id));
  if (!chosen.length) return refuse("Nothing is selected, so nothing was written.");
  if (input.from?.length) {
    // Copies and moves act only on what the preview showed (0.6.0): every chosen item must still match it, byte for byte.
    if (!input.seen) return refuse("Preview first: copying and moving need the notes as the preview showed them. Nothing was copied or moved.");
    const changed = chosen.filter((item) => !origins.get(item.id) || input.seen![item.id] !== origins.get(item.id)!.fingerprint);
    if (changed.length) {
      const names = changed.map((item) => `"${item.title}"`).join(", ");
      return refuse(`${names} changed since the preview (another agent or editor wrote ${changed.length === 1 ? "it" : "them"}). Nothing was copied or moved. Preview again to see the new version.`);
    }
  }
  if (input.move) {
    // Refused before anything is written: a Move that cannot remove its originals is a Copy with a false label.
    const blocked = chosen.map((item) => origins.get(item.id)).find((origin) => !origin || origin.unmovable);
    if (blocked !== undefined) return refuse(`These can be copied but not moved: ${blocked?.unmovable ?? "the originals are not known"}. Copy instead.`);
    const same = chosen.map((item) => origins.get(item.id)!).find((origin) => (target.kind === "append" ? origin.path === target.path : origin.sourceId === target.sourceId));
    if (same) return refuse(`That is already in ${target.label}; pick another place to move it to.`);
  }
  const masked = chosen.filter((item) => item.body.includes(MASK_FILL)).length;
  const warnings = masked ? [`${masked} item${masked === 1 ? "" : "s"} still hold hidden (masked) values; the dots were saved as they are.`] : [];
  const reports: WriteReport[] = [];
  const written = new Set<string>();
  /** Notes saved whose line Claude's list couldn't take (kept, never rolled back): said as they are; a Move leaves their originals. */
  const unlisted: string[] = [];

  if (target.kind === "claude-memory") {
    for (const item of chosen) {
      const result = await claudeCreate(
        paseo,
        { sourceId: target.sourceId, ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}), name: item.title, description: descriptionOf(item), type: item.type ?? "project", body: item.body, hook: descriptionOf(item) },
        { allowMasked: true },
      );
      reports.push(...result.reports);
      if (result.ok) written.add(item.id);
      else if (/couldn't update the index/.test(result.message)) unlisted.push(result.message);
      else if (!result.reports.length) reports.push({ target: target.path, ok: false, action: "refused", readBack: "skipped", error: result.message });
    }
  } else {
    if (input.expected === undefined) return refuse("Preview first: the save needs the file as the preview saw it.");
    const stale = staleReason(target.current, input.expected);
    if (stale) return refuse(stale);
    const text = chosen.reduce((acc, item) => appendText(acc, asSection(item)), target.current.text);
    const result = await instructionWrite(paseo, { path: target.path, ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}), text, expected: input.expected }, { allowMasked: true });
    reports.push(...result.reports);
    warnings.push(...result.warnings);
    if (result.ok) for (const item of chosen) written.add(item.id);
    else if (!result.reports.length) return refuse(result.message);
  }

  let moved = 0;
  const leftBehind: string[] = [];
  /** Originals that changed during the move: nothing of theirs was removed, and their copies stay (never deleted). */
  const changedNow: ImportItem[] = [];
  /** Where a version moved aside is kept, when its name was taken before it could go back. */
  const keptAside: string[] = [];
  if (input.move) {
    const done = chosen.filter((item) => written.has(item.id)).map((item) => ({ item, origin: origins.get(item.id)! }));
    for (const { item, origin } of done.filter((entry) => entry.origin.kind === "memory")) {
      // claudeDelete removes it race-free (server/write.ts safeDelete): only if it is still byte for byte what was previewed.
      const result = await claudeDelete(paseo, { sourceId: origin.sourceId, ...(origin.workspaceId ? { workspaceId: origin.workspaceId } : {}), key: origin.key!, expected: origin.stamp! });
      reports.push(...result.reports);
      const kept = result.reports.find((report) => report.keptAt)?.keptAt;
      if (kept) keptAside.push(`"${item.title}": the version found is kept in ${tilde(kept, userHome())}`);
      if (result.ok) moved += 1;
      else if (kept || (await stillThereButChanged(origin))) changedNow.push(item);
      else leftBehind.push(`"${item.title}" (${result.message.replace(/\.$/, "")})`);
    }
    // Sections: every chosen section of one file goes in ONE write, found by its text, removed bottom-up.
    const byFile = new Map<string, Array<{ item: ImportItem; origin: Origin }>>();
    for (const entry of done.filter((candidate) => candidate.origin.kind === "section")) byFile.set(entry.origin.path, [...(byFile.get(entry.origin.path) ?? []), entry]);
    for (const [path, entries] of byFile) {
      // Read again right before the trimmed file is written; the write itself is a compare-and-swap against these bytes (safeWrite: hash, then inode, size and time just before the rename).
      const current = await readCurrent(path);
      const seen = entries[0]!.origin.stamp;
      const sections = current.exists ? splitSections(current.text) : [];
      const at = (origin: Origin) => sections.find((section) => section.key === origin.key && `section:${sha256(sectionText(current.text, section))}` === origin.fingerprint);
      if (!current.exists || !seen || current.stamp?.hash !== seen.hash) {
        // The file changed: where a section is still there as previewed, its copy is taken back; where it's gone, the copy is all that's left, so it stays.
        for (const { item, origin } of entries) {
          if (at(origin)) changedNow.push(item);
          else leftBehind.push(`"${item.title}" (no longer in ${basename(path)} as it was; the copy is kept)`);
        }
        continue;
      }
      const found = entries.map(({ item, origin }) => ({ item, section: at(origin) }));
      for (const { item } of found.filter((entry) => !entry.section)) leftBehind.push(`"${item.title}" (no longer found in ${basename(path)})`);
      const removable = found.filter((entry) => entry.section).sort((a, b) => b.section!.start - a.section!.start);
      if (!removable.length) continue;
      let text = current.text;
      for (const { section } of removable) text = replaceSection(text, section!, "");
      text = text.replace(/\n{3,}/g, "\n\n");
      // The one way files change (server/write.ts swapFile): the file as it is is set aside into `.memories-backup` beside it, verified, then the trimmed one put in place no-replace.
      const result = await instructionWrite(paseo, { path, ...(entries[0]!.origin.workspaceId ? { workspaceId: entries[0]!.origin.workspaceId } : {}), text, expected: current.stamp! });
      reports.push(...result.reports);
      if (result.ok) moved += removable.length;
      else {
        // Refused at the swap: an editor got there first. Nothing was removed; where the section is still there, its copy goes back.
        const after = await readCurrent(path);
        const still = (origin: Origin) => after.exists && splitSections(after.text).some((section) => `section:${sha256(sectionText(after.text, section))}` === origin.fingerprint);
        for (const { item } of removable) {
          const origin = origins.get(item.id)!;
          if (still(origin)) changedNow.push(item);
          else leftBehind.push(`"${item.title}" (${result.message.replace(/\.$/, "")})`);
        }
      }
    }
  }
  // A copy is never deleted or rolled back: when an original changed, both stay, and the message says so.
  const changedWords = [
    ...changedNow.map((item) => `"${item.title}" changed during the move (another agent or editor wrote it), so its original was not removed; it is now in both places`),
    ...keptAside,
  ];
  const ok = reports.length > 0 && reports.every((report) => report.ok) && written.size === chosen.length && leftBehind.length === 0 && changedNow.length === 0;
  logWrite("import-apply", target.path, `${written.size}/${chosen.length} written${input.move ? `, ${moved} moved, ${leftBehind.length} left behind` : ""}`);
  const verb = input.move ? "Moved" : input.from?.length ? "Copied" : "Imported";
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return {
    ok,
    message: unlisted.length
      ? `${unlisted.join(" ")}${written.size ? ` The other ${written.size === 1 ? "item was" : `${written.size} items were`} saved.` : ""}${input.move ? " Nothing was removed from where it came from." : ""}`
      : changedWords.length
      ? `${changedWords.join(". ")}.${leftBehind.length ? ` Also left in both places: ${leftBehind.join("; ")}.` : ""}`
      : leftBehind.length
      ? `Copied ${plural(written.size, "item")} into ${target.label}, but ${plural(leftBehind.length, "original")} could not be removed, so ${leftBehind.length === 1 ? "it is" : "they are"} now in both places: ${leftBehind.join("; ")}.`
      : ok
        ? `${verb} ${plural(written.size, "item")} into ${target.label}.`
        : `${written.size} of ${plural(chosen.length, "item")} saved into ${target.label}; see the report for the rest.`,
    reports,
    warnings,
  };
}

/** An original that is still there but no longer what was previewed (so it changed during the move). */
async function stillThereButChanged(origin: Origin): Promise<boolean> {
  const now = await readCurrent(origin.path);
  return now.exists && fileFingerprint(now) !== origin.fingerprint;
}

// ------------------------------------------------------------------ export

export async function exportMemories(
  paseo: Paseo | null,
  input: { selection: { scope?: string; projectPath?: string; sourceIds?: string[]; entries?: Array<{ sourceId: string; key?: string }> }; format: string; reveal?: string[]; revealAll?: boolean },
) {
  const discovery = await discover(paseo);
  const units = await buildCorpus(discovery);
  const { scope, projectPath, sourceIds, entries } = input.selection;
  const chosen = units.filter((unit) => {
    if (scope && scope !== "all" && unit.scope !== scope) return false;
    if (projectPath && unit.projectPath !== projectPath) return false;
    if (sourceIds?.length && !sourceIds.includes(unit.sourceId)) return false;
    if (entries?.length && !entries.some((entry) => entry.sourceId === unit.sourceId && (entry.key === undefined || entry.key === unit.key))) return false;
    return true;
  });
  const reveal = new Set(input.reveal ?? []);
  let maskedCount = 0;
  const summary = [];
  const items: BundleItem[] = [];
  for (const unit of chosen) {
    const raw = unit.text;
    const secrets = [raw, unit.title, unit.description ?? "", unit.type ?? ""].reduce((sum, text) => sum + findSecrets(text).length, 0);
    const open = input.revealAll || reveal.has(unit.id);
    const hide = (text: string) => (open ? text : maskSecrets(text).text);
    const body = hide(raw);
    const masked = secrets > 0 && !open;
    if (masked) maskedCount += 1;
    summary.push({ id: unit.id, title: maskSecrets(unit.title).text, sourceId: unit.sourceId, secrets, masked });
    items.push({
      agent: unit.agent,
      scope: unit.scope,
      kind: unit.kind,
      ...(unit.projectPath ? { projectHint: unit.projectPath } : {}),
      title: hide(unit.title),
      ...(unit.description !== undefined ? { description: hide(unit.description) } : {}),
      ...(unit.type !== undefined ? { type: hide(unit.type) } : {}),
      body,
      masked,
    });
  }
  const markdown = input.format === "markdown";
  const date = new Date().toISOString().slice(0, 10);
  logWrite("export", "(returned to the app)", `${items.length} items, ${maskedCount} masked`);
  return {
    text: markdown ? renderMarkdown(items) : buildBundle(items, hostname()),
    fileName: `paseo-memories-${date}.${markdown ? "md" : "json"}`,
    count: items.length,
    masked: maskedCount,
    units: summary,
  };
}

type Ctx = PluginHandlerContext;
export const handleImportParse = (input: Parameters<typeof importParse>[0]) => importParse(input);
export const handleImportPreview = (input: Parameters<typeof importPreview>[1], { paseo }: Ctx) => importPreview(paseo, input);
export const handleImportApply = (input: Parameters<typeof importApply>[1], { paseo }: Ctx) => importApply(paseo, input);
export const handleExport = (input: Parameters<typeof exportMemories>[1], { paseo }: Ctx) => exportMemories(paseo, input);
