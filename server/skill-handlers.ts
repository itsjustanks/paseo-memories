import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { WriteReport } from "../shared/contracts";
import { codexSkillEnabled, setSkillEnabled } from "../shared/codex-skills-toml";
import { canFixAll, quickSummary } from "../shared/finding-groups";
import { maskSecrets } from "../shared/secrets";
import { lockLooksValid, readLock, serializeLock, withoutEntry } from "../shared/skill-lock";
import { friendlyRef, shadowsFor, type Shadow } from "../shared/scope";
import { nameKey } from "../shared/skill-md";
import type { AddSource, ListingCost } from "../shared/skill-contracts";
import { CATALOG, catalogName } from "../shared/skills-catalog";
import { accountForProvider } from "./accounts";
import { startWrite, workspaceDirectory, type Paseo } from "./daemon";
import { skillLockPath, userHome } from "./env";
import { Probe } from "./files";
import { logWrite } from "./log";
import { withDeadline } from "./run";
import { readMemoriesSettings } from "./settings";
import { recordSkills } from "./sidebar-cache";
import { addSkill, previewSkill } from "./skill-add";
import { forgetAdded } from "./skill-records";
import { gitRoot } from "./git";
import { projectRoots } from "./skill-roots";
import { chatUsage, folderUsage, requestUsagePass, usageState, usageSummary } from "./skill-usage";
import { agentWindow, claudeWindows, type AccountWindow } from "./skill-models";
import { cost, discoverSkills, findSkill, forgetSkills, publicSkill, skillMdPaths, walkSkill, type InternalSkill, type SkillsDiscovery } from "./skills";
import { skillParentReason } from "./writable";
import { createSkillLink, moveRefusal, moveToBackup, newSession, readCurrent, safeWrite, type Session } from "./write";

/**
 * The Skills RPC handlers. Reads answer from discovery and the usage scan's
 * last answer (never waiting for a pass, never starting a process, never
 * using the network); writes go through `server/write.ts` with backups, one
 * report per place.
 */

const MAX_BODY = 200 * 1024;

type Ctx = Pick<PluginHandlerContext, "paseo">;

function result(ok: boolean, message: string, reports: WriteReport[], warnings: string[] = []) {
  return { ok, message, reports, warnings };
}

// ------------------------------------------------------------------ reads

export async function handleSkillsInventory({ refresh }: { refresh?: boolean }, { paseo }: Ctx) {
  const discovery = await discoverSkills(paseo, { refresh: Boolean(refresh) });
  const usage = usageState(discovery.settings.skillsUsage);
  // The Skills dot's summary (0.5.1): the page's rule, warnings make the dot; kept for the sidebar at load.
  await recordSkills(quickSummary("skills", discovery.findings, discovery.findings.some((finding) => finding.severity === "warn") ? "attention" : null), discovery.at).catch(() => undefined);
  return {
    checkedAt: new Date(discovery.at).toISOString(),
    skills: discovery.skills.map(publicSkill),
    costs: discovery.costs,
    findings: discovery.findings,
    ...(discovery.nextStep ? { nextStep: discovery.nextStep } : {}),
    usage,
    windowDays: discovery.settings.skillsWindowDays,
    home: userHome(),
    counts: {
      skills: discovery.skills.length,
      places: discovery.skills.reduce((sum, skill) => sum + skill.locations.length, 0),
      projects: discovery.projects.length,
      accounts: discovery.accounts.accounts.filter((account) => account.exists && (account.agent === "claude" || account.agent === "codex")).length,
    },
    checked: discovery.checked,
    notes: discovery.notes,
  };
}

export async function handleSkillDetail({ skillId, reveal }: { skillId: string; reveal?: boolean }, { paseo }: Ctx) {
  const discovery = await discoverSkills(paseo);
  const skill = discovery.byId.get(skillId);
  if (!skill) throw new Error("That skill is no longer there. Refresh the list.");
  const warnings: string[] = [];
  let body = "";
  let truncated = false;
  try {
    const bytes = await fs.readFile(skill.skillMd);
    truncated = bytes.length > MAX_BODY;
    body = bytes.subarray(0, MAX_BODY).toString("utf8");
  } catch {
    warnings.push("Its instructions could not be read just now.");
  }
  const settings = await readMemoriesSettings();
  if (!reveal && settings.maskSecrets) body = maskSecrets(body).text;
  const fileList: Array<{ path: string; bytes: number; kind: string; executable: boolean }> = [];
  await walkSkill(skill.path, fileList);
  fileList.sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)));
  return {
    skill: publicSkill(skill),
    body,
    truncated,
    fileList,
    ...(skill.lockEntry ? { lock: { source: skill.lockEntry.source, sourceType: skill.lockEntry.sourceType, ...(skill.lockEntry.ref ? { ref: skill.lockEntry.ref } : {}), ...(skill.lockEntry.installedAt ? { installedAt: skill.lockEntry.installedAt } : {}), ...(skill.lockEntry.updatedAt ? { updatedAt: skill.lockEntry.updatedAt } : {}) } } : {}),
    warnings,
  };
}

export async function handleSkillsUsage({ days, refresh }: { days?: number; refresh?: boolean }, { paseo }: Ctx) {
  const discovery = await discoverSkills(paseo);
  const settings = discovery.settings;
  const window = days ?? settings.skillsWindowDays;
  if (settings.skillsUsage && refresh) requestUsagePass(discovery.accounts.accounts, { minGapMs: 10_000 });
  const state = usageState(settings.skillsUsage);
  const names = [...new Set(discovery.skills.flatMap((skill) => [skill.name, skill.folder]))];
  const summary = usageSummary(settings.skillsUsage ? names : [], window);
  const byName = new Map<string, InternalSkill>();
  for (const skill of discovery.skills) {
    byName.set(skill.name.toLowerCase(), skill);
    if (!byName.has(skill.folder.toLowerCase())) byName.set(skill.folder.toLowerCase(), skill);
  }
  const notes = ["Claude records every skill it uses, so its counts are exact. Codex doesn't, so its counts are estimated from the skill files it read."];
  if (state.note) notes.push(state.note);
  return {
    days: window,
    firstDay: summary.firstDay,
    lastDay: summary.lastDay,
    rows: summary.rows.map((row) => {
      const skill = byName.get(row.name.toLowerCase());
      return { ...row, ...(skill ? { skillId: skill.id } : {}) };
    }),
    totals: summary.totals,
    neverUsed: settings.skillsUsage && state.state === "ready" ? summary.neverUsed.map((name) => byName.get(name.toLowerCase())).filter((skill): skill is InternalSkill => Boolean(skill) && skill!.scope !== "project").filter((skill, i, all) => all.indexOf(skill) === i).map((skill) => ({ name: skill.name, skillId: skill.id, listingChars: Math.max(skill.listing.claude, skill.listing.codex) })) : [],
    state,
    notes,
  };
}

export async function handleSkillsCatalog(_input: Record<string, never>, { paseo }: Ctx) {
  const discovery = await discoverSkills(paseo);
  return {
    entries: CATALOG.map((entry) => {
      const name = catalogName(entry);
      const have = discovery.skills.find((skill) => nameKey(skill.folder) === nameKey(name));
      return {
        id: entry.id,
        name,
        title: entry.title,
        blurb: entry.blurb,
        publisher: entry.publisher,
        source: `${entry.owner}/${entry.repo}`,
        commit: entry.commit,
        license: entry.license,
        files: entry.files,
        scripts: entry.scripts,
        alreadyHave: Boolean(have),
        ...(have ? { alreadyHaveId: have.id } : {}),
      };
    }),
    note: "Each skill is pinned to the exact version this plugin checked; what you preview is what gets added.",
  };
}

// ------------------------------------------------------------------ panels

type PanelSkill = { skillId: string; name: string; description: string; provenance: string; scope: string; listingChars: number; state: string; projectPath?: string; where?: string; path?: string; shadows: Shadow[] };

/** This workspace's own skill folders, and where its project starts (its git root). */
type Here = { roots: string[]; projectRoot: string };

async function hereFor(directory: string): Promise<Here> {
  const probe = new Probe();
  return { roots: (await projectRoots(probe, directory)).map((root) => resolve(root.path)), projectRoot: (await gitRoot(probe, directory)) ?? resolve(directory) };
}

/**
 * Where an agent HERE finds a skill (0.6.0 review): for a project skill, the
 * place in this workspace's own skill folders (a skill another project links
 * to is this project's at this project's path, not at the folder it really
 * lives in), with this project as its project. Your own skills keep their
 * first place.
 */
function localView(skill: InternalSkill, here: Here): { path: string; projectPath?: string } {
  if (skill.scope !== "project") return { path: skill.locations[0]?.path ?? skill.path };
  const mine = skill.locations.find((location) => here.roots.includes(resolve(dirname(location.path))));
  return mine ? { path: mine.path, projectPath: here.projectRoot } : { path: skill.locations[0]?.path ?? skill.path, ...(skill.projectPath ? { projectPath: skill.projectPath } : {}) };
}

/** Shadows worked out from what an agent here sees: each skill at its place in this workspace. */
function shadowsHere(skills: InternalSkill[], here: Here): Map<string, Shadow[]> {
  return shadowsFor(skills.map((skill) => ({ id: skill.id, name: skill.name, scope: skill.scope, readBy: skill.readBy, state: skill.state, ...(localView(skill, here).projectPath ? { projectPath: localView(skill, here).projectPath } : {}) })));
}

function panelSkill(skill: InternalSkill, agent: string, shadows: Map<string, Shadow[]>, here: Here): PanelSkill {
  const { path, projectPath } = localView(skill, here);
  return {
    skillId: skill.id,
    name: skill.name,
    description: skill.description,
    provenance: skill.provenance,
    scope: skill.scope,
    listingChars: agent === "codex" ? skill.listing.codex : agent === "claude" ? skill.listing.claude : 0,
    state: skill.state[agent] ?? "on",
    ...(projectPath ? { projectPath } : {}),
    where: friendlyRef(path, { home: userHome(), projectPath }),
    path,
    shadows: shadows.get(skill.id) ?? [],
  };
}

/** Skills an agent of `agent` started in `directory` with this account can use: its user-level ones plus the project's. */
async function skillsFor(discovery: SkillsDiscovery, agent: string, accountId: string | undefined, directory: string): Promise<InternalSkill[]> {
  const projectPaths = new Set((await projectRoots(new Probe(), directory)).filter((root) => root.agents.includes(agent)).map((root) => resolve(root.path)));
  return discovery.skills.filter((skill) => {
    if (!skill.readBy.includes(agent)) return false;
    if (skill.scope === "project") return skill.locations.some((location) => projectPaths.has(resolve(join(location.path, ".."))));
    if (agent === "claude") return accountId ? skill.claudeAccounts.includes(accountId) : true;
    if (agent === "codex") return accountId ? skill.codexAccounts.includes(accountId) : true;
    return true;
  });
}

function costOf(discovery: SkillsDiscovery, agent: string, accountId: string | undefined, skills: InternalSkill[], window?: AccountWindow): ListingCost | undefined {
  const base = discovery.costs.find((entry) => entry.agent === agent && (!accountId || entry.accountId === accountId));
  if (!base) return undefined;
  const chars = skills.reduce((sum, skill) => sum + (agent === "claude" ? skill.listing.claude : skill.listing.codex), 0);
  const count = skills.filter((skill) => (agent === "claude" ? skill.listing.claude : skill.listing.codex) > 0).length;
  const known = window ?? (base.budgetKnown ? { contextTokens: base.budgetChars / 0.04, ...(base.model ? { model: base.model } : {}), from: "settings" as const } : undefined);
  return { ...cost(agent, base.accountId ?? "", base.label, count, chars, agent === "claude" ? known : undefined), note: "Including this project's own skills." };
}

function named(discovery: SkillsDiscovery, counts: Map<string, number>) {
  const byName = new Map<string, InternalSkill>();
  for (const skill of discovery.skills) {
    byName.set(skill.name.toLowerCase(), skill);
    if (!byName.has(skill.folder.toLowerCase())) byName.set(skill.folder.toLowerCase(), skill);
  }
  return [...counts]
    .map(([name, count]) => {
      const skill = byName.get(name.toLowerCase()) ?? byName.get(name.toLowerCase().split(":").pop() ?? "");
      return { name: skill?.name ?? name, count, ...(skill ? { skillId: skill.id } : {}) };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Keep a logged name when the model chose it, or when it names a skill here. */
function keepFor(discovery: SkillsDiscovery): (name: string, modelUses: number) => boolean {
  const known = new Set(discovery.skills.flatMap((skill) => [skill.name.toLowerCase(), skill.folder.toLowerCase()]));
  return (name, modelUses) => modelUses > 0 || known.has(name.toLowerCase()) || known.has(name.toLowerCase().split(":").pop() ?? "");
}

type AgentFacts = { sessionIds: string[]; cwd?: string; createdAt?: number; provider?: string; model?: string };

/** What Paseo says about one agent: its chat ids (Claude session, Codex thread) when the SDK has them. Never throws. */
async function agentFacts(paseo: Paseo, agentId: string): Promise<AgentFacts | null> {
  const agents = (paseo as unknown as { agents?: { ref?: (id: string) => { refresh?: () => Promise<unknown>; current?: () => unknown } } }).agents;
  if (!agents?.ref) return null;
  try {
    const handle = agents.ref(agentId);
    if (handle.refresh) await withDeadline(handle.refresh(), "the agent's details", 5_000);
    const snap = handle.current?.() as { cwd?: string; createdAt?: string; provider?: string; model?: string | null; persistence?: { sessionId?: string; nativeHandle?: string } | null } | null | undefined;
    if (!snap) return null;
    const created = snap.createdAt ? Date.parse(snap.createdAt) : NaN;
    return {
      sessionIds: [snap.persistence?.sessionId, snap.persistence?.nativeHandle].filter((value): value is string => typeof value === "string" && value.length > 0),
      ...(snap.cwd ? { cwd: snap.cwd } : {}),
      ...(Number.isFinite(created) ? { createdAt: created } : {}),
      ...(snap.provider ? { provider: snap.provider } : {}),
      ...(snap.model ? { model: snap.model } : {}),
    };
  } catch {
    return null;
  }
}

export async function handleSkillsAgent({ workspaceId, providerId, agentId }: { workspaceId: string; providerId: string; agentId?: string }, { paseo }: Ctx) {
  const directory = await workspaceDirectory(paseo, workspaceId);
  const discovery = await discoverSkills(paseo);
  const { agent, account } = accountForProvider(discovery.accounts, providerId);
  const notes: string[] = [];
  const skills = await skillsFor(discovery, agent, account?.id, directory);
  if (agent !== "claude" && agent !== "codex") notes.push("This plugin counts skill use for Claude and Codex only.");
  let chat = { match: "unknown", skills: [] as Array<{ name: string; count: number; skillId?: string }>, note: "Which skills this chat used can't be told for this agent." };
  const usageOn = discovery.settings.skillsUsage;
  const facts = agentId && (agent === "claude" || agent === "codex") ? await agentFacts(paseo, agentId) : null;
  if (!usageOn) chat = { ...chat, note: "Counting skill use is turned off in the settings." };
  else if (agentId && (agent === "claude" || agent === "codex")) {
    const exact = facts?.sessionIds.length ? chatUsage(facts.sessionIds, keepFor(discovery)) : null;
    if (exact && exact.size) chat = { match: "exact", skills: named(discovery, exact), note: "" };
    else if (facts?.sessionIds.length && usageState(true).state === "ready") chat = { match: "exact", skills: [], note: "" };
    else if (facts?.createdAt) {
      const guessed = folderUsage(facts.cwd ?? directory, facts.createdAt, keepFor(discovery), agent);
      chat = { match: "folder-time", skills: named(discovery, guessed), note: "Matched by this agent's folder and start time, so other chats in the same folder since then are counted too." };
    }
  }
  // This agent's own model decides Claude's budget, when Paseo says which it is.
  const window = agent === "claude" && account ? agentWindow(facts?.model, (await claudeWindows(paseo, discovery.accounts, new Probe())).get(account.id)) : undefined;
  const listCost = costOf(discovery, agent, account?.id, skills, window);
  const here = await hereFor(directory);
  const shadows = shadowsHere(skills, here);
  return {
    agent,
    directory,
    skills: skills.map((skill) => panelSkill(skill, agent, shadows, here)),
    ...(listCost ? { cost: listCost } : {}),
    chat,
    notes,
  };
}

export async function handleSkillsWorkspace({ workspaceId }: { workspaceId: string }, { paseo }: Ctx) {
  const directory = await workspaceDirectory(paseo, workspaceId);
  const discovery = await discoverSkills(paseo);
  const agents = [];
  const found: Array<{ agent: string; skills: InternalSkill[]; cost?: ListingCost }> = [];
  for (const agent of ["claude", "codex"]) {
    const account = discovery.accounts.accounts.find((entry) => entry.agent === agent && entry.origin === "default" && entry.exists);
    const skills = await skillsFor(discovery, agent, account?.id, directory);
    const cost = costOf(discovery, agent, account?.id, skills);
    found.push({ agent, skills, ...(cost ? { cost } : {}) });
  }
  // Which copy each agent uses when a name is at both levels here (0.6.0).
  const here = await hereFor(directory);
  const shadows = shadowsHere([...new Map(found.flatMap((entry) => entry.skills).map((skill) => [skill.id, skill])).values()], here);
  for (const { agent, skills, cost } of found) agents.push({ agent, skills: skills.map((skill) => panelSkill(skill, agent, shadows, here)), ...(cost ? { cost } : {}) });
  const notes: string[] = [];
  let used: Array<{ name: string; count: number; skillId?: string }> = [];
  if (!discovery.settings.skillsUsage) notes.push("Counting skill use is turned off in the settings.");
  else {
    used = named(discovery, folderUsage(directory, Date.now() - discovery.settings.skillsWindowDays * 86_400_000, keepFor(discovery)));
    const state = usageState(true);
    if (state.note) notes.push(state.note);
  }
  return { directory, agents, used, notes };
}

// ------------------------------------------------------------------ add

export async function handleSkillsPreview({ source }: { source: AddSource }, { paseo }: Ctx) {
  return previewSkill(paseo, source);
}

export async function handleSkillsAdd(input: { source: AddSource; planHash: string; confirmScripts?: boolean }, { paseo }: Ctx) {
  const settings = await readMemoriesSettings();
  return addSkill(paseo, input, settings.backupsToKeep);
}

// ------------------------------------------------------------------ turn off / on

/**
 * Claude Code honours `skillOverrides` in user, project, local and managed
 * settings, matched by skill name; plugin skills are not affected
 * (https://code.claude.com/docs/en/skills, "Override skill visibility from
 * settings"). This writes the account's user `settings.json`.
 */
const OVERRIDE_KEY = "skillOverrides";

/** Claude's user settings with one skill's override set (off) or taken out (on). */
function claudeSettingsText(current: string | null, name: string, on: boolean): { text: string } | { error: string } {
  let value: Record<string, unknown> = {};
  if (current !== null && current.trim() !== "") {
    try {
      const parsed = JSON.parse(current) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "Claude's settings file isn't a settings object, so it was left as it is." };
      value = parsed as Record<string, unknown>;
    } catch {
      return { error: "Claude's settings file can't be read (it isn't valid JSON), so it was left as it is." };
    }
  }
  const existing = value[OVERRIDE_KEY];
  if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) return { error: "Claude's settings set skill switches in a shape this plugin doesn't change." };
  const overrides = { ...((existing as Record<string, unknown>) ?? {}) };
  if (on) delete overrides[name];
  else overrides[name] = "off";
  const next = { ...value };
  if (Object.keys(overrides).length) next[OVERRIDE_KEY] = overrides;
  else delete next[OVERRIDE_KEY];
  const newline = current === null || current.endsWith("\n") ? "\n" : "";
  return { text: `${JSON.stringify(next, null, 2)}${newline}` };
}

function claudeOverrideOf(text: string, name: string): string | undefined {
  try {
    const value = (JSON.parse(text) as { skillOverrides?: Record<string, unknown> }).skillOverrides?.[name];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The name Codex keys its switches on: the skill's own name, else its folder's. */
function codexName(skill: InternalSkill): string {
  return skill.header.name || skill.folder;
}

export async function handleSkillsToggle({ skillId, agent, on, accountId }: { skillId: string; agent: string; on: boolean; accountId?: string }, { paseo }: Ctx) {
  const found = await findSkill(paseo, skillId);
  if (!found) return result(false, "That skill is no longer there. Refresh the list.", []);
  const { skill, discovery } = found;
  if (!skill.can.turnOff.includes(agent)) return result(false, skill.can.turnOffReason ?? `This skill can't be turned ${on ? "on" : "off"} for that agent here.`, []);
  const accountIds = (agent === "claude" ? skill.claudeAccounts : skill.codexAccounts).filter((id) => !accountId || id === accountId);
  if (!accountIds.length) return result(false, "No account of that agent reads this skill.", []);
  startWrite();
  forgetSkills();
  const settings = await readMemoriesSettings();
  const session = newSession(settings.backupsToKeep);
  const reports: WriteReport[] = [];
  for (const id of accountIds) {
    const account = discovery.accounts.accounts.find((entry) => entry.id === id);
    if (!account) continue;
    if (agent === "claude") {
      const path = join(account.dir, "settings.json");
      const current = await readCurrent(path);
      const next = claudeSettingsText(current.exists ? current.text : null, skill.name, on);
      if ("error" in next) {
        reports.push({ target: path, ok: false, action: "refused", readBack: "skipped", error: next.error });
        continue;
      }
      const report = await safeWrite(session, path, next.text, { newMode: 0o600, current, check: (text) => (claudeOverrideOf(text, skill.name) === "off") === !on });
      reports.push(report);
      logWrite("skills-toggle", path, report.ok ? report.action : "failed");
    } else {
      const path = join(account.dir, "config.toml");
      const current = await readCurrent(path);
      const name = codexName(skill);
      const paths = skillMdPaths(skill);
      const next = setSkillEnabled(current.exists ? current.text : "", name, on, paths);
      if ("error" in next) {
        reports.push({ target: path, ok: false, action: "refused", readBack: "skipped", error: next.error });
        continue;
      }
      const report = await safeWrite(session, path, next.text, { newMode: 0o600, current, check: (text) => codexSkillEnabled(text, name, paths) === on });
      reports.push(report);
      logWrite("skills-toggle", path, report.ok ? report.action : "failed");
    }
  }
  forgetSkills();
  const ok = reports.length > 0 && reports.every((report) => report.ok);
  const who = agent === "claude" ? "Claude" : "Codex";
  return result(ok, ok ? `${skill.name} is ${on ? "on" : "off"} for ${who}. New chats see the change; open ones may need a restart.` : reports.find((report) => !report.ok)?.error ?? "Nothing was changed.", reports);
}

// ------------------------------------------------------------------ remove

async function removeLockEntry(session: Session, name: string): Promise<WriteReport | null> {
  const path = skillLockPath();
  const current = await readCurrent(path);
  if (!current.exists) return null;
  const read = readLock(current.text);
  if (!read.ok) return { target: path, ok: false, action: "refused", readBack: "skipped", error: read.reason };
  if (!(name in read.lock.skills)) return null;
  return safeWrite(session, path, serializeLock(withoutEntry(read.lock, name)), { newMode: 0o644, current, check: lockLooksValid });
}

export async function handleSkillsRemove({ skillId }: { skillId: string; confirm?: boolean }, { paseo }: Ctx) {
  const found = await findSkill(paseo, skillId);
  if (!found) return result(false, "That skill is no longer there. Refresh the list.", []);
  const { skill } = found;
  if (!skill.can.remove) return result(false, skill.can.removeReason ?? "This plugin won't remove that skill.", []);
  // Every link must be one this plugin may take away, or nothing is done (no half-removed skill).
  for (const location of skill.locations) {
    if (!location.link) continue;
    const refused = await skillParentReason(dirname(location.path), "remove");
    if (refused) return result(false, `Something outside your own skills folders links to ${skill.name} (${location.root.startsWith("project") ? "a project" : "a folder this plugin doesn't change"}), so it was left as it is. Remove that link first.`, []);
  }
  const home = skill.homeRoot!;
  const homeReal = await fs.realpath(home.path).catch(() => home.path);
  const ownsFolder = resolve(join(skill.path, "..")) === resolve(homeReal) && home.userFolder;
  // And the folder itself must be one the backups can take, before any link goes (review-040 #4).
  if (ownsFolder) {
    const refused = await moveRefusal(skill.path);
    if (refused) return result(false, refused, []);
  }
  startWrite();
  forgetSkills();
  const settings = await readMemoriesSettings();
  const session = newSession(settings.backupsToKeep);
  const reports: WriteReport[] = [];
  // Links first (each in a folder of the user's own), then the folder itself.
  for (const location of skill.locations) {
    if (!location.link) continue;
    const report = await moveToBackup(session, location.path);
    reports.push(report);
    logWrite("skills-remove", location.path, report.ok ? "link removed" : report.action);
  }
  if (ownsFolder) {
    const report = await moveToBackup(session, skill.path);
    reports.push(report);
    logWrite("skills-remove", skill.path, report.ok ? "moved to backups" : report.action);
    if (report.ok) {
      if (skill.provenance === "npx-skills" || skill.provenance === "added-here") {
        const lock = await removeLockEntry(session, skill.folder);
        if (lock) reports.push(lock);
      }
      await forgetAdded(skill.path);
    }
  }
  forgetSkills();
  const ok = reports.length > 0 && reports.every((report) => report.ok);
  const linkOnly = !ownsFolder;
  return result(
    ok,
    ok
      ? linkOnly
        ? `Removed the link to ${skill.name}; the folder it pointed to is untouched.`
        : `Removed ${skill.name}. A copy is in this plugin's backups if you want it back.`
      : reports.find((report) => !report.ok)?.error ?? "Nothing was removed.",
    reports,
  );
}

// ------------------------------------------------------------------ fix ("Worth a look")

export async function handleSkillsFix({ findingId }: { findingId: string }, { paseo }: Ctx) {
  const discovery = await discoverSkills(paseo, { refresh: true });
  const plan = discovery.fixes.get(findingId);
  if (!plan) return result(false, "That's already sorted, or it changed since you looked. Refresh the list.", []);
  startWrite();
  forgetSkills();
  const settings = await readMemoriesSettings();
  const reports = await applyFix(newSession(settings.backupsToKeep), plan);
  forgetSkills();
  const ok = reports.length > 0 && reports.every((report) => report.ok);
  return result(ok, ok ? "Done. Anything taken out is in this plugin's backups." : reports.find((report) => !report.ok)?.error ?? "Nothing was changed.", reports);
}

type FixPlan = NonNullable<ReturnType<SkillsDiscovery["fixes"]["get"]>>;

async function applyFix(session: Session, plan: FixPlan): Promise<WriteReport[]> {
  const reports: WriteReport[] = [];
  if (plan.kind === "unlink" || plan.kind === "move-to-backup") reports.push(await moveToBackup(session, plan.path));
  else if (plan.kind === "remove-orphan") for (const path of plan.paths) reports.push(await moveToBackup(session, path, { paseoOrphan: true }));
  else if (plan.kind === "forget-lock-entry") {
    const report = await removeLockEntry(session, plan.name);
    if (report) reports.push(report);
  }
  for (const report of reports) logWrite("skills-fix", report.target, report.ok ? report.action : "failed");
  return reports;
}

/**
 * "Fix all" for one kind of thing worth a look (0.5.1): only the kinds whose
 * fix moves something to the backups or takes a line off the installer's
 * list, so each is undoable. Checked again first; only the items the person
 * confirmed (`findingIds`, required: never the whole kind unseen). One
 * backup session for the lot. One at a time: a second Fix all waits, then
 * finds those items already done and says so.
 */
let fixAllQueue: Promise<unknown> = Promise.resolve();

export function handleSkillsFixAll(input: { kind: string; findingIds?: string[] | undefined }, ctx: Ctx) {
  const run = fixAllQueue.then(() => skillsFixAllNow(input, ctx));
  fixAllQueue = run.catch(() => undefined);
  return run;
}

async function skillsFixAllNow({ kind, findingIds }: { kind: string; findingIds?: string[] | undefined }, { paseo }: Ctx) {
  if (!canFixAll("skills", kind)) return result(false, "Those need a look one at a time. Nothing was changed.", []);
  if (!findingIds?.length) return result(false, "Nothing was changed: Fix all needs the list of items you confirmed. Open the group and press Fix all again.", []);
  const discovery = await discoverSkills(paseo, { refresh: true });
  const wanted = new Set(findingIds);
  const plans = discovery.findings.filter((finding) => finding.kind === kind && wanted.has(finding.id)).flatMap((finding) => {
    const plan = discovery.fixes.get(finding.id);
    return plan ? [plan] : [];
  });
  // Items asked for that are no longer there to fix: done already (by another Fix all, or by hand).
  const already = wanted.size - plans.length;
  const before = already ? ` ${already} ${already === 1 ? "was" : "were"} already done.` : "";
  if (plans.length === 0) return result(true, already === 1 ? "Already done: that one was sorted already. Nothing needed changing." : `Already done: all ${already} were sorted already. Nothing needed changing.`, []);
  startWrite();
  forgetSkills();
  const session = newSession((await readMemoriesSettings()).backupsToKeep);
  const reports: WriteReport[] = [];
  for (const plan of plans) reports.push(...(await applyFix(session, plan)));
  forgetSkills();
  const failed = reports.filter((report) => !report.ok);
  const done = plans.length - new Set(failed.map((report) => report.target)).size;
  if (failed.length) return result(false, `Fixed ${done} of ${plans.length}. ${failed[0]!.error ?? "Some could not be changed."} Anything taken out is in this plugin's backups.${before}`, reports);
  return result(true, `Fixed all ${plans.length}. Anything taken out is in this plugin's backups.${before}`, reports);
}

// ------------------------------------------------------------------ link it for Claude

export async function handleSkillsLink({ skillId }: { skillId: string }, { paseo }: Ctx) {
  const found = await findSkill(paseo, skillId);
  if (!found) return result(false, "That skill is no longer there. Refresh the list.", []);
  const { skill, discovery } = found;
  if (!skill.can.link) return result(false, "Every Claude account already sees this skill.", []);
  startWrite();
  forgetSkills();
  const reports: WriteReport[] = [];
  for (const account of discovery.accounts.accounts) {
    if (account.agent !== "claude" || !account.exists || skill.claudeAccounts.includes(account.id)) continue;
    const report = await createSkillLink(join(account.dir, "skills"), skill.folder, skill.path);
    reports.push(report);
    logWrite("skills-link", report.target, report.ok ? "linked" : report.action);
  }
  forgetSkills();
  const ok = reports.length > 0 && reports.every((report) => report.ok);
  return result(ok, ok ? `Claude can use ${skill.name} now. New chats see it; open ones may need a restart.` : reports.find((report) => !report.ok)?.error ?? "No link was made.", reports);
}
