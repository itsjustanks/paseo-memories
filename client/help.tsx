import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { PLAIN_GUIDES, PLAIN_GUIDE_TECHNICAL_HINT, type HelpTarget } from "../shared/guides";
import { PLAIN } from "../shared/plain";
import { canOpenLinks, openLink } from "./links";
import { usePlain } from "./mode";
import { Accordion, AccordionItem, Bullets, Button, Divider, HostIcon, NumberedStep, SectionTitle, useTokens } from "./ui";

/**
 * Help (0.5.0; the Guide before): plain questions, each folded, then the
 * technical reference (how each agent loads memory, with the real numbers,
 * and what is read-only and why) and the agents' own docs, folded too.
 */

type Block = { title: string; icon: string; lines: string[] };

const LOADING: Block[] = [
  {
    title: "Claude Code",
    icon: "Bot",
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
    icon: "Bot",
    lines: [
      "Loads your AGENTS.override.md, or else AGENTS.md, from its home folder, then one file per folder from the git root down: AGENTS.override.md, else AGENTS.md.",
      "Project files share a 32 KiB budget: the file that crosses it is cut, and nothing after it loads.",
      "With memories on, only memory_summary.md is added, cut to about 2,500 tokens. MEMORY.md is searched when needed.",
    ],
  },
  {
    title: "Paseo",
    icon: "Monitor",
    lines: [
      "The appended system prompt reaches Claude, Codex, OpenCode, pi and Oh My Pi agents started or relaunched after a change. Running agents keep what they started with. Copilot, Cursor and Gemini (ACP) never get it.",
    ],
  },
  {
    title: "OpenCode, pi, Oh My Pi and Copilot",
    icon: "Users",
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
  icon: "Lock",
  lines: [
    "Managed CLAUDE.md: set by your organisation.",
    "Codex's raw_memories.md, rollout summaries, extensions, working diff and database: Codex rebuilds them, so edits are lost or confuse it. Its MEMORY.md and memory_summary.md can be edited: Codex folds your edit in at its next run, and the wording may change.",
    "Codex developer_instructions and OpenCode's instructions list: they live in config files; edit those files directly.",
    "Copilot Memory: stored online by GitHub. Oh My Pi's generated memory: rebuilt by Oh My Pi.",
  ],
};

const SAFETY: Block = {
  title: "How saving works",
  icon: "ShieldCheck",
  lines: [
    "Every save first copies the old file to Paseo's plugin-data folder (never next to the file), writes the new text in one step, reads it back and shows you a report.",
    "If the file changed since you opened it, the save stops. Values that look like secrets stay hidden until you reveal them, and a save with hidden values in it is refused.",
    "Token counts are estimates (about 4 bytes per token), always shown with ≈.",
  ],
};

/** Where the numbers above come from: each agent's own documentation. */
const DOCS = [
  { label: "Claude Code: how Claude remembers your project", url: "https://code.claude.com/docs/en/memory" },
  { label: "Codex: memories", url: "https://learn.chatgpt.com/docs/customization/memories?surface=app" },
  { label: "Codex: AGENTS.md", url: "https://learn.chatgpt.com/docs/agent-configuration/agents-md" },
  { label: "OpenCode: rules", url: "https://opencode.ai/docs/rules/" },
  { label: "Copilot CLI: custom instructions", url: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions" },
  { label: "Copilot Memory", url: "https://docs.github.com/en/copilot/concepts/agents/copilot-memory" },
] as const;

/** The agents' own docs, opened in the browser. Only on apps that can open links (Paseo 0.10+). */
function DocsList() {
  const t = useTokens();
  const [message, setMessage] = useState("");
  const open = (url: string) =>
    void openLink(url).then((outcome) => setMessage(outcome === "opened" ? "" : outcome === "copied" ? `Couldn't open a browser, so the link was copied: ${url}` : `Couldn't open a browser. The link is ${url}`));
  return (
    <View style={{ gap: t.space.hair }}>
      {DOCS.map((doc) => (
        <Pressable key={doc.url} accessibilityRole="link" accessibilityLabel={`${doc.label} (opens in your browser)`} onPress={() => open(doc.url)} hitSlop={t.control.hit} style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, paddingVertical: t.space.xs + t.space.hair, alignSelf: "flex-start" }}>
          {HostIcon ? <HostIcon name="ExternalLink" size={16} color={t.color.accent} /> : null}
          <Text style={[t.text.body, { color: t.color.accent, fontWeight: "600", flexShrink: 1 }]}>{doc.label}</Text>
        </Pressable>
      ))}
      {message ? <Text style={t.text.caption}>{message}</Text> : null}
    </View>
  );
}

/** The reference, one heading and its points per part, split by rules (no cards inside a fold-out). */
function Reference() {
  const t = useTokens();
  return (
    <>
      {[...LOADING, READ_ONLY, SAFETY].map((block, index) => (
        <React.Fragment key={block.title}>
          {index > 0 ? <Divider /> : null}
          <View style={{ gap: t.space.sm }}>
            <SectionTitle icon={block.icon}>{block.title}</SectionTitle>
            <Bullets items={block.lines} icon="Dot" />
          </View>
        </React.Fragment>
      ))}
    </>
  );
}

const H = PLAIN.help;

/** Help: common questions, each folded with one button where it helps; then the details, folded (open in technical mode). */
export function Help({ onAction }: { onAction: (target: HelpTarget) => void }) {
  const t = useTokens();
  const plain = usePlain();
  return (
    <View style={{ gap: t.space.section }}>
      <View style={{ gap: t.space.row }}>
        <SectionTitle icon="CircleHelp">{H.questions}</SectionTitle>
        <Accordion>
          {PLAIN_GUIDES.map((guide) => (
            <AccordionItem key={guide.title} icon={guide.icon} title={guide.title}>
              {guide.steps.map((step, n) => (
                <NumberedStep key={step} n={n + 1}>
                  {step}
                </NumberedStep>
              ))}
              {guide.action ? (
                <View style={{ flexDirection: "row" }}>
                  <Button label={guide.action.label} onPress={() => onAction(guide.action!.to)} />
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
          {plain ? <Text style={t.text.caption}>{PLAIN_GUIDE_TECHNICAL_HINT}</Text> : null}
          <Reference />
        </AccordionItem>
        {canOpenLinks() ? (
          <AccordionItem icon="ExternalLink" title={H.docsTitle} summary={H.docsSummary}>
            <DocsList />
          </AccordionItem>
        ) : null}
      </Accordion>
    </View>
  );
}
