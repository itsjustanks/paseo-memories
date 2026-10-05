import React from "react";
import { Text, View } from "react-native";
import { CLAUDE_DESC_CAP, CODEX_DESC_CAP } from "../shared/skill-md";
import { SKILLS_PLAIN as S } from "../shared/skills-plain";
import { usePlain } from "./mode";
import { Bullets, Card, Disclosure, Meta, NumberedStep, useTokens } from "./ui";

/**
 * Plain how-tos for skills, then (folded) where each agent finds them and
 * what this plugin will and won't change. The technical reference names
 * files and folders; the plain part never does.
 */

const HOW_TOS = [
  { title: "Add a well-known skill", steps: ["Open Add a skill and stay on From our list.", "Press Preview on the one you want and read what it adds.", "If it includes code, read its files and tick the box. Then press Add it."] },
  { title: "Keep the list short", steps: ["Open Usage and pick 30 days.", "Open the folded list of skills not used in that time.", "Press Turn off on the ones you don't need. Nothing is deleted."] },
  { title: "Write your own", steps: ["Open Add a skill, then Write your own.", "Give it a short name, say when agents should use it, and write the steps.", "Press Check it, read the preview, then Add it."] },
  { title: "Put a removed skill back", steps: ["Removed skills go to this plugin's backups, never straight to the bin.", "Ask an agent to move the folder back from the backups into the shared skills place, or do it in Finder."] },
] as const;

const REFERENCE = [
  "Claude: ~/.claude/skills (or each account's CLAUDE_CONFIG_DIR), its synced/ claude.ai copies, enabled plugins' skills/, the managed .claude/skills, and a project's .claude/skills from the folder up to the repository root.",
  "Shared: ~/.agents/skills, read by Codex, OpenCode, Copilot, Gemini, Cursor and pi; npx skills installs here and records each skill in ~/.agents/.skill-lock.json (v3).",
  "Codex: also $CODEX_HOME/skills (older), its .system built-ins and /etc/codex/skills; a project's .agents/skills and .codex/skills.",
  `Listing cost: Claude keeps 1% of the model's context window for names and descriptions (each cut at ${CLAUDE_DESC_CAP} characters); Codex keeps 2% (each cut at ${CODEX_DESC_CAP}).`,
  "Turn off: Claude's skillOverrides in the account's settings.json; Codex's [[skills.config]] name / enabled = false in config.toml. Plugin, claude.ai, built-in and Paseo skills are never changed here.",
  "Add: one copy in ~/.agents/skills, a relative link in each Claude account's skills/, and a lock entry. Remove: the folder and its links go to $PASEO_HOME/plugin-data/paseo-memories/backups/.",
  "Usage: Claude's Skill tool calls and typed /name commands in <account>/projects/**/*.jsonl (exact); Codex's <skill> blocks and SKILL.md reads in $CODEX_HOME/sessions (estimated).",
];

export function SkillsGuide() {
  const t = useTokens();
  const plain = usePlain();
  return (
    <>
      {HOW_TOS.map((howTo, index) => (
        <Disclosure key={howTo.title} title={howTo.title} open={index === 0}>
          <Card>
            {howTo.steps.map((step, n) => (
              <NumberedStep key={step} n={n + 1}>
                {step}
              </NumberedStep>
            ))}
          </Card>
        </Disclosure>
      ))}
      <Disclosure quiet title={plain ? "Technical details" : "Reference"} open={!plain}>
        <Card>
          <View style={{ gap: t.space.sm }}>
            <Bullets items={REFERENCE} icon="Dot" />
          </View>
          <Meta>{S.usage.estimated}</Meta>
        </Card>
      </Disclosure>
      <Text style={t.text.caption}>{S.about.flowNote}</Text>
    </>
  );
}
