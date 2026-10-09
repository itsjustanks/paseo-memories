import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { FindingSchema, NextStepSchema, WriteResultSchema } from "./contracts";

/**
 * Skills RPCs (0.4.0). Additive, like the Memories contracts: new fields are
 * optional or defaulted, categorical output fields are plain strings with
 * their known values listed here, and nothing is renamed. Ids are opaque to
 * the app: it sends back what it was given, never a path it made itself.
 */

/** Known `Skill.provenance` values. */
export const SKILL_PROVENANCE = [
  "paseo", // a `.paseo-managed-files.json` marker: Paseo rewrites it at daemon start
  "npx-skills", // an entry in `npx skills`' lock file
  "added-here", // added by this plugin
  "claude-plugin", // inside an enabled Claude Code plugin
  "claude-ai", // synced from claude.ai (`<cfg>/skills/synced/`)
  "codex-builtin", // Codex's own (`$CODEX_HOME/skills/.system`)
  "managed", // Claude's managed folder or Codex's `/etc/codex/skills`
  "by-hand", // anything else in a user or shared folder
  "project", // in a project's folder
] as const;

/** Known `SkillLocation.root` values. */
export const SKILL_ROOTS = ["shared", "claude-user", "claude-synced", "claude-plugin", "claude-managed", "codex-user", "codex-system", "codex-admin", "pi-user", "project-claude", "project-agents", "project-codex", "project-pi"] as const;

/** Known finding kinds (`Finding.kind`) for skills. */
export const SKILL_FINDING_KINDS = ["broken-link", "empty-folder", "stray-file", "invalid", "duplicate", "unused", "over-budget", "paseo-orphan", "lock-missing"] as const;

export const SkillLocationSchema = z.object({
  /** Where an agent finds it: the folder entry itself (a link when `link`). */
  path: z.string(),
  root: z.string(),
  link: z.boolean().default(false),
  accountId: z.string().optional(),
  projectPath: z.string().optional(),
});
export type SkillLocation = z.infer<typeof SkillLocationSchema>;

export const SkillProblemSchema = z.object({ code: z.string(), severity: z.string(), message: z.string() });

export const SkillSchema = z.object({
  /** Opaque: stable across reads while the skill's folder stays where it is. */
  id: z.string(),
  name: z.string(),
  /** The folder's name (what `npx skills` and Codex key on). */
  folder: z.string(),
  description: z.string().default(""),
  whenToUse: z.string().optional(),
  /** The folder with links followed. */
  path: z.string(),
  locations: z.array(SkillLocationSchema),
  provenance: z.string(),
  /** "obra/superpowers", a plugin's name, … */
  provenanceDetail: z.string().optional(),
  /** user | project | managed | plugin */
  scope: z.string(),
  projectPath: z.string().optional(),
  readBy: z.array(z.string()).default([]),
  access: z.enum(["editable", "read-only"]),
  reason: z.string().optional(),
  files: z.number(),
  bytes: z.number(),
  /** Files an agent might run (anything but instructions and text), counting a SKILL.md whose header or body runs commands. */
  scripts: z.number().default(0),
  /** Why its SKILL.md can run commands on this computer, when it can. */
  runsCommands: z.string().optional(),
  problems: z.array(SkillProblemSchema).default([]),
  /** False when its SKILL.md says `user-invocable: false`: Claude then keeps it out of the "/" menu. */
  userInvocable: z.boolean().optional(),
  /** Characters this skill adds to each agent's skill list, at the start of every chat. */
  listing: z.object({ claude: z.number(), codex: z.number() }),
  /** Per agent: on | off | name-only | user-invocable-only | model-off | mixed (some accounts off). */
  state: z.record(z.string(), z.string()).default({}),
  versionControlled: z.boolean().optional(),
  can: z.object({
    turnOff: z.array(z.string()).default([]),
    turnOffReason: z.string().optional(),
    remove: z.boolean().default(false),
    removeReason: z.string().optional(),
    /** Added here but missing from a Claude account's skills: "Link it for Claude" makes the missing links. */
    link: z.boolean().default(false),
  }),
  usage: z.object({ total: z.number(), lastUsed: z.string(), estimated: z.boolean() }).optional(),
});
export type Skill = z.infer<typeof SkillSchema>;

export const ListingCostSchema = z.object({
  agent: z.string(),
  accountId: z.string().optional(),
  label: z.string(),
  skills: z.number(),
  chars: z.number(),
  tokens: z.number(),
  /** What the agent keeps whole; 0 when the model (so the window) isn't known. */
  budgetChars: z.number(),
  /** Only when the budget is known and the list is over it: a guess never raises a warning. */
  overBudget: z.boolean(),
  budgetKnown: z.boolean().default(false),
  /** The model the budget was worked out for, when known. */
  model: z.string().optional(),
  note: z.string().default(""),
});
export type ListingCost = z.infer<typeof ListingCostSchema>;

export const UsageStateSchema = z.object({
  /** off | waiting | checking | ready */
  state: z.string(),
  asOf: z.string().optional(),
  complete: z.boolean().default(false),
  files: z.object({ claude: z.number(), codex: z.number() }).default({ claude: 0, codex: 0 }),
  note: z.string().default(""),
});

export const skillsInventory = defineRpc({
  name: "paseo-memories.skills-inventory",
  input: z.object({ refresh: z.boolean().optional() }),
  output: z.object({
    checkedAt: z.string(),
    skills: z.array(SkillSchema),
    costs: z.array(ListingCostSchema).default([]),
    findings: z.array(FindingSchema).default([]),
    nextStep: NextStepSchema.optional(),
    usage: UsageStateSchema,
    /** The days "used lately" counts over (the skillsWindowDays setting). */
    windowDays: z.number().default(30),
    /** The host's home folder, so the app can name places plainly ("Claude's settings (default)"). */
    home: z.string().default(""),
    counts: z.object({ skills: z.number(), places: z.number(), projects: z.number(), accounts: z.number() }),
    checked: z.array(z.string()).default([]),
    notes: z.array(z.string()).default([]),
  }),
});

export const skillDetail = defineRpc({
  name: "paseo-memories.skills-detail",
  input: z.object({ skillId: z.string(), reveal: z.boolean().optional() }),
  output: z.object({
    skill: SkillSchema,
    /** SKILL.md as text, secrets masked unless revealed; cut at 200 KB. */
    body: z.string(),
    truncated: z.boolean().default(false),
    fileList: z.array(z.object({ path: z.string(), bytes: z.number(), kind: z.string(), executable: z.boolean() })).default([]),
    lock: z.object({ source: z.string(), sourceType: z.string(), ref: z.string().optional(), installedAt: z.string().optional(), updatedAt: z.string().optional() }).optional(),
    warnings: z.array(z.string()).default([]),
  }),
});

export const UsageRowSchema = z.object({
  name: z.string(),
  total: z.number(),
  claude: z.number(),
  codex: z.number(),
  typed: z.number(),
  helpers: z.number(),
  perDay: z.array(z.number()),
  projects: z.array(z.object({ path: z.string(), count: z.number() })),
  lastUsed: z.string(),
  chats: z.number(),
  installed: z.boolean(),
  skillId: z.string().optional(),
});

export const skillsUsage = defineRpc({
  name: "paseo-memories.skills-usage",
  input: z.object({ days: z.number().int().min(1).max(90).optional(), refresh: z.boolean().optional() }),
  output: z.object({
    days: z.number(),
    firstDay: z.string(),
    lastDay: z.string(),
    rows: z.array(UsageRowSchema),
    totals: z.object({ uses: z.number(), claude: z.number(), codex: z.number(), typed: z.number() }),
    neverUsed: z.array(z.object({ name: z.string(), skillId: z.string(), listingChars: z.number() })).default([]),
    state: UsageStateSchema,
    notes: z.array(z.string()).default([]),
  }),
});

/** How "used in this chat" was decided: exact (the agent's own chat id) | folder-time (same folder, since it started) | unknown. */
export const ChatUsageSchema = z.object({ match: z.string(), skills: z.array(z.object({ name: z.string(), count: z.number(), skillId: z.string().optional() })), note: z.string().default("") });

/** What one agent does with a skill whose name is at both levels (shared/scope.ts). */
export const ShadowSchema = z.object({ agent: z.string(), state: z.enum(["used", "skipped", "both"]), projects: z.array(z.string()).default([]), by: z.enum(["managed", "personal", "project"]).optional(), over: z.enum(["managed", "personal", "project"]).optional() });

export const PanelSkillSchema = z.object({
  skillId: z.string(),
  name: z.string(),
  description: z.string().default(""),
  provenance: z.string(),
  scope: z.string(),
  listingChars: z.number(),
  state: z.string().default("on"),
  /** 0.6.0: the project it belongs to (project skills), its folder as a person would point at it, and the full path for the expanded detail. */
  projectPath: z.string().optional(),
  where: z.string().optional(),
  path: z.string().optional(),
  /** Its name is also at the other level: which copy this agent uses. */
  shadows: z.array(ShadowSchema).default([]),
});

export const skillsAgent = defineRpc({
  name: "paseo-memories.skills-agent",
  input: z.object({ workspaceId: z.string(), providerId: z.string(), agentId: z.string().optional() }),
  output: z.object({
    agent: z.string(),
    directory: z.string(),
    skills: z.array(PanelSkillSchema),
    cost: ListingCostSchema.optional(),
    chat: ChatUsageSchema,
    notes: z.array(z.string()).default([]),
  }),
});

export const skillsWorkspace = defineRpc({
  name: "paseo-memories.skills-workspace",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({
    directory: z.string(),
    agents: z.array(z.object({ agent: z.string(), skills: z.array(PanelSkillSchema), cost: ListingCostSchema.optional() })),
    /** Skills used in chats started in this folder, over the usage window. */
    used: z.array(z.object({ name: z.string(), count: z.number(), skillId: z.string().optional() })).default([]),
    notes: z.array(z.string()).default([]),
  }),
});

// ------------------------------------------------------------------ add

export const CatalogCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  blurb: z.string(),
  publisher: z.string(),
  source: z.string(),
  commit: z.string(),
  license: z.string(),
  files: z.number(),
  scripts: z.boolean(),
  /** The same name in any spelling is already here. */
  alreadyHave: z.boolean(),
  alreadyHaveId: z.string().optional(),
});

export const skillsCatalog = defineRpc({
  name: "paseo-memories.skills-catalog",
  input: z.object({}),
  output: z.object({ entries: z.array(CatalogCardSchema), note: z.string().default("") }),
});

/** kind: catalog (`id`) | github (`link`) | write (`name`, `whenToUse`, `instructions`). */
export const AddSourceSchema = z.object({
  kind: z.string(),
  id: z.string().max(200).optional(),
  link: z.string().max(500).optional(),
  name: z.string().max(64).optional(),
  whenToUse: z.string().max(1024).optional(),
  instructions: z.string().max(100_000).optional(),
});
export type AddSource = z.infer<typeof AddSourceSchema>;

export const PlannedFileSchema = z.object({ path: z.string(), bytes: z.number(), kind: z.string(), executable: z.boolean() });

export const AddTargetSchema = z.object({
  /** canonical | link | lock */
  kind: z.string(),
  path: z.string(),
  agent: z.string().optional(),
  accountId: z.string().optional(),
  label: z.string(),
});

export const skillsPreview = defineRpc({
  name: "paseo-memories.skills-preview",
  input: z.object({ source: AddSourceSchema }),
  output: z.object({
    ok: z.boolean(),
    /** Why it can't be added (bad link, nothing found, a name clash, too big); "" when it can. */
    problem: z.string().default(""),
    name: z.string().default(""),
    description: z.string().default(""),
    source: z.string().default(""),
    commit: z.string().default(""),
    files: z.array(PlannedFileSchema).default([]),
    scripts: z.boolean().default(false),
    /** The SKILL.md as it will be written (secrets masked). */
    skillMd: z.string().default(""),
    targets: z.array(AddTargetSchema).default([]),
    problems: z.array(SkillProblemSchema).default([]),
    warnings: z.array(z.string()).default([]),
    clash: z.object({ name: z.string(), skillId: z.string() }).optional(),
    /** For a link with several skills: the folders to pick from (send again with the folder in the link). */
    /** `link`: what to preview for that one (the repository at the same commit). */
    choices: z.array(z.object({ path: z.string(), name: z.string(), link: z.string().optional() })).default([]),
    planHash: z.string().default(""),
  }),
});

export const skillsAdd = defineRpc({
  name: "paseo-memories.skills-add",
  input: z.object({
    source: AddSourceSchema,
    planHash: z.string(),
    /** The person read the file list and agreed: "This skill includes code your agents may run." */
    confirmScripts: z.boolean().optional(),
  }),
  output: WriteResultSchema.extend({ skillId: z.string().optional(), needsScriptsConfirm: z.boolean().optional(), /** Added, but a link for Claude couldn't be made: offer "Link it for Claude". */ linkRetry: z.boolean().optional() }),
});

// ------------------------------------------------------------------ manage

export const skillsToggle = defineRpc({
  name: "paseo-memories.skills-toggle",
  input: z.object({
    skillId: z.string(),
    /** claude | codex */
    agent: z.string(),
    on: z.boolean(),
    /** One account; every account that reads the skill when omitted. */
    accountId: z.string().optional(),
  }),
  output: WriteResultSchema,
});

export const skillsRemove = defineRpc({
  name: "paseo-memories.skills-remove",
  input: z.object({ skillId: z.string(), confirm: z.boolean().optional() }),
  output: WriteResultSchema,
});

/** Make the links a skill added here is missing in Claude's accounts (the retry after a link failed). */
export const skillsLink = defineRpc({
  name: "paseo-memories.skills-link",
  input: z.object({ skillId: z.string() }),
  output: WriteResultSchema,
});

/** The one plain action of a "Worth a look" finding, done on the host from the finding's own record. */
export const skillsFix = defineRpc({
  name: "paseo-memories.skills-fix",
  input: z.object({ findingId: z.string() }),
  output: WriteResultSchema,
});

/** Fix every finding of one safe kind at once (0.5.1); `findingIds`: the ones the page showed. */
export const skillsFixAll = defineRpc({
  name: "paseo-memories.skills-fix-all",
  input: z.object({ kind: z.string().max(64), findingIds: z.array(z.string().max(300)).max(5000).optional() }),
  output: WriteResultSchema,
});
