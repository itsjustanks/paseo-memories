/**
 * Where skills and memories apply (0.6.0): "Everywhere" or "This project ·
 * <name>", friendly file references, which copy an agent uses when a name is
 * at both levels, and the panels' grouping. Fixture sandbox only.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after } from "node:test";
import { fakePaseo, makeSandbox } from "./helpers";
import { addSkills, skillMd, writeSkill } from "./skills-helpers";

const base = await makeSandbox();
const sb = addSkills(base);
// The same names at both levels in the app: `alpha` for Claude only (.claude/skills), `beta` in the shared project folder.
writeSkill(join(sb.app, ".claude", "skills", "alpha"), skillMd("alpha", "The app's own alpha."));
writeSkill(join(sb.app, ".agents", "skills", "beta"), skillMd("beta", "The app's own beta."));
const { SCOPE_WORDS, friendlyRef, scopeKind, scopeLabel, scopeMove, shadowLine, shadowsFor } = await import("../shared/scope");
const { groupOf, readers, scopedItems, scopedSkills } = await import("../client/scope-view");
const { handleSkillsWorkspace } = await import("../server/skill-handlers");
const { forgetSkillCaches } = await import("../server/skills");
const { plainAgent } = await import("../shared/plain");
after(() => sb.cleanup());

test("scope: project-level only in a project; yours, managed, plugin and built-in apply everywhere", () => {
  assert.equal(scopeKind({ scope: "project" }), "project");
  for (const scope of ["user", "managed", "plugin", "host", undefined]) assert.equal(scopeKind({ scope }), "everywhere", String(scope));
  assert.equal(scopeLabel({ scope: "user" }), "Everywhere");
  assert.equal(scopeLabel({ scope: "project", projectPath: "/work/project-hub" }), "This project · project-hub");
  assert.equal(scopeLabel({ scope: "project", projectPath: "/work/project-hub" }, () => "project-hub (in work)"), "This project · project-hub (in work)");
  assert.equal(scopeLabel({ scope: "project" }), "Everywhere", "no project known: not claimed for one");
  assert.equal(scopeMove(SCOPE_WORDS.everywhere, SCOPE_WORDS.project("project-hub")), "From Everywhere → This project · project-hub");
});

test("friendly references: the project's name and its own path, or ~ for your home", () => {
  assert.equal(friendlyRef("/work/project-hub/.claude/skills/foo", { home: "/Users/sam", projectPath: "/work/project-hub" }), "project-hub · .claude/skills/foo");
  assert.equal(friendlyRef("/Users/sam/.claude/skills/foo", { home: "/Users/sam", projectPath: "/work/project-hub" }), "~/.claude/skills/foo");
  assert.equal(friendlyRef("/etc/codex/skills/x", { home: "/Users/sam" }), "/etc/codex/skills/x");
  assert.equal(friendlyRef("/work/project-hubby/CLAUDE.md", { projectPath: "/work/project-hub" }), "/work/project-hubby/CLAUDE.md", "a sibling folder isn't inside the project");
});

test("shadowing: Claude runs your Everywhere copy; Codex lists both", () => {
  const skills = [
    { id: "u-deploy", name: "deploy", scope: "user", readBy: ["claude", "codex"] },
    { id: "p-deploy", name: "deploy", scope: "project", projectPath: "/work/project-hub", readBy: ["claude", "codex"] },
    { id: "u-solo", name: "solo", scope: "user", readBy: ["claude"] },
    { id: "p-codex", name: "solo", scope: "project", projectPath: "/work/other", readBy: ["codex"] },
  ];
  const shadows = shadowsFor(skills);
  assert.deepEqual(shadows.get("u-deploy"), [
    { agent: "claude", state: "used", projects: ["project-hub"], over: "project" },
    { agent: "codex", state: "both", projects: ["project-hub"] },
  ]);
  assert.deepEqual(shadows.get("p-deploy"), [
    { agent: "claude", state: "skipped", projects: ["project-hub"], by: "personal" },
    { agent: "codex", state: "both", projects: ["project-hub"] },
  ]);
  assert.equal(shadows.has("u-solo"), false, "Claude's copy and Codex's copy never meet");
  assert.equal(shadowLine(shadows.get("p-deploy"), plainAgent, "project"), "Claude uses your Everywhere copy of this name instead. Codex lists both this and your Everywhere copy.");
  assert.equal(shadowLine(shadows.get("u-deploy"), plainAgent, "everywhere"), "In project-hub, Claude uses this copy, not the project's own. In project-hub, Codex lists both copies.");
  assert.equal(shadowLine(undefined, plainAgent, "everywhere"), "");
});

test("the workspace panel's skills: where each applies, its folder in friendly form, and the shadows, from the host", async () => {
  forgetSkillCaches();
  const workspace = await handleSkillsWorkspace({ workspaceId: "ws-app" }, { paseo: fakePaseo(sb).api } as never);
  const claude = workspace.agents.find((entry) => entry.agent === "claude")!;
  const mine = claude.skills.find((skill) => skill.name === "alpha" && skill.scope === "project")!;
  const yours = claude.skills.find((skill) => skill.name === "alpha" && skill.scope !== "project")!;
  assert.ok(mine && yours, "both alphas are listed for Claude here");
  assert.equal(mine.where, "app · .claude/skills/alpha");
  assert.ok(yours.where!.startsWith("~/"), String(yours.where));
  assert.deepEqual(mine.shadows.map((shadow) => [shadow.agent, shadow.state]), [["claude", "skipped"]]);
  assert.ok(yours.shadows.some((shadow) => shadow.agent === "claude" && shadow.state === "used"));
  const grouped = scopedSkills(workspace.agents);
  assert.ok(grouped.project.some((entry) => entry.skill.name === "alpha"));
  assert.equal(grouped.project.some((entry) => entry.scope !== "project"), false);
  assert.equal(grouped.project[0]!.shadows.length > 0, true, "a name at both levels lists first");
});

test("the panels' items: this project's own, then everywhere; each once, with every agent that reads it", () => {
  const plan = (agent: string, items: Array<Partial<import("../shared/contracts").LoadItem>>) => ({ agent, directory: "/work/project-hub", items: items.map((item, order) => ({ order, label: item.path ?? "x", kind: "claude-md", when: "launch", bytes: 40, loadedBytes: 40, tokens: 10, truncated: false, note: "", ...item })), total: { bytes: 0, tokens: 0 }, notes: [], unsure: [] });
  const plans = [
    plan("claude", [
      { path: "/Users/sam/.claude/CLAUDE.md", scope: "user" },
      { path: "/work/project-hub/CLAUDE.md", scope: "project" },
      { path: "/work/project-hub/AGENTS.md", scope: "project", kind: "agents-md", when: "skipped" },
      { path: "/work/project-hub/gone.md", scope: "project", when: "missing" },
    ]),
    plan("codex", [{ path: "/work/project-hub/AGENTS.md", scope: "project", kind: "agents-md" }]),
  ];
  const view = scopedItems(plans, { home: "/Users/sam", directory: "/work/project-hub", plain: false });
  assert.deepEqual(view.project.map((entry) => [entry.where, entry.agents.join("+"), entry.skippedBy.join("+"), entry.when]), [
    ["project-hub · CLAUDE.md", "claude", "", "launch"],
    ["project-hub · AGENTS.md", "codex", "claude", "launch"],
  ]);
  assert.deepEqual(view.everywhere.map((entry) => entry.where), ["~/.claude/CLAUDE.md"]);
  assert.equal(readers(["claude", "codex"]), "Claude and Codex");
});

test("the Skills list groups by where a skill applies", () => {
  assert.equal(groupOf({ access: "editable", scope: "user" }), "everywhere");
  assert.equal(groupOf({ access: "editable", scope: "project", projectPath: "/work/project-hub" }), "project:/work/project-hub");
  assert.equal(groupOf({ access: "read-only", scope: "plugin" }), "other");
});

test("a file read by two agents keeps the larger read, and a path written from home is still in its project", () => {
  const plan = (agent: string, when: string, tokens: number) => ({ agent, directory: "/Users/sam/code/app", items: [{ order: 0, label: "AGENTS.md", kind: "agents-md", path: "~/code/app/AGENTS.md", when, bytes: 4, loadedBytes: 4, tokens, truncated: false, note: "", scope: "project" }], total: { bytes: 0, tokens: 0 }, notes: [], unsure: [] });
  const view = scopedItems([plan("claude", "skipped", 0), plan("codex", "launch", 5000)], { home: "/Users/sam", directory: "/Users/sam/code/app", plain: false });
  assert.deepEqual(view.project.map((entry) => [entry.where, entry.when, entry.tokens]), [["app · AGENTS.md", "launch", 5000]]);
});

test("one file is one row however plans write it; a file without a scope inside the project is the project's", () => {
  const plan = (agent: string, items: Array<Record<string, unknown>>) => ({ agent, directory: "/Users/sam/code/app", items: items.map((item, order) => ({ order, kind: "claude-md", when: "launch", bytes: 4, loadedBytes: 4, tokens: 10, truncated: false, note: "", ...item })), total: { bytes: 0, tokens: 0 }, notes: [], unsure: [] }) as never;
  const view = scopedItems(
    [
      plan("claude", [{ label: "~/.claude/CLAUDE.md", path: "/Users/sam/.claude/CLAUDE.md", scope: "user" }, { label: "~/code/app/AGENTS.md", kind: "agents-md", scope: "project", when: "skipped" }]),
      plan("opencode", [{ label: "~/.claude/CLAUDE.md" }, { label: "/Users/sam/code/app/CLAUDE.md" }]),
    ],
    { home: "/Users/sam", directory: "/Users/sam/code/app", plain: false },
  );
  assert.deepEqual(view.everywhere.map((entry) => [entry.where, entry.agents.join("+")]), [["~/.claude/CLAUDE.md", "claude+opencode"]]);
  assert.deepEqual(view.project.map((entry) => entry.where).sort(), ["app · AGENTS.md", "app · CLAUDE.md"]);
});

test("component names are unique across the app code (the bundler renames clashes, which breaks the real-app check's matching)", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = join(import.meta.dirname, "..", "client");
  const names = readdirSync(dir)
    .filter((file) => /\.tsx?$/.test(file))
    .flatMap((file) => [...readFileSync(join(dir, file), "utf8").matchAll(/^(?:export )?function ([A-Z]\w*)/gm)].map((match) => match[1]!));
  const twice = names.filter((name, index) => names.indexOf(name) !== index);
  assert.deepEqual(twice, []);
});

test("shadowing follows Claude's documented order: organisation (managed) over yours over a project's; plugins never clash", () => {
  const skills = [
    { id: "m", name: "deploy", scope: "managed", readBy: ["claude"] },
    { id: "u", name: "deploy", scope: "user", readBy: ["claude"] },
    { id: "p", name: "deploy", scope: "project", projectPath: "/work/hub", readBy: ["claude"] },
    { id: "plug", name: "deploy", scope: "plugin", readBy: ["claude"] },
  ];
  const shadows = shadowsFor(skills);
  assert.deepEqual(shadows.get("m"), [{ agent: "claude", state: "used", projects: ["hub"], over: "personal" }]);
  assert.deepEqual(shadows.get("u"), [{ agent: "claude", state: "skipped", projects: [], by: "managed" }]);
  assert.deepEqual(shadows.get("p"), [{ agent: "claude", state: "skipped", projects: ["hub"], by: "managed" }]);
  assert.equal(shadows.has("plug"), false);
  assert.equal(shadowLine(shadows.get("u"), plainAgent, "everywhere"), "Claude uses your organisation's copy of this name instead.");
  assert.equal(shadowLine(shadows.get("m"), plainAgent, "everywhere"), "Claude uses this copy over your own of the same name.");
  // Only yours and a managed one: no project involved.
  const two = shadowsFor(skills.slice(0, 2));
  assert.equal(two.get("u")![0]!.state, "skipped");
  assert.equal(two.get("m")![0]!.state, "used");
});

test("a file one agent skips: only the agents that read it are its readers, the rest 'skip it'", () => {
  const plan = (agent: string, when: string) => ({ agent, directory: "/w/app", items: [{ order: 0, label: "AGENTS.md", kind: "agents-md", path: "/w/app/AGENTS.md", when, bytes: 4, loadedBytes: 4, tokens: when === "skipped" ? 0 : 900, truncated: false, note: "", scope: "project" }], total: { bytes: 0, tokens: 0 }, notes: [], unsure: [] });
  const [row] = scopedItems([plan("claude", "skipped"), plan("codex", "launch"), plan("opencode", "on-demand")], { directory: "/w/app", plain: false }).project;
  assert.deepEqual([row!.agents, row!.skippedBy, row!.when, row!.tokens], [["codex", "opencode"], ["claude"], "launch", 900]);
  const [only] = scopedItems([plan("claude", "skipped")], { directory: "/w/app", plain: false }).project;
  assert.deepEqual([only!.agents, only!.skippedBy, only!.when], [[], ["claude"], "skipped"]);
});

test("files from a folder above the project are inherited, not its own; a Paseo worktree is its own root", () => {
  const plan = (directory: string, items: Array<Record<string, unknown>>) => ({ agent: "claude", directory, items: items.map((item, order) => ({ order, kind: "claude-md", when: "launch", bytes: 4, loadedBytes: 4, tokens: 10, truncated: false, note: "", scope: "project", ...item })), total: { bytes: 0, tokens: 0 }, notes: [], unsure: [] }) as never;
  const tree = "/Users/sam/.paseo/worktrees/app/feature-x";
  const view = scopedItems(
    [plan(tree, [{ label: "CLAUDE.md", path: `${tree}/CLAUDE.md` }, { label: "AGENTS.md", kind: "agents-md", path: "/Users/sam/.paseo/AGENTS.md" }, { label: "~/AGENTS.md", kind: "agents-md", path: "/Users/sam/AGENTS.md" }, { label: "notes", kind: "claude-auto-memory", path: "/Users/sam/.claude/projects/-x/memory" }])],
    { home: "/Users/sam", directory: tree, projectRoot: tree, plain: false },
  );
  assert.deepEqual(view.project.map((entry) => entry.where), ["feature-x · CLAUDE.md", "~/.claude/projects/-x/memory"]);
  assert.deepEqual(view.everywhere.map((entry) => [entry.where, entry.inherited]), [["~/.paseo/AGENTS.md", true], ["~/AGENTS.md", true]]);
  // A workspace in a subfolder: the repo root's file is the project's own.
  const sub = scopedItems([plan("/w/big/sub", [{ label: "CLAUDE.md", path: "/w/big/CLAUDE.md" }])], { directory: "/w/big/sub", projectRoot: "/w/big", plain: false });
  assert.deepEqual(sub.project.map((entry) => entry.where), ["big · CLAUDE.md"]);
});

test("a skill another project links to is this project's, at this project's path", async () => {
  const { mkdirSync, symlinkSync } = await import("node:fs");
  mkdirSync(join(sb.plain, ".claude", "skills"), { recursive: true });
  symlinkSync(join(sb.app, ".claude", "skills", "app-helper"), join(sb.plain, ".claude", "skills", "app-helper"));
  forgetSkillCaches();
  const workspace = await handleSkillsWorkspace({ workspaceId: "ws-plain" }, { paseo: fakePaseo(sb).api } as never);
  const helper = workspace.agents.find((entry) => entry.agent === "claude")!.skills.find((skill) => skill.name === "app-helper")!;
  assert.ok(helper, "the linked skill is listed in the other project");
  assert.equal(helper.where, "plain · .claude/skills/app-helper");
  assert.equal(helper.projectPath, sb.plain);
});

test("shadowing compares exact names, case-sensitive: deploy-prod and deployprod are two skills", () => {
  const shadows = shadowsFor([
    { id: "a", name: "deploy-prod", scope: "user", readBy: ["claude"] },
    { id: "b", name: "deployprod", scope: "project", projectPath: "/work/hub", readBy: ["claude"] },
    { id: "c", name: "Release", scope: "user", readBy: ["claude"] },
    { id: "d", name: "release", scope: "project", projectPath: "/work/hub", readBy: ["claude"] },
  ]);
  assert.equal(shadows.size, 0);
});

test("only enabled copies count: a copy turned off for Claude neither wins nor hides another", () => {
  const shadows = shadowsFor([
    { id: "u", name: "deploy", scope: "user", readBy: ["claude", "codex"], state: { claude: "off" } },
    { id: "p", name: "deploy", scope: "project", projectPath: "/work/hub", readBy: ["claude", "codex"], state: {} },
  ]);
  assert.ok(!shadows.get("p")!.some((shadow) => shadow.agent === "claude"), "Claude runs the project copy; nothing hides it");
  assert.ok(!shadows.get("u")!.some((shadow) => shadow.agent === "claude"));
  assert.ok(shadows.get("p")!.some((shadow) => shadow.agent === "codex" && shadow.state === "both"), "Codex still lists both");
});
