import { basename, sep } from "node:path";
import { listDir } from "./files";

/**
 * The one rule for "may this plugin write this file?", by name and place.
 * The write module refuses on it and the inventory marks sources read-only
 * on it, so the app never offers an editor the host would refuse.
 */

const NEVER_UNDER = new Set([".git", ".ssh", ".gnupg", "node_modules"]);
const CODEX_GENERATED = new Set(["raw_memories.md", "phase2_workspace_diff.md"]);
const CODEX_OWNED_DIRS = new Set(["rollout_summaries", "extensions"]);

/** A Codex home: the folder holds Codex's config, sign-in or memory database. */
async function isCodexHome(dir: string): Promise<boolean> {
  return (await listDir(dir)).some((entry) => entry.name === "config.toml" || entry.name === "auth.json" || /^memories_\d+\.sqlite$/.test(entry.name));
}

/** Null when the file may be written; otherwise why not, in a sentence. */
export async function writableReason(path: string): Promise<string | null> {
  const name = basename(path);
  const parts = path.split(sep);
  if (!/\.md$/i.test(name)) return `${name} is not a markdown memory or instruction file, so this plugin will not write it.`;
  if (name.startsWith(".")) return `${name} is a hidden file, so this plugin will not write it.`;
  const blocked = parts.find((part) => NEVER_UNDER.has(part));
  if (blocked) return `${name} is inside a folder this plugin never writes to (${blocked}).`;
  // Codex's own files, only inside a real Codex home: `<home>/memories/…`.
  const at = parts.lastIndexOf("memories");
  if (at > 0) {
    const home = parts.slice(0, at).join(sep) || sep;
    const inside = parts[at + 1];
    const generated = parts.length === at + 2 && CODEX_GENERATED.has(name);
    const owned = inside !== undefined && CODEX_OWNED_DIRS.has(inside) && parts.length > at + 2;
    if ((generated || owned) && (await isCodexHome(home))) {
      return generated ? `Codex rebuilds ${name}; edits there are lost.` : `Codex owns ${inside}/; this plugin never writes there.`;
    }
  }
  return null;
}

/** A source the inventory lists as editable is one the write module accepts: otherwise it is shown read-only with the reason. */
export async function applyWritable<T extends { path: string; access: string; reason?: string; isDirectory?: boolean; kind: string }>(source: T): Promise<T> {
  if (source.access !== "editable" || source.isDirectory || source.kind === "claude-auto-memory" || source.kind === "paseo-prompt" || /^[a-z]+:/.test(source.path)) return source;
  const reason = await writableReason(source.path);
  return reason ? { ...source, access: "read-only", reason } : source;
}
