import type { LoadItem, LoadPlan } from "../shared/contracts";
import { PLAIN, isCodexInternal, plainAgent, plainPlanItemName } from "../shared/plain";
import { friendlyRef, scopeKind, type ScopeKind, type Shadow } from "../shared/scope";
import { folderName } from "../shared/labels";

/**
 * What an agent here loads, by where it applies (0.6.0): this project's own
 * first, then what every project gets. Each item once, with every agent that
 * reads it and its file as a person would point at it. Pure (no
 * react-native), so the panels' grouping is tested.
 */

export type ScopedItem = {
  key: string;
  scope: ScopeKind;
  name: string;
  /** Agents that read it (at the start or when needed), in plan order. */
  agents: string[];
  /** Agents whose plan has it but skips it ("Claude skips it": a project CLAUDE.md wins over AGENTS.md). */
  skippedBy: string[];
  /** A file from a folder above the project (Claude reads every parent folder's): inherited, not the project's own. */
  inherited: boolean;
  /** "acme-web · CLAUDE.md", "~/.claude/CLAUDE.md". */
  where: string;
  path?: string;
  /** launch | on-demand | skipped */
  when: string;
  tokens: number;
  truncated: boolean;
  /** The first plan's item, to open it in Memories. */
  item: LoadItem;
};

export type PanelSkillView = { skillId: string; name: string; scope: string; projectPath?: string | undefined; where?: string | undefined; path?: string | undefined; provenance: string; state: string; shadows?: Shadow[] | undefined };
export type ScopedSkill = { skill: PanelSkillView; scope: ScopeKind; agents: string[]; shadows: Shadow[] };

/** Plan items an agent reads (not missing); in plain mode without Codex's working files and Copilot's store, as before. */
function shown(item: LoadItem, plain: boolean): boolean {
  if (item.when === "missing") return false;
  return !plain || (!isCodexInternal(item) && item.kind !== "copilot-memory");
}

export function scopedItems(plans: readonly LoadPlan[], options: { home?: string | undefined; directory: string; projectRoot?: string | undefined; plain: boolean; projectName?: (path: string) => string }): Record<ScopeKind, ScopedItem[]> {
  const projectName = options.projectName ?? folderName;
  const root = (options.projectRoot ?? options.directory).replace(/\/+$/, "");
  const byKey = new Map<string, ScopedItem & { states: Map<string, string> }>();
  // One file is one row, however a plan writes its path ("~/…" or in full, or only in its label).
  const pathOf = (item: LoadItem): string | undefined => {
    const given = item.path ?? (/^[~/]/.test(item.label) ? item.label : undefined);
    return given && options.home && given.startsWith("~/") ? `${options.home}${given.slice(1)}` : given;
  };
  const inside = (path: string | undefined) => Boolean(path && (path === root || path.startsWith(`${root}/`)));
  for (const plan of plans) {
    for (const item of plan.items) {
      if (!shown(item, options.plain)) continue;
      const path = pathOf(item);
      const key = path ?? `${item.kind}:${item.label}`;
      const known = byKey.get(key);
      if (known) {
        // Per agent: the strongest way it reads the file (at the start, when needed, or skipped).
        const was = known.states.get(plan.agent);
        if (!was || was === "skipped" || (was === "on-demand" && item.when === "launch")) known.states.set(plan.agent, item.when);
        if (item.when !== "skipped") {
          known.tokens = Math.max(known.tokens, item.tokens);
          known.truncated ||= item.truncated;
        }
        continue;
      }
      // A plan that doesn't say goes by the folder: inside this project is this project's.
      const declared: ScopeKind = item.scope ? scopeKind(item) : inside(path) ? "project" : "everywhere";
      // Claude reads every parent folder's instructions; those above the project are inherited, not its own (its notes folder stays its own).
      const inherited = declared === "project" && Boolean(path) && !inside(path) && item.kind !== "claude-auto-memory";
      const scope: ScopeKind = inherited ? "everywhere" : declared;
      byKey.set(key, {
        key,
        scope,
        name: options.plain ? plainPlanItemName(item, plan.agent, options.directory) : item.label,
        agents: [],
        skippedBy: [],
        inherited,
        where: path ? friendlyRef(path, { home: options.home, ...(scope === "project" ? { projectPath: root } : {}) }, projectName) : item.label,
        ...(path ? { path } : {}),
        when: item.when,
        tokens: item.when === "skipped" ? 0 : item.tokens,
        truncated: item.when !== "skipped" && item.truncated,
        item,
        states: new Map([[plan.agent, item.when]]),
      });
    }
  }
  const rank = (when: string) => (when === "launch" ? 2 : when === "on-demand" ? 1 : 0);
  const all: ScopedItem[] = [...byKey.values()].map(({ states, ...entry }) => {
    const readers = [...states].filter(([, when]) => when !== "skipped");
    const best = readers.reduce((top, [, when]) => (rank(when) > rank(top) ? when : top), "skipped");
    return { ...entry, agents: readers.map(([agent]) => agent), skippedBy: [...states].filter(([, when]) => when === "skipped").map(([agent]) => agent), when: best };
  });
  return { project: all.filter((entry) => entry.scope === "project"), everywhere: all.filter((entry) => entry.scope === "everywhere") };
}

export function scopedSkills(agents: ReadonlyArray<{ agent: string; skills: readonly PanelSkillView[] }>): Record<ScopeKind, ScopedSkill[]> {
  const byId = new Map<string, ScopedSkill>();
  for (const { agent, skills } of agents) {
    for (const skill of skills) {
      const known = byId.get(skill.skillId);
      const shadows = skill.shadows ?? [];
      if (known) {
        if (!known.agents.includes(agent)) known.agents.push(agent);
        for (const shadow of shadows) if (!known.shadows.some((other) => other.agent === shadow.agent)) known.shadows.push(shadow);
        continue;
      }
      byId.set(skill.skillId, { skill, scope: scopeKind(skill), agents: [agent], shadows: [...shadows] });
    }
  }
  // Shadowed names first, so the copy that matters is seen; then by name.
  const sorted = [...byId.values()].sort((a, b) => Number(b.shadows.length > 0) - Number(a.shadows.length > 0) || a.skill.name.localeCompare(b.skill.name));
  return { project: sorted.filter((entry) => entry.scope === "project"), everywhere: sorted.filter((entry) => entry.scope === "everywhere") };
}

/**
 * Which group the Skills list puts a skill under (0.6.0: by where it
 * applies): "everywhere" (yours, every project gets it), "project:<path>"
 * (that project's own), or "other" (looked after elsewhere: Paseo's,
 * plugins', claude.ai's, built-in).
 */
export function groupOf(skill: { access: string; scope: string; projectPath?: string | undefined }): string {
  if (skill.access === "read-only") return "other";
  if (scopeKind(skill) === "project" && skill.projectPath) return `project:${skill.projectPath}`;
  return "everywhere";
}

/** "Claude and Codex", "Claude": who reads it. */
export function readers(agents: readonly string[]): string {
  const names = agents.map(plainAgent);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export const PANEL_WORDS = {
  notes: "Notes and instructions",
  skills: "Skills",
  nothingProject: "Nothing of this project's own yet: agents here get only what every project gets.",
  nothingEverywhere: "Nothing of your own that every project gets.",
  inheritedLead: "What agents here also get: yours, and any parent folder's.",
  fromParent: "From a parent folder",
  skips: (agents: string) => `${agents} skips it`,
  loadOrder: "In load order, per agent",
  loadOrderSummary: "Each agent's list, in the order it reads, with sizes",
  open: PLAIN.panel.open,
} as const;
