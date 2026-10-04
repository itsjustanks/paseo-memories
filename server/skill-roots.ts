import { join, resolve } from "node:path";
import type { Account } from "../shared/contracts";
import type { Accounts } from "./accounts";
import { claudeManagedSkillsDir, codexAdminSkillsDir, sharedSkillsDir, userHome } from "./env";
import type { Probe } from "./files";
import { ancestors } from "./git";

/**
 * The folders agents read skills from (docs/SKILLS-SPEC.md "Where skills
 * live"), each with who reads it and whether this plugin may change what is
 * in it. One list for discovery and the writers, so the app is never offered
 * an action the host would refuse (the Memories `writable.ts` rule).
 */

export type RootKind =
  | "shared"
  | "claude-user"
  | "claude-synced"
  | "claude-plugin"
  | "claude-managed"
  | "codex-user"
  | "codex-system"
  | "codex-admin"
  | "pi-user"
  | "project-claude"
  | "project-agents"
  | "project-codex"
  | "project-pi";

export type SkillRoot = {
  kind: RootKind;
  path: string;
  /** Agents that read skills here. */
  agents: string[];
  accountId?: string;
  projectPath?: string;
  /** For plugin roots: the plugin's name, which Claude puts before the skill's (`plugin:name`). */
  plugin?: string;
  /** May this plugin remove skills or add links here? */
  userFolder: boolean;
};

/** Agents that read the shared folder (`~/.agents/skills`) and a project's `.agents/skills` (skills-research/codex-others-install.md). */
export const SHARED_READERS = ["codex", "opencode", "copilot", "gemini", "cursor", "pi"];

/** Roots whose skills this plugin never changes, and why (plain sentences). */
export const READ_ONLY_ROOTS: Partial<Record<RootKind, string>> = {
  "claude-synced": "Synced from your claude.ai account; change it there.",
  "claude-plugin": "Part of a Claude Code plugin; manage it with the plugin.",
  "claude-managed": "Set up by your organisation for every user of this computer.",
  "codex-system": "Built into Codex, which rewrites it when it updates.",
  "codex-admin": "Set up for every user of this computer.",
  "pi-user": "pi's skills are listed here but changed in pi for now.",
  "project-pi": "pi's skills are listed here but changed in pi for now.",
};

type ClaudeSettings = { enabledPlugins?: Record<string, unknown> };
type InstalledPlugins = { plugins?: Record<string, Array<{ scope?: unknown; projectPath?: unknown; installPath?: unknown }>> };

/** Enabled Claude Code plugins of one account: `installed_plugins.json` entries the account's settings turn on. */
async function claudePluginRoots(probe: Probe, account: Account): Promise<SkillRoot[]> {
  const out: SkillRoot[] = [];
  let installed: InstalledPlugins | null = null;
  let settings: ClaudeSettings | null = null;
  try {
    const text = await probe.text(join(account.dir, "plugins", "installed_plugins.json"));
    installed = text ? (JSON.parse(text) as InstalledPlugins) : null;
  } catch {
    installed = null;
  }
  try {
    const text = await probe.text(join(account.dir, "settings.json"));
    settings = text ? (JSON.parse(text) as ClaudeSettings) : null;
  } catch {
    settings = null;
  }
  const enabled = settings?.enabledPlugins ?? {};
  for (const [key, entries] of Object.entries(installed?.plugins ?? {})) {
    if (enabled[key] !== true || !Array.isArray(entries)) continue;
    const plugin = key.split("@")[0] ?? key;
    for (const entry of entries) {
      if (entry?.scope !== "user" || typeof entry.installPath !== "string") continue;
      out.push({ kind: "claude-plugin", path: join(entry.installPath, "skills"), agents: ["claude"], accountId: account.id, plugin, userFolder: false });
    }
  }
  return out;
}

/** Every user-level root on this host, per account. */
export async function userRoots(probe: Probe, accounts: Accounts): Promise<SkillRoot[]> {
  const home = userHome();
  const roots: SkillRoot[] = [{ kind: "shared", path: sharedSkillsDir(), agents: SHARED_READERS, userFolder: true }];
  for (const account of accounts.accounts) {
    if (!account.exists) continue;
    if (account.agent === "claude") {
      // OpenCode also reads the default ~/.claude/skills.
      const agents = account.dir === join(home, ".claude") ? ["claude", "opencode"] : ["claude"];
      roots.push({ kind: "claude-user", path: join(account.dir, "skills"), agents, accountId: account.id, userFolder: true });
      // claude.ai's copies: `skills/synced/<account bucket>/<name>/` (checked on a real machine, 2026-10-04).
      const synced = join(account.dir, "skills", "synced");
      for (const bucket of await probe.list(synced)) {
        if (bucket.isDirectory() && !bucket.name.startsWith(".")) roots.push({ kind: "claude-synced", path: join(synced, bucket.name), agents: ["claude"], accountId: account.id, userFolder: false });
      }
      roots.push(...(await claudePluginRoots(probe, account)));
    } else if (account.agent === "codex") {
      roots.push({ kind: "codex-user", path: join(account.dir, "skills"), agents: ["codex"], accountId: account.id, userFolder: true });
      roots.push({ kind: "codex-system", path: join(account.dir, "skills", ".system"), agents: ["codex"], accountId: account.id, userFolder: false });
    } else if (account.agent === "pi") {
      roots.push({ kind: "pi-user", path: join(account.dir, "skills"), agents: ["pi"], accountId: account.id, userFolder: false });
    }
  }
  roots.push({ kind: "claude-managed", path: claudeManagedSkillsDir(), agents: ["claude"], userFolder: false });
  roots.push({ kind: "codex-admin", path: codexAdminSkillsDir(), agents: ["codex"], userFolder: false });
  return roots;
}

/**
 * The folders from a project's directory up to its repository root (the
 * worktree's own root in a worktree: the first folder up with a `.git` file
 * or folder), never the home folder itself. Outside a repository, only the
 * directory.
 */
export async function projectChain(probe: Probe, directory: string): Promise<string[]> {
  const home = resolve(userHome());
  const up = ancestors(directory).reverse();
  const out: string[] = [];
  for (const folder of up) {
    if (folder === home) break;
    out.push(folder);
    if (await probe.exists(join(folder, ".git"))) return out;
  }
  return [resolve(directory)].filter((folder) => folder !== home);
}

export async function projectRoots(probe: Probe, directory: string): Promise<SkillRoot[]> {
  const roots: SkillRoot[] = [];
  const projectPath = resolve(directory);
  for (const folder of await projectChain(probe, directory)) {
    roots.push({ kind: "project-claude", path: join(folder, ".claude", "skills"), agents: ["claude", "opencode", "copilot"], projectPath, userFolder: false });
    roots.push({ kind: "project-agents", path: join(folder, ".agents", "skills"), agents: SHARED_READERS, projectPath, userFolder: false });
    roots.push({ kind: "project-codex", path: join(folder, ".codex", "skills"), agents: ["codex"], projectPath, userFolder: false });
    roots.push({ kind: "project-pi", path: join(folder, ".pi", "skills"), agents: ["pi"], projectPath, userFolder: false });
  }
  return roots;
}
