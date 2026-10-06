import { useRpc } from "@getpaseo/plugin/client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { Finding } from "../shared/contracts";
import { plainError } from "../shared/errors";
import { PLAIN } from "../shared/plain";
import { clockTime } from "../shared/schedule";
import { groupFindings, groupTitle, quickSummary, type FindingGroup } from "../shared/finding-groups";
import { skillsFix, skillsFixAll } from "../shared/skill-contracts";
import { SKILL_ADD_PAGE, SKILL_TABS, SKILLS_PLAIN as S, plainSkillFinding, plainSkillMessage, skillSubject, plainWordsFromChars, skillLitTab, type SkillTabId } from "../shared/skills-plain";
import { QueryState } from "./data";
import { GroupedFindings } from "./finding-groups";
import { ModeProvider, usePlain } from "./mode";
import { TabBarOf } from "./navigation";
import type { MemoriesScreenProps } from "./register";
import { canOpenScreen, openScreenById } from "./screens";
import { FlowSteps, Glossary } from "./about";
import { AddSkill } from "./skills-add";
import { useSkillsInventory, useSkillsRefresh } from "./skills-data";
import { SkillsHelp } from "./skills-help";
import { SkillsList } from "./skills-list";
import { onSkillsPlace, skillsLanding, skillsParams, syncSkillsParams, takeSkillsPlace, type AddMode, type SkillsPlace } from "./skills-nav";
import { SkillsResult, type SkillsResultValue } from "./skills-report";
import { reportSidebarStatus } from "./sidebar-status";
import { SkillsUsage } from "./skills-usage";
import { Button, Card, Disclosure, Divider, ErrorText, HeroCard, Header, Link, Meta, NumberedStep, Notice, QuietLine, Row, Screen, SectionTitle, StatusLine, SubPageTop, TabLine, TokensProvider, useTokens, useUi, type Status } from "./ui";

/**
 * The Skills page (0.5.0): Overview · Your skills · Usage · Help. Add a skill
 * is a page under Your skills (that tab stays lit), opened from its button,
 * the Overview, the sidebar's "+" and Help. Each tab starts with its own
 * content: one plain sentence at most.
 */

export function SkillsSurface(props: MemoriesScreenProps) {
  const t = useUi(props.theme, props.layout.compact);
  return (
    <TokensProvider value={t}>
      <ModeProvider>
        <SkillsBody key={props.host.id} {...props} />
      </ModeProvider>
    </TokensProvider>
  );
}

type Inventory = NonNullable<ReturnType<typeof useSkillsInventory>["data"]>;

function SkillsBody({ host, params }: MemoriesScreenProps) {
  const t = useTokens();
  const plain = usePlain();
  const hostId = host.id;
  const first = useMemo(() => takeSkillsPlace() ?? skillsLanding(params), []);
  const [place, setPlace] = useState<SkillsPlace>(first);
  const inventory = useSkillsInventory(hostId);
  const refresh = useSkillsRefresh(hostId);
  useEffect(() => onSkillsPlace((next) => (takeSkillsPlace(), setPlace(next))), []);
  // Paseo 0.11+: new params (back/forward) move the page; a move inside it records new params.
  const paramsKey = JSON.stringify(params ?? null);
  const seen = useRef(paramsKey);
  useEffect(() => {
    if (seen.current === paramsKey) return;
    seen.current = paramsKey;
    setPlace(skillsLanding(params));
  }, [paramsKey]);
  const here = skillsParams(place);
  useEffect(() => syncSkillsParams(here, params), [JSON.stringify(here)]);

  const go = (next: SkillsPlace) => setPlace(next);
  const tabs = SKILL_TABS.map((tab) => ({ id: tab.id, icon: tab.icon, label: plain ? tab.label : tab.technical }));
  const inv = inventory.data;
  const status: Status = inventory.error && !inv ? "error" : !inv ? "busy" : inv.findings.some((finding) => finding.severity === "warn") ? "attention" : "ok";
  const label = host.label ?? hostId;
  const caption = inventory.error && !inv ? S.status.cantRead(label) : !inv ? S.status.checking(label) : S.status.on(label);
  // The sidebar row's dot: something worth a look among the skills (from the list already read; no extra call).
  useEffect(() => {
    if (!inv) return;
    const tone = status === "attention" ? "attention" : null;
    reportSidebarStatus("skills", hostId, tone, quickSummary("skills", inv.findings, tone));
  }, [inv, status]);
  return (
    <Screen t={t}>
      <Header title="Skills" icon="Sparkles" status={status} caption={caption} trailing={<Button label={PLAIN.refresh} icon="RefreshCw" variant="ghost" onPress={() => void refresh()} loading={inventory.isFetching} />} />
      <TabBarOf tabs={tabs} active={skillLitTab(place.tab)} onSelect={(tab: SkillTabId) => go({ tab })} name="Skills sections" />
      {place.tab === "overview" ? <SkillsOverview hostId={hostId} onGo={go} /> : null}
      {place.tab === "skills" && !place.skillId && inv?.skills.length ? <TabLine action={<Button label={S.addButton} icon="Plus" onPress={() => go({ tab: "add" })} />}>{S.lines.skills}</TabLine> : null}
      {place.tab === "skills" ? <SkillsList hostId={hostId} skillId={place.skillId ?? null} onOpen={(skillId) => go({ tab: "skills", ...(skillId ? { skillId } : {}) })} onGo={go} /> : null}
      {place.tab === "usage" ? <TabLine>{S.lines.usage}</TabLine> : null}
      {place.tab === "usage" ? <SkillsUsage hostId={hostId} onOpen={(skillId) => go({ tab: "skills", skillId })} /> : null}
      {place.tab === "add" ? (
        <SubPageTop back={S.more.back} onBack={() => go({ tab: "skills" })} title={SKILL_ADD_PAGE.label}>
          {S.lines.add}
        </SubPageTop>
      ) : null}
      {place.tab === "add" ? <AddSkill hostId={hostId} mode={place.add ?? "catalog"} onMode={(add: AddMode) => go({ tab: "add", add })} onOpen={(skillId) => go({ tab: "skills", skillId })} /> : null}
      {place.tab === "help" ? <SkillsHelp onGo={go} /> : null}
    </Screen>
  );
}

// ------------------------------------------------------------------ Overview

/** The agent's biggest account: the one most skills reach. */
function costFor(inv: Inventory, agent: string) {
  return inv.costs.filter((cost) => cost.agent === agent).sort((a, b) => b.skills - a.skills)[0];
}

/** A finding's one action, as the Overview offers it. */
export function useFindingAction(hostId: string, onGo: (place: SkillsPlace) => void) {
  const call = useRpc(skillsFix);
  const callAll = useRpc(skillsFixAll);
  const refresh = useSkillsRefresh(hostId);
  const [busy, setBusy] = useState<string | null>(null);
  const [busyGroup, setBusyGroup] = useState<string | null>(null);
  const [result, setResult] = useState<SkillsResultValue | null>(null);
  const act = async (finding: Finding) => {
    const action = finding.action;
    if (!action) return;
    if (action.kind === "fix") {
      setBusy(finding.id);
      try {
        setResult(await call({ findingId: finding.id }));
      } catch (error) {
        setResult({ ok: false, message: plainError(error) });
      } finally {
        setBusy(null);
        void refresh();
      }
    } else if (action.kind === "review" && (finding.kind === "unused" || finding.kind === "over-budget")) onGo({ tab: "usage" });
    else if (finding.sourceIds[0]) onGo({ tab: "skills", skillId: finding.sourceIds[0] });
    else onGo({ tab: "skills" });
  };
  // Only the items the confirm listed are sent (client/finding-groups.tsx).
  const fixAll = async (group: FindingGroup<Finding>, findingIds: string[]) => {
    setBusyGroup(group.key);
    try {
      setResult(await callAll({ kind: group.key, findingIds }));
    } catch (error) {
      setResult({ ok: false, message: plainError(error) });
    } finally {
      setBusyGroup(null);
      void refresh();
    }
  };
  return { act, busy, result, clear: () => setResult(null), fixAll, busyGroup };
}

function actionLabel(finding: Finding, plain: boolean): string {
  if (!finding.action) return "";
  if (finding.action.kind === "fix") return plain ? S.fix : finding.action.label;
  return plain ? S.show : finding.action.label;
}

export function FindingsCard({ findings, hostId, onGo }: { findings: Finding[]; hostId: string; onGo: (place: SkillsPlace) => void }) {
  const t = useTokens();
  const plain = usePlain();
  const { act, busy, result, clear, fixAll, busyGroup } = useFindingAction(hostId, onGo);
  // One row per kind with its count and Fix all where safe (0.5.1); a kind with one item keeps its own row.
  const row = (finding: Finding, { grouped, first }: { grouped: boolean; first: boolean }) => {
    const words = plain ? plainSkillFinding(finding) : { title: finding.message, detail: finding.detail ?? "" };
    const title = grouped && plain ? skillSubject(finding) : words.title;
    const detail = grouped && plain ? "" : words.detail;
    return (
      <Row
        first={first}
        {...(grouped ? {} : { tone: finding.severity === "warn" ? ("attention" as const) : ("neutral" as const) })}
        title={<Text style={t.text.bodyStrong}>{title}</Text>}
        meta={detail ? <Text style={plain ? t.text.body : t.text.caption}>{detail}</Text> : null}
        trailing={finding.action ? <Button label={actionLabel(finding, plain)} variant="ghost" loading={busy === finding.id} onPress={() => void act(finding)} /> : null}
      />
    );
  };
  return (
    <>
      {result ? <SkillsResult hostId={hostId} result={result} onDismiss={clear} /> : null}
      <GroupedFindings page="skills" findings={findings} renderRow={row} busyGroup={busyGroup} onFixAll={(group, ids) => void fixAll(group, ids)} itemName={(finding) => [skillSubject(finding), finding.detail].filter(Boolean).join(" · ")} />
    </>
  );
}

function SkillsOverview({ hostId, onGo }: { hostId: string; onGo: (place: SkillsPlace) => void }) {
  const t = useTokens();
  const plain = usePlain();
  const inventory = useSkillsInventory(hostId);
  const inv = inventory.data;
  const { act } = useFindingAction(hostId, onGo);
  // "Show me" on the hero opens the list, so a fix is always pressed where it is explained.
  const [listOpen, setListOpen] = useState(false);
  const empty = inv ? inv.skills.length === 0 : false;
  return (
    <>
      {!inv ? (
        inventory.error ? (
          <HeroCard tone="error" icon="CircleAlert" title={S.hero.cantRead} lead={plainError(inventory.error)}>
            <View style={{ flexDirection: "row" }}>
              <Button label={PLAIN.hero.tryAgain} icon="RefreshCw" variant="primary" loading={inventory.isFetching} onPress={() => void inventory.refetch()} />
            </View>
          </HeroCard>
        ) : (
          <HeroCard tone="neutral" icon="Loader" title={S.hero.loading.title} lead={S.hero.loading.lead} />
        )
      ) : empty ? (
        <HeroCard tone="neutral" icon="Sparkles" title={S.hero.none.title} lead={S.hero.none.lead}>
          <View style={{ flexDirection: "row" }}>
            <Button label={S.addButton} icon="Plus" variant="primary" onPress={() => onGo({ tab: "add" })} />
          </View>
        </HeroCard>
      ) : (
        <OverviewHero inv={inv} onGo={onGo} onAct={(finding) => (finding.action?.kind === "fix" ? setListOpen(true) : act(finding))} />
      )}
      {inv ? <QueryState query={inventory} what="your agents' skills" /> : null}
      {inv && inv.findings.length ? (
        <Disclosure key={String(listOpen)} open={listOpen} quiet title={S.allWorth(inv.findings.length)} openTitle={S.hideWorth}>
          <FindingsCard findings={inv.findings} hostId={hostId} onGo={onGo} />
          {!plain ? inv.checked.concat(inv.notes).map((line) => <Meta key={line}>{line}</Meta>) : null}
        </Disclosure>
      ) : null}
      <SkillsAbout open={empty} />
      {canOpenScreen() ? <QuietLine icon="Brain" links={[{ label: PLAIN.overview.openMemories, onPress: () => openScreenById("memories") }]}>{PLAIN.overview.memoriesPointer}</QuietLine> : null}
    </>
  );
}

function OverviewHero({ inv, onGo, onAct }: { inv: Inventory; onGo: (place: SkillsPlace) => void; onAct: (finding: Finding) => void }) {
  const t = useTokens();
  const plain = usePlain();
  const R = S.rows;
  const warn = inv.findings.filter((finding) => finding.severity === "warn");
  const first = [...warn, ...inv.findings][0];
  const tone: Status = warn.length ? "attention" : "ok";
  const title = inv.findings.length ? S.hero.worth(inv.findings.length) : S.hero.tidy;
  const top = groupFindings("skills", [...warn, ...inv.findings.filter((finding) => finding.severity !== "warn")])[0];
  const lead = first ? (plain ? (top && top.findings.length > 1 ? groupTitle("skills", top.key, top.findings.length) : plainSkillFinding(first).title) : first.message) : S.hero.tidyLead;
  const claude = costFor(inv, "claude");
  const codex = costFor(inv, "codex");
  const others = inv.skills.filter((skill) => !skill.readBy.includes("claude") && !skill.readBy.includes("codex")).length;
  const used = inv.skills.filter((skill) => (skill.usage?.total ?? 0) > 0);
  const uses = used.reduce((sum, skill) => sum + (skill.usage?.total ?? 0), 0);
  const usage = inv.usage;
  const words = (chars: number) => (plain ? plainWordsFromChars(chars) : `${chars.toLocaleString("en-US")} characters`);
  const costHint = (cost: typeof claude) => (cost ? (cost.overBudget ? S.overLimit : R.listCost(words(cost.chars))) : null);
  const usedValue = usage.state === "off" ? R.countingOff : usage.state === "ready" ? R.usedValue(used.length, uses) : R.counting;
  const event = usage.asOf ? S.lastCounted(clockTime(usage.asOf)) : S.checked(clockTime(inv.checkedAt));
  return (
    <HeroCard tone={tone} icon={warn.length ? "ListChecks" : "CircleCheck"} title={title} lead={lead}>
      <View style={{ gap: t.space.xs }}>
        {claude ? <StatusLine label={R.claude} value={R.skills(claude.skills)} status={claude.overBudget ? "attention" : "neutral"} hint={costHint(claude)} /> : null}
        {codex ? <StatusLine label={R.codex} value={R.skills(codex.skills)} status="neutral" hint={costHint(codex)} /> : null}
        {!claude && !codex && others ? <StatusLine label={R.others} value={R.skills(others)} status="neutral" /> : null}
        <StatusLine label={R.used} value={usedValue} status="neutral" hint={usage.state === "ready" ? R.usedHint(inv.windowDays) : null} action={{ label: SKILL_TABS.find((tab) => tab.id === "usage")!.label, onPress: () => onGo({ tab: "usage" }) }} />
      </View>
      <Meta>{usage.state !== "ready" && usage.note ? `${event} ${usage.note}` : event}</Meta>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
        {first?.action ? <Button label={S.show} icon="ArrowRight" variant="primary" onPress={() => onAct(first)} /> : null}
        <Button label={S.addButton} icon="Plus" variant={first?.action ? "secondary" : "primary"} onPress={() => onGo({ tab: "add" })} />
      </View>
    </HeroCard>
  );
}

/** "New to Skills? How it works": one card, the parts split by rules. */
export function SkillsAbout({ open }: { open: boolean }) {
  const t = useTokens();
  const A = S.about;
  return (
    <Disclosure key={String(open)} title={S.newTo} open={open}>
      <Card>
        <View style={{ gap: t.space.sm }}>
          <SectionTitle icon="Sparkles">{A.whatIsTitle}</SectionTitle>
          {A.whatIs.map((line) => (
            <Text key={line} style={t.text.body}>
              {line}
            </Text>
          ))}
        </View>
        <Divider />
        <View style={{ gap: t.space.row }}>
          <SectionTitle icon="Workflow">{A.howTitle}</SectionTitle>
          <FlowSteps steps={A.flow} note={A.flowNote} />
        </View>
        <Divider />
        <View style={{ gap: t.space.row }}>
          <SectionTitle icon="ListOrdered">{A.useTitle}</SectionTitle>
          {A.steps.map((step, index) => (
            <NumberedStep key={step} n={index + 1}>
              {step}
            </NumberedStep>
          ))}
        </View>
        <Divider />
        <View style={{ gap: t.space.row }}>
          <SectionTitle icon="BookOpen">{A.wordsTitle}</SectionTitle>
          <Glossary words={A.words} />
        </View>
      </Card>
    </Disclosure>
  );
}

export { ErrorText, Link };
