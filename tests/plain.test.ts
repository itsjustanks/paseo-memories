/**
 * Plain mode must not show file names or technical words. Every string table
 * the plain views render from, and every plain name, finding, notice and
 * guide step, is checked against the jargon list. The folded "Technical
 * details" reference (client/guide.tsx) is the one place they are allowed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FINDING_KINDS, SOURCE_KINDS } from "../shared/contracts";
import { PLAIN_GUIDES, PLAIN_GUIDE_TECHNICAL_HINT } from "../shared/guides";
import { noteTargetWarning, planNote } from "../shared/notes";
import {
  JARGON,
  PLAIN,
  PLAIN_AGENT,
  PLAIN_MEMORY_TYPES,
  jargonIn,
  plainDetailWarning,
  plainFinding,
  plainMessage,
  plainNextStep,
  plainPlanItemName,
  plainReadOnly,
  plainSourceName,
  plainWhen,
  plainWords,
} from "../shared/plain";

/** Every string in a table; functions are called with sample arguments. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "function") {
    const call = value as (...args: unknown[]) => unknown;
    for (const sample of [1, 3]) strings(call(sample, sample), out);
    strings(call("acme-web", "acme-web"), out);
  } else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, out);
  return out;
}

function assertPlain(texts: string[], what: string): void {
  const hits = texts.flatMap((text) => jargonIn(text).map((word) => `${word} in "${text}"`));
  assert.deepEqual(hits, [], what);
}

const H = "/home/demo";
const PATHS: Record<string, string> = {
  "claude-managed": "/Library/Application Support/ClaudeCode/CLAUDE.md",
  "claude-md": `${H}/.claude/CLAUDE.md`,
  "claude-local": `${H}/code/acme-web/CLAUDE.local.md`,
  "claude-rule": `${H}/.claude/rules/testing.md`,
  "claude-import": `${H}/shared-rules.md`,
  "claude-auto-memory": `${H}/.claude/projects/-home-demo-code-acme-web/memory`,
  "agents-md": `${H}/.codex/AGENTS.md`,
  "codex-memory": `${H}/.codex/memories/MEMORY.md`,
  "codex-generated": `${H}/.codex/memories/raw_memories.md`,
  "paseo-prompt": "paseo:appendSystemPrompt",
  "opencode-md": `${H}/.config/opencode/AGENTS.md`,
  "opencode-config": `${H}/.config/opencode/opencode.json`,
  "pi-md": `${H}/.pi/agent/AGENTS.md`,
  "omp-md": `${H}/.omp/agent/RULES.md`,
  "omp-generated": `${H}/.omp/agent/memories`,
  "copilot-md": `${H}/.copilot/copilot-instructions.md`,
  "copilot-memory": "copilot:memory",
};

test("the jargon list is the one in the brief", () => {
  assert.deepEqual([...JARGON], ["CLAUDE.md", "AGENTS.md", "MEMORY.md", "frontmatter", "token", "slug", "scope", "sqlite", "consolidation", "markdown", "repo", "config"]);
  assert.deepEqual(jargonIn("Your repository config"), ["repo", "config"]);
});

test("plain string tables and guides have no jargon", () => {
  assertPlain(strings(PLAIN), "PLAIN");
  assertPlain(strings(PLAIN_GUIDES), "guides");
  assertPlain([PLAIN_GUIDE_TECHNICAL_HINT], "guide hint");
  assertPlain(strings(PLAIN_MEMORY_TYPES), "memory types");
  assertPlain(strings(PLAIN_AGENT), "agents");
  for (const guide of PLAIN_GUIDES) assert.ok(guide.steps.length >= 3 && guide.steps.length <= 6, `${guide.title}: 3 to 6 steps`);
});

test("every kind of source has a plain name", () => {
  const names: string[] = [];
  const accounts = [{ id: "claude:/x", origin: "agent-link", email: "work@example.com", label: "work" }];
  for (const kind of SOURCE_KINDS) {
    for (const scope of ["user", "project", "managed", "host"]) {
      for (const versionControlled of [false, true]) {
        const source = { kind, scope, agent: kind.split("-")[0]!, path: PATHS[kind]!, projectPath: `${H}/code/acme-web`, accountId: "claude:/x", versionControlled };
        const name = plainSourceName(source, accounts);
        assert.ok(name.length > 0);
        names.push(name);
      }
    }
    names.push(plainPlanItemName({ kind, scope: "project", path: PATHS[kind]!, label: PATHS[kind]! }, "claude", `${H}/code/acme-web`));
  }
  assertPlain(names, "source names");
  assert.equal(plainSourceName({ kind: "claude-md", scope: "user", agent: "claude", path: `${H}/.claude/CLAUDE.md` }), "Your instructions for Claude");
  assert.equal(plainSourceName({ kind: "agents-md", scope: "user", agent: "codex", path: `${H}/.codex/AGENTS.md` }), "Your instructions for Codex");
  assert.equal(plainSourceName({ kind: "agents-md", scope: "project", agent: "codex", path: `${H}/code/acme-web/AGENTS.md`, projectPath: `${H}/code/acme-web`, versionControlled: true }), "Project instructions · acme-web (shared with the team)");
  assert.equal(plainSourceName({ kind: "claude-auto-memory", scope: "project", agent: "claude", path: PATHS["claude-auto-memory"]!, projectPath: `${H}/code/acme-web` }), "Claude's notes for acme-web");
  assert.equal(plainSourceName({ kind: "codex-memory", scope: "user", agent: "codex", path: PATHS["codex-memory"]! }), "What Codex has learned");
  assert.equal(plainSourceName({ kind: "paseo-prompt", scope: "host", agent: "paseo", path: "paseo:appendSystemPrompt" }), "Instructions for every agent on this computer");
});

test("findings, next steps, notices and messages are plain", () => {
  const texts: string[] = [];
  const nameOf = () => "Your instructions for Claude";
  for (const kind of [...FINDING_KINDS, "codex-pending", "something-new"]) {
    for (const message of ['MEMORY.md in acme-web lists x.md, which does not exist.', 'Possible conflict (a guess): "Release process" appears in 2 places.']) {
      const plain = plainFinding({ kind, message, sourceIds: ["a", "b"] }, nameOf);
      texts.push(plain.title, plain.detail);
    }
  }
  assert.equal(plainFinding({ kind: "duplicate", message: "", sourceIds: [] }, nameOf).title, "Two notes say the same thing");
  assert.equal(plainFinding({ kind: "stale-path", message: "", sourceIds: [] }, nameOf).title, "A note mentions a file or folder that no longer exists");
  const step = plainNextStep({ title: "Delete the copy", detail: "x" }, { kind: "secret", message: "", sourceIds: ["a"] }, 3, nameOf);
  texts.push(step.title, step.detail, ...strings(plainNextStep({ title: "", detail: "" }, undefined, 0, nameOf)));
  for (const kind of SOURCE_KINDS) texts.push(plainReadOnly({ kind, access: "read-only" }), plainReadOnly({ kind, access: "online" }));
  for (const when of ["launch", "on-demand", "skipped", "missing"]) texts.push(plainWhen(when));
  for (const tokens of [0, 3, 40, 400, 4000, 40_000]) texts.push(plainWords(tokens));
  const server = [
    "This file is in a git repository: the change shows up in git.",
    "In a git repository: a change here shows up in git.",
    "Saved CLAUDE.md.",
    "Created AGENTS.md.",
    "Imported 1 item into ~/.claude/CLAUDE.md.",
    "No change; nothing was written.",
    "That section is no longer in the file. Reload it; nothing was saved.",
    "The text still has hidden (masked) values in it. Reveal them before editing, so they are not replaced by dots. Nothing was saved.",
    "1 item still hold hidden (masked) values; the dots were saved as they are.",
    "Codex reads AGENTS.md as instructions; it does not become Codex's generated memory.",
    "Holds values that look like secrets; they are hidden here and saved as they are.",
    "SYSTEM.md replaces pi's whole base prompt.",
  ];
  texts.push(...server.map(plainMessage));
  for (const warning of ["212 lines; Claude's docs suggest keeping CLAUDE.md under 200.", "MEMORY.md is over Claude's limit: only the first 200 lines (25,000 B) load.", "2 MEMORY.md lines point to a file that does not exist.", "1 memory file is not named in MEMORY.md.", "The file does not exist yet.", "Too large or not text; not opened here."]) {
    const plain = plainDetailWarning(warning);
    if (plain) texts.push(plain);
  }
  assertPlain(texts, "findings and messages");
  assert.equal(plainWords(400), "about 300 words");
  assert.equal(plainWords(4000), "about 3,000 words");
});

test("Add a note labels and reasons are plain", () => {
  const texts: string[] = [];
  const facts = {
    claude: { items: [{ kind: "claude-md", scope: "user", path: `${H}/.claude/CLAUDE.md`, when: "launch", access: "editable" }, { kind: "claude-auto-memory", scope: "project", path: PATHS["claude-auto-memory"]!, when: "skipped", access: "editable" }], account: "work@example.com" },
    codex: { items: [{ kind: "agents-md", scope: "project", path: `${H}/code/acme-web/AGENTS.md`, when: "launch", access: "editable", versionControlled: true }] },
  };
  for (const who of ["all", "claude", "codex"] as const) {
    for (const where of [{ kind: "everywhere" as const }, { kind: "project" as const, name: "acme-web" }]) {
      for (const input of [facts, {}, { claude: { unavailable: "Claude isn't set up on this computer." } }]) {
        const plan = planNote(who, where, input);
        texts.push(...plan.targets.map((target) => target.label), ...plan.skipped.map((entry) => entry.reason), ...plan.targets.map((target) => noteTargetWarning(target) ?? ""));
      }
    }
  }
  assertPlain(texts, "add a note");
});
