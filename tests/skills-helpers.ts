/**
 * Skills on top of the test sandbox: made-up skills in every place agents
 * look, built per test inside the sandbox's temp HOME (never the fixture
 * folder, so the Memories tests see the same home they always did). Import
 * after `makeSandbox()` and before any server code.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import type { Sandbox } from "./helpers";

export type SkillsSandbox = Sandbox & {
  shared: string;
  lock: string;
  claudeSkills: string;
  slotSkills: string;
  codexSkills: string;
  piSkills: string;
  pluginDir: string;
  codexAdmin: string;
};

export function skillMd(name: string, description: string, body = "Do the thing, step by step.\n", extra = ""): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${extra}---\n\n${body}`;
}

export function writeSkill(folder: string, text: string, files: Record<string, { text: string; mode?: number }> = {}): void {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(join(folder, "SKILL.md"), text);
  for (const [path, file] of Object.entries(files)) {
    fs.mkdirSync(dirname(join(folder, path)), { recursive: true });
    fs.writeFileSync(join(folder, path), file.text, { mode: file.mode ?? 0o644 });
    if (file.mode) fs.chmodSync(join(folder, path), file.mode);
  }
}

export const LOCK_EXTRA = { dismissed: { findSkillsPrompt: true }, lastSelectedAgents: ["claude-code", "codex"] };

/** The sandbox from `makeSandbox()`, with skills everywhere. */
export function addSkills(sb: Sandbox): SkillsSandbox {
  const home = sb.home;
  const shared = join(home, ".agents", "skills");
  const lock = join(home, ".agents", ".skill-lock.json");
  const claudeSkills = join(sb.claude, "skills");
  const slotSkills = join(sb.slot.claude, "skills");
  const codexSkills = join(sb.codex, "skills");
  const piSkills = join(home, ".pi", "agent", "skills");
  const pluginDir = join(sb.claude, "plugins", "cache", "market", "toolkit", "1.0.0");
  const codexAdmin = join(sb.root, "codex-admin");
  process.env.PASEO_MEMORIES_CODEX_ADMIN_DIR = codexAdmin;
  // The running Paseo's own bundle (in real life: <server package>/dist/server/skills).
  const bundle = join(sb.root, "paseo-bundle");
  for (const name of ["paseo", "paseo-help"]) writeSkill(join(bundle, name), skillMd(name, "Bundled with Paseo."));
  process.env.PASEO_MEMORIES_PASEO_BUNDLE_DIR = bundle;

  // Shared folder: one from npx skills, one by hand with a script, Paseo's own and an orphan of Paseo's.
  writeSkill(join(shared, "alpha"), skillMd("alpha", "Plans the work before starting."));
  writeSkill(join(shared, "beta"), skillMd("beta", "Runs the release checks."), { "scripts/run.sh": { text: "#!/bin/sh\necho ok\n", mode: 0o755 } });
  writeSkill(join(shared, "paseo"), skillMd("paseo", "Paseo reference."), { ".paseo-managed-files.json": { text: '{"version":1,"files":{}}' } });
  writeSkill(join(shared, "paseo-loop"), skillMd("paseo-loop", "Old Paseo loop."), { ".paseo-managed-files.json": { text: '{"version":1,"files":{}}' } });
  writeSkill(join(shared, "dup-thing"), skillMd("dup-thing", "First wording."));
  fs.writeFileSync(
    lock,
    JSON.stringify(
      {
        version: 3,
        skills: {
          alpha: { source: "acme/skills", sourceType: "github", sourceUrl: "https://github.com/acme/skills.git", skillPath: "skills/alpha/SKILL.md", skillFolderHash: "a".repeat(40), installedAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
          ghost: { source: "acme/skills", sourceType: "github", sourceUrl: "https://github.com/acme/skills.git", skillPath: "skills/ghost/SKILL.md", skillFolderHash: "b".repeat(40), installedAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
        },
        ...LOCK_EXTRA,
      },
      null,
      2,
    ),
  );

  // Claude, default account: a link to the shared copy, its own skills, and every kind of mess.
  fs.mkdirSync(claudeSkills, { recursive: true });
  fs.symlinkSync("../../.agents/skills/alpha", join(claudeSkills, "alpha"));
  writeSkill(join(claudeSkills, "own-skill"), skillMd("own-skill", "Writes the weekly summary."));
  writeSkill(join(claudeSkills, "dup-thing"), skillMd("dup-thing", "Second wording, different."));
  writeSkill(join(claudeSkills, "Bad_Name"), skillMd("Bad_Name", "Has a name agents may refuse."));
  writeSkill(join(claudeSkills, "no-header"), "Just instructions, no header at all.\n");
  fs.mkdirSync(join(claudeSkills, "empty-one"));
  fs.mkdirSync(join(claudeSkills, "readme-only"));
  fs.writeFileSync(join(claudeSkills, "readme-only", "README.md"), "Not a skill.\n");
  fs.writeFileSync(join(claudeSkills, "pack.zip"), "PK fake");
  fs.symlinkSync("../../nowhere/broken", join(claudeSkills, "broken"));
  writeSkill(join(claudeSkills, "synced", "org1_acct1", "drawing"), skillMd("drawing", "Draws diagrams (from claude.ai)."));
  fs.writeFileSync(join(claudeSkills, "synced", ".bucket-org1_acct1"), "");
  writeSkill(join(claudeSkills, "picky"), skillMd("picky", "Only when a person asks.", undefined, "disable-model-invocation: true\n"));

  // A Claude plugin, enabled, and one turned off.
  writeSkill(join(pluginDir, "skills", "deploy"), skillMd("deploy", "Deploys the site."));
  const offDir = join(sb.claude, "plugins", "cache", "market", "off", "1.0.0");
  writeSkill(join(offDir, "skills", "hidden"), skillMd("hidden", "From a plugin that is off."));
  fs.writeFileSync(
    join(sb.claude, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "toolkit@market": [{ scope: "user", installPath: pluginDir, version: "1.0.0" }], "off@market": [{ scope: "user", installPath: offDir, version: "1.0.0" }] } }),
  );
  fs.writeFileSync(join(sb.claude, "settings.json"), `${JSON.stringify({ theme: "dark", autoMemoryEnabled: true, enabledPlugins: { "toolkit@market": true, "off@market": false } }, null, 2)}\n`);

  // The slot account: one skill of its own.
  writeSkill(join(slotSkills, "slot-skill"), skillMd("slot-skill", "Only the slot account has this."));

  // Codex: an old-style user skill, a built-in one, and broken links.
  writeSkill(join(codexSkills, "legacy-x"), skillMd("legacy-x", "An older Codex skill."));
  writeSkill(join(codexSkills, ".system", "openai-docs"), skillMd("openai-docs", "Codex's own docs skill."));
  fs.symlinkSync(join(sb.root, "gone", "gstack-a"), join(codexSkills, "gstack-a"));

  // pi, managed, Codex admin.
  writeSkill(join(piSkills, "pi-only"), skillMd("pi-only", "A pi skill."));
  writeSkill(join(sb.managed, ".claude", "skills", "corp-policy"), skillMd("corp-policy", "The organisation's rules."));
  writeSkill(join(codexAdmin, "admin-skill"), skillMd("admin-skill", "Set up for everyone."));

  // A project: Claude's and the shared project folders.
  writeSkill(join(sb.app, ".claude", "skills", "app-helper"), skillMd("app-helper", "Knows this app's layout."));
  writeSkill(join(sb.app, ".agents", "skills", "app-shared"), skillMd("app-shared", "Shared by every agent in this app."));

  return { ...sb, shared, lock, claudeSkills, slotSkills, codexSkills, piSkills, pluginDir, codexAdmin };
}

// ------------------------------------------------------------------ chat logs

export function claudeSkillLine(skill: string, at: string, session: string, cwd: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ parentUuid: null, isSidechain: false, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Using a skill." }, { type: "tool_use", id: "toolu_1", name: "Skill", input: { skill } }] }, timestamp: at, sessionId: session, cwd, version: "2.1.280", ...extra });
}

export function claudeCommandLine(command: string, at: string, session: string, cwd: string, asBlocks = false): string {
  const text = `<command-message>${command}</command-message>\n<command-name>/${command}</command-name>`;
  return JSON.stringify({ type: "user", message: { role: "user", content: asBlocks ? [{ type: "text", text }] : text }, timestamp: at, sessionId: session, cwd });
}

export function claudeNoiseLine(at: string, session: string, cwd: string, size = 200): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(size) }] }, timestamp: at, sessionId: session, cwd });
}

export function codexMetaLine(thread: string, cwd: string, at: string): string {
  return JSON.stringify({ timestamp: at, type: "session_meta", payload: { id: thread, cwd, originator: "codex_cli_rs" } });
}

export function codexTurnLine(cwd: string, at: string): string {
  return JSON.stringify({ timestamp: at, type: "turn_context", payload: { cwd, model: "gpt-5", note: "skills listed: /x/skills/alpha/SKILL.md" } });
}

export function codexSkillBlockLine(name: string, at: string): string {
  return JSON.stringify({ timestamp: at, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `<skill>\n<name>${name}</name>\n<path>/h/.agents/skills/${name}/SKILL.md</path>\n</skill>` }] } });
}

export function codexReadLine(name: string, at: string, kind: "function_call" | "custom_tool_call" = "function_call"): string {
  const payload = kind === "function_call" ? { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", `cat ~/.agents/skills/${name}/SKILL.md`] }) } : { type: "custom_tool_call", name: "exec", input: `sed -n 1,80p /h/.codex/skills/${name}/SKILL.md` };
  return JSON.stringify({ timestamp: at, type: "response_item", payload });
}

/** Instructions that mention a SKILL.md but are not a use (a developer message listing skills). */
export function codexListingLine(at: string): string {
  return JSON.stringify({ timestamp: at, type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "Skills: /h/.agents/skills/beta/SKILL.md" }] } });
}

export function writeLines(path: string, lines: string[], append = false): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  (append ? fs.appendFileSync : fs.writeFileSync)(path, lines.map((line) => `${line}\n`).join(""));
}

export function blobSha(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function isoDaysAgo(days: number, hour = 12): string {
  const date = new Date(Date.now() - days * 86_400_000);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

// ------------------------------------------------------------------ a fake GitHub

export type FakeRepo = { owner: string; repo: string; commit: string; files: Record<string, { text: string; mode?: string }>; folderTrees?: Record<string, string>; /** The commit is on the default branch (compare API "behind"); false: "diverged". */ onMainLine?: boolean };

/** Answers the GitHub API and raw downloads for the repositories given; counts every call. */
export function fakeGithub(repos: FakeRepo[]) {
  const calls: string[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push(url);
    for (const repo of repos) {
      const api = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
      if (url === api) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      if (url.startsWith(`${api}/compare/`)) return new Response(JSON.stringify({ status: repo.onMainLine === false ? "diverged" : "behind" }), { status: 200 });
      if (url.startsWith(`${api}/commits/`)) return new Response(repo.commit, { status: 200 });
      if (url.startsWith(`${api}/git/trees/`)) {
        const folders = new Set<string>();
        for (const path of Object.keys(repo.files)) {
          const parts = path.split("/");
          for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
        }
        const tree = [
          ...[...folders].map((path) => ({ path, mode: "040000", type: "tree", sha: repo.folderTrees?.[path] ?? createHash("sha1").update(`tree:${path}`).digest("hex") })),
          ...Object.entries(repo.files).map(([path, file]) => ({ path, mode: file.mode ?? "100644", type: file.mode === "120000" ? "blob" : "blob", sha: blobSha(Buffer.from(file.text)), size: Buffer.byteLength(file.text) })),
        ];
        return new Response(JSON.stringify({ sha: createHash("sha1").update(repo.commit).digest("hex"), tree, truncated: false }), { status: 200 });
      }
      const raw = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.commit}/`;
      if (url.startsWith(raw)) {
        const path = url.slice(raw.length).split("/").map(decodeURIComponent).join("/");
        const file = repo.files[path];
        if (file) return new Response(file.text, { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, fetchImpl };
}
