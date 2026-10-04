import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { Text, View } from "react-native";
import { skillsAgent, skillsWorkspace } from "../shared/skill-contracts";
import { SKILLS_PLAIN as S, plainProvenance, plainWordsFromChars } from "../shared/skills-plain";
import { KEY, QueryState } from "./data";
import { usePlain } from "./mode";
import { canOpenScreen } from "./screens";
import { openSkills } from "./skills-nav";
import { Card, Disclosure, Link, Meta, Row, Section, Tag, useTokens } from "./ui";

/**
 * The Skills part of the Memories panels: how many skills an agent here can
 * use and what that list costs at the start of every chat, which ones were
 * used (in this chat when Paseo says which chat it is, else in this folder),
 * and the full list folded away.
 */

type Used = Array<{ name: string; count: number; skillId?: string }>;
type PanelSkill = { skillId: string; name: string; description: string; provenance: string; listingChars: number; state: string };

function UsedList({ used }: { used: Used }) {
  const t = useTokens();
  if (!used.length) return <Meta>{S.panel.noneUsed}</Meta>;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
      {used.slice(0, 12).map((entry) => (
        <Tag key={entry.name} label={`${entry.name} · ${entry.count}×`} tone="ok" />
      ))}
    </View>
  );
}

function AllSkills({ title, skills }: { title: string; skills: PanelSkill[] }) {
  const plain = usePlain();
  return (
    <Disclosure quiet title={title}>
      <Card padded={false}>
        {skills.map((skill, index) => (
          <Row
            key={skill.skillId}
            first={index === 0}
            title={skill.name}
            meta={<Meta>{plain ? plainProvenance(skill.provenance) : skill.provenance}</Meta>}
            trailing={skill.state === "off" ? <Tag label="Off" /> : null}
            {...(canOpenScreen() ? { onPress: () => openSkills({ tab: "skills", skillId: skill.skillId }) } : {})}
          />
        ))}
      </Card>
    </Disclosure>
  );
}

function costLine(count: number, chars: number, plain: boolean): string {
  return plain ? S.panel.count(count, plainWordsFromChars(chars)) : `${count} skills · ${chars.toLocaleString("en-US")} characters listed at the start`;
}

export function WorkspaceSkills({ hostId, workspaceId }: { hostId: string; workspaceId: string }) {
  const plain = usePlain();
  const call = useRpc(skillsWorkspace);
  const query = useQuery({ queryKey: [KEY, hostId, "skills", "workspace", workspaceId], queryFn: () => call({ workspaceId }), retry: 1, refetchOnMount: "always" });
  const data = query.data;
  const all = new Map<string, PanelSkill>();
  for (const agent of data?.agents ?? []) for (const skill of agent.skills) all.set(skill.skillId, skill);
  return (
    <Section title={S.panel.title} icon="Sparkles">
      <QueryState query={query} what="the skills here" />
      {data ? (
        <>
          {data.agents.map((agent) => (agent.cost ? <Meta key={agent.agent}>{`${agent.agent === "claude" ? "Claude" : "Codex"}: ${costLine(agent.cost.skills, agent.cost.chars, plain)}`}</Meta> : null))}
          <PanelLabel>{S.panel.usedHere}</PanelLabel>
          <UsedList used={data.used} />
          {data.notes.map((line) => (
            <Meta key={line}>{line}</Meta>
          ))}
          <AllSkills title={S.panel.all(all.size)} skills={[...all.values()].sort((a, b) => a.name.localeCompare(b.name))} />
          {canOpenScreen() ? <Link label={S.panel.open} onPress={() => openSkills()} /> : null}
        </>
      ) : null}
    </Section>
  );
}

export function AgentSkills({ hostId, workspaceId, provider, agentId }: { hostId: string; workspaceId: string; provider: string | null; agentId: string }) {
  const plain = usePlain();
  const call = useRpc(skillsAgent);
  const query = useQuery({ queryKey: [KEY, hostId, "skills", "agent", workspaceId, provider, agentId], queryFn: () => call({ workspaceId, providerId: provider ?? "", agentId }), enabled: Boolean(provider), retry: 1, refetchOnMount: "always" });
  const data = query.data;
  return (
    <Section title={S.panel.title} icon="Sparkles">
      <QueryState query={query} what="this agent's skills" />
      {data ? (
        <>
          {data.cost ? <Meta>{costLine(data.cost.skills, data.cost.chars, plain)}</Meta> : null}
          <PanelLabel>{data.chat.match === "folder-time" ? S.panel.usedChatGuess : S.panel.usedChat}</PanelLabel>
          {data.chat.match === "unknown" ? <Meta>{data.chat.note || S.panel.unknown}</Meta> : <UsedList used={data.chat.skills} />}
          {data.chat.match === "folder-time" && data.chat.note ? <Meta>{data.chat.note}</Meta> : null}
          <AllSkills title={S.panel.allAgent(data.skills.length)} skills={data.skills} />
          {canOpenScreen() ? <Link label={S.panel.open} onPress={() => openSkills()} /> : null}
        </>
      ) : null}
    </Section>
  );
}

function PanelLabel({ children }: { children: string }) {
  const t = useTokens();
  return <Text style={t.text.label}>{children}</Text>;
}
