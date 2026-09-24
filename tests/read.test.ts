import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { fakePaseo, makeSandbox, violations, type Sandbox } from "./helpers";

// Environment first, then server code.
let sb: Sandbox = await makeSandbox();
const { forgetAllFiles } = await import("../server/files");
const { forgetDiscovery } = await import("../server/discover");
const { resetDaemonCache } = await import("../server/daemon");
const read = await import("../server/read");
const { claudeSlug } = await import("../shared/slug");
const { MASK_FILL } = await import("../shared/secrets");

async function fresh(options: Parameters<typeof makeSandbox>[0] = {}): Promise<Sandbox> {
  sb.cleanup();
  sb = await makeSandbox(options);
  forgetAllFiles();
  forgetDiscovery();
  resetDaemonCache();
  return sb;
}

afterEach(() => assert.deepEqual(violations, [], "no write outside the sandbox"));

const slotProviders = (s: Sandbox) => ({
  "claude-work": { extends: "claude", env: { CLAUDE_CONFIG_DIR: "~/.agent-link/accounts/claude/slot@example.com" } },
  "codex-work": { extends: "codex", env: { CODEX_HOME: s.slot.codex } },
});

test("inventory: accounts from defaults, AgentLink slots and provider env", async () => {
  await fresh();
  const paseo = fakePaseo(sb, { prompt: "Be kind.", providers: slotProviders(sb) });
  const inv = await read.handleInventory({}, { paseo: paseo.api });
  const ids = inv.accounts.map((account) => `${account.agent}:${account.origin}:${account.dir.replace(sb.home, "~")}`);
  assert.ok(ids.includes("claude:default:~/.claude"));
  assert.ok(ids.includes("codex:default:~/.codex"));
  assert.ok(ids.includes("claude:agent-link:~/.agent-link/accounts/claude/slot@example.com"));
  assert.ok(ids.includes("codex:agent-link:~/.agent-link/accounts/codex/slot@example.com"));
  const slot = inv.accounts.find((account) => account.dir === sb.slot.claude)!;
  assert.deepEqual(slot.providerIds, ["claude-work"], "the provider's ~ path resolved to the slot");
  assert.equal(slot.email, "slot@example.com");
  assert.equal(inv.accounts.find((account) => account.dir === sb.claude)!.email, "me@example.com");
  assert.ok(inv.accounts.find((account) => account.dir === sb.slot.codex)!.providerIds.includes("codex-work"));
  assert.ok(inv.accounts.some((account) => account.agent === "omp" && account.exists));
  // The slot's own files are sources on that account.
  const slotFile = inv.sources.find((source) => source.path === join(sb.slot.claude, "CLAUDE.md"))!;
  assert.equal(slotFile.accountId, slot.id);
  assert.equal(inv.sources.find((source) => source.path === "paseo:appendSystemPrompt")!.bytes, 8);
});

test("inventory: Claude memory folders, counts, and slugs mapped back to projects", async () => {
  await fresh();
  const inv = await read.handleInventory({}, { paseo: fakePaseo(sb).api });
  const folders = inv.sources.filter((source) => source.kind === "claude-auto-memory");
  assert.equal(inv.counts.claudeMemoryFolders, 3);
  assert.equal(folders.length, 3);
  // app: 5 memory files + MEMORY.md; long: 1 + MEMORY.md; old: 1 + MEMORY.md
  assert.equal(inv.counts.claudeMemoryFiles, 10);
  assert.equal(inv.counts.codexHomes, 2);
  const app = folders.find((source) => source.path === sb.appMemory)!;
  assert.equal(app.projectPath, sb.app);
  assert.equal(app.files, 5);
  assert.equal(app.slug, claudeSlug(sb.app));
  const long = folders.find((source) => source.path === sb.longMemory)!;
  assert.equal(long.projectPath, sb.long, "a >200-character path maps through the hashed slug");
  assert.ok(long.slug!.length > 200);
  assert.equal(long.loaded.bytes < long.bytes, true, "the over-limit index is cut");
  assert.match(long.loaded.note, /cut at 200 lines/);
  const old = folders.find((source) => source.slug === "-old-deleted-project")!;
  assert.equal(old.projectPath, undefined, "a folder with no known path is 'other projects'");
  // 4 Paseo projects plus the worktree and big/sub workspace folders.
  assert.equal(inv.checked[0], "Checked 3 Claude memory folders in 2 Claude config folders, 2 Codex homes and 6 projects.");
});

test("inventory: one source per file, with every agent that reads it", async () => {
  await fresh();
  const inv = await read.handleInventory({}, { paseo: fakePaseo(sb).api });
  const by = (path: string) => inv.sources.find((source) => source.path === path);
  const appAgents = by(join(sb.app, "AGENTS.md"))!;
  assert.equal(inv.sources.filter((source) => source.path === join(sb.app, "AGENTS.md")).length, 1);
  // Codex and pi take the override; Claude has a CLAUDE.md; omp's native .omp/AGENTS.md shadows it at that depth.
  assert.deepEqual([...appAgents.readBy].sort(), ["copilot", "opencode"]);
  const override = by(join(sb.app, "AGENTS.override.md"))!;
  assert.deepEqual([...override.readBy].sort(), ["codex", "pi"]);
  const plain = by(join(sb.plain, "AGENTS.md"))!;
  assert.ok(plain.readBy.includes("claude"), "no CLAUDE.md there, so Claude reads AGENTS.md");
  assert.ok(plain.readBy.includes("codex"));
  const userClaude = by(join(sb.claude, "CLAUDE.md"))!;
  assert.ok(userClaude.readBy.includes("claude"));
  assert.equal(by(join(sb.app, "CLAUDE.md"))!.versionControlled, true);
  assert.equal(by(join(sb.app, "CLAUDE.local.md"))!.versionControlled, undefined, "CLAUDE.local.md is never flagged");
  assert.equal(by(join(sb.codex, "memories", "raw_memories.md"))!.access, "read-only");
  assert.equal(by(join(sb.codex, "memories", "memory_summary.md"))!.access, "editable");
  assert.equal(by(join(sb.managed, "CLAUDE.md"))!.access, "read-only");
  assert.equal(by("copilot:memory")!.access, "online");
  assert.equal(by(join(sb.home, ".omp", "agent", "memories"))!.access, "read-only");
  assert.equal(inv.sources.some((source) => source.path.endsWith("config.toml")), false, "config files are not sources");
});

test("source detail: index drift, over-limit, shapes and secrets per memory", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const detail = await read.handleSourceDetail({ sourceId: sb.appMemory }, { paseo });
  assert.deepEqual(detail.index!.missingFiles, ["missing.md"]);
  assert.deepEqual(detail.index!.unindexedFiles, ["unindexed.md"]);
  const entries = Object.fromEntries(detail.entries.map((entry) => [entry.key, entry]));
  assert.equal(entries["nested.md"]!.shape, "nested");
  assert.equal(entries["flat.md"]!.shape, "flat");
  assert.equal(entries["flat_session.md"]!.shape, "flat-session");
  assert.equal(entries["unindexed.md"]!.indexed, false);
  assert.equal(entries["nested.md"]!.hook, "the nested shape");
  assert.equal(entries["secret.md"]!.secrets, 3);
  assert.equal(detail.warnings.length, 2);
  const long = await read.handleSourceDetail({ sourceId: sb.longMemory }, { paseo });
  assert.equal(long.index!.truncated, true);
  assert.equal(long.index!.loadedLines, 200);
  const claudeMd = await read.handleSourceDetail({ sourceId: join(sb.claude, "CLAUDE.md") }, { paseo });
  assert.deepEqual(claudeMd.entries.map((entry) => entry.title), ["User preferences", "Style"]);
  assert.deepEqual(claudeMd.imports.map((entry) => [entry.ref, entry.exists]), [["~/shared-rules.md", true], ["notes/extra.md", true]]);
  const codex = await read.handleSourceDetail({ sourceId: join(sb.codex, "memories", "memory_summary.md") }, { paseo });
  assert.equal(codex.codex!.lock, "free");
  assert.match(codex.codex!.pending!, /hasn't finished its last clean-up/);
});

test("entry body: secrets masked unless revealed; stamp for the stale-write guard", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  const masked = await read.handleEntryBody({ sourceId: sb.appMemory, key: "secret.md" }, { paseo });
  assert.equal(masked.masked, true);
  assert.equal(masked.secrets, 3);
  assert.ok(!masked.body.includes("abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.ok(masked.body.includes(MASK_FILL));
  assert.equal(masked.fields!.name, "Secret memory");
  assert.ok(!masked.body.startsWith("---"), "the body comes without frontmatter");
  const revealed = await read.handleEntryBody({ sourceId: sb.appMemory, key: "secret.md", reveal: true }, { paseo });
  assert.equal(revealed.masked, false);
  assert.ok(revealed.body.includes("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD"));
  assert.equal(revealed.stamp!.hash!.length, 64);
  const section = await read.handleEntryBody({ sourceId: join(sb.claude, "CLAUDE.md"), key: "1:style" }, { paseo });
  assert.equal(section.body, "## Style\n\nShort sentences.");
  await assert.rejects(read.handleEntryBody({ sourceId: sb.appMemory, key: "../../../../.claude.json" }, { paseo }), /not in this folder/);
  await assert.rejects(read.handleEntryBody({ sourceId: "/etc/passwd" }, { paseo }), /no longer there/);
  // Settings can turn masking off.
  const settings = join(sb.paseoHome, "plugin-settings", "paseo-memories");
  (await import("node:fs")).mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, "memories.json"), JSON.stringify({ version: 1, values: { maskSecrets: false } }));
  forgetDiscovery();
  const unmasked = await read.handleEntryBody({ sourceId: sb.appMemory, key: "secret.md" }, { paseo });
  assert.equal(unmasked.masked, false);
});

function plan(plans: Array<{ agent: string; items: Array<{ path?: string; when: string; loadedBytes: number; truncated: boolean; kind: string; note: string }> }>, agent: string) {
  const found = plans.find((entry) => entry.agent === agent)!;
  const at = (path: string) => found.items.find((item) => item.path === path);
  return { ...found, at, launch: found.items.filter((item) => item.when === "launch").map((item) => item.path) };
}

test("Claude plan: layers, imports (4 hops), rules, CLAUDE.md beats AGENTS.md, auto memory", async () => {
  await fresh();
  const paseo = fakePaseo(sb, { prompt: "Append me." });
  const { plans, directory } = await read.handleWorkspacePlan({ workspaceId: "ws-app" }, { paseo: paseo.api });
  assert.equal(directory, sb.app);
  const claude = plan(plans, "claude");
  assert.equal(claude.at(join(sb.managed, "CLAUDE.md"))!.when, "launch");
  assert.equal(claude.at(join(sb.claude, "CLAUDE.md"))!.when, "launch");
  assert.equal(claude.at(join(sb.home, "shared-rules.md"))!.kind, "claude-import");
  assert.equal(claude.at(join(sb.claude, "notes", "deeper.md"))!.when, "launch", "hop two is followed");
  assert.equal(claude.at(join(sb.claude, "rules", "general.md"))!.when, "launch");
  assert.equal(claude.at(join(sb.claude, "rules", "frontend", "react.md"))!.when, "on-demand", "paths: makes it on demand");
  for (const name of ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md", join(".claude", "rules", "api.md"), join("docs", "guide.md")]) {
    assert.equal(claude.at(join(sb.app, name))!.when, "launch", name);
  }
  assert.equal(claude.at(join(sb.app, "AGENTS.md"))!.when, "skipped");
  assert.equal(claude.at(join(sb.app, "packages", "web", "CLAUDE.md"))!.when, "on-demand");
  const auto = claude.at(sb.appMemory)!;
  assert.equal(auto.when, "launch");
  assert.equal(auto.loadedBytes > 0, true);
  assert.equal(claude.at("paseo:appendSystemPrompt")!.loadedBytes, 10);
  assert.equal(plans.find((entry) => entry.agent === "copilot")!.items.some((item) => item.path === "paseo:appendSystemPrompt"), false, "Copilot never gets the appended prompt");
});

test("Claude plan: no project CLAUDE.md means AGENTS.md; the settings option changes that", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  let claude = plan((await read.handleWorkspacePlan({ workspaceId: "ws-plain" }, { paseo })).plans, "claude");
  assert.equal(claude.at(join(sb.plain, "AGENTS.md"))!.when, "launch");
  writeFileSync(join(sb.claude, "settings.json"), JSON.stringify({ pluginConfigs: { "agents-md@builtin": { options: { instructionFiles: "claude-md" } } } }));
  forgetAllFiles();
  claude = plan((await read.handleWorkspacePlan({ workspaceId: "ws-plain" }, { paseo })).plans, "claude");
  assert.equal(claude.at(join(sb.plain, "AGENTS.md"))!.when, "skipped");
  writeFileSync(join(sb.claude, "settings.json"), JSON.stringify({ pluginConfigs: { "agents-md@builtin": { options: { instructionFiles: "claude-md-and-agents-md" } } } }));
  claude = plan((await read.handleWorkspacePlan({ workspaceId: "ws-app" }, { paseo })).plans, "claude");
  assert.equal(claude.at(join(sb.app, "AGENTS.md"))!.when, "launch", "both mode loads AGENTS.md beside CLAUDE.md");
  writeFileSync(join(sb.claude, "settings.json"), JSON.stringify({ autoMemoryEnabled: false, pluginConfigs: { "agents-md@builtin": { options: { instructionFiles: "managed-only" } } } }));
  claude = plan((await read.handleWorkspacePlan({ workspaceId: "ws-app" }, { paseo })).plans, "claude");
  // The app's own .claude/settings.json turns auto memory back on.
  assert.deepEqual(claude.launch, [join(sb.managed, "CLAUDE.md"), sb.appMemory]);
  claude = plan((await read.handleWorkspacePlan({ workspaceId: "ws-plain" }, { paseo })).plans, "claude");
  assert.deepEqual(claude.launch, [join(sb.managed, "CLAUDE.md")]);
  assert.equal(claude.items.find((item) => item.kind === "claude-auto-memory")!.when, "skipped");
});

test("Claude plan: a worktree shares the main checkout's memory folder", async () => {
  await fresh();
  const { plans } = await read.handleWorkspacePlan({ workspaceId: "ws-wt" }, { paseo: fakePaseo(sb).api });
  const claude = plan(plans, "claude");
  assert.equal(claude.at(sb.appMemory)?.when, "launch", "the worktree's memory is the app's folder");
});

test("Claude plan: the environment turns auto memory off", async () => {
  await fresh();
  const paseo = fakePaseo(sb, { providers: { claude: { env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } } } }).api;
  const result = await read.handleAgentPlan({ workspaceId: "ws-app", providerId: "claude" }, { paseo });
  assert.equal(result.plan.items.find((item) => item.path === sb.appMemory)!.when, "skipped");
});

test("Codex plan: user file, override beats AGENTS.md, 32 KiB cap, git-root walk, summary cut", async () => {
  await fresh();
  const paseo = fakePaseo(sb).api;
  let codex = plan((await read.handleWorkspacePlan({ workspaceId: "ws-app" }, { paseo })).plans, "codex");
  assert.equal(codex.at(join(sb.codex, "AGENTS.md"))!.when, "launch");
  assert.equal(codex.at(join(sb.app, "AGENTS.override.md"))!.when, "launch");
  assert.equal(codex.at(join(sb.app, "AGENTS.md")), undefined, "one file per folder");
  assert.equal(codex.at(join(sb.home, "AGENTS.md")), undefined, "the walk stops at the git root");
  const summary = codex.at(join(sb.codex, "memories", "memory_summary.md"))!;
  assert.equal(summary.loadedBytes, 10_000, "2,500 tokens ≈ 10,000 bytes");
  assert.equal(summary.truncated, true);
  assert.equal(codex.at(join(sb.codex, "memories", "MEMORY.md"))!.when, "on-demand");
  assert.ok(codex.items.some((item) => item.kind === "codex-config"), "developer_instructions counted");

  codex = plan((await read.handleWorkspacePlan({ workspaceId: "ws-big-sub" }, { paseo })).plans, "codex");
  const big = codex.at(join(sb.big, "AGENTS.md"))!;
  assert.equal(big.loadedBytes, 32 * 1024);
  assert.equal(big.truncated, true);
  assert.equal(codex.at(join(sb.big, "sub", "AGENTS.md"))!.when, "skipped", "past the cap nothing more loads");

  resetDaemonCache();
  forgetDiscovery();
  const slot = await read.handleAgentPlan({ workspaceId: "ws-app", providerId: "codex-work" }, { paseo: fakePaseo(sb, { providers: slotProviders(sb) }).api });
  assert.equal(slot.plan.configDir, sb.slot.codex);
  assert.ok(slot.plan.items.some((item) => item.path === join(sb.slot.codex, "AGENTS.md") && item.when === "launch"));
  assert.ok(slot.plan.notes.some((note) => note.includes("memories are off")));
});

test("OpenCode, pi, omp and Copilot plans follow their own rules", async () => {
  await fresh();
  const { plans } = await read.handleWorkspacePlan({ workspaceId: "ws-app" }, { paseo: fakePaseo(sb).api });
  const opencode = plan(plans, "opencode");
  assert.equal(opencode.at(join(sb.claude, "CLAUDE.md"))!.when, "launch", "no OpenCode AGENTS.md, so Claude's user file");
  assert.equal(opencode.at(join(sb.app, "AGENTS.md"))!.when, "launch");
  assert.equal(opencode.at(join(sb.app, "CLAUDE.md")), undefined, "AGENTS.md matched, so CLAUDE.md is not read");
  assert.equal(opencode.at(join(sb.home, "shared-rules.md"))!.when, "launch", "opencode.json instructions[]");
  const pi = plan(plans, "pi");
  assert.equal(pi.at(join(sb.home, ".pi", "agent", "AGENTS.md"))!.when, "launch");
  assert.equal(pi.at(join(sb.app, "AGENTS.override.md"))!.when, "launch");
  assert.equal(pi.at(join(sb.home, ".pi", "agent", "APPEND_SYSTEM.md"))!.when, "launch");
  const omp = plan(plans, "omp");
  assert.equal(omp.at(join(sb.home, ".omp", "agent", "AGENTS.md"))!.when, "launch", "native user file wins");
  assert.equal(omp.at(join(sb.app, ".omp", "AGENTS.md"))!.when, "launch");
  assert.equal(omp.at(join(sb.app, ".omp", "RULES.md"))!.when, "launch");
  const copilot = plan(plans, "copilot");
  assert.equal(copilot.at(join(sb.home, ".copilot", "copilot-instructions.md"))!.when, "launch");
  assert.equal(copilot.at(join(sb.home, ".copilot", "instructions", "go.instructions.md"))!.when, "on-demand");
  assert.equal(copilot.at(join(sb.app, ".github", "instructions", "ts.instructions.md"))!.when, "on-demand");
  assert.equal(copilot.at(join(sb.app, "CLAUDE.md"))!.when, "launch");
  assert.equal(copilot.at("copilot:memory")!.when, "skipped");
});

test("an unknown workspace is a plain sentence", async () => {
  await fresh();
  await assert.rejects(read.handleWorkspacePlan({ workspaceId: "nope" }, { paseo: fakePaseo(sb).api }), /no longer exists/);
});

test.after(() => sb.cleanup());
