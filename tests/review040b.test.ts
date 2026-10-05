/**
 * Final review pass on 829fc3d (review-040.md "Final pass"): A, B and C,
 * each written to fail before its fix.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fakePaseo, makeSandbox } from "./helpers";
import { addSkills, fakeGithub, skillMd, writeSkill, type FakeRepo } from "./skills-helpers";

const sb = addSkills(await makeSandbox());
const { handleSkillsPreview, handleSkillDetail } = await import("../server/skill-handlers");
const { forgetSkillCaches, discoverSkills } = await import("../server/skills");
const { setGithubFetch } = await import("../server/github");
const { forgetPrepared } = await import("../server/skill-add");
const { skillMdRunsCommands } = await import("../shared/skill-md");
const { reportLines } = await import("../shared/skills-plain");
const { jargonIn } = await import("../shared/plain");
const ctx = { paseo: fakePaseo(sb).api };
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("no network in tests");
}) as typeof fetch;
const C = "c".repeat(40);
const repos: FakeRepo[] = [{ owner: "acme", repo: "tools", commit: C, files: { "skills/lint-fix/SKILL.md": { text: skillMd("lint-fix", "Fixes lint.") }, "skills/other/SKILL.md": { text: skillMd("other", "Other.") } } }];
beforeEach(() => {
  setGithubFetch(fakeGithub(repos).fetchImpl as never);
  forgetPrepared();
  forgetSkillCaches();
});
after(() => {
  globalThis.fetch = realFetch;
  setGithubFetch(null);
  sb.cleanup();
});

test("040b-A quoted keys and headers that can't be fully read count as running commands", async () => {
  const header = (lines: string) => `---\nname: a\ndescription: d\n${lines}---\nBody.\n`;
  for (const lines of ['"hooks":\n  Stop:\n    - command: x\n', "'hooks':\n  Stop: []\n", '"allowed-tools": Bash\n', "'shell': bash\n", '"context": fork\n']) assert.ok(skillMdRunsCommands(header(lines)), lines);
  // Lines the reader can't classify: fail closed.
  for (const lines of ["? complex key\n: value\n", "<<: *base\n", "- stray item\n", "{hooks: x}\n", "hooks : x\n"]) assert.ok(skillMdRunsCommands(header(lines)), lines);
  // Ordinary headers stay quiet.
  for (const lines of ['license: "MIT: see file"\n', "metadata:\n  version: 1\n", "when_to_use: >\n  folded\n  text\n", "# a comment\n"]) assert.equal(skillMdRunsCommands(header(lines)), null, lines);
  // Since the release pass (040c-D): any quoted key, and any key this plugin doesn't know, counts too.
  for (const lines of ['"license": MIT\n', "description2: >\n  folded\n"]) assert.ok(skillMdRunsCommands(header(lines)), lines);
  writeSkill(join(sb.shared, "quoted-hooks"), header('"hooks":\n  Stop:\n    - command: x\n'));
  try {
    const skill = (await discoverSkills(ctx.paseo as never, { refresh: true })).skills.find((entry) => entry.folder === "quoted-hooks")!;
    assert.equal(skill.scripts, 1);
    assert.match(skill.runsCommands ?? "", /hooks|can't read/);
    const detail = await handleSkillDetail({ skillId: skill.id }, ctx);
    assert.equal(detail.fileList.find((file) => file.path === "SKILL.md")!.kind, "script");
    assert.ok(detail.skill.runsCommands, "the detail view says so");
  } finally {
    rmSync(join(sb.shared, "quoted-hooks"), { recursive: true });
  }
});

test("040b-B a link holding several skills: each choice carries a link that previews", async () => {
  const several = await handleSkillsPreview({ source: { kind: "github", link: "acme/tools" } }, ctx);
  assert.equal(several.ok, false);
  assert.equal(several.source, "acme/tools");
  assert.equal(several.commit, C);
  const choice = several.choices.find((entry) => entry.name === "lint-fix")!;
  assert.equal(choice.link, `acme/tools/skills/lint-fix@${C}`);
  const picked = await handleSkillsPreview({ source: { kind: "github", link: choice.link! } }, ctx);
  assert.equal(picked.ok, true, picked.problem);
  assert.equal(picked.name, "lint-fix");
});

test("040b-C every place a change touched is listed: done, or not and why, in plain words", () => {
  const H = sb.home;
  const reports = [
    { target: join(H, ".agents", "skills", "alpha"), ok: true, action: "moved", readBack: "ok", backupPath: "/b/x" },
    { target: join(H, ".claude", "skills", "alpha"), ok: true, action: "deleted", readBack: "ok", backupPath: "/b/x.link.json" },
    { target: join(H, ".agent-link", "accounts", "claude", "work@example.com", "settings.json"), ok: false, action: "refused", readBack: "skipped", error: "Claude's settings file can't be read (it isn't valid JSON), so it was left as it is." },
    { target: join(H, ".codex", "config.toml"), ok: true, action: "updated", readBack: "ok" },
    { target: join(H, ".agents", ".skill-lock.json"), ok: true, action: "updated", readBack: "ok" },
  ];
  const plain = reportLines(reports, true, H);
  assert.equal(plain.length, 5);
  assert.deepEqual(plain.map((line) => line.ok), [true, true, false, true, true]);
  assert.match(plain[0]!.place, /shared skills place/);
  assert.match(plain[1]!.place, /Claude/);
  assert.match(plain[2]!.place, /Claude's settings \(work@example.com\)/);
  assert.match(plain[2]!.state, /can't be read/);
  assert.equal(plain[2]!.state.includes(" ,"), false, "no stray space where a technical aside was taken out");
  assert.match(plain[3]!.place, /Codex's settings/);
  assert.match(plain[4]!.place, /skills installer's list/);
  for (const line of plain) assert.deepEqual(jargonIn(`${line.place} ${line.state}`), [], `${line.place}: ${line.state}`);
  const technical = reportLines(reports, false, H);
  assert.equal(technical[2]!.place, reports[2]!.target, "technical: the path itself");
});
