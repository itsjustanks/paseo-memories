import React from "react";
import { Text, View } from "react-native";
import { PLAIN_GUIDES, PLAIN_GUIDE_TECHNICAL_HINT } from "../shared/guides";
import { PLAIN } from "../shared/plain";
import { usePlain } from "./mode";
import { Card, Disclosure, Section, useTokens } from "./ui";

/** How each agent loads memory, with the real numbers, and what is read-only and why. */

type Block = { title: string; lines: string[] };

const LOADING: Block[] = [
  {
    title: "Claude Code",
    lines: [
      "Loads, broadest first: your organisation's managed CLAUDE.md, your own CLAUDE.md and rules, then CLAUDE.md (or .claude/CLAUDE.md) and CLAUDE.local.md in every folder from the top of the disk down to where the agent starts.",
      "@path imports are followed up to 4 hops. A CLAUDE.md over 4 MiB is skipped.",
      "Rules with paths: in their frontmatter, and CLAUDE.md files in subfolders, load only when Claude reads a matching file.",
      "AGENTS.md: read only when the project has no CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md of its own (the default; settings.json can change it).",
      "Auto memory: the first 200 lines or 25,000 bytes of MEMORY.md load at launch; each memory file loads when Claude needs it. All worktrees and subfolders of one git repository share one memory folder.",
    ],
  },
  {
    title: "Codex",
    lines: [
      "Loads your AGENTS.override.md, or else AGENTS.md, from its home folder, then one file per folder from the git root down: AGENTS.override.md, else AGENTS.md.",
      "Project files share a 32 KiB budget: the file that crosses it is cut, and nothing after it loads.",
      "With memories on, only memory_summary.md is added, cut to about 2,500 tokens. MEMORY.md is searched when needed.",
    ],
  },
  {
    title: "Paseo",
    lines: [
      "The appended system prompt reaches Claude, Codex, OpenCode, pi and Oh My Pi agents started or relaunched after a change. Running agents keep what they started with. Copilot, Cursor and Gemini (ACP) never get it.",
    ],
  },
  {
    title: "OpenCode, pi, Oh My Pi and Copilot",
    lines: [
      "OpenCode: its own AGENTS.md, or Claude's user CLAUDE.md when it has none; in the project, AGENTS.md, else CLAUDE.md, else CONTEXT.md.",
      "pi: the first of AGENTS.override.md, AGENTS.md and CLAUDE.md in each folder up to the top of the disk. SYSTEM.md replaces pi's own prompt.",
      "Oh My Pi: one user file (its own first, then other agents'), its .omp folder's AGENTS.md and RULES.md, and one project file per folder depth.",
      "Copilot CLI: its instructions files plus AGENTS.md and CLAUDE.md from the repository root down, all merged.",
    ],
  },
];

const READ_ONLY: Block = {
  title: "What you cannot edit here, and why",
  lines: [
    "Managed CLAUDE.md: set by your organisation.",
    "Codex's raw_memories.md, rollout summaries, extensions, working diff and database: Codex rebuilds them, so edits are lost or confuse it. Its MEMORY.md and memory_summary.md can be edited: Codex folds your edit in at its next run, and the wording may change.",
    "Codex developer_instructions and OpenCode's instructions list: they live in config files; edit those files directly.",
    "Copilot Memory: stored online by GitHub. Oh My Pi's generated memory: rebuilt by Oh My Pi.",
  ],
};

const SAFETY: Block = {
  title: "How saving works",
  lines: [
    "Every save first copies the old file to Paseo's plugin-data folder (never next to the file), writes the new text in one step, reads it back and shows you a report.",
    "If the file changed since you opened it, the save stops. Values that look like secrets stay hidden until you reveal them, and a save with hidden values in it is refused.",
    "Token counts are estimates (about 4 bytes per token), always shown with ≈.",
  ],
};

function Reference() {
  const t = useTokens();
  return (
    <View style={{ gap: t.space.lg }}>
      {[...LOADING, READ_ONLY, SAFETY].map((block) => (
        <Section key={block.title} title={block.title}>
          <Card>
            {block.lines.map((line) => (
              <Text key={line} style={t.text.body}>
                {`•  ${line}`}
              </Text>
            ))}
          </Card>
        </Section>
      ))}
    </View>
  );
}

/** Plain: task guides, numbered, then the reference folded away. Technical: the reference as it was. */
export function Guide() {
  const t = useTokens();
  const plain = usePlain();
  if (!plain) return <Reference />;
  return (
    <View style={{ gap: t.space.lg }}>
      {PLAIN_GUIDES.map((guide) => (
        <Section key={guide.title} title={guide.title}>
          <Card>
            <View style={{ gap: t.space.sm }}>
              {guide.steps.map((step, index) => (
                <View key={step} style={{ flexDirection: "row", gap: t.space.sm, alignItems: "flex-start" }}>
                  <Text style={[t.text.bodyStrong, { width: 20, flexShrink: 0 }]}>{`${index + 1}.`}</Text>
                  <Text style={[t.text.body, { flex: 1, minWidth: 0 }]}>{step}</Text>
                </View>
              ))}
            </View>
          </Card>
        </Section>
      ))}
      <Disclosure title={PLAIN.technical}>
        <Text style={t.text.caption}>{PLAIN_GUIDE_TECHNICAL_HINT}</Text>
        <Reference />
      </Disclosure>
    </View>
  );
}
