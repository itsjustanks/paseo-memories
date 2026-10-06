import { AGENT_LABELS } from "./agents";
import type { Account, Source } from "./contracts";
import { folderName } from "./labels";
import { isCodexInternal, plainAgent } from "./plain";

/**
 * How Memories groups and counts notes (0.5.1), in one place, so the
 * Overview and the Everywhere and Projects tabs always agree: the Overview's
 * "Everywhere: 4 notes" is the sum of the badges on Everywhere, and its
 * "In your projects: 312 notes in 40 projects" is the sum on Projects.
 * Pure: no React, so the tests read it directly.
 *
 * Everywhere groups by agent and account; Projects puts Paseo's workspaces
 * first, then other known folders, then Claude notes for projects whose
 * folder isn't on this computer. Two projects with the same name get their
 * parent folder added ("acme-web (in work)"). Projects with no notes
 * fold behind "Show empty".
 */

export type SourceGroup = { key: string; title: string; icon: string; caption?: string; path?: string; sources: Source[] };

type Workspace = { name: string; path: string };

function accountTitle(account: Account | undefined, agent: string): string {
  const name = AGENT_LABELS[agent] ?? agent;
  if (!account) return name;
  return account.email ? `${name} · ${account.email}` : `${name} · ${account.label}`;
}

function plainAccountTitle(account: Account | undefined, agent: string): string {
  const name = plainAgent(agent);
  return account && account.origin !== "default" ? `${name} · ${account.email ?? account.label}` : name;
}

/** The sources a list shows: plain mode leaves out Codex's own working files. */
export function listedSources(sources: readonly Source[], plain: boolean): Source[] {
  return plain ? sources.filter((source) => !isCodexInternal(source)) : [...sources];
}

/** How many notes a source holds: a folder counts its files, a file counts once, a file not written yet counts none. */
export function noteCount(source: Pick<Source, "exists" | "isDirectory" | "files">): number {
  if (!source.exists) return 0;
  return source.isDirectory ? (source.files ?? 0) : 1;
}

export function notesIn(sources: ReadonlyArray<Pick<Source, "exists" | "isDirectory" | "files">>): number {
  return sources.reduce((sum, source) => sum + noteCount(source), 0);
}

export function userGroups(sources: readonly Source[], accounts: readonly Account[], plain = false): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const source of sources) {
    if (source.scope !== "user" && source.scope !== "managed" && source.scope !== "host") continue;
    const account = accounts.find((entry) => entry.id === source.accountId);
    const key = source.scope === "managed" ? "managed" : source.scope === "host" ? "host" : (source.accountId ?? source.agent);
    const title = plain
      ? source.scope === "managed" ? "Set by your organisation" : source.scope === "host" ? "Every agent on this computer" : plainAccountTitle(account, source.agent)
      : source.scope === "managed" ? "Managed by your organisation" : source.scope === "host" ? "Paseo (every agent on this host)" : accountTitle(account, source.agent);
    const icon = source.scope === "managed" ? "Building2" : source.scope === "host" ? "Monitor" : "Bot";
    const group = groups.get(key) ?? { key, title, icon, ...(account && !plain ? { path: account.dir } : {}), sources: [] };
    group.sources.push(source);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * A project's name, the same in every view (group headings and note names):
 * a Paseo workspace's own folder takes the workspace's name, the home folder
 * is "Your home folder", anything else keeps its own folder name. (0.5.0 gave
 * a folder inside or around a workspace the workspace's name, which made
 * several "acme-web"s.)
 */
export function projectTitle(path: string, workspaces: readonly Workspace[], home = ""): string {
  const workspace = workspaces.find((entry) => entry.path === path);
  if (workspace?.name) return workspace.name;
  if (home && path.replace(/\/+$/, "") === home.replace(/\/+$/, "")) return "Your home folder";
  return folderName(path);
}

export function projectGroups(sources: readonly Source[], workspaces: readonly Workspace[], plain = false, home = ""): SourceGroup[] {
  const groups = new Map<string, SourceGroup & { rank: number; projectPath?: string }>();
  for (const source of sources) {
    if (source.scope !== "project") continue;
    const path = source.projectPath;
    const key = path ?? "unknown";
    const workspace = path ? workspaces.find((entry) => entry.path === path || path.startsWith(`${entry.path}/`) || entry.path.startsWith(`${path}/`)) : undefined;
    const rank = workspace ? 0 : path ? 1 : 2;
    const unknown = plain
      ? { title: "Projects not found on this computer", caption: "Claude kept notes for these, but their project folders aren't here." }
      : { title: "Other projects (path unknown)", caption: "Claude keeps these by a folder name that cannot be turned back into a path." };
    const title = path ? projectTitle(path, workspaces, home) : unknown.title;
    const group = groups.get(key) ?? { key, rank, title, icon: path ? "FolderCode" : "FolderSearch", ...(path ? { projectPath: path, ...(plain ? {} : { path }) } : { caption: unknown.caption }), sources: [] };
    group.rank = Math.min(group.rank, rank);
    group.sources.push(source);
    groups.set(key, group);
  }
  const list = disambiguate([...groups.values()]);
  return list.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title)).map(({ rank: _rank, projectPath: _path, ...group }) => group);
}

/**
 * Projects that share a name get their parent folder added: "acme-web (in
 * work)" and "acme-web (in archive)". If the parents share a name too,
 * more of the path is added until they differ.
 */
export function disambiguate<G extends { title: string; projectPath?: string }>(groups: G[]): G[] {
  const byTitle = new Map<string, G[]>();
  for (const group of groups) if (group.projectPath) byTitle.set(group.title, [...(byTitle.get(group.title) ?? []), group]);
  for (const [title, same] of byTitle) {
    if (same.length < 2) continue;
    const parts = same.map((group) => group.projectPath!.split("/").filter(Boolean));
    // The fewest trailing parent folders that tell them all apart (at most the whole path).
    const longest = Math.max(...parts.map((segments) => segments.length));
    for (let depth = 1; depth <= longest; depth += 1) {
      const labels = parts.map((segments) => segments.slice(Math.max(0, segments.length - 1 - depth), segments.length - 1).join("/") || "/");
      if (new Set(labels).size === labels.length || depth === longest) {
        same.forEach((group, index) => {
          group.title = `${title} (in ${labels[index]})`;
        });
        break;
      }
    }
  }
  return groups;
}

/** The groups with notes, and the empty ones ("0 notes": worktrees, projects Claude never wrote for) to fold away. The open one always shows. */
export function splitEmpty<G extends { sources: Source[] }>(groups: readonly G[], keep: string | null = null): { shown: G[]; empty: G[] } {
  const shown: G[] = [];
  const empty: G[] = [];
  for (const group of groups) (notesIn(group.sources) > 0 || group.sources.some((source) => source.id === keep) ? shown : empty).push(group);
  return { shown, empty };
}

/**
 * The Overview's two counts, from the same groups the tabs show: notes
 * followed everywhere (and how much an agent reads of them at the start of
 * every chat), and notes in projects (and in how many projects).
 */
export function placeCounts(sources: readonly Source[], accounts: readonly Account[], workspaces: readonly Workspace[], plain: boolean): { everywhere: { notes: number; tokens: number; agents: string[] }; projects: { notes: number; projects: number } } {
  const listed = listedSources(sources, plain);
  const user = userGroups(listed, accounts, plain).flatMap((group) => group.sources);
  const projects = projectGroups(listed, workspaces, plain);
  return {
    everywhere: { notes: notesIn(user), tokens: user.reduce((sum, source) => sum + source.loaded.tokens, 0), agents: [...new Set(user.filter((source) => noteCount(source) > 0 && source.scope === "user").map((source) => source.agent))] },
    projects: { notes: projects.reduce((sum, group) => sum + notesIn(group.sources), 0), projects: projects.filter((group) => group.key !== "unknown" && notesIn(group.sources) > 0).length },
  };
}
