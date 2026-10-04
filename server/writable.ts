import { basename, dirname, join, resolve, sep } from "node:path";
import { discoverAccounts } from "./accounts";
import { lastKnownLaunch } from "./daemon";
import { sharedSkillsDir, skillLockPath } from "./env";
import { listDir, statSafe } from "./files";

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

/** Paseo marks the skills it installs (and rewrites at every start) with this file. */
export const PASEO_SKILL_MARKER = ".paseo-managed-files.json";

/** Agent folders as of now (accounts read fresh; provider settings as last read from the daemon). */
async function agentDirs(): Promise<{ claude: string[]; codex: string[]; pi: string[] }> {
  const { accounts } = await discoverAccounts(lastKnownLaunch());
  const pick = (agent: string) => accounts.filter((account) => account.agent === agent && account.exists).map((account) => resolve(account.dir));
  return { claude: pick("claude"), codex: pick("codex"), pi: pick("pi") };
}

/**
 * The skills features' extra files, by exact place: `npx skills`' lock file,
 * a Claude account's `settings.json` (`skillOverrides`), and a Codex home's
 * `config.toml` (`[[skills.config]]`). Null when allowed, a reason when it
 * is one of those names somewhere else, undefined when it is none of them.
 */
async function skillConfigReason(path: string): Promise<string | null | undefined> {
  const name = basename(path);
  const full = resolve(path);
  if (name === ".skill-lock.json") return full === resolve(skillLockPath()) ? null : `${name} is only written at npx skills' own place.`;
  if (name === "settings.json" || name === "config.toml") {
    const dirs = await agentDirs();
    const home = dirname(full);
    if (name === "settings.json" && dirs.claude.includes(home)) return null;
    if (name === "config.toml" && dirs.codex.includes(home)) return null;
    return undefined;
  }
  return undefined;
}

/** A skill folder this plugin must not change: Paseo's, claude.ai's or Codex's own. Null when none of those. */
export async function skillFolderReason(folder: string): Promise<string | null> {
  const parts = resolve(folder).split(sep);
  const at = parts.lastIndexOf("skills");
  if (at >= 0 && (parts[at + 1] === "synced" || parts[at + 1] === ".system")) return "That skill is kept by claude.ai or Codex itself; this plugin never changes it.";
  if (await statSafe(join(folder, PASEO_SKILL_MARKER))) return "Paseo manages that skill and rewrites it every time it starts; this plugin never changes it.";
  return null;
}

/**
 * Folders whose direct children are skills this plugin may add, link or move
 * to the backups: the shared folder, and each Claude, Codex and pi account's
 * `skills/`. Never a project's, a plugin's, claude.ai's, Codex's own or a
 * managed one.
 */
export async function skillParentReason(parent: string, purpose: "install" | "link" | "remove"): Promise<string | null> {
  const full = resolve(parent);
  const shared = resolve(sharedSkillsDir());
  const dirs = await agentDirs();
  const claude = dirs.claude.map((dir) => join(dir, "skills"));
  const codex = dirs.codex.map((dir) => join(dir, "skills"));
  const pi = dirs.pi.map((dir) => join(dir, "skills"));
  if (purpose === "install") return full === shared ? null : "Skills are only added to the shared skills folder.";
  if (purpose === "link") return claude.includes(full) || pi.includes(full) ? null : "Links are only made in Claude's and pi's own skills folders.";
  return full === shared || claude.includes(full) || codex.includes(full) || pi.includes(full) ? null : "That isn't in a skills folder of yours, so this plugin won't remove it.";
}

/** Null when the file may be written; otherwise why not, in a sentence. */
export async function writableReason(path: string): Promise<string | null> {
  const name = basename(path);
  const parts = path.split(sep);
  const config = await skillConfigReason(path);
  if (config !== undefined) return config;
  // Inside a skill folder agents read: never Paseo's, claude.ai's or Codex's own.
  const skillsAt = parts.lastIndexOf("skills");
  if (skillsAt >= 0 && skillsAt < parts.length - 1) {
    const folder = parts.slice(0, Math.min(skillsAt + 3, parts.length - 1)).join(sep) || sep;
    const reason = await skillFolderReason(folder);
    if (reason) return reason;
  }
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
