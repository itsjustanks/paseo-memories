import type { PluginAgentPanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { Text, View } from "react-native";
import { AGENT_LABELS } from "../shared/agents";
import { agentPlan, workspacePlan, type LoadPlan } from "../shared/contracts";
import { formatBytes, formatTokens } from "../shared/format";
import { folderName, whenLabel } from "../shared/labels";
import { KEY, QueryState } from "./data";
import { canOpenMemories, openMemories } from "./navigate";
import { Button, Card, EmptyState, Facts, Header, PathText, Row, Screen, Section, Tag, useTokens, useUi } from "./ui";

/**
 * What an agent started here loads, in the order it loads it, with sizes and
 * ≈ tokens. The workspace panel shows every provider; the agent panel shows
 * that agent's provider and account.
 */

function PlanCard({ plan, showMissing }: { plan: LoadPlan; showMissing?: boolean }) {
  const t = useTokens();
  const shown = plan.items.filter((item) => showMissing || item.when !== "missing");
  const launch = shown.filter((item) => item.when === "launch").length;
  return (
    <Section title={`${AGENT_LABELS[plan.agent] ?? plan.agent} · ${formatTokens(plan.total.tokens)} at launch`} trailing={<Tag label={`${launch} at launch`} />}>
      {plan.configDir ? <Text style={t.text.caption}>{`Config folder: ${plan.configDir}`}</Text> : null}
      <Card padded={false}>
        {shown.length === 0 ? (
          <View style={{ padding: t.space.md }}>
            <Text style={t.text.caption}>Nothing loads for this agent here.</Text>
          </View>
        ) : (
          shown.map((item, index) => (
            <Row
              key={`${item.order}:${item.path ?? item.label}`}
              first={index === 0}
              title={<PathText path={item.label} style={t.text.bodyStrong} />}
              subtitle={item.note || undefined}
              meta={
                <Facts
                  items={[
                    item.when === "missing" ? null : { value: formatBytes(item.bytes) },
                    item.when === "launch" ? { value: formatTokens(item.tokens) } : null,
                    item.truncated ? { value: `cut to ${formatBytes(item.loadedBytes)}`, tone: "attention" } : null,
                  ]}
                />
              }
              trailing={item.when === "launch" ? null : <Tag label={whenLabel(item.when)} tone="neutral" />}
              {...(item.sourceId && canOpenMemories() ? { onPress: () => openMemories({ tab: item.scope === "user" || item.kind === "paseo-prompt" ? "user" : "projects", sourceId: item.sourceId! }) } : {})}
            />
          ))
        )}
      </Card>
      {[...plan.notes, ...plan.unsure].map((line) => (
        <Text key={line} style={t.text.caption}>
          {line}
        </Text>
      ))}
    </Section>
  );
}

export function MemoriesWorkspacePanel({ theme, layout, host, workspaceId }: PluginWorkspacePanelProps) {
  const t = useUi(theme, layout.compact);
  const call = useRpc(workspacePlan);
  const query = useQuery({ queryKey: [KEY, host.id, "workspace-plan", workspaceId], queryFn: () => call({ workspaceId }), retry: 1, refetchOnMount: "always" });
  const plans = query.data?.plans.filter((plan) => plan.items.some((item) => item.when !== "missing")) ?? [];
  return (
    <Screen t={t}>
      <Header title="Memories" caption={query.data ? `What an agent started in ${folderName(query.data.directory)} loads` : "What an agent started here loads"} />
      <QueryState query={query} what="this workspace's memory" />
      {query.data && plans.length === 0 ? <EmptyState title="Nothing loads here" body={`Checked every agent's files for ${query.data.directory}: none apply.`} /> : null}
      {plans.map((plan) => (
        <PlanCard key={plan.agent} plan={plan} />
      ))}
      {canOpenMemories() ? (
        <View style={{ flexDirection: "row" }}>
          <Button label="Open Memories" variant="ghost" onPress={() => openMemories({ tab: "projects" })} />
        </View>
      ) : null}
    </Screen>
  );
}

export function MemoriesAgentPanel({ theme, layout, host, workspaceId, agentId }: PluginAgentPanelProps) {
  const t = useUi(theme, layout.compact);
  const provider = useAgent(agentId, (agent) => agent.provider);
  const call = useRpc(agentPlan);
  const query = useQuery({
    queryKey: [KEY, host.id, "agent-plan", workspaceId, provider],
    queryFn: () => call({ workspaceId, providerId: provider ?? "", agentId }),
    enabled: Boolean(provider),
    retry: 1,
    refetchOnMount: "always",
  });
  return (
    <Screen t={t}>
      <Header title="Memories" caption={provider ? `What this ${AGENT_LABELS[provider] ?? provider} agent loads` : "What this agent loads"} />
      <QueryState query={query} what="this agent's memory" />
      {query.data ? <PlanCard plan={query.data.plan} showMissing /> : null}
      {query.data ? <Text style={t.text.caption}>{`Checked for ${query.data.directory}. A running agent keeps what it loaded at launch; this is what a new one would load.`}</Text> : null}
    </Screen>
  );
}
