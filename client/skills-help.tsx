import React from "react";
import { Text, View } from "react-native";
import { CLAUDE_DESC_CAP, CODEX_DESC_CAP } from "../shared/skill-md";
import { SKILL_HOW_TOS, SKILLS_PLAIN as S } from "../shared/skills-plain";
import { usePlain } from "./mode";
import type { SkillsPlace } from "./skills-nav";
import { Accordion, AccordionItem, Bullets, Button, Meta, NumberedStep, SectionTitle, useTokens } from "./ui";

/**
 * Help (0.5.0; the Guide before): plain questions for skills, each folded with
 * one button where it helps, then (folded) where each agent finds them and
 * what this plugin will and won't change. The technical reference names
 * files and folders; the plain part never does.
 */


const REFERENCE = [
  "Claude: ~/.claude/skills (or each account's CLAUDE_CONFIG_DIR), its synced/ claude.ai copies, enabled plugins' skills/, the managed .claude/skills, and a project's .claude/skills from the folder up to the repository root.",
  "Shared: ~/.agents/skills, read by Codex, OpenCode, Copilot, Gemini, Cursor and pi; npx skills installs here and records each skill in ~/.agents/.skill-lock.json (v3).",
  "Codex: also $CODEX_HOME/skills (older), its .system built-ins and /etc/codex/skills; a project's .agents/skills and .codex/skills.",
  `Listing cost: Claude keeps 1% of the model's context window for names and descriptions (each cut at ${CLAUDE_DESC_CAP} characters); Codex keeps 2% (each cut at ${CODEX_DESC_CAP}).`,
  "Turn off: Claude's skillOverrides in the account's settings.json; Codex's [[skills.config]] name / enabled = false in config.toml. Plugin, claude.ai, built-in and Paseo skills are never changed here.",
  "Add: one copy in ~/.agents/skills, a relative link in each Claude account's skills/, and a lock entry. Remove: the folder and its links go to $PASEO_HOME/plugin-data/paseo-memories/backups/.",
  "Usage: Claude's Skill tool calls and typed /name commands in <account>/projects/**/*.jsonl (exact); Codex's <skill> blocks and SKILL.md reads in $CODEX_HOME/sessions (estimated).",
];

export function SkillsHelp({ onGo }: { onGo: (place: SkillsPlace) => void }) {
  const t = useTokens();
  const plain = usePlain();
  const H = S.help;
  return (
    <View style={{ gap: t.space.section }}>
      <View style={{ gap: t.space.row }}>
        <SectionTitle icon="CircleHelp">{H.questions}</SectionTitle>
        <Accordion>
          {SKILL_HOW_TOS.map((howTo) => (
            <AccordionItem key={howTo.title} icon={howTo.icon} title={howTo.title}>
              {howTo.steps.map((step, n) => (
                <NumberedStep key={step} n={n + 1}>
                  {step}
                </NumberedStep>
              ))}
              {howTo.action ? (
                <View style={{ flexDirection: "row" }}>
                  <Button label={howTo.action.label} onPress={() => onGo(howTo.action!.place)} />
                </View>
              ) : null}
            </AccordionItem>
          ))}
          <AccordionItem icon="LayoutGrid" title={H.tabsQuestion}>
            {H.tabs.map((entry) => (
              <View key={entry.tab} style={{ gap: t.space.xs }}>
                <Text style={t.text.bodyStrong}>{entry.tab}</Text>
                <Bullets items={entry.canDo} />
              </View>
            ))}
          </AccordionItem>
        </Accordion>
      </View>
      <Accordion>
        <AccordionItem icon="SlidersHorizontal" title={H.detailsTitle} summary={H.detailsSummary} open={!plain}>
          <Bullets items={REFERENCE} icon="Dot" />
          <Meta>{S.usage.estimated}</Meta>
        </AccordionItem>
      </Accordion>
    </View>
  );
}
