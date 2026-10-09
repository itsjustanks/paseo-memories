import { tilde } from "./agents";
import { folderName } from "./labels";

/**
 * Where a skill or a memory applies, said the same way everywhere (0.6.0):
 * "Everywhere" (your own, in every project) or "This project · <name>" (a
 * project's own, only there). Plus friendly file references, and which copy
 * an agent uses when a skill's name is at both levels. Pure.
 */

export type ScopeKind = "everywhere" | "project";

export const SCOPE_WORDS = {
  everywhere: "Everywhere",
  project: (name: string) => `This project · ${name}`,
  /** One line under a section, saying what it holds. */
  everywhereLead: "Yours: every project gets these.",
  projectLead: "This project's own: only agents working here get these.",
} as const;

/** Project-level only when it lives in a project; your own, managed, plugin and built-in ones apply everywhere. */
export function scopeKind(item: { scope?: string | undefined }): ScopeKind {
  return item.scope === "project" ? "project" : "everywhere";
}

export function scopeLabel(item: { scope?: string | undefined; projectPath?: string | undefined }, projectName: (path: string) => string = folderName): string {
  return scopeKind(item) === "project" && item.projectPath ? SCOPE_WORDS.project(projectName(item.projectPath)) : SCOPE_WORDS.everywhere;
}

/** "From Everywhere → This project · project-hub". */
export function scopeMove(from: string, to: string): string {
  return `From ${from} → ${to}`;
}

/**
 * A file as a person would point at it: "project-hub · .claude/skills/foo"
 * inside a project, "~/.claude/skills/foo" in your home folder, else the
 * path as it is. The full path stays for an expanded detail with Copy.
 */
export function friendlyRef(given: string, where: { home?: string | undefined; projectPath?: string | undefined }, projectName: (path: string) => string = folderName): string {
  // A path already written from home ("~/code/app/CLAUDE.md") is the same place.
  const path = where.home && given.startsWith("~/") ? `${where.home}${given.slice(1)}` : given;
  const project = where.projectPath?.replace(/\/+$/, "");
  if (project && path.startsWith(`${project}/`)) return `${projectName(project)} · ${path.slice(project.length + 1)}`;
  return where.home ? tilde(path, where.home) : path;
}

/**
 * What one agent does with a skill whose name is at more than one level
 * (the exact same name, case and hyphens included):
 *   - Claude Code runs ONE copy: enterprise (managed) over personal over
 *     project (code.claude.com/docs/en/skills, "Resolve skills that share a
 *     name"). The winner is `used`; every other copy is `skipped`, with `by`
 *     naming the level that wins;
 *   - Codex doesn't merge them; every copy is listed (`both`) (Codex docs,
 *     "Build skills").
 * `projects` names the projects involved: for a winning copy, the projects
 * whose own copy it beats; for a project copy, its own project.
 */
export type Level = "managed" | "personal" | "project";
export type Shadow = { agent: string; state: "used" | "skipped" | "both"; projects: string[]; by?: Level; over?: Level };

/** `state[agent] === "off"`: turned off for that agent, so it never runs there and never wins or loses. */
type Shadowable = { id: string; name: string; scope: string; readBy: readonly string[]; projectPath?: string | undefined; state?: Readonly<Record<string, string>> | undefined };

/** A skill's level for Claude's precedence: an organisation's (managed) copy, yours, or a project's. Plugin skills are namespaced (`plugin:name`), so they never clash. */
export function levelOf(skill: { scope?: string | undefined }): Level {
  return skill.scope === "managed" ? "managed" : scopeKind(skill) === "project" ? "project" : "personal";
}

const RANK: Record<Level, number> = { managed: 2, personal: 1, project: 0 };

export function shadowsFor<S extends Shadowable>(skills: readonly S[], projectName: (path: string) => string = folderName): Map<string, Shadow[]> {
  const out = new Map<string, Shadow[]>();
  const byName = new Map<string, S[]>();
  // Exact names, case-sensitive: `deploy-prod` and `deployprod` are two skills, as `/deploy-prod` and `/deployprod` are two commands.
  for (const skill of skills) if (skill.scope !== "plugin") byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill]);
  const names = (list: S[]) => [...new Set(list.map((skill) => (skill.projectPath ? projectName(skill.projectPath) : "")).filter(Boolean))].sort();
  const add = (skill: S, shadow: Shadow) => out.set(skill.id, [...(out.get(skill.id) ?? []), shadow]);
  for (const group of byName.values()) {
    for (const agent of ["claude", "codex"]) {
      // Only copies this agent actually has on: one turned off for it neither runs nor hides another.
      const mine = group.filter((skill) => skill.readBy.includes(agent) && skill.state?.[agent] !== "off");
      const levels = new Set(mine.map(levelOf));
      if (levels.size < 2) continue;
      if (agent === "codex") {
        for (const skill of mine) add(skill, { agent, state: "both", projects: levelOf(skill) === "project" ? names([skill]) : names(mine.filter((other) => levelOf(other) === "project")) });
        continue;
      }
      const top = [...levels].sort((a, b) => RANK[b] - RANK[a])[0]!;
      const beaten = [...levels].filter((level) => level !== top).sort((a, b) => RANK[b] - RANK[a])[0]!;
      for (const skill of mine) {
        const level = levelOf(skill);
        if (level === top) add(skill, { agent, state: "used", projects: names(mine.filter((other) => levelOf(other) === "project")), over: beaten });
        else add(skill, { agent, state: "skipped", projects: level === "project" ? names([skill]) : [], by: top });
      }
    }
  }
  return out;
}

/** One short line for a skill's shadows, or "" when its name is only at one level. */
export function shadowLine(shadows: readonly Shadow[] | undefined, agentName: (agent: string) => string, mine: ScopeKind): string {
  if (!shadows?.length) return "";
  const where = (shadow: Shadow) => (shadow.projects.length ? shadow.projects.join(", ") : "a project");
  const parts = shadows.map((shadow) => {
    const agent = agentName(shadow.agent);
    if (shadow.state === "used") return shadow.over === "personal" ? `${agent} uses this copy over your own of the same name` : `In ${where(shadow)}, ${agent} uses this copy, not the project's own`;
    if (shadow.state === "skipped") return shadow.by === "managed" ? `${agent} uses your organisation's copy of this name instead` : `${agent} uses your Everywhere copy of this name instead`;
    return mine === "everywhere" ? (shadow.projects.length ? `In ${where(shadow)}, ${agent} lists both copies` : `${agent} lists every copy of this name`) : `${agent} lists both this and your Everywhere copy`;
  });
  return `${parts.join(". ")}.`;
}
