/**
 * Finding skills: every place and every kind of origin, one entry per real
 * folder with everyone who reads it, the checks, the tidy findings, the
 * listing cost per account, and the read rules (no process, no network, no
 * blocking file calls, nothing kept but headers and counts).
 */
import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fakePaseo, makeSandbox, spawned, withoutSyncFs } from "./helpers";
import { addSkills, type SkillsSandbox } from "./skills-helpers";

const base = await makeSandbox();
const sb: SkillsSandbox = addSkills(base);
const { discoverSkills, forgetSkillCaches, skillCacheSizes } = await import("../server/skills");
const { handleSkillsInventory, handleSkillDetail, handleSkillsCatalog, handleSkillsUsage, handleSkillsWorkspace } = await import("../server/skill-handlers");
const { setGithubFetch } = await import("../server/github");
const { markClientSeen } = await import("../server/presence");

const fetched: string[] = [];
before(() => setGithubFetch(async (url) => (fetched.push(url), new Response("", { status: 500 }))));
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  fetched.push(String(input));
  throw new Error("no network in tests");
}) as typeof fetch;
after(() => {
  globalThis.fetch = originalFetch;
  setGithubFetch(null);
  sb.cleanup();
});

const fake = fakePaseo(sb);
const ctx = { paseo: fake.api };

async function fresh() {
  forgetSkillCaches();
  return discoverSkills(fake.api, { refresh: true });
}

function byName(discovery: Awaited<ReturnType<typeof fresh>>, name: string) {
  const skill = discovery.skills.find((entry) => entry.name === name);
  assert.ok(skill, `${name} found`);
  return skill!;
}

test("every place and origin, deduped by real folder", async () => {
  const d = await fresh();
  const expect: Record<string, [string, string, string]> = {
    // name: [provenance, scope, access]
    alpha: ["npx-skills", "user", "editable"],
    beta: ["by-hand", "user", "editable"],
    paseo: ["paseo", "user", "read-only"],
    "paseo-loop": ["paseo", "user", "read-only"],
    "own-skill": ["by-hand", "user", "editable"],
    drawing: ["claude-ai", "user", "read-only"],
    "toolkit:deploy": ["claude-plugin", "plugin", "read-only"],
    "slot-skill": ["by-hand", "user", "editable"],
    "legacy-x": ["by-hand", "user", "editable"],
    "openai-docs": ["codex-builtin", "user", "read-only"],
    "pi-only": ["by-hand", "user", "read-only"],
    "corp-policy": ["managed", "managed", "read-only"],
    "admin-skill": ["managed", "managed", "read-only"],
    "app-helper": ["project", "project", "editable"],
    "app-shared": ["project", "project", "editable"],
  };
  for (const [name, [provenance, scope, access]] of Object.entries(expect)) {
    const skill = byName(d, name);
    assert.equal(skill.provenance, provenance, `${name} provenance`);
    assert.equal(skill.scope, scope, `${name} scope`);
    assert.equal(skill.access, access, `${name} access`);
  }
  assert.equal(d.skills.some((skill) => skill.name.includes("hidden")), false, "a turned-off plugin's skills are not listed");
  // alpha: one real folder, two places, read by Claude and the shared readers.
  const alpha = byName(d, "alpha");
  assert.equal(alpha.locations.length, 2);
  assert.deepEqual(alpha.locations.map((location) => [location.root, location.link]).sort(), [["claude-user", true], ["shared", false]]);
  for (const agent of ["claude", "codex", "opencode", "pi"]) assert.ok(alpha.readBy.includes(agent), agent);
  assert.equal(alpha.provenanceDetail, "acme/skills");
  assert.equal(byName(d, "toolkit:deploy").provenanceDetail, "toolkit");
  assert.equal(byName(d, "beta").scripts, 1);
  assert.equal(byName(d, "alpha").scripts, 0);
  assert.equal(byName(d, "app-helper").projectPath, sb.app);
  assert.equal(byName(d, "app-helper").versionControlled, true);
  assert.equal(new Set(d.skills.map((skill) => skill.id)).size, d.skills.length, "ids are unique");
  assert.ok(d.skills.every((skill) => /^sk_[0-9a-f]{24}$/.test(skill.id)), "ids are opaque");
});

test("who may do what, and why not", async () => {
  const d = await fresh();
  assert.deepEqual(byName(d, "alpha").can.turnOff.sort(), ["claude", "codex"]);
  assert.equal(byName(d, "alpha").can.remove, true);
  assert.deepEqual(byName(d, "own-skill").can.turnOff, ["claude"]);
  assert.deepEqual(byName(d, "legacy-x").can.turnOff, ["codex"]);
  for (const name of ["paseo", "drawing", "toolkit:deploy", "openai-docs", "corp-policy"]) {
    const skill = byName(d, name);
    assert.deepEqual(skill.can.turnOff, [], name);
    assert.ok(skill.can.turnOffReason, name);
    assert.equal(skill.can.remove, false, name);
    assert.ok(skill.can.removeReason, name);
  }
  assert.equal(byName(d, "app-helper").can.remove, false, "project skills are removed in the project");
  assert.equal(byName(d, "pi-only").can.remove, false);
  assert.equal(byName(d, "picky").state.claude, "model-off");
  assert.equal(byName(d, "picky").listing.claude, 0, "a skill only a person may run isn't listed to Claude");
});

test("checks and tidy findings, each with one action", async () => {
  const d = await fresh();
  const kinds = (kind: string) => d.findings.filter((finding) => finding.kind === kind);
  const brokens = kinds("broken-link").map((finding) => finding.detail);
  assert.ok(brokens.includes(join(sb.claudeSkills, "broken")));
  assert.ok(brokens.includes(join(sb.codexSkills, "gstack-a")));
  assert.deepEqual(kinds("empty-folder").map((finding) => finding.detail), [join(sb.claudeSkills, "empty-one")]);
  assert.deepEqual(kinds("stray-file").map((finding) => finding.detail), [join(sb.claudeSkills, "pack.zip")]);
  assert.equal(kinds("duplicate").length, 1);
  assert.match(kinds("duplicate")[0]!.message, /dup-thing is in 2 places/);
  assert.deepEqual(kinds("paseo-orphan").map((finding) => finding.message.split(" ")[0]), ["paseo-loop"]);
  assert.deepEqual(kinds("lock-missing").map((finding) => finding.message.includes("ghost")), [true]);
  const invalid = kinds("invalid").map((finding) => finding.message);
  assert.ok(invalid.some((message) => message.includes("readme-only")), "a folder with no SKILL.md");
  assert.ok(invalid.some((message) => message.startsWith("no-header:")), "no header");
  assert.equal(invalid.some((message) => message.startsWith("Bad_Name:")), false, "an odd name alone is info, not a finding");
  assert.ok(byName(d, "Bad_Name").problems.some((problem) => problem.code === "name-invalid"));
  for (const finding of d.findings) {
    if (finding.action?.kind === "fix") assert.ok(d.fixes.has(finding.id), `${finding.kind} has its fix on the host`);
    assert.ok(finding.message.endsWith(".") || finding.message.endsWith(")"), finding.message);
  }
  assert.ok(d.nextStep, "one next step");
  assert.equal(d.nextStep!.title, d.findings.find((finding) => finding.severity === "warn")!.message);
});

test("listing cost per account: a budget only when the model is known", async () => {
  const d = await fresh();
  const claude = d.costs.find((cost) => cost.agent === "claude" && cost.accountId === `claude:${sb.claude}`)!;
  const slot = d.costs.find((cost) => cost.agent === "claude" && cost.accountId === `claude:${sb.slot.claude}`)!;
  const codex = d.costs.find((cost) => cost.agent === "codex" && cost.accountId === `codex:${sb.codex}`)!;
  assert.ok(claude && slot && codex);
  const listed = d.skills.filter((skill) => skill.scope !== "project" && skill.claudeAccounts.includes(`claude:${sb.claude}`) && skill.listing.claude > 0);
  assert.equal(claude.skills, listed.length);
  assert.equal(claude.chars, listed.reduce((sum, skill) => sum + skill.listing.claude, 0));
  assert.equal(claude.tokens, Math.ceil(claude.chars / 4));
  assert.equal(claude.budgetKnown, false, "no model known: a fact, not a budget");
  assert.equal(claude.overBudget, false);
  assert.equal(codex.budgetKnown, false, "Codex's window isn't known here");
  assert.equal(slot.skills, 2, "the slot sees its own skill and the managed one");
  assert.ok(codex.skills >= 5, "shared, its own, built-in and admin skills");
});

test("over budget: only against the window the agents use", async () => {
  const { writeSkill, skillMd } = await import("./skills-helpers");
  const { readFileSync, writeFileSync, rmSync } = await import("node:fs");
  for (let i = 0; i < 8; i += 1) writeSkill(join(sb.shared, `wordy-${i}`), skillMd(`wordy-${i}`, "w".repeat(1500)));
  for (let i = 0; i < 8; i += 1) symlinkSync(join(sb.shared, `wordy-${i}`), join(sb.claudeSkills, `wordy-${i}`));
  const path = join(sb.claude, "settings.json");
  const original = readFileSync(path, "utf8");
  const withModel = (model: string) => writeFileSync(path, JSON.stringify({ ...JSON.parse(original), model }, null, 2));
  try {
    let d = await fresh();
    assert.equal(d.findings.some((finding) => finding.kind === "over-budget"), false, "unknown model: no alarm");
    withModel("claude-haiku-4-5");
    d = await fresh();
    const small = d.costs.find((cost) => cost.accountId === `claude:${sb.claude}`)!;
    assert.deepEqual([small.budgetKnown, small.budgetChars, small.overBudget, small.model], [true, 8000, true, "claude-haiku-4-5"]);
    assert.ok(d.findings.some((finding) => finding.kind === "over-budget" && finding.message.includes("claude-haiku-4-5")));
    withModel("opus[1m]");
    d = await fresh();
    const big = d.costs.find((cost) => cost.accountId === `claude:${sb.claude}`)!;
    assert.deepEqual([big.budgetKnown, big.budgetChars, big.overBudget], [true, 40000, false]);
    assert.equal(d.findings.some((finding) => finding.kind === "over-budget"), false);
    // The agents Paseo runs decide over the account's default: the smallest window counts.
    const { forgetAgentModels } = await import("../server/skill-models");
    (fake.api as unknown as { agents: unknown }).agents = { list: async () => ({ entries: [{ agent: { provider: "claude", model: "opus[1m]" } }, { agent: { provider: "claude", model: "claude-sonnet-4-5" } }] }) };
    forgetAgentModels();
    d = await fresh();
    assert.equal(d.costs.find((cost) => cost.accountId === `claude:${sb.claude}`)!.budgetChars, 8000);
    (fake.api as unknown as { agents: unknown }).agents = { list: async () => ({ entries: [{ agent: { provider: "claude", model: "some-gateway-model" } }] }) };
    forgetAgentModels();
    d = await fresh();
    assert.equal(d.costs.find((cost) => cost.accountId === `claude:${sb.claude}`)!.budgetKnown, false, "an agent on an unknown model: no guess");
  } finally {
    writeFileSync(path, original);
    delete (fake.api as unknown as { agents?: unknown }).agents;
    for (let i = 0; i < 8; i += 1) {
      rmSync(join(sb.claudeSkills, `wordy-${i}`));
      rmSync(join(sb.shared, `wordy-${i}`), { recursive: true });
    }
  }
});

test("Paseo orphans come only from the running Paseo's own bundle", async () => {
  const { forgetPaseoBundle } = await import("../server/paseo-bundle");
  const saved = process.env.PASEO_MEMORIES_PASEO_BUNDLE_DIR;
  try {
    process.env.PASEO_MEMORIES_PASEO_BUNDLE_DIR = "";
    forgetPaseoBundle();
    let d = await fresh();
    assert.equal(d.findings.some((finding) => finding.kind === "paseo-orphan"), false, "bundle unreadable: no orphan finding at all");
    process.env.PASEO_MEMORIES_PASEO_BUNDLE_DIR = saved;
    forgetPaseoBundle();
    d = await fresh();
    assert.deepEqual(d.findings.filter((finding) => finding.kind === "paseo-orphan").map((finding) => finding.message.split(" ")[0]), ["paseo-loop"]);
  } finally {
    process.env.PASEO_MEMORIES_PASEO_BUNDLE_DIR = saved;
    forgetPaseoBundle();
  }
});

test("reads start no process, use no network and never block", async () => {
  markClientSeen();
  forgetSkillCaches();
  const spawnedBefore = spawned.length;
  const { result, blocked } = await withoutSyncFs(async () => {
    const inventory = await handleSkillsInventory({ refresh: true }, ctx);
    const skill = inventory.skills.find((entry) => entry.name === "beta")!;
    const detail = await handleSkillDetail({ skillId: skill.id }, ctx);
    const catalog = await handleSkillsCatalog({}, ctx);
    const usage = await handleSkillsUsage({}, ctx);
    const workspace = await handleSkillsWorkspace({ workspaceId: "ws-app" }, ctx);
    return { inventory, detail, catalog, usage, workspace };
  });
  assert.deepEqual(blocked, []);
  assert.equal(spawned.length, spawnedBefore);
  assert.deepEqual(fetched, []);
  assert.ok(result.detail.body.includes("Runs the release checks."));
  assert.deepEqual(result.detail.fileList.map((file) => [file.path, file.kind, file.executable]), [["SKILL.md", "instructions", false], ["scripts/run.sh", "script", true]]);
  assert.equal(result.catalog.entries.length >= 6, true);
  const names = result.workspace.agents.find((agent) => agent.agent === "claude")!.skills.map((skill) => skill.name);
  assert.ok(names.includes("app-helper") && names.includes("alpha"));
  assert.equal(result.workspace.agents.find((agent) => agent.agent === "codex")!.skills.some((skill) => skill.name === "app-helper"), false, "Codex doesn't read .claude/skills");
  assert.ok(result.workspace.agents.find((agent) => agent.agent === "codex")!.skills.some((skill) => skill.name === "app-shared"));
  assert.ok(result.inventory.checked[0]!.startsWith("Checked "));
});

test("caches keep headers and counts only, and forget what is gone", async () => {
  await fresh();
  const sizes = skillCacheSizes();
  const { rmSync } = await import("node:fs");
  const { writeSkill, skillMd } = await import("./skills-helpers");
  writeSkill(join(sb.shared, "temp-one"), skillMd("temp-one", "Short-lived."));
  forgetSkillCaches();
  await discoverSkills(fake.api, { refresh: true });
  assert.equal(skillCacheSizes().headers, sizes.headers + 1);
  rmSync(join(sb.shared, "temp-one"), { recursive: true });
  await discoverSkills(fake.api, { refresh: true });
  assert.equal(skillCacheSizes().headers, sizes.headers, "a removed skill's header is forgotten");
});

test("secrets in a skill's text are masked unless revealed", async () => {
  const { writeSkill, skillMd } = await import("./skills-helpers");
  const key = ["sk", "ant", "api03", "Zz9".repeat(10)].join("-");
  writeSkill(join(sb.shared, "with-key"), skillMd("with-key", "Calls an API."), {});
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(sb.shared, "with-key", "SKILL.md"), skillMd("with-key", "Calls an API.", `Use ${key} here.\n`));
  const d = await fresh();
  const id = d.skills.find((skill) => skill.name === "with-key")!.id;
  assert.equal((await handleSkillDetail({ skillId: id }, ctx)).body.includes(key), false);
  assert.equal((await handleSkillDetail({ skillId: id, reveal: true }, ctx)).body.includes(key), true);
  const { rmSync } = await import("node:fs");
  rmSync(join(sb.shared, "with-key"), { recursive: true });
});
