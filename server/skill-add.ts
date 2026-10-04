import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { repoId, parseGithubLink, type GithubLink } from "../shared/github-link";
import { maskSecrets } from "../shared/secrets";
import { ADD_LIMITS, cleanText, cutText, fileKind, planHash, safeRelativePath, type PlannedFile } from "../shared/skill-files";
import { readLock, serializeLock, withEntry, lockLooksValid, type LockEntry } from "../shared/skill-lock";
import { buildSkillMd, nameKey, parseSkillMd, RESERVED_NAMES, skillNameOk, skillProblems, SKILL_SPEC } from "../shared/skill-md";
import { catalogEntry, catalogName } from "../shared/skills-catalog";
import type { AddSource } from "../shared/skill-contracts";
import type { WriteReport } from "../shared/contracts";
import { sha256Hex } from "../shared/hash";
import type { Paseo } from "./daemon";
import { sha256 } from "./files";
import { startWrite } from "./daemon";
import { sharedSkillsDir, skillLockPath } from "./env";
import { fetchFile, fetchTree, GithubError, resolveCommit, skillFolders, type Tree } from "./github";
import { logWrite } from "./log";
import { recordAdded } from "./skill-records";
import { discoverSkills, forgetSkills, type SkillsDiscovery } from "./skills";
import { createSkillLink, installSkillFolder, newSession, readCurrent, safeWrite } from "./write";

/**
 * "Add a skill" (docs/SKILLS-SPEC.md "Manage"): a preview that downloads and
 * checks everything and returns a plan hash, then an add that writes only
 * that plan. Three sources: the curated list (pinned commits), a GitHub link
 * (pinned to the commit it resolves to), or a skill written here. Network
 * only here, only on an explicit preview or add.
 *
 * Installed like `npx skills`: one copy in `~/.agents/skills/<name>`, a link
 * in each Claude account's `skills/` (and pi's, when pi is set up here), and
 * an entry in `npx skills`' lock file.
 */

export const PLAN_CHANGED = "What would be added changed since the preview (the source, the files, or where they would go). Preview it again; nothing was added.";
export const SCRIPTS_CONFIRM = "This skill includes code your agents may run. Read the file list, then confirm to add it.";

type Prepared = {
  source: AddSource;
  sourceLabel: string;
  commit: string;
  name: string;
  description: string;
  files: Array<PlannedFile & { sha256: string; bytes: number; data: Buffer }>;
  skillMdText: string;
  lockEntry: { source: string; sourceType: string; sourceUrl: string; ref?: string; skillPath?: string; skillFolderHash: string } | null;
  warnings: string[];
  folderTree?: string;
};

type Target = { kind: "canonical" | "link" | "lock"; path: string; agent?: string; accountId?: string; label: string };

export type Preview = {
  ok: boolean;
  problem: string;
  name: string;
  description: string;
  source: string;
  commit: string;
  files: PlannedFile[];
  scripts: boolean;
  skillMd: string;
  targets: Target[];
  problems: Array<{ code: string; severity: string; message: string }>;
  warnings: string[];
  clash?: { name: string; skillId: string };
  choices: Array<{ path: string; name: string }>;
  planHash: string;
};

const EMPTY: Preview = { ok: false, problem: "", name: "", description: "", source: "", commit: "", files: [], scripts: false, skillMd: "", targets: [], problems: [], warnings: [], choices: [], planHash: "" };

// Prepared downloads, by source, for a short while: the add after a preview doesn't download again.
const PREPARED_MS = 10 * 60_000;
const prepared = new Map<string, { at: number; value: Prepared }>();

function sourceKey(source: AddSource): string {
  return JSON.stringify([source.kind, source.id ?? "", source.link ?? "", source.name ?? "", source.whenToUse ?? "", source.instructions ?? ""]);
}

function remember(key: string, value: Prepared): void {
  const now = Date.now();
  for (const [k, entry] of prepared) if (now - entry.at > PREPARED_MS) prepared.delete(k);
  while (prepared.size >= 3) prepared.delete(prepared.keys().next().value!);
  prepared.set(key, { at: now, value });
}

/** For tests. */
export function forgetPrepared(): void {
  prepared.clear();
}

class AddProblem extends Error {
  constructor(
    message: string,
    readonly choices: Array<{ path: string; name: string }> = [],
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ preparing (downloads happen here only)

async function fromGithub(link: GithubLink, expected?: { tree: string }): Promise<Omit<Prepared, "source" | "sourceLabel">> {
  const commit = await resolveCommit(link);
  const tree: Tree = await fetchTree(link, commit);
  if (tree.truncated) throw new AddProblem("That repository is too big for GitHub to list in one go. Link to the skill's own folder.");
  const base = link.path ?? "";
  const folders = skillFolders(tree).filter((folder) => (base ? folder === base || folder.startsWith(`${base}/`) : true));
  let folder: string;
  if (folders.includes(base)) folder = base;
  else if (folders.length === 1) folder = folders[0]!;
  else if (folders.length === 0) throw new AddProblem("There's no skill (no SKILL.md) at that address.");
  else throw new AddProblem(`That link holds ${folders.length} skills. Pick one.`, folders.slice(0, 50).map((path) => ({ path, name: path.split("/").pop() || link.repo })));
  const prefix = folder ? `${folder}/` : "";
  const folderTree = folder ? tree.entries.find((entry) => entry.type === "tree" && entry.path === folder)?.sha : tree.sha;
  if (expected && folderTree !== expected.tree) throw new AddProblem("That skill's files at the pinned version are not what this plugin checked. Nothing was added.");
  const inside = tree.entries.filter((entry) => entry.path.startsWith(prefix) && entry.type !== "tree");
  const warnings: string[] = [];
  if (inside.some((entry) => entry.mode === "120000")) throw new AddProblem("That skill contains links to other files, which this plugin doesn't add.");
  const submodules = inside.filter((entry) => entry.type === "commit");
  if (submodules.length) warnings.push(`${submodules.length} linked repositor${submodules.length === 1 ? "y is" : "ies are"} inside it and won't be added.`);
  const blobs = inside.filter((entry) => entry.type === "blob");
  if (blobs.length > ADD_LIMITS.files) throw new AddProblem(`That skill has ${blobs.length} files; this plugin adds at most ${ADD_LIMITS.files}.`);
  const declared = blobs.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  if (declared > ADD_LIMITS.totalBytes) throw new AddProblem(`That skill is ${Math.round(declared / 1024)} KB; this plugin adds at most ${Math.round(ADD_LIMITS.totalBytes / 1024)} KB.`);
  const files: Prepared["files"] = [];
  let total = 0;
  for (const entry of blobs) {
    const rel = entry.path.slice(prefix.length);
    if (!safeRelativePath(rel)) throw new AddProblem("A file in that skill has a name that would land outside its folder.");
    if ((entry.size ?? 0) > ADD_LIMITS.fileBytes) throw new AddProblem(`${rel} is bigger than ${Math.round(ADD_LIMITS.fileBytes / 1024)} KB.`);
    const data = await fetchFile(link, commit, entry);
    total += data.length;
    if (total > ADD_LIMITS.totalBytes) throw new AddProblem(`That skill is over ${Math.round(ADD_LIMITS.totalBytes / 1024)} KB.`);
    const executable = entry.mode === "100755";
    files.push({ path: rel, bytes: data.length, executable, kind: fileKind(rel, executable, data.subarray(0, 2)), sha256: sha256(data), data });
  }
  const skillMd = files.find((file) => file.path === "SKILL.md");
  if (!skillMd) throw new AddProblem("There's no skill (no SKILL.md) at that address.");
  let skillMdText: string;
  try {
    skillMdText = new TextDecoder("utf-8", { fatal: true }).decode(skillMd.data);
  } catch {
    throw new AddProblem("That skill's instructions are not plain text, so this plugin won't add it.");
  }
  const header = parseSkillMd(skillMdText);
  const folderName = folder ? folder.split("/").pop()! : link.repo;
  const name = skillNameOk(folderName.toLowerCase()) && folderName === folderName.toLowerCase() ? folderName : header.name && skillNameOk(header.name) ? header.name : "";
  if (!name) throw new AddProblem(`That skill's folder (${cutText(cleanText(folderName), 80)}) isn't a valid skill name (lower-case letters, digits and single hyphens).`);
  return {
    commit,
    name,
    description: cutText(cleanText(header.description ?? ""), SKILL_SPEC.descriptionMax),
    files,
    skillMdText,
    lockEntry: { source: repoId(link), sourceType: "github", sourceUrl: `https://github.com/${repoId(link)}.git`, ...(link.ref && link.ref !== commit ? { ref: link.ref } : {}), skillPath: `${prefix}SKILL.md`, skillFolderHash: folderTree ?? "" },
    warnings,
    ...(folderTree ? { folderTree } : {}),
  };
}

function fromWritten(source: AddSource): Omit<Prepared, "source" | "sourceLabel"> {
  const name = (source.name ?? "").trim();
  const when = (source.whenToUse ?? "").replace(/\s+/g, " ").trim();
  const body = (source.instructions ?? "").trim();
  if (!skillNameOk(name)) throw new AddProblem("Give it a name of lower-case letters, digits and single hyphens (up to 64), like weekly-report.");
  if (!when) throw new AddProblem("Say when agents should use it; that's how they decide.");
  if (when.length > SKILL_SPEC.descriptionMax) throw new AddProblem(`Keep "when to use it" under ${SKILL_SPEC.descriptionMax} characters.`);
  if (!body) throw new AddProblem("Write the instructions agents should follow.");
  const text = buildSkillMd(name, when, body);
  const data = Buffer.from(text, "utf8");
  return {
    commit: "",
    name,
    description: when,
    files: [{ path: "SKILL.md", bytes: data.length, executable: false, kind: "instructions", sha256: sha256Hex(text), data }],
    skillMdText: text,
    lockEntry: null,
    warnings: [],
  };
}

async function prepare(source: AddSource, useCache: boolean): Promise<Prepared> {
  const key = sourceKey(source);
  const hit = prepared.get(key);
  if (useCache && hit && Date.now() - hit.at < PREPARED_MS) return hit.value;
  let value: Prepared;
  if (source.kind === "catalog") {
    const entry = catalogEntry(source.id ?? "");
    if (!entry) throw new AddProblem("That skill isn't on this plugin's list.");
    const got = await fromGithub({ owner: entry.owner, repo: entry.repo, ref: entry.commit, path: entry.path }, { tree: entry.tree });
    if (got.name !== catalogName(entry)) throw new AddProblem("That skill's name at the pinned version is not what this plugin checked. Nothing was added.");
    value = { ...got, source, sourceLabel: `${entry.owner}/${entry.repo}` };
  } else if (source.kind === "github") {
    const link = parseGithubLink(source.link ?? "");
    if ("error" in link) throw new AddProblem(link.error);
    value = { ...(await fromGithub(link)), source, sourceLabel: repoId(link) };
  } else if (source.kind === "write") {
    value = { ...fromWritten(source), source, sourceLabel: "written here" };
  } else throw new AddProblem("Pick a skill from the list, paste a GitHub link, or write your own.");
  remember(key, value);
  return value;
}

// ------------------------------------------------------------------ where it goes (read fresh every time)

async function exists(path: string): Promise<boolean> {
  return fs.lstat(path).then(
    () => true,
    () => false,
  );
}

async function targetsFor(discovery: SkillsDiscovery, name: string): Promise<{ targets: Target[]; warnings: string[] }> {
  const warnings: string[] = [];
  const targets: Target[] = [{ kind: "canonical", path: join(sharedSkillsDir(), name), label: "The shared skills folder (Codex, OpenCode, Copilot, Gemini, Cursor and pi read it)" }];
  for (const account of discovery.accounts.accounts) {
    if (!account.exists) continue;
    if (account.agent === "claude") targets.push({ kind: "link", path: join(account.dir, "skills", name), agent: "claude", accountId: account.id, label: `A link for Claude (${account.label})` });
    if (account.agent === "pi") targets.push({ kind: "link", path: join(account.dir, "skills", name), agent: "pi", accountId: account.id, label: `A link for pi (${account.label})` });
  }
  if (discovery.lock.read.ok) targets.push({ kind: "lock", path: skillLockPath(), label: "npx skills' list of installed skills" });
  else warnings.push(`${discovery.lock.read.reason} The skill is added without an entry there.`);
  return { targets, warnings };
}

/** The same name in any spelling: an existing skill, or anything already at one of the places. */
async function clashFor(discovery: SkillsDiscovery, name: string, targets: Target[]): Promise<{ name: string; skillId: string } | null> {
  const key = nameKey(name);
  const skill = discovery.skills.find((entry) => nameKey(entry.folder) === key || nameKey(entry.name.split(":").pop() ?? entry.name) === key);
  if (skill) return { name: skill.name, skillId: skill.id };
  if (RESERVED_NAMES.has(name)) return { name, skillId: "" };
  for (const target of targets) {
    if (target.kind === "lock") continue;
    if (await exists(target.path)) return { name, skillId: "" };
    // Another spelling of the name in the same folder (`My-Skill` beside `my-skill` on a disk that tells case apart).
    const siblings = await fs.readdir(dirname(target.path)).catch(() => [] as string[]);
    if (siblings.some((entry) => nameKey(entry) === key)) return { name, skillId: "" };
  }
  if (discovery.lock.read.ok && Object.keys(discovery.lock.read.lock.skills).some((entry) => nameKey(entry) === key)) return { name, skillId: "" };
  return null;
}

function hashOf(value: Prepared, targets: Target[]): string {
  return planHash({ source: `${value.source.kind}:${value.sourceLabel}:${value.lockEntry?.skillPath ?? ""}`, commit: value.commit, name: value.name, files: value.files, targets: targets.map((target) => `${target.kind}:${target.path}`) });
}

async function plan(paseo: Paseo | null, source: AddSource, useCache: boolean): Promise<{ value: Prepared; preview: Preview }> {
  const value = await prepare(source, useCache);
  const discovery = await discoverSkills(paseo, { refresh: true });
  const { targets, warnings } = await targetsFor(discovery, value.name);
  const clash = await clashFor(discovery, value.name, targets);
  const scripts = value.files.some((file) => file.kind === "script");
  const header = parseSkillMd(value.skillMdText);
  const preview: Preview = {
    ...EMPTY,
    ok: !clash,
    problem: clash ? `You already have a skill called ${clash.name}${clash.name === value.name ? "" : ` (the same name, spelled differently)`}. Nothing will be overwritten; remove that one first or pick another skill.` : "",
    name: value.name,
    description: value.description,
    source: value.sourceLabel,
    commit: value.commit,
    files: value.files.map(({ path, bytes, kind, executable }) => ({ path, bytes, kind, executable })),
    scripts,
    skillMd: maskSecrets(value.skillMdText).text,
    targets,
    problems: skillProblems(header, value.name),
    warnings: [...value.warnings, ...warnings, ...(scripts ? [SCRIPTS_CONFIRM] : [])],
    ...(clash ? { clash } : {}),
    planHash: clash ? "" : hashOf(value, targets),
  };
  return { value, preview };
}

export async function previewSkill(paseo: Paseo | null, source: AddSource): Promise<Preview> {
  try {
    return (await plan(paseo, source, false)).preview;
  } catch (error) {
    if (error instanceof AddProblem) return { ...EMPTY, problem: error.message, choices: error.choices };
    if (error instanceof GithubError) return { ...EMPTY, problem: error.message };
    throw error;
  }
}

// ------------------------------------------------------------------ adding

export type AddResult = { ok: boolean; message: string; reports: WriteReport[]; warnings: string[]; skillId?: string; needsScriptsConfirm?: boolean };

export async function addSkill(paseo: Paseo | null, input: { source: AddSource; planHash: string; confirmScripts?: boolean }, backupsToKeep: number): Promise<AddResult> {
  let planned;
  try {
    planned = await plan(paseo, input.source, true);
  } catch (error) {
    if (error instanceof AddProblem || error instanceof GithubError) return { ok: false, message: error.message, reports: [], warnings: [] };
    throw error;
  }
  const { value, preview } = planned;
  if (!preview.ok) return { ok: false, message: preview.problem, reports: [], warnings: [] };
  if (!input.planHash || input.planHash !== preview.planHash) return { ok: false, message: PLAN_CHANGED, reports: [], warnings: [] };
  if (preview.scripts && !input.confirmScripts) return { ok: false, message: SCRIPTS_CONFIRM, reports: [], warnings: [], needsScriptsConfirm: true };

  startWrite();
  forgetSkills();
  const session = newSession(backupsToKeep);
  const reports: WriteReport[] = [];
  const warnings: string[] = [];
  const canonical = preview.targets.find((target) => target.kind === "canonical")!;
  const installed = await installSkillFolder(dirname(canonical.path), value.name, value.files.map((file) => ({ path: file.path, bytes: file.data, executable: file.executable })));
  reports.push(installed);
  logWrite("skills-add", canonical.path, installed.ok ? "ok" : installed.action);
  if (!installed.ok) {
    forgetSkills();
    return { ok: false, message: installed.error ?? "The skill could not be added.", reports, warnings };
  }
  const real = await fs.realpath(canonical.path).catch(() => canonical.path);
  for (const target of preview.targets.filter((entry) => entry.kind === "link")) {
    const report = await createSkillLink(dirname(target.path), value.name, canonical.path);
    reports.push(report);
    logWrite("skills-add", target.path, report.ok ? "linked" : report.action);
    if (!report.ok) warnings.push(`Added, but not linked for ${target.agent === "pi" ? "pi" : "Claude"} (${report.error ?? "unknown reason"}).`);
  }
  const lockTarget = preview.targets.find((target) => target.kind === "lock");
  if (lockTarget) {
    const current = await readCurrent(lockTarget.path);
    const read = readLock(current.exists ? current.text : null);
    if (!read.ok) warnings.push(`${read.reason} The skill was added without an entry there.`);
    else {
      const now = new Date().toISOString();
      const entry: LockEntry = value.lockEntry
        ? { ...value.lockEntry, installedAt: now, updatedAt: now }
        : { source: "paseo-memories", sourceType: "local", sourceUrl: canonical.path, skillFolderHash: "", installedAt: now, updatedAt: now };
      if (!current.exists) await fs.mkdir(dirname(lockTarget.path), { recursive: true, mode: 0o755 });
      const report = await safeWrite(session, lockTarget.path, serializeLock(withEntry(read.lock, value.name, entry)), { newMode: 0o644, current, check: lockLooksValid });
      reports.push(report);
      logWrite("skills-add", lockTarget.path, report.ok ? "ok" : report.action);
      if (!report.ok) warnings.push(`Added, but npx skills' list could not be updated (${report.error ?? "unknown reason"}).`);
    }
  }
  await recordAdded(real, { name: value.name, source: value.sourceLabel, commit: value.commit, addedAt: new Date().toISOString() });
  forgetSkills();
  const after = await discoverSkills(paseo, { refresh: true });
  const skill = after.skills.find((entry) => entry.path === real);
  return {
    ok: warnings.length === 0,
    message: warnings.length ? `Added ${value.name}, with ${warnings.length === 1 ? "one thing" : `${warnings.length} things`} to check.` : `Added ${value.name}. New chats can use it; chats already open may need a restart to see it.`,
    reports,
    warnings,
    ...(skill ? { skillId: skill.id } : {}),
  };
}

