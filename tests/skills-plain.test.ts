/**
 * Skills in plain mode: every label, intro, finding and host message a
 * person sees with technical details off is checked against the jargon list
 * (no SKILL.md, npx, lock files, links on disk, tokens or git). Host
 * messages come from a real discovery of the sandbox, every finding kind
 * included, plus the add/turn-off/remove sentences.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { jargonIn } from "../shared/plain";
import { SKILL_FINDING_KINDS, SKILL_PROVENANCE } from "../shared/skill-contracts";
import { SKILL_TABS, SKILLS_PLAIN, plainProvenance, plainReaders, plainSkillFinding, plainSkillMessage, plainState, plainWordsFromChars, sinceText } from "../shared/skills-plain";
import { fakePaseo, makeSandbox } from "./helpers";
import { addSkills } from "./skills-helpers";

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
  assert.deepEqual(texts.flatMap((text) => jargonIn(text).map((word) => `${word} in "${text}"`)), [], what);
}

test("Skills' plain strings, tabs, origins and states have no jargon", () => {
  assertPlain(strings(SKILLS_PLAIN), "SKILLS_PLAIN");
  assertPlain(SKILL_TABS.map((tab) => tab.label), "tabs");
  assertPlain(SKILL_PROVENANCE.flatMap((kind) => [plainProvenance(kind), plainProvenance(kind, "acme/agent-skills")]), "origins");
  assertPlain(["on", "off", "mixed", "name-only", "user-invocable-only", "model-off"].map(plainState), "states");
  assertPlain([plainReaders(["codex", "opencode", "copilot", "gemini", "cursor", "pi", "claude"]), plainWordsFromChars(9400), sinceText(new Date().toISOString())], "helpers");
});

test("every finding and host message the sandbox produces reads plainly", async () => {
  const sb = addSkills(await makeSandbox());
  try {
    const { discoverSkills, forgetSkillCaches } = await import("../server/skills");
    const { PLAN_CHANGED, SCRIPTS_CONFIRM, OFF_MAIN_LINE } = await import("../server/skill-add");
    const { RUNS_COMMANDS, skillMdRunsCommands } = await import("../shared/skill-md");
    forgetSkillCaches();
    const d = await discoverSkills(fakePaseo(sb).api, { refresh: true });
    const kinds = new Set(d.findings.map((finding) => finding.kind));
    for (const kind of ["broken-link", "empty-folder", "stray-file", "invalid", "duplicate", "paseo-orphan", "lock-missing"]) assert.ok(kinds.has(kind), kind);
    const findings = [
      ...d.findings,
      { kind: "unused", message: "3 skills weren't used in the last 30 days on this computer but are listed at the start of every chat (about 160 tokens)." },
      { kind: "over-budget", message: "Claude's skill list (Default (~/.claude)) is about 9,400 characters, over the 8,000 it keeps whole; some descriptions get cut." },
    ];
    for (const kind of SKILL_FINDING_KINDS) assert.ok(findings.some((finding) => finding.kind === kind), `sample for ${kind}`);
    assertPlain(findings.flatMap((finding) => Object.values(plainSkillFinding(finding))), "findings");
    const messages = [
      PLAN_CHANGED,
      SCRIPTS_CONFIRM,
      ...d.skills.flatMap((skill) => [skill.reason ?? "", skill.can.turnOffReason ?? "", skill.can.removeReason ?? "", ...skill.problems.map((problem) => problem.message)]),
      d.lock.read.ok ? "" : d.lock.read.reason,
      "The skills record kept by npx skills is version 2; this plugin only updates version 3, so it was left as it is.",
      "Added, but npx skills' list could not be updated (No permission to write .skill-lock.json.).",
      "There's no skill (no SKILL.md) at that address.",
      "Claude's settings file can't be read (it isn't valid JSON), so it was left as it is.",
      OFF_MAIN_LINE,
      RUNS_COMMANDS,
      ...["---\nname: a\ndescription: d\nhooks:\n  x: y\n---\n", "---\nname: a\ndescription: d\nallowed-tools: Bash\n---\n", "---\nname: a\ndescription: d\nshell: bash\n---\n", "---\nname: a\ndescription: d\nagent: x\n---\n", "---\nname: a\ndescription: d\n---\n!`date`\n"].map((text) => skillMdRunsCommands(text) ?? ""),
      "It contains .paseo-managed-files.json, which marks it as looked after by another program, so it isn't added.",
      "Two of its files differ only in capitals or accents (notes.md and NOTES.md), so one would overwrite the other on many disks. It isn't added.",
      "This skill calls itself alpha but its folder is nice-helper; agents could mistake it for another skill, so it isn't added.",
      'Added, but Claude couldn\'t see it in one account (work): No permission to write alpha. Use "Link it for Claude" to try again.',
      "A link for Claude led somewhere else after it was made. Nothing was added.",
      "npx skills' list read back differently from what was written. Nothing was added.",
    ].filter(Boolean);
    // A message may name the skill's own file; plain mode shows no file names, so drop names with dots first.
    const plainMessages = messages.map(plainSkillMessage);
    assert.equal(plainMessages.some((text) => text.includes(".paseo-managed-files.json")), false, "no marker file name in plain mode");
    assertPlain(plainMessages.map((text) => text.replace(/\S+\.(json|toml|md)\b/g, "a file")), "host messages");
  } finally {
    sb.cleanup();
  }
});
