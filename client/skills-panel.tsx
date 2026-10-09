import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { Text, View } from "react-native";
import { skillsAgent, skillsWorkspace } from "../shared/skill-contracts";
import { SKILLS_PLAIN as S, plainWordsFromChars } from "../shared/skills-plain";
import { KEY, QueryState } from "./data";
import { usePlain } from "./mode";
import { canOpenScreen } from "./screens";
import { openSkills } from "./skills-nav";
import { Link, Meta, Section, Tag, useTokens } from "./ui";

/**
 * The Skills part of the Memories panels: what the skill list costs at the
 * start of every chat and which skills were used (in this chat when Paseo
 * says which chat it is, else in this folder). Which skills an agent here
 * has, by where they apply, is in the panel's scope sections (0.6.0).
 */

type Used = Array<{ name: string; count: number; skillId?: string }>;

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

function costLine(count: number, chars: number, plain: boolean): string {
  return plain ? S.panel.count(count, plainWordsFromChars(chars)) : `${count} skills · ${chars.toLocaleString("en-US")} characters listed at the start`;
}

/** The skills agents in this workspace can use (shared with the panel's scope sections; one request). */
export function useWorkspaceSkills(hostId: string, workspaceId: string) {
  const call = useRpc(skillsWorkspace);
  return useQuery({ queryKey: [KEY, hostId, "skills", "workspace", workspaceId], queryFn: () => call({ workspaceId }), retry: 1, refetchOnMount: "always" });
}

export function useAgentSkills(hostId: string, workspaceId: string, provider: string | null, agentId: string) {
  const call = useRpc(skillsAgent);
  return useQuery({ queryKey: [KEY, hostId, "skills", "agent", workspaceId, provider, agentId], queryFn: () => call({ workspaceId, providerId: provider ?? "", agentId }), enabled: Boolean(provider), retry: 1, refetchOnMount: "always" });
}

/**
 * Skill use in this workspace: what the skill list costs at the start of
 * every chat, and which skills were used here lately. The skills themselves
 * are listed by where they apply, in the panel's scope sections (0.6.0).
 */
export function WorkspaceSkillUse({ hostId, workspaceId }: { hostId: string; workspaceId: string }) {
  const plain = usePlain();
  const query = useWorkspaceSkills(hostId, workspaceId);
  const data = query.data;
  return (
    <Section title={S.panel.useTitle} icon="Sparkles">
      <QueryState query={query} what="the skills here" />
      {data ? (
        <>
          {data.agents.map((agent) => (agent.cost ? <Meta key={agent.agent}>{`${agent.agent === "claude" ? "Claude" : "Codex"}: ${costLine(agent.cost.skills, agent.cost.chars, plain)}`}</Meta> : null))}
          <PanelLabel>{S.panel.usedHere}</PanelLabel>
          <UsedList used={data.used} />
          {data.notes.map((line) => (
            <Meta key={line}>{line}</Meta>
          ))}
          {canOpenScreen() ? <Link label={S.panel.open} onPress={() => openSkills()} /> : null}
        </>
      ) : null}
    </Section>
  );
}

export function AgentSkillUse({ hostId, workspaceId, provider, agentId }: { hostId: string; workspaceId: string; provider: string | null; agentId: string }) {
  const plain = usePlain();
  const query = useAgentSkills(hostId, workspaceId, provider, agentId);
  const data = query.data;
  return (
    <Section title={S.panel.useTitle} icon="Sparkles">
      <QueryState query={query} what="this agent's skills" />
      {data ? (
        <>
          {data.cost ? <Meta>{costLine(data.cost.skills, data.cost.chars, plain)}</Meta> : null}
          <PanelLabel>{data.chat.match === "folder-time" ? S.panel.usedChatGuess : S.panel.usedChat}</PanelLabel>
          {data.chat.match === "unknown" ? <Meta>{data.chat.note || S.panel.unknown}</Meta> : <UsedList used={data.chat.skills} />}
          {data.chat.match === "folder-time" && data.chat.note ? <Meta>{data.chat.note}</Meta> : null}
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
