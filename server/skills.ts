import fs from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { FindingInput, NextStep } from "../shared/contracts";
import { readLock, type LockFile, type LockRead } from "../shared/skill-lock";
import { codexSkillEnabled } from "../shared/codex-skills-toml";
import { fileKind } from "../shared/skill-files";
import {
  claudeBudgetChars,
  claudeListingChars,
  codexListingChars,
  nameKey,
  parseSkillMd,
  skillMdRunsCommands,
  skillProblems,
  tokensForChars,
  type ClaudeListing,
  type SkillHeader,
  type SkillProblem,
} from "../shared/skill-md";
import type { ListingCost, Skill, SkillLocation } from "../shared/skill-contracts";
import { sha256Hex } from "../shared/hash";
import { plural } from "../shared/format";
import { discoverAccounts, type Accounts } from "./accounts";
import { paseoProjects, readDaemonOrNull, type Paseo } from "./daemon";
import { skillLockPath, userHome } from "./env";
import { Probe, sha256 } from "./files";
import { versionControlled } from "./git";
import { readMemoriesSettings } from "./settings";
import { paseoBundle } from "./paseo-bundle";
import { claudeWindows, type AccountWindow } from "./skill-models";
import { readAdded, type AddedRecord } from "./skill-records";
import { READ_ONLY_ROOTS, projectRoots, userRoots, type RootKind, type SkillRoot } from "./skill-roots";
import { requestUsagePass, usageState, usageSummary } from "./skill-usage";
import type { MemoriesSettings } from "../shared/settings";

/**
 * Every skill this host's agents can find, per account and project, one
 * entry per real folder (links followed; a folder several agents read is ONE
 * skill with `readBy` listing them), with where it came from, what it costs
 * each agent at the start of every chat, and what is worth a look.
 *
 * Reads only: no process is started, no network is used, and SKILL.md text is
 * never kept (its parsed header and hash are, keyed by the file's stat).
 */

/** Names Paseo used to ship and still cleans up itself (@getpaseo/server 0.11 `LEGACY_SKILL_NAMES`): never orphans. */
export const PASEO_LEGACY = new Set(["paseo-chat", "paseo-epic", "paseo-orchestrate", "paseo-orchestrator"]);
export const PASEO_MARKER = ".paseo-managed-files.json";

const STRAY = /\.(zip|tar|tgz|gz|7z|rar|skill)$/i;
const MAX_PROJECTS = 200;
const MAX_ENTRIES_PER_ROOT = 2000;
const WALK_LIMITS = { files: 500, depth: 6 };
const REUSE_MS = 2_000;

type Finding = FindingInput & { severity: string };

/** What a finding's one action does on the host (skills-fix), kept server-side so the app never sends a path. */
export type FixPlan =
  | { kind: "unlink"; path: string }
  | { kind: "move-to-backup"; path: string }
  | { kind: "forget-lock-entry"; name: string }
  | { kind: "remove-orphan"; paths: string[] };

export type InternalSkill = Skill & {
  skillMd: string;
  header: SkillHeader;
  hash: string;
  homeRoot: SkillRoot | null;
  roots: SkillRoot[];
  claudeAccounts: string[];
  codexAccounts: string[];
  lockEntry?: { name: string; source: string; sourceType: string; ref?: string; installedAt?: string; updatedAt?: string };
};

export type SkillsDiscovery = {
  at: number;
  settings: MemoriesSettings;
  accounts: Accounts;
  roots: SkillRoot[];
  skills: InternalSkill[];
  byId: Map<string, InternalSkill>;
  costs: ListingCost[];
  findings: Finding[];
  fixes: Map<string, FixPlan>;
  nextStep?: NextStep;
  projects: string[];
  lock: { path: string; read: LockRead };
  checked: string[];
  notes: string[];
};

// ------------------------------------------------------------------ caches (stat-keyed, nothing but headers and counts)

type HeaderEntry = { stamp: string; header: SkillHeader; hash: string; bytes: number; runs: string | null };
type FolderEntry = { stamp: string; files: number; bytes: number; scripts: number };
const headers = new Map<string, HeaderEntry>();
const folders = new Map<string, FolderEntry>();

let last: SkillsDiscovery | null = null;
let generation = 0;
let lastGeneration = 0;

/** A write happened: the next read discovers again. */
export function forgetSkills(): void {
  generation += 1;
  last = null;
}

/** For tests. */
export function forgetSkillCaches(): void {
  forgetSkills();
  headers.clear();
  folders.clear();
}

export function skillCacheSizes(): { headers: number; folders: number } {
  return { headers: headers.size, folders: folders.size };
}

/** A copy that shares no memory with the text it was cut from. */
function own(text: string): string {
  return Buffer.from(text, "utf8").toString("utf8");
}

async function readHeader(path: string, seen: Set<string>): Promise<HeaderEntry | null> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > 1024 * 1024) return null;
  seen.add(path);
  const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
  const hit = headers.get(path);
  if (hit?.stamp === stamp) return hit;
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path);
  } catch {
    return null;
  }
  const source = bytes.toString("utf8");
  const parsed = parseSkillMd(source);
  const header: SkillHeader = {
    hasHeader: parsed.hasHeader,
    headerBroken: parsed.headerBroken,
    bodyLines: parsed.bodyLines,
    ...(parsed.name !== undefined ? { name: own(parsed.name) } : {}),
    ...(parsed.description !== undefined ? { description: own(parsed.description) } : {}),
    ...(parsed.whenToUse !== undefined ? { whenToUse: own(parsed.whenToUse) } : {}),
    ...(parsed.disableModelInvocation !== undefined ? { disableModelInvocation: parsed.disableModelInvocation } : {}),
    ...(parsed.userInvocable !== undefined ? { userInvocable: parsed.userInvocable } : {}),
  };
  const runs = skillMdRunsCommands(source);
  const entry = { stamp, header, hash: sha256(bytes), bytes: bytes.length, runs: runs === null ? null : own(runs) };
  headers.set(path, entry);
  return entry;
}

/** Files, bytes and files an agent might run, inside a skill folder (bounded; links inside are not followed). */
export async function walkSkill(folder: string, list?: Array<{ path: string; bytes: number; kind: string; executable: boolean }>): Promise<{ files: number; bytes: number; scripts: number }> {
  const out = { files: 0, bytes: 0, scripts: 0 };
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > WALK_LIMITS.depth || out.files >= WALK_LIMITS.files) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.files >= WALK_LIMITS.files) return;
      if (entry.name === PASEO_MARKER || entry.name === ".DS_Store") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git" && entry.name !== "node_modules") await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = await fs.stat(path);
      } catch {
        continue;
      }
      const executable = (stat.mode & 0o111) !== 0;
      let head: Uint8Array | null = null;
      if (!executable && stat.size >= 2) {
        try {
          const handle = await fs.open(path, "r");
          try {
            const buffer = Buffer.alloc(2);
            await handle.read(buffer, 0, 2, 0);
            head = buffer;
          } finally {
            await handle.close();
          }
        } catch {
          head = null;
        }
      }
      const rel = relative(folder, path).split("\\").join("/");
      let kind = fileKind(rel, executable, head);
      // A SKILL.md whose header or body runs commands counts as code too (review-040 #1).
      if (rel === "SKILL.md" && stat.size <= 1024 * 1024) {
        const text = await fs.readFile(path, "utf8").catch(() => "");
        if (skillMdRunsCommands(text)) kind = "script";
      }
      out.files += 1;
      out.bytes += stat.size;
      if (kind === "script") out.scripts += 1;
      list?.push({ path: rel, bytes: stat.size, kind, executable });
    }
  };
  await walk(folder, 0);
  return out;
}

async function folderStats(folder: string, skillMd: HeaderEntry, seen: Set<string>): Promise<FolderEntry> {
  let dirStamp = "";
  try {
    const stat = await fs.stat(folder);
    dirStamp = `${stat.mtimeMs}:${stat.ino}`;
  } catch {
    dirStamp = "missing";
  }
  const stamp = `${dirStamp}|${skillMd.stamp}`;
  seen.add(folder);
  const hit = folders.get(folder);
  if (hit?.stamp === stamp) return hit;
  const counted = await walkSkill(folder);
  const entry = { stamp, ...counted };
  folders.set(folder, entry);
  return entry;
}

// ------------------------------------------------------------------ one root

type RootEntry =
  | { kind: "skill"; name: string; path: string; link: boolean; real: string }
  | { kind: "broken-link"; name: string; path: string }
  | { kind: "empty"; name: string; path: string }
  | { kind: "no-skill-md"; name: string; path: string }
  | { kind: "stray-file"; name: string; path: string };

async function readRoot(root: SkillRoot): Promise<RootEntry[]> {
  let entries;
  try {
    entries = await fs.readdir(root.path, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: RootEntry[] = [];
  for (const entry of entries.slice(0, MAX_ENTRIES_PER_ROOT)) {
    const name = entry.name;
    if (name.startsWith(".")) continue;
    if (root.kind === "claude-user" && name.toLowerCase() === "synced") continue;
    const path = join(root.path, name);
    let target;
    let link = false;
    if (entry.isSymbolicLink()) {
      link = true;
      try {
        target = await fs.stat(path);
      } catch {
        out.push({ kind: "broken-link", name, path });
        continue;
      }
    } else target = entry;
    if (!target.isDirectory()) {
      if (target.isFile() && STRAY.test(name)) out.push({ kind: "stray-file", name, path });
      continue;
    }
    const real = link ? await fs.realpath(path).catch(() => path) : await fs.realpath(path).catch(() => path);
    let inside: string[];
    try {
      inside = await fs.readdir(real);
    } catch {
      continue;
    }
    if (inside.includes("SKILL.md")) out.push({ kind: "skill", name, path, link, real });
    else if (inside.filter((file) => file !== ".DS_Store").length === 0) out.push({ kind: "empty", name, path });
    else out.push({ kind: "no-skill-md", name, path });
  }
  return out;
}

// ------------------------------------------------------------------ settings each agent keeps per skill

type ClaudeOverrides = Record<string, string>;

async function claudeOverrides(probe: Probe, dir: string): Promise<ClaudeOverrides> {
  const text = await probe.text(join(dir, "settings.json"));
  if (!text) return {};
  try {
    const value = (JSON.parse(text) as { skillOverrides?: unknown }).skillOverrides;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, state]) => typeof state === "string")) as ClaudeOverrides;
  } catch {
    return {};
  }
}

function combine(states: string[]): string {
  const set = new Set(states);
  if (set.size === 0) return "on";
  if (set.size === 1) return states[0]!;
  return "mixed";
}

// ------------------------------------------------------------------ provenance and access

const NOT_TOGGLED: Record<string, string> = {
  paseo: "Paseo manages its own skills and puts them back when it starts; choose which ones agents get in Paseo's settings.",
  "claude-plugin": "Part of a Claude Code plugin; turn the plugin off in Claude Code instead.",
  "claude-ai": "Synced from your claude.ai account; turn it off there.",
  "codex-builtin": "Built into Codex.",
  managed: "Set up for every user of this computer by an administrator.",
};

function idFor(path: string): string {
  return `sk_${sha256Hex(path).slice(0, 24)}`;
}

export function findingId(kind: string, ...parts: string[]): string {
  return `${kind}:${sha256Hex(parts.join("\u0000")).slice(0, 16)}`;
}

function rootProvenance(kind: RootKind): string | null {
  switch (kind) {
    case "claude-synced":
      return "claude-ai";
    case "claude-plugin":
      return "claude-plugin";
    case "claude-managed":
    case "codex-admin":
      return "managed";
    case "codex-system":
      return "codex-builtin";
    case "project-claude":
    case "project-agents":
    case "project-codex":
    case "project-pi":
      return "project";
    default:
      return null;
  }
}

// ------------------------------------------------------------------ discovery

export async function discoverSkills(paseo: Paseo | null, { refresh = false } = {}): Promise<SkillsDiscovery> {
  if (!refresh && last && lastGeneration === generation && Date.now() - last.at < REUSE_MS) return last;
  const startedAt = generation;
  const settings = await readMemoriesSettings();
  const daemon = await readDaemonOrNull(paseo);
  const accounts = await discoverAccounts(daemon?.launch ?? {});
  const probe = new Probe();
  const home = userHome();
  const notes: string[] = [];
  if (paseo && !daemon) notes.push("Paseo's settings could not be read, so only the default agent folders were checked.");

  const projects: string[] = [];
  for (const entry of await paseoProjects(paseo)) {
    if (projects.length >= MAX_PROJECTS) break;
    const path = resolve(entry.path);
    if (path !== resolve(home) && !projects.includes(path) && (await probe.isDir(path))) projects.push(path);
  }
  const roots = [...(await userRoots(probe, accounts))];
  const seenProject = new Set<string>();
  for (const project of projects) {
    for (const root of await projectRoots(probe, project)) {
      if (seenProject.has(root.path)) continue;
      seenProject.add(root.path);
      roots.push(root);
    }
  }

  const lockPath = skillLockPath();
  const lockText = await probe.text(lockPath);
  const lockRead = readLock(lockText);
  const lock: LockFile | null = lockRead.ok ? lockRead.lock : null;
  if (!lockRead.ok) notes.push(lockRead.reason);
  const added = await readAdded();

  // Real folder → skill; plus the root each real folder sits in directly.
  const rootReal = new Map<SkillRoot, string>();
  for (const root of roots) rootReal.set(root, await fs.realpath(root.path).catch(() => root.path));
  const homeRootOf = (real: string): SkillRoot | null => {
    const parent = dirname(real);
    for (const root of roots) if (rootReal.get(root) === parent && root.kind !== "claude-synced") return root;
    for (const root of roots) if (rootReal.get(root) === parent) return root;
    return null;
  };

  const seenHeaders = new Set<string>();
  const seenFolders = new Set<string>();
  const byReal = new Map<string, InternalSkill>();
  const findings: Finding[] = [];
  const fixes = new Map<string, FixPlan>();
  const looked = { roots: 0, places: 0 };

  const addFinding = (finding: Finding, fix?: FixPlan) => {
    if (findings.some((existing) => existing.id === finding.id)) return;
    findings.push(finding);
    if (fix) fixes.set(finding.id, fix);
  };

  for (const root of roots) {
    const entries = await readRoot(root);
    if (entries.length || (await probe.isDir(root.path))) looked.roots += 1;
    const tidyHere = root.userFolder || root.kind.startsWith("project-");
    for (const entry of entries) {
      if (entry.kind !== "skill") {
        if (!tidyHere) continue;
        const fixable = root.userFolder;
        if (entry.kind === "broken-link") {
          addFinding(
            { id: findingId("broken-link", entry.path), kind: "broken-link", severity: "warn", sourceIds: [], message: `${entry.name} points to a skill that no longer exists.`, detail: entry.path, ...(fixable ? { action: { label: "Remove the broken link", kind: "fix" } } : {}) },
            fixable ? { kind: "unlink", path: entry.path } : undefined,
          );
        } else if (entry.kind === "empty") {
          addFinding(
            { id: findingId("empty-folder", entry.path), kind: "empty-folder", severity: "info", sourceIds: [], message: `${entry.name} is an empty skill folder.`, detail: entry.path, ...(fixable ? { action: { label: "Move it to the backups", kind: "fix" } } : {}) },
            fixable ? { kind: "move-to-backup", path: entry.path } : undefined,
          );
        } else if (entry.kind === "stray-file") {
          addFinding(
            { id: findingId("stray-file", entry.path), kind: "stray-file", severity: "info", sourceIds: [], message: `${entry.name} is a packed file in a skills folder; agents don't read it.`, detail: entry.path, ...(fixable ? { action: { label: "Move it to the backups", kind: "fix" } } : {}) },
            fixable ? { kind: "move-to-backup", path: entry.path } : undefined,
          );
        } else {
          addFinding({ id: findingId("invalid", entry.path), kind: "invalid", severity: "warn", sourceIds: [], message: `${entry.name} has no instructions file (SKILL.md), so agents skip it.`, detail: entry.path });
        }
        continue;
      }
      looked.places += 1;
      const location: SkillLocation = {
        path: entry.path,
        root: root.kind,
        link: entry.link,
        ...(root.accountId ? { accountId: root.accountId } : {}),
        ...(root.projectPath ? { projectPath: root.projectPath } : {}),
      };
      const known = byReal.get(entry.real);
      if (known) {
        known.locations.push(location);
        known.roots.push(root);
        for (const agent of root.agents) if (!known.readBy.includes(agent)) known.readBy.push(agent);
        continue;
      }
      const skillMd = join(entry.real, "SKILL.md");
      const head = await readHeader(skillMd, seenHeaders);
      if (!head) continue;
      const stats = await folderStats(entry.real, head, seenFolders);
      const folder = basename(entry.real);
      const header = head.header;
      const plainName = header.name || folder;
      const name = root.plugin ? `${root.plugin}:${plainName}` : plainName;
      const homeRoot = homeRootOf(entry.real) ?? root;
      const skill: InternalSkill = {
        id: idFor(entry.real),
        name,
        folder,
        description: header.description ?? "",
        ...(header.whenToUse ? { whenToUse: header.whenToUse } : {}),
        path: entry.real,
        locations: [location],
        provenance: "by-hand",
        scope: root.kind.startsWith("project-") ? "project" : root.kind === "claude-plugin" ? "plugin" : root.kind === "claude-managed" || root.kind === "codex-admin" ? "managed" : "user",
        ...(root.projectPath ? { projectPath: root.projectPath } : {}),
        readBy: [...root.agents],
        access: "editable",
        files: stats.files,
        bytes: stats.bytes,
        scripts: stats.scripts,
        ...(head.runs ? { runsCommands: head.runs } : {}),
        ...(header.userInvocable === false ? { userInvocable: false } : {}),
        problems: skillProblems(header, folder),
        listing: { claude: 0, codex: 0 },
        state: {},
        can: { turnOff: [], remove: false, link: false },
        skillMd,
        header,
        hash: head.hash,
        homeRoot,
        roots: [root],
        claudeAccounts: [],
        codexAccounts: [],
      };
      byReal.set(entry.real, skill);
    }
  }

  // Who, where from, and what may be done.
  const claudeAccounts = accounts.accounts.filter((account) => account.agent === "claude" && account.exists);
  const codexAccounts = accounts.accounts.filter((account) => account.agent === "codex" && account.exists);
  const overrides = new Map<string, ClaudeOverrides>();
  for (const account of claudeAccounts) overrides.set(account.id, await claudeOverrides(probe, account.dir));
  const codexConfigs = new Map<string, string>();
  for (const account of codexAccounts) codexConfigs.set(account.id, (await probe.text(join(account.dir, "config.toml"))) ?? "");

  const skills = [...byReal.values()];
  for (const skill of skills) {
    const home = skill.homeRoot!;
    let provenance = rootProvenance(home.kind);
    if (provenance === "claude-plugin") skill.provenanceDetail = home.plugin;
    if (!provenance || provenance === "project") {
      if (await probe.exists(join(skill.path, PASEO_MARKER))) provenance = "paseo";
    }
    if (!provenance) {
      const record: AddedRecord | undefined = added[skill.path];
      const lockEntry = lock?.skills[skill.folder];
      if (record) {
        provenance = "added-here";
        skill.provenanceDetail = record.source;
      } else if (lockEntry) {
        provenance = "npx-skills";
        skill.provenanceDetail = lockEntry.source;
      } else provenance = "by-hand";
    }
    skill.provenance = provenance;
    const lockEntry = lock?.skills[skill.folder];
    if (lockEntry && (provenance === "npx-skills" || provenance === "added-here")) {
      skill.lockEntry = { name: skill.folder, source: lockEntry.source, sourceType: lockEntry.sourceType, ...(lockEntry.ref ? { ref: lockEntry.ref } : {}), installedAt: lockEntry.installedAt, updatedAt: lockEntry.updatedAt };
    }

    // Access: read-only by place or by owner.
    const readOnly = provenance === "paseo" ? "Paseo manages this skill and rewrites it every time it starts; edits here would be lost." : READ_ONLY_ROOTS[home.kind];
    if (readOnly) {
      skill.access = "read-only";
      skill.reason = readOnly;
    } else if (home.kind.startsWith("project-")) {
      skill.versionControlled = await versionControlled(probe, skill.skillMd);
      if (skill.versionControlled) skill.reason = "In a project folder tracked by git: a change here is shared with everyone on the project.";
    }

    // Which accounts see it.
    const claudeSeen = new Set<string>();
    const codexSeen = new Set<string>();
    for (const root of skill.roots) {
      if (root.agents.includes("claude")) {
        if (root.accountId) claudeSeen.add(root.accountId);
        else for (const account of claudeAccounts) claudeSeen.add(account.id);
      }
      if (root.agents.includes("codex")) {
        if (root.accountId && root.kind.startsWith("codex")) codexSeen.add(root.accountId);
        else for (const account of codexAccounts) codexSeen.add(account.id);
      }
    }
    skill.claudeAccounts = [...claudeSeen];
    skill.codexAccounts = [...codexSeen];

    // State per agent.
    if (skill.claudeAccounts.length) {
      const states = skill.claudeAccounts.map((id) => {
        const value = home.kind === "claude-plugin" ? undefined : overrides.get(id)?.[skill.name];
        const base = value === "off" || value === "name-only" || value === "user-invocable-only" ? value : "on";
        return base === "on" && skill.header.disableModelInvocation ? "model-off" : base;
      });
      skill.state.claude = combine(states);
    }
    if (skill.codexAccounts.length) {
      skill.state.codex = combine(skill.codexAccounts.map((id) => (codexSkillEnabled(codexConfigs.get(id) ?? "", skill.header.name || skill.folder, skillMdPaths(skill)) ? "on" : "off")));
    }

    // Listing cost (one account's view; the costs below add them up per account).
    const claudeState = (skill.state.claude ?? "on") as ClaudeListing | "mixed";
    skill.listing.claude = skill.readBy.includes("claude") ? claudeListingChars(skill.name, skill.header, claudeState === "mixed" ? "on" : claudeState) : 0;
    skill.listing.codex = skill.readBy.includes("codex") && skill.state.codex !== "off" ? codexListingChars(skill.folder, skill.description, skill.skillMd) : 0;

    // Turn off.
    const blocked = NOT_TOGGLED[provenance];
    if (blocked) skill.can.turnOffReason = blocked;
    else {
      if (skill.claudeAccounts.length) skill.can.turnOff.push("claude");
      if (skill.codexAccounts.length) skill.can.turnOff.push("codex");
      if (!skill.can.turnOff.length) skill.can.turnOffReason = "Neither Claude nor Codex reads it, and this plugin can only turn skills off for those two.";
    }

    // Link it for Claude: one this plugin added to the shared folder that a Claude account doesn't see (a link that failed).
    if (provenance === "added-here" && home.kind === "shared") {
      for (const account of claudeAccounts) {
        if (skill.claudeAccounts.includes(account.id)) continue;
        if (!(await probe.exists(join(account.dir, "skills", skill.folder)))) skill.can.link = true;
      }
    }

    // Remove.
    if ((provenance === "added-here" || provenance === "npx-skills" || provenance === "by-hand") && home.userFolder) skill.can.remove = true;
    else if (provenance === "project") skill.can.removeReason = "It lives in the project's own folder; remove it there.";
    else skill.can.removeReason = skill.reason ?? "This skill isn't one this plugin may remove.";
  }

  // Forget cached headers and folders no longer seen.
  for (const path of [...headers.keys()]) if (!seenHeaders.has(path)) headers.delete(path);
  for (const path of [...folders.keys()]) if (!seenFolders.has(path)) folders.delete(path);

  // Usage, from the background scan's last answer (never waited for).
  const installedNames = [...new Set(skills.flatMap((skill) => [skill.name, skill.folder]))];
  if (settings.skillsUsage) requestUsagePass(accounts.accounts);
  const usage = settings.skillsUsage ? usageSummary(installedNames, settings.skillsWindowDays) : null;
  const usageReady = usageState(settings.skillsUsage);
  if (usage) {
    const rows = new Map(usage.rows.map((row) => [row.name.toLowerCase(), row]));
    for (const skill of skills) {
      const row = rows.get(skill.name.toLowerCase()) ?? rows.get(skill.folder.toLowerCase());
      skill.usage = row ? { total: row.total, lastUsed: row.lastUsed, estimated: row.codex > 0 } : { total: 0, lastUsed: "", estimated: false };
    }
  }

  // Costs: per Claude and Codex account, each real folder once.
  const windows = await claudeWindows(paseo, accounts, probe);
  const costs: ListingCost[] = [];
  for (const account of claudeAccounts) {
    const mine = skills.filter((skill) => skill.scope !== "project" && skill.claudeAccounts.includes(account.id));
    const chars = mine.reduce((sum, skill) => sum + claudeListingFor(skill, overrides.get(account.id) ?? {}), 0);
    costs.push(cost("claude", account.id, account.label, mine.filter((skill) => claudeListingFor(skill, overrides.get(account.id) ?? {}) > 0).length, chars, windows.get(account.id)));
  }
  for (const account of codexAccounts) {
    const config = codexConfigs.get(account.id) ?? "";
    const mine = skills.filter((skill) => skill.scope !== "project" && skill.codexAccounts.includes(account.id) && codexSkillEnabled(config, skill.header.name || skill.folder, skillMdPaths(skill)));
    const chars = mine.reduce((sum, skill) => sum + codexListingChars(skill.folder, skill.description, skill.skillMd), 0);
    costs.push(cost("codex", account.id, account.label, mine.length, chars, undefined));
  }

  // Worth a look.
  skillFindings(skills, costs, lock, usage, usageReady, settings, await paseoBundle(), addFinding);

  const nextStep = pickNext(findings);
  const checked = [
    `Checked ${plural(looked.roots, "skills folder")} for ${plural(claudeAccounts.length, "Claude account")}, ${plural(codexAccounts.length, "Codex home")} and ${plural(projects.length, "project")}; found ${plural(skills.length, "skill")} in ${plural(looked.places, "place")}.`,
  ];
  if (!paseo) notes.push("No Paseo daemon to ask for projects, so project skills were not checked.");

  const result: SkillsDiscovery = {
    at: Date.now(),
    settings,
    accounts,
    roots,
    skills,
    byId: new Map(skills.map((skill) => [skill.id, skill])),
    costs,
    findings,
    fixes,
    ...(nextStep ? { nextStep } : {}),
    projects,
    lock: { path: lockPath, read: lockRead },
    checked,
    notes,
  };
  if (startedAt === generation) {
    last = result;
    lastGeneration = generation;
  }
  return result;
}

/** Every path Codex may know this skill's SKILL.md by: the real one and one through each place it is found. */
export function skillMdPaths(skill: Pick<InternalSkill, "skillMd" | "locations">): string[] {
  return [...new Set([skill.skillMd, ...skill.locations.map((location) => join(location.path, "SKILL.md"))])];
}

function claudeListingFor(skill: InternalSkill, overrides: ClaudeOverrides): number {
  if (!skill.readBy.includes("claude")) return 0;
  const value = skill.homeRoot?.kind === "claude-plugin" ? undefined : overrides[skill.name];
  const state: ClaudeListing = value === "off" || value === "name-only" || value === "user-invocable-only" ? value : "on";
  return claudeListingChars(skill.name, skill.header, state);
}

/**
 * One account's list cost. Claude's budget comes from the window its agents
 * use (`window`); Codex's depends on its model's window, which this plugin
 * doesn't know, so its cost is a fact, never a warning.
 */
export function cost(agent: string, accountId: string, label: string, count: number, chars: number, window: AccountWindow | undefined): ListingCost {
  const tokens = agent === "claude" ? window?.contextTokens ?? null : null;
  const budget = tokens ? claudeBudgetChars(tokens) : 0;
  const note = agent === "claude"
    ? tokens
      ? `Claude keeps about ${budget.toLocaleString("en-US")} characters of skill descriptions whole${window?.model ? ` with ${window.model}` : ""}; projects can add more of their own.`
      : "Claude keeps 1% of its model's window for skill descriptions; which model these agents use isn't known here, so this is shown as a fact only."
    : "Codex keeps 2% of its model's window for its skill list; projects can add more of their own.";
  return { agent, accountId, label, skills: count, chars, tokens: tokensForChars(chars), budgetChars: budget, overBudget: Boolean(tokens) && chars > budget, budgetKnown: Boolean(tokens), ...(window?.model && tokens ? { model: window.model } : {}), note };
}

type UsageSummary = ReturnType<typeof usageSummary>;

function skillFindings(
  skills: InternalSkill[],
  costs: ListingCost[],
  lock: LockFile | null,
  usage: UsageSummary | null,
  usageReady: ReturnType<typeof usageState>,
  settings: MemoriesSettings,
  bundle: ReadonlySet<string> | null,
  add: (finding: Finding, fix?: FixPlan) => void,
): void {
  // Header and name problems, one finding per skill (the worst problem leads).
  for (const skill of skills) {
    const warn = skill.problems.filter((problem: SkillProblem | { severity: string }) => problem.severity === "warn");
    if (!warn.length || skill.access === "read-only") continue;
    add({ id: findingId("invalid", skill.path), kind: "invalid", severity: "warn", sourceIds: [skill.id], message: `${skill.name}: ${warn[0]!.message}`, ...(warn.length > 1 ? { detail: warn.slice(1).map((problem) => problem.message).join(" ") } : {}), action: { label: "Open it", kind: "open", sourceId: skill.id } });
  }

  // The same name, different instructions, in several places.
  const byName = new Map<string, InternalSkill[]>();
  for (const skill of skills) {
    const key = nameKey(skill.folder);
    byName.set(key, [...(byName.get(key) ?? []), skill]);
  }
  for (const group of byName.values()) {
    if (group.length < 2 || new Set(group.map((skill) => skill.hash)).size < 2) continue;
    const ids = group.map((skill) => skill.id);
    add({ id: findingId("duplicate", ...group.map((skill) => skill.path).sort()), kind: "duplicate", severity: "warn", sourceIds: ids, message: `${group[0]!.folder} is in ${group.length} places with different instructions; agents may pick either.`, action: { label: "Compare them", kind: "review", sourceId: ids[0] } });
  }

  // Paseo orphans: Paseo's marker, but not a skill the running Paseo ships or cleans up. Only when its bundle could be read.
  for (const skill of bundle ? skills : []) {
    if (skill.provenance !== "paseo" || bundle!.has(skill.folder) || PASEO_LEGACY.has(skill.folder)) continue;
    const userPaths = skill.homeRoot?.userFolder ? [skill.path] : [];
    add(
      { id: findingId("paseo-orphan", skill.path), kind: "paseo-orphan", severity: "info", sourceIds: [skill.id], message: `${skill.folder} was put here by Paseo, but the Paseo running here doesn't ship it, so nothing will update or remove it.`, ...(userPaths.length ? { action: { label: "Move it to the backups", kind: "fix" } } : {}) },
      userPaths.length ? { kind: "remove-orphan", paths: userPaths } : undefined,
    );
  }

  // Lock entries with nothing on disk.
  if (lock) {
    const names = new Set(skills.flatMap((skill) => [skill.folder]));
    for (const [name, entry] of Object.entries(lock.skills)) {
      if (names.has(name)) continue;
      add({ id: findingId("lock-missing", name), kind: "lock-missing", severity: "info", sourceIds: [], message: `npx skills lists ${name} (from ${entry.source}), but it isn't in any skills folder here.`, action: { label: "Take it off the list", kind: "fix" } }, { kind: "forget-lock-entry", name });
    }
  }

  // Lists over budget.
  for (const entry of costs) {
    if (!entry.overBudget || !entry.budgetKnown) continue;
    add({ id: findingId("over-budget", entry.agent, entry.accountId ?? ""), kind: "over-budget", severity: "warn", sourceIds: [], message: `Claude's skill list (${entry.label}) is about ${entry.chars.toLocaleString("en-US")} characters, over the ${entry.budgetChars.toLocaleString("en-US")} it keeps whole${entry.model ? ` with ${entry.model}` : ""}; some descriptions get cut.`, action: { label: "See what costs the most", kind: "review" } });
  }

  // Unused but costing: only once usage has been counted all the way through.
  if (usage && usageReady.state === "ready" && usageReady.complete) {
    const unused = skills.filter((skill) => skill.can.turnOff.length && (skill.listing.claude > 0 || skill.listing.codex > 0) && (skill.usage?.total ?? 0) === 0);
    if (unused.length) {
      const chars = unused.reduce((sum, skill) => sum + Math.max(skill.listing.claude, skill.listing.codex), 0);
      add({ id: findingId("unused", String(settings.skillsWindowDays)), kind: "unused", severity: "info", heuristic: true, sourceIds: unused.map((skill) => skill.id), message: `${plural(unused.length, "skill")} weren't used in the last ${settings.skillsWindowDays} days on this computer but are listed at the start of every chat (about ${tokensForChars(chars).toLocaleString("en-US")} tokens).`, action: { label: "Review them", kind: "review" } });
    }
  }
}

const SEVERITY_ORDER: Record<string, number> = { error: 0, warn: 1, info: 2 };

function pickNext(findings: Finding[]): NextStep | undefined {
  const first = [...findings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3))[0];
  if (!first) return undefined;
  return { title: first.message, detail: findings.length > 1 ? `${plural(findings.length - 1, "more thing")} worth a look after this.` : "That's the only thing worth a look.", ...(first.action ? { action: first.action } : {}) };
}

/** The skill with this id, discovered fresh (writes must never act on a cached view). */
export async function findSkill(paseo: Paseo | null, skillId: string): Promise<{ skill: InternalSkill; discovery: SkillsDiscovery } | null> {
  const discovery = await discoverSkills(paseo, { refresh: true });
  const skill = discovery.byId.get(skillId);
  return skill ? { skill, discovery } : null;
}

/** Public shape: internal fields left out. */
export function publicSkill(skill: InternalSkill): Skill {
  const { skillMd: _skillMd, header: _header, hash: _hash, homeRoot: _homeRoot, roots: _roots, claudeAccounts: _claude, codexAccounts: _codex, lockEntry: _lock, ...rest } = skill;
  return rest;
}

/** Is `path` a skill folder (or a link in a skills folder) that agents read: a skills root's direct child? */
export function rootOfEntry(discovery: SkillsDiscovery, path: string): SkillRoot | null {
  const parent = dirname(resolve(path));
  return discovery.roots.find((root) => resolve(root.path) === parent) ?? null;
}

