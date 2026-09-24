import { basename, join } from "node:path";
import type { Source } from "../shared/contracts";
import { parseMemoryFile, readFields } from "../shared/frontmatter";
import { sectionText, splitSections } from "../shared/markdown";
import type { Unit } from "../shared/tidy";
import type { Discovery } from "./discover";
import { Probe } from "./files";

/**
 * Everything the tidy checks, search and export look at, as units: one per
 * Claude memory file, one per section of an instruction file or Codex
 * memory. Text comes through the stat-keyed cache; generated Codex files,
 * the sqlite and anything over 1 MB are left out.
 */

export const TEXT_KINDS = new Set(["claude-md", "claude-local", "claude-rule", "claude-import", "claude-managed", "agents-md", "codex-memory", "opencode-md", "pi-md", "omp-md", "copilot-md"]);
const MAX_UNIT_FILE = 1024 * 1024;

/** A section's text without its heading line. */
export function sectionBody(text: string): string {
  const body = text.replace(/^\s{0,3}#{1,6}\s[^\n]*\n?/, "").replace(/^\n+/, "");
  return body.endsWith("\n") || body === "" ? body : `${body}\n`;
}

function unitId(sourceId: string, key: string): string {
  return `${sourceId}#${key}`;
}

export async function memoryFolderUnits(probe: Probe, source: Source): Promise<Unit[]> {
  const out: Unit[] = [];
  for (const entry of await probe.list(source.path)) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "MEMORY.md" || entry.name.startsWith(".")) continue;
    const path = join(source.path, entry.name);
    const stat = await probe.stat(path);
    if (!stat || stat.size > MAX_UNIT_FILE) continue;
    const text = await probe.text(path);
    if (text === null) continue;
    const file = parseMemoryFile(text);
    const fields = readFields(file);
    out.push({
      id: unitId(source.id, entry.name),
      sourceId: source.id,
      key: entry.name,
      title: fields.name ?? entry.name.replace(/\.md$/, ""),
      text: file.body,
      agent: source.agent,
      scope: source.scope,
      kind: source.kind,
      path,
      ...(source.projectPath ? { projectPath: source.projectPath } : {}),
      ...(fields.description !== undefined ? { description: fields.description } : {}),
      ...(fields.type !== undefined ? { type: fields.type } : {}),
    });
  }
  return out;
}

export async function fileUnits(probe: Probe, source: Source): Promise<Unit[]> {
  const stat = await probe.stat(source.path);
  if (!stat?.isFile || stat.size > MAX_UNIT_FILE) return [];
  const text = await probe.text(source.path);
  if (!text) return [];
  return splitSections(text).map((section) => ({
    id: unitId(source.id, section.key),
    sourceId: source.id,
    key: section.key,
    title: section.key === "0:" ? basename(source.path) : section.title,
    // The heading is the title; the text is what is under it.
    text: section.key === "0:" ? sectionText(text, section) : sectionBody(sectionText(text, section)),
    agent: source.agent,
    scope: source.scope,
    kind: source.kind,
    path: source.path,
    ...(source.projectPath ? { projectPath: source.projectPath } : {}),
  }));
}

export async function unitsFor(probe: Probe, source: Source): Promise<Unit[]> {
  if (!source.exists) return [];
  if (source.kind === "claude-auto-memory") return memoryFolderUnits(probe, source);
  if (TEXT_KINDS.has(source.kind) && !source.isDirectory) return fileUnits(probe, source);
  return [];
}

export async function buildCorpus(discovery: Discovery, probe = new Probe()): Promise<Unit[]> {
  const units: Unit[] = [];
  for (const source of discovery.sources) units.push(...(await unitsFor(probe, source)));
  return units;
}
