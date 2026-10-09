import type { PluginAgentPanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { Text, View } from "react-native";
import { AGENT_LABELS } from "../shared/agents";
import { agentPlan, workspacePlan, type LoadPlan } from "../shared/contracts";
import { formatBytes, formatTokens } from "../shared/format";
import { folderName, whenLabel } from "../shared/labels";
import { PLAIN, isCodexInternal, plainAgent, plainPlanItemName, plainWhen, plainWords } from "../shared/plain";
import { KEY, QueryState } from "./data";
import { AgentSkillUse, WorkspaceSkillUse, useAgentSkills, useWorkspaceSkills } from "./skills-panel";
import { PANEL_WORDS, readers, scopedItems, scopedSkills, type PanelSkillView, type ScopedItem, type ScopedSkill } from "./scope-view";
import { SCOPE_WORDS, shadowLine, type ScopeKind } from "../shared/scope";
import { canOpenScreen } from "./screens";
import { openSkills } from "./skills-nav";
import { ModeProvider, usePlain } from "./mode";
import { canOpenMemories, itemDestination, openMemories, panelDestination } from "./navigate";
import { Accordion, AccordionItem, Button, Card, Disclosure, EmptyState, Facts, Header, Meta, PathText, Row, Screen, Section, Tag, useTokens, useUi } from "./ui";

/**
 * What an agent started here loads, in the order it loads it, with sizes and
 * ≈ tokens. The workspace panel shows every provider; the agent panel shows
 * that agent's provider and account.
 */

function openItem(item: LoadPlan["items"][number]) {
  const destination = itemDestination(item);
  return destination && canOpenMemories() ? { onPress: () => openMemories(destination) } : {};
}


/** Plain: what an agent reads, in order, by name, with about how many words; Codex's own working files are left out (they show with technical details). */
function PlainPlanCard({ plan, showMissing }: { plan: LoadPlan; showMissing?: boolean }) {
  const t = useTokens();
  const P = PLAIN.panel;
  const shown = plan.items.filter((item) => (showMissing || item.when !== "missing") && !isCodexInternal(item) && item.kind !== "copilot-memory");
  return (
    <Section title={`${plainAgent(plan.agent)} · ${P.readAtStart(plainWords(plan.total.tokens))}`} icon="Bot">
      <Card padded={false}>
        {shown.length === 0 ? (
          <View style={{ padding: t.space.row }}>
            <Text style={t.text.body}>{P.nothing}</Text>
          </View>
        ) : (
          shown.map((item, index) => (
            <Row
              key={`${item.order}:${item.path ?? item.label}`}
              first={index === 0}
              title={<Text style={t.text.bodyStrong}>{plainPlanItemName(item, plan.agent, plan.directory)}</Text>}
              meta={<Facts items={[item.when === "launch" ? { value: plainWords(item.tokens) } : null, item.truncated ? { value: "Only the start is read", tone: "attention" } : null]} />}
              trailing={plainWhen(item.when) ? <Tag label={plainWhen(item.when)} tone="neutral" /> : null}
              {...openItem(item)}
            />
          ))
        )}
      </Card>
    </Section>
  );
}

function PlanCard({ plan, showMissing }: { plan: LoadPlan; showMissing?: boolean }) {
  const t = useTokens();
  const plain = usePlain();
  if (plain) return <PlainPlanCard plan={plan} {...(showMissing ? { showMissing } : {})} />;
  const shown = plan.items.filter((item) => showMissing || item.when !== "missing");
  const launch = shown.filter((item) => item.when === "launch").length;
  return (
    <Section title={`${AGENT_LABELS[plan.agent] ?? plan.agent} · ${formatTokens(plan.total.tokens)} at launch`} icon="Bot" trailing={<Tag label={`${launch} at launch`} />}>
      {plan.configDir ? <Text style={t.text.caption}>{`Config folder: ${plan.configDir}`}</Text> : null}
      <Card padded={false}>
        {shown.length === 0 ? (
          <View style={{ padding: t.space.row }}>
            <Text style={t.text.body}>Nothing loads for this agent here.</Text>
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
              {...openItem(item)}
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

/** One item's row: its name, who reads it, its file as a person would point at it; tapping opens it in Memories. */
function ItemRow({ entry, first, plain }: { entry: ScopedItem; first: boolean; plain: boolean }) {
  const t = useTokens();
  return (
    <Row
      first={first}
      title={<Text style={t.text.bodyStrong}>{entry.name}</Text>}
      meta={<Facts items={[entry.agents.length ? { value: readers(entry.agents) } : null, entry.skippedBy.length ? { value: PANEL_WORDS.skips(readers(entry.skippedBy)) } : null, { value: entry.where }, entry.when === "launch" ? { value: plain ? plainWords(entry.tokens) : formatTokens(entry.tokens) } : null, entry.truncated ? { value: plain ? "Only the start is read" : "cut", tone: "attention" } : null]} />}
      trailing={entry.inherited ? <Tag label={PANEL_WORDS.fromParent} tone="neutral" /> : entry.when !== "launch" && (plain ? plainWhen(entry.when) : whenLabel(entry.when)) ? <Tag label={plain ? plainWhen(entry.when) : whenLabel(entry.when)} tone="neutral" /> : null}
      {...openItem(entry.item)}
    />
  );
}

/** One skill's row: name, who can use it, its folder; a name at both levels says which copy each agent uses. */
function PanelSkillRow({ entry, first }: { entry: ScopedSkill; first: boolean }) {
  const t = useTokens();
  const shadow = shadowLine(entry.shadows, plainAgent, entry.scope);
  return (
    <Row
      first={first}
      title={entry.skill.name}
      meta={
        <View style={{ gap: t.space.hair }}>
          <Facts items={[{ value: readers(entry.agents) }, entry.skill.where ? { value: entry.skill.where } : null]} />
          {shadow ? <Text style={[t.text.caption, { color: t.color.warning }]}>{shadow}</Text> : null}
        </View>
      }
      trailing={entry.skill.state === "off" ? <Tag label="Off" /> : null}
      {...(canOpenScreen() ? { onPress: () => openSkills({ tab: "skills", skillId: entry.skill.skillId }) } : {})}
    />
  );
}

/** Most of your Everywhere skills fold away; a name at both levels always shows. */
const OPEN_SKILLS = 6;

function ScopeSection({ kind, title, items, skills, skillsLoading, plain }: { kind: ScopeKind; title: string; items: ScopedItem[]; skills: ScopedSkill[] | null; skillsLoading: boolean; plain: boolean }) {
  const t = useTokens();
  const shownSkills = skills ?? [];
  const open = shownSkills.filter((entry, index) => entry.shadows.length > 0 || index < OPEN_SKILLS || kind === "project");
  const folded = shownSkills.filter((entry) => !open.includes(entry));
  const empty = !items.length && !shownSkills.length && !skillsLoading;
  return (
    <Section title={title} icon={kind === "project" ? "FolderGit2" : "Globe"}>
      <Meta>{kind === "project" ? SCOPE_WORDS.projectLead : items.some((entry) => entry.inherited) ? PANEL_WORDS.inheritedLead : SCOPE_WORDS.everywhereLead}</Meta>
      {empty ? <Text style={t.text.body}>{kind === "project" ? PANEL_WORDS.nothingProject : PANEL_WORDS.nothingEverywhere}</Text> : null}
      {items.length ? (
        <>
          <Text style={t.text.label}>{PANEL_WORDS.notes}</Text>
          <Card padded={false}>
            {items.map((entry, index) => (
              <ItemRow key={entry.key} entry={entry} first={index === 0} plain={plain} />
            ))}
          </Card>
        </>
      ) : null}
      {open.length ? (
        <>
          <Text style={t.text.label}>{`${PANEL_WORDS.skills} (${shownSkills.length})`}</Text>
          <Card padded={false}>
            {open.map((entry, index) => (
              <PanelSkillRow key={entry.skill.skillId} entry={entry} first={index === 0} />
            ))}
          </Card>
        </>
      ) : null}
      {folded.length ? (
        <Disclosure quiet title={`${folded.length} more`}>
          <Card padded={false}>
            {folded.map((entry, index) => (
              <PanelSkillRow key={entry.skill.skillId} entry={entry} first={index === 0} />
            ))}
          </Card>
        </Disclosure>
      ) : null}
    </Section>
  );
}

/**
 * This project's own first, then what every project gets (0.6.0): the
 * clearest view of exactly what an agent here loads, each item with who
 * reads it and its file in friendly form. The per-agent load order, with
 * sizes, folds below.
 */
function ScopedLoad({ plans, directory, projectRoot, home, skills, skillsLoading }: { plans: LoadPlan[]; directory: string; projectRoot?: string | undefined; home?: string | undefined; skills: Array<{ agent: string; skills: PanelSkillView[] }> | null; skillsLoading: boolean }) {
  const plain = usePlain();
  const items = scopedItems(plans, { home, directory, projectRoot, plain });
  const grouped = skills ? scopedSkills(skills) : null;
  return (
    <>
      <ScopeSection kind="project" title={SCOPE_WORDS.project(folderName(projectRoot ?? directory))} items={items.project} skills={grouped?.project ?? null} skillsLoading={skillsLoading} plain={plain} />
      <ScopeSection kind="everywhere" title={SCOPE_WORDS.everywhere} items={items.everywhere} skills={grouped?.everywhere ?? null} skillsLoading={skillsLoading} plain={plain} />
      {plans.length ? (
        <Accordion>
          <AccordionItem icon="ListOrdered" title={PANEL_WORDS.loadOrder} summary={PANEL_WORDS.loadOrderSummary}>
            {plans.map((plan) => (
              <PlanCard key={plan.agent} plan={plan} />
            ))}
          </AccordionItem>
        </Accordion>
      ) : null}
    </>
  );
}

export function MemoriesWorkspacePanel(props: PluginWorkspacePanelProps) {
  return (
    <ModeProvider>
      <WorkspacePanel {...props} />
    </ModeProvider>
  );
}

function WorkspacePanel({ theme, layout, host, workspaceId }: PluginWorkspacePanelProps) {
  const t = useUi(theme, layout.compact);
  const plain = usePlain();
  const call = useRpc(workspacePlan);
  const query = useQuery({ queryKey: [KEY, host.id, "workspace-plan", workspaceId], queryFn: () => call({ workspaceId }), retry: 1, refetchOnMount: "always" });
  const skills = useWorkspaceSkills(host.id, workspaceId);
  const plans = query.data?.plans.filter((plan) => plan.items.some((item) => item.when !== "missing")) ?? [];
  return (
    <Screen t={t}>
      <Header
        panel
        title="Memories & Skills"
        caption={plain ? (query.data ? PLAIN.panel.caption(folderName(query.data.directory)) : PLAIN.panel.captionAny) : query.data ? `What an agent started in ${folderName(query.data.directory)} loads` : "What an agent started here loads"}
      />
      <QueryState query={query} what={plain ? "what agents read here" : "this workspace's memory"} />
      {query.data ? <ScopedLoad plans={plans} directory={query.data.directory} projectRoot={query.data.projectRoot} home={query.data.home} skills={skills.data?.agents ?? null} skillsLoading={skills.isLoading} /> : null}
      <WorkspaceSkillUse hostId={host.id} workspaceId={workspaceId} />
      {canOpenMemories() ? (
        <View style={{ flexDirection: "row" }}>
          <Button label={PLAIN.panel.open} icon="Brain" variant="ghost" onPress={() => openMemories(panelDestination(plans))} />
        </View>
      ) : null}
    </Screen>
  );
}

export function MemoriesAgentPanel(props: PluginAgentPanelProps) {
  return (
    <ModeProvider>
      <AgentPanel {...props} />
    </ModeProvider>
  );
}

function AgentPanel({ theme, layout, host, workspaceId, agentId }: PluginAgentPanelProps) {
  const t = useUi(theme, layout.compact);
  const plain = usePlain();
  const provider = useAgent(agentId, (agent) => agent.provider);
  const call = useRpc(agentPlan);
  const query = useQuery({
    queryKey: [KEY, host.id, "agent-plan", workspaceId, provider],
    queryFn: () => call({ workspaceId, providerId: provider ?? "", agentId }),
    enabled: Boolean(provider),
    retry: 1,
    refetchOnMount: "always",
  });
  const skills = useAgentSkills(host.id, workspaceId, provider ?? null, agentId);
  return (
    <Screen t={t}>
      <Header
        panel
        title="Memories & Skills"
        caption={plain ? (provider ? PLAIN.panel.agentCaption(plainAgent(provider)) : PLAIN.panel.captionAny) : provider ? `What this ${AGENT_LABELS[provider] ?? provider} agent loads` : "What this agent loads"}
      />
      <QueryState query={query} what={plain ? "what this agent reads" : "this agent's memory"} />
      {query.data ? <ScopedLoad plans={[query.data.plan]} directory={query.data.directory} projectRoot={query.data.projectRoot} home={query.data.home} skills={skills.data ? [{ agent: skills.data.agent, skills: skills.data.skills }] : null} skillsLoading={skills.isLoading} /> : null}
      {query.data ? <Text style={t.text.caption}>{plain ? PLAIN.panel.runningNote : `Checked for ${query.data.directory}. A running agent keeps what it loaded at launch; this is what a new one would load.`}</Text> : null}
      <AgentSkillUse hostId={host.id} workspaceId={workspaceId} provider={provider ?? null} agentId={agentId} />
    </Screen>
  );
}
