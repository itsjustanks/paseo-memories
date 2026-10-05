import { basename, join } from "node:path";
import type { Source } from "../shared/contracts";
import { parseMemoryFile, readFields } from "../shared/frontmatter";
import { sectionText, splitSections } from "../shared/markdown";
import { textFeatures, type TextFeatures, type Unit } from "../shared/tidy";
import type { Discovery } from "./discover";
import { Probe, type Stat } from "./files";

/**
 * Everything the tidy checks, search and export look at, as units: one per
 * Claude memory file, one per section of an instruction file or Codex
 * memory. Generated Codex files, the sqlite and anything over 1 MB are left
 * out.
 *
 * Each file is read and split once per version (size, mtime, inode): the
 * units are kept with the file's stamp and reused while it is unchanged, and
 * so are their duplicate-check features (`featuresOf`). A build of the whole
 * corpus forgets files it no longer sees; at most CORPUS_CACHE_LIMITS files
 * and bytes (of file text) are kept, the least recently used dropped first.
 * Units are shared between callers: treat them as read-only.
 */

export const TEXT_KINDS = new Set(["claude-md", "claude-local", "claude-rule", "claude-import", "claude-managed", "agents-md", "codex-memory", "opencode-md", "pi-md", "omp-md", "copilot-md"]);
const MAX_UNIT_FILE = 1024 * 1024;
export const CORPUS_CACHE_LIMITS = { files: 20_000, bytes: 64 * 1024 * 1024 };

type FileEntry = { stamp: string; meta: string; units: Unit[]; bytes: number };
const files = new Map<string, FileEntry>();
let cachedBytes = 0;

function keep(path: string, entry: FileEntry): void {
  drop(path);
  files.set(path, entry);
  cachedBytes += entry.bytes;
  trim();
}

function trim(): void {
  while (files.size > CORPUS_CACHE_LIMITS.files || cachedBytes > CORPUS_CACHE_LIMITS.bytes) {
    const oldest = files.keys().next().value;
    if (oldest === undefined) break;
    drop(oldest);
  }
}

function drop(path: string): void {
  const hit = files.get(path);
  if (!hit) return;
  cachedBytes -= hit.bytes;
  files.delete(path);
}
const features = new WeakMap<Unit, TextFeatures>();

/** A unit's duplicate-check features, worked out once per unit (so once per file version). */
export function featuresOf(unit: Unit): TextFeatures {
  let hit = features.get(unit);
  if (!hit) features.set(unit, (hit = textFeatures(unit.text)));
  return hit;
}

function stampOf(stat: Stat): string {
  return `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
}

/** The units of one file for this source, from the cache while the file is unchanged. */
async function cached(probe: Probe, path: string, stat: Stat, meta: string, build: (text: string) => Unit[]): Promise<Unit[] | null> {
  const stamp = stampOf(stat);
  const hit = files.get(path);
  if (hit && hit.stamp === stamp && hit.meta === meta) {
    // Most recently used last, so the cap drops the oldest.
    files.delete(path);
    files.set(path, hit);
    trim();
    return hit.units;
  }
  const text = await probe.text(path);
  if (text === null) {
    drop(path);
    return null;
  }
  const units = build(text);
  keep(path, { stamp, meta, units, bytes: text.length });
  return units;
}

function metaOf(source: Source): string {
  return JSON.stringify([source.id, source.agent, source.scope, source.kind, source.projectPath ?? ""]);
}

/** For tests and diagnostics. */
export function corpusCacheSize(): { files: number; bytes: number } {
  return { files: files.size, bytes: cachedBytes };
}

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
  const meta = metaOf(source);
  for (const entry of await probe.list(source.path)) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "MEMORY.md" || entry.name.startsWith(".")) continue;
    const path = join(source.path, entry.name);
    const stat = await probe.stat(path);
    if (!stat || stat.size > MAX_UNIT_FILE) continue;
    const units = await cached(probe, path, stat, meta, (text) => {
      const file = parseMemoryFile(text);
      const fields = readFields(file);
      return [
        {
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
        },
      ];
    });
    if (units) out.push(...units);
  }
  return out;
}

export async function fileUnits(probe: Probe, source: Source): Promise<Unit[]> {
  const stat = await probe.stat(source.path);
  if (!stat?.isFile || stat.size > MAX_UNIT_FILE) return [];
  const units = await cached(probe, source.path, stat, metaOf(source), (text) =>
    text
      ? splitSections(text).map((section) => ({
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
        }))
      : [],
  );
  return units ?? [];
}

export async function unitsFor(probe: Probe, source: Source): Promise<Unit[]> {
  if (!source.exists) return [];
  if (source.kind === "claude-auto-memory") return memoryFolderUnits(probe, source);
  if (TEXT_KINDS.has(source.kind) && !source.isDirectory) return fileUnits(probe, source);
  return [];
}

export async function buildCorpus(discovery: Discovery, probe = new Probe()): Promise<Unit[]> {
  const units: Unit[] = [];
  const live = new Set<string>();
  for (const source of discovery.sources) {
    for (const unit of await unitsFor(probe, source)) {
      units.push(unit);
      live.add(unit.path);
    }
  }
  // Files no longer in the inventory (or now empty) are forgotten.
  for (const path of [...files.keys()]) if (!live.has(path)) drop(path);
  return units;
}
