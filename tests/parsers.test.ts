import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { baseCli, expandHome, inheritedEnv, launchEnvFor, launchValue, readProviderLaunch } from "../shared/agents";
import { formatScalar, frontmatterKeys, newMemoryFile, parseMemoryFile, readFields, serializeMemoryFile, setBody, setField } from "../shared/frontmatter";
import { CLAUDE_MEMORY_INDEX_BYTES, byteLength, claudeIndexLoad, lineCount, tokensFor } from "../shared/limits";
import { importRefs, replaceSection, sectionText, splitSections } from "../shared/markdown";
import { parseIndex, removeIndexLine, renameIndexLine, upsertIndexLine } from "../shared/memory-index";
import { MASK_FILL, findSecrets, hasNewMask, maskSecrets } from "../shared/secrets";
import { claudeSlug, javaHash } from "../shared/slug";
import { parseToml } from "../shared/toml";
import { FIXTURES } from "./helpers";

const memory = (name: string) => readFileSync(join(FIXTURES, "home", ".claude", "projects", "@app", "memory", name), "utf8");

// ------------------------------------------------------------------ frontmatter

test("all three frontmatter shapes parse", () => {
  const nested = readFields(parseMemoryFile(memory("nested.md")));
  assert.equal(nested.shape, "nested");
  assert.equal(nested.name, "Nested memory");
  assert.equal(nested.description, "Uses the nested: metadata shape");
  assert.equal(nested.type, "project");
  assert.equal(nested.extra["metadata.node_type"], "memory");
  assert.equal(nested.extra["metadata.originSessionId"], "11111111-2222-3333-4444-555555555555");
  assert.deepEqual(nested.extra.tags, ["alpha", "beta"]);
  assert.equal(nested.extra["metadata.reviewer"], "someone");

  const flat = readFields(parseMemoryFile(memory("flat.md")));
  assert.deepEqual([flat.shape, flat.type, flat.name], ["flat", "feedback", "Flat memory"]);

  const session = readFields(parseMemoryFile(memory("flat_session.md")));
  assert.deepEqual([session.shape, session.type], ["flat-session", "reference"]);
  assert.equal(session.extra.originSessionId, "99999999-8888-7777-6666-555555555555");
});

test("a file without frontmatter is all body, and round-trips", () => {
  const text = "Just a note.\n";
  const file = parseMemoryFile(text);
  assert.equal(file.hasFrontmatter, false);
  assert.equal(readFields(file).shape, "none");
  assert.equal(serializeMemoryFile(file), text);
});

test("parse then serialize is byte-identical for every shape", () => {
  for (const name of ["nested.md", "flat.md", "flat_session.md", "unindexed.md", "secret.md"]) {
    assert.equal(serializeMemoryFile(parseMemoryFile(memory(name))), memory(name), name);
  }
  const crlf = memory("flat.md").replace(/\n/g, "\r\n");
  assert.equal(serializeMemoryFile(parseMemoryFile(crlf)), crlf);
});

test("editing one field changes only that line: unknown keys, comments and quoting stay", () => {
  const original = memory("nested.md");
  const edited = serializeMemoryFile(setField(setField(parseMemoryFile(original), "type", "feedback"), "description", "New: description"));
  const before = original.split("\n");
  const after = edited.split("\n");
  assert.equal(after.length, before.length);
  const changed = before.map((line, index) => (line === after[index] ? null : index)).filter((index) => index !== null);
  assert.deepEqual(changed, [2, 6], "only description (quoted) and metadata.type lines changed");
  assert.equal(after[2], 'description: "New: description"', "quoted stays quoted");
  assert.equal(after[6], "  type: feedback", "nested type edited in place");
  assert.ok(edited.includes("# a comment the plugin must keep"));
  assert.ok(edited.includes("  reviewer: someone"));
  const fields = readFields(parseMemoryFile(edited));
  assert.deepEqual([fields.shape, fields.type, fields.description], ["nested", "feedback", "New: description"]);
});

test("flat shapes keep type at the top level; a body edit leaves the frontmatter bytes alone", () => {
  const original = memory("flat_session.md");
  const file = setBody(setField(parseMemoryFile(original), "type", "project"), "\nNew body.\n");
  const text = serializeMemoryFile(file);
  assert.ok(text.includes("\ntype: project\n"));
  assert.ok(!text.includes("metadata:"));
  assert.ok(text.includes("originSessionId: 99999999-8888-7777-6666-555555555555"));
  assert.ok(text.endsWith("---\n\nNew body.\n"));
  assert.equal(readFields(parseMemoryFile(text)).shape, "flat-session");
});

test("a missing field is added next to its siblings; a value needing quotes gets them", () => {
  const file = parseMemoryFile("---\nname: A\ntype: user\nextra: 1\n---\nBody\n");
  const text = serializeMemoryFile(setField(file, "description", "has: colon"));
  assert.equal(text, '---\nname: A\ndescription: "has: colon"\ntype: user\nextra: 1\n---\nBody\n');
  assert.equal(formatScalar("plain words"), "plain words");
  assert.equal(formatScalar("true"), '"true"');
  assert.equal(formatScalar("- dash"), '"- dash"');
  assert.equal(formatScalar("multi\nline"), '"multi\\nline"');
});

test("new files come out in the shape asked for and parse back", () => {
  const nested = newMemoryFile({ name: "N", description: "D", type: "feedback" }, "Body text");
  assert.equal(nested, "---\nname: N\ndescription: D\nmetadata:\n  node_type: memory\n  type: feedback\n---\nBody text\n");
  assert.equal(readFields(parseMemoryFile(nested)).shape, "nested");
  const flat = newMemoryFile({ name: "N", description: "D" }, "\nBody\n", "flat");
  assert.equal(readFields(parseMemoryFile(flat)).shape, "flat");
  assert.equal(readFields(parseMemoryFile(flat)).type, "project");
});

test("rule and Copilot frontmatter keys are read", () => {
  assert.deepEqual(frontmatterKeys(readFileSync(join(FIXTURES, "home", ".claude", "rules", "frontend", "react.md"), "utf8")).paths, ["src/**/*.tsx"]);
  assert.equal(frontmatterKeys("---\napplyTo: \"**/*.ts\"\n---\nx").applyTo, "**/*.ts");
});

// ------------------------------------------------------------------ MEMORY.md index

test("index lines parse with either separator, and skip what is not a memory line", () => {
  const lines = parseIndex(memory("MEMORY.md"));
  assert.deepEqual(lines.map((line) => line.file), ["nested.md", "flat.md", "flat_session.md", "secret.md", "missing.md"]);
  assert.equal(lines[2]!.separator, " - ");
  assert.equal(lines[0]!.separator, " — ");
  assert.equal(lines[0]!.hook, "the nested shape");
  assert.deepEqual(parseIndex("- [A](./a%20b.md)\n- [Web](https://x.test/a.md) — link\n# heading\n").map((line) => line.file), ["a b.md"]);
});

test("index edits touch one line and keep the file's separator", () => {
  const text = memory("MEMORY.md");
  const added = upsertIndexLine(text, "new.md", "New", "a hook");
  assert.equal(added, `${text}- [New](new.md) — a hook\n`);
  const updated = upsertIndexLine(text, "flat_session.md", "Renamed title", "new hook");
  assert.ok(updated.includes("- [Renamed title](flat_session.md) - new hook"), "the ' - ' line keeps ' - '");
  assert.equal(updated.split("\n").length, text.split("\n").length);
  const renamed = renameIndexLine(text, "flat.md", "flat2.md");
  assert.ok(renamed.includes("- [Flat memory](flat2.md) — the flat shape"));
  assert.ok(!parseIndex(renamed).some((line) => line.file === "flat.md"));
  const removed = removeIndexLine(text, "missing.md");
  assert.equal(removed.split("\n").length, text.split("\n").length - 1);
  assert.ok(removed.startsWith("# Memory index\n"));
  assert.equal(removeIndexLine(text, "nope.md"), text);
  assert.equal(upsertIndexLine("", "a.md", "A", ""), "- [A](a.md)\n");
});

// ------------------------------------------------------------------ markdown

test("sections split on headings outside code fences; one can be replaced alone", () => {
  const text = "intro\n\n# One\na\n```\n# not a heading\n```\n## Two\nb\n";
  const sections = splitSections(text);
  assert.deepEqual(sections.map((section) => [section.key, section.title]), [["0:", "(top of file)"], ["1:one", "One"], ["2:two", "Two"]]);
  assert.equal(sectionText(text, sections[2]!), "## Two\nb");
  assert.equal(replaceSection(text, sections[2]!, "## Two\nchanged\n"), "intro\n\n# One\na\n```\n# not a heading\n```\n## Two\nchanged\n");
});

test("@imports are found outside code, emails are not", () => {
  const refs = importRefs("See @docs/a.md and @~/b.md.\nMail me@example.com\n`@not/this`\n```\n@nor/this\n```\n@./c.md\n");
  assert.deepEqual(refs, ["docs/a.md", "~/b.md", "./c.md"]);
});

// ------------------------------------------------------------------ TOML

test("Codex config.toml: tables, multi-line strings, arrays, quoted headers", () => {
  const tables = parseToml(readFileSync(join(FIXTURES, "home", ".codex", "config.toml"), "utf8"));
  assert.equal(tables[""]!.developer_instructions, "Be brief.\nCite files.");
  assert.deepEqual(tables[""]!.project_doc_fallback_filenames, ["TEAM.md"]);
  assert.equal(tables.features!.memories, true);
  assert.equal(tables.memories!.use_memories, true);
  assert.equal(tables["projects./tmp/whatever"]!.trust_level, "trusted");
  const multi = parseToml('project_root_markers = [\n  ".git",\n  ".hg", # comment\n]\nproject_doc_max_bytes = 1_024\n');
  assert.deepEqual(multi[""]!.project_root_markers, [".git", ".hg"]);
  assert.equal(multi[""]!.project_doc_max_bytes, 1024);
});

// ------------------------------------------------------------------ slug

test("Claude's folder name for a path, including past 200 characters", () => {
  assert.equal(claudeSlug("/Users/sam/code/demo"), "-Users-sam-code-demo");
  assert.equal(claudeSlug("/a.b_c d/é😀"), "-a-b-c-d----");
  const long = `/Users/me/${"deep-folder/".repeat(30)}project`;
  const slug = claudeSlug(long);
  assert.equal(slug.length > 200, true);
  assert.equal(slug.slice(0, 200), long.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200));
  assert.equal(slug.slice(201), Math.abs(javaHash(long)).toString(36));
  // Java String.hashCode reference values.
  assert.equal(javaHash("hello"), 99162322);
  assert.equal(javaHash(""), 0);
});

// ------------------------------------------------------------------ secrets

test("token shapes are found and masked; the mask is recognisable", () => {
  const text = [
    "anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
    "github ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    "slack xoxb-1234567890-abcdefghij",
    "aws AKIAABCDEFGHIJKLMNOP",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "api_key=0123456789abcdef0123456789abcdef",
    "password: Zq8vN2mPx7RtY4kL9wB3",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
  ].join("\n");
  const found = findSecrets(text);
  assert.equal(found.length, 9, found.map((match) => match.kind).join(", "));
  const masked = maskSecrets(text);
  assert.equal(masked.count, 9);
  assert.ok(!masked.text.includes("abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.ok(masked.text.includes(`sk-a${MASK_FILL}`));
  assert.ok(masked.text.includes(`password: Zq8v${MASK_FILL}`));
  assert.equal(findSecrets(masked.text).length, 0, "a masked value is not found again");
  assert.equal(hasNewMask(masked.text, text), true);
  assert.equal(hasNewMask(text, text), false);
});

test("ordinary prose is not a secret", () => {
  const prose = "The token: refresh happens hourly. password: see 1Password. sk-learn is a library. The key=value pairs are fine.";
  assert.deepEqual(findSecrets(prose), []);
});

// ------------------------------------------------------------------ limits and env layering

test("MEMORY.md loads 200 lines or 25,000 bytes, whichever comes first", () => {
  const short = "a\nb\n";
  assert.deepEqual(claudeIndexLoad(short), { bytes: 4, lines: 2, truncated: false });
  const many = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
  const cut = claudeIndexLoad(many);
  assert.deepEqual([cut.lines, cut.truncated, cut.reason], [200, true, "lines"]);
  const wide = Array.from({ length: 100 }, () => "x".repeat(499)).join("\n");
  const bytes = claudeIndexLoad(wide);
  assert.equal(bytes.truncated, true);
  assert.equal(bytes.reason, "bytes");
  assert.ok(bytes.bytes <= CLAUDE_MEMORY_INDEX_BYTES);
  assert.equal(bytes.lines, 50);
  assert.equal(tokensFor(10), 3);
  assert.equal(byteLength("é😀"), 6);
  assert.equal(lineCount("a\nb"), 2);
});

test("provider env: daemon, then base provider, then provider; ~ expanded", () => {
  const launch = readProviderLaunch({
    providers: {
      claude: { env: { CLAUDE_CONFIG_DIR: "~/.claude-base" } },
      work: { extends: "claude", env: { CLAUDE_CONFIG_DIR: "~/.claude-work" } },
      derived: { extends: "claude", env: {} },
      codex2: { extends: "codex", env: { CODEX_HOME: "/abs/codex" } },
    },
  });
  const daemon = { CLAUDE_CONFIG_DIR: "/daemon/claude", CODEX_HOME: "/daemon/codex" };
  assert.equal(launchValue("CLAUDE_CONFIG_DIR", launchEnvFor("work", launch, daemon)), "~/.claude-work");
  assert.equal(launchValue("CLAUDE_CONFIG_DIR", launchEnvFor("derived", launch, daemon)), "~/.claude-base");
  assert.equal(launchValue("CODEX_HOME", launchEnvFor("codex", launch, daemon)), "/daemon/codex");
  assert.equal(launchValue("CODEX_HOME", launchEnvFor("codex2", launch, daemon)), "/abs/codex");
  assert.deepEqual(inheritedEnv("derived", launch), { CLAUDE_CONFIG_DIR: "~/.claude-base" });
  assert.equal(baseCli("work", launch), "claude");
  assert.equal(expandHome("~/.claude-work", "/home/me"), "/home/me/.claude-work");
});
