import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, View } from "react-native";
import { AGENT_LABELS } from "../shared/agents";
import { search, type Finding, type FindingAction } from "../shared/contracts";
import { plainError } from "../shared/errors";
import { formatBytes, formatTokens, plural } from "../shared/format";
import { folderName, scopeLabel } from "../shared/labels";
import { PLAIN, isCodexInternal, plainAgent, plainFinding, plainFindings, plainNextStep, plainWords, scanProgressNote } from "../shared/plain";
import { OverviewGuide } from "./about";
import { KEY, QueryState, useFindings, useInventory } from "./data";
import { usePlain, useSourceNames } from "./mode";
import type { SectionId } from "./navigation";
import { clockTime } from "../shared/schedule";
import { MarkdownLine } from "./markdown";
import { canOpenScreen, openScreenById } from "./screens";
import { Button, Card, Disclosure, ErrorText, Facts, Field, HeroCard, Link, Loading, Meta, PathText, QuietLine, Row, StatusLine, Tag, useTokens, type Status } from "./ui";

/**
 * "What do my agents remember, and what needs tidying?" The hero says the
 * state in words with the totals per agent and the one next step; then the
 * list of things worth a look, a search box, and the guide (what Memories is,
 * how it works, how to use it, the words).
 */

const TONE: Record<string, Status> = { error: "error", warn: "attention", info: "neutral" };

type Props = { hostId: string; onOpen: (sourceId: string, key?: string) => void; onAddNote: () => void; onGo: (tab: SectionId) => void };
type Hero = { tone: Status; icon: string; title: string; lead: string };

/** The state in words, from the first thing worth a look (findings are sorted most serious first). */
function heroFor(shown: Finding[], lead: string | undefined): Hero {
  const first = shown[0];
  if (!first) return { tone: "ok", icon: "CircleCheck", title: PLAIN.hero.tidy, lead: PLAIN.tidy.allGood.detail };
  const tone = TONE[first.severity] ?? "neutral";
  return { tone, icon: tone === "error" ? "ShieldAlert" : "ListChecks", title: tone === "error" ? PLAIN.hero.attention : PLAIN.hero.worth(shown.length), lead: lead ?? "" };
}

/** Before the checks answer: still checking, or they failed (the totals still show). */
function waitingHero(failed: boolean): Hero {
  return failed ? { tone: "attention", icon: "TriangleAlert", ...PLAIN.hero.checksFailed } : { tone: "neutral", icon: "Loader", ...PLAIN.hero.checking };
}

function FindingRow({ finding, first, onOpen }: { finding: Finding; first: boolean; onOpen: (action: FindingAction) => void }) {
  const t = useTokens();
  const plain = usePlain();
  const names = useSourceNames(useHostId());
  if (plain) {
    const words = plainFinding(finding, names.byId);
    return (
      <Row
        first={first}
        tone={TONE[finding.severity] ?? "neutral"}
        title={<Text style={t.text.bodyStrong}>{words.title}</Text>}
        meta={words.detail ? <Text style={t.text.body}>{words.detail}</Text> : null}
        trailing={finding.action?.sourceId ? <Button label={PLAIN.tidy.show} variant="ghost" onPress={() => onOpen(finding.action!)} /> : null}
      />
    );
  }
  return (
    <Row
      first={first}
      tone={TONE[finding.severity] ?? "neutral"}
      title={<Text style={t.text.body}>{finding.message}</Text>}
      meta={finding.heuristic ? <Text style={t.text.caption}>A guess: check before acting on it.</Text> : null}
      trailing={finding.action?.sourceId ? <Button label={finding.action.kind === "delete" ? "Review" : "Open"} variant="ghost" onPress={() => onOpen(finding.action!)} /> : null}
    />
  );
}

/** The bottom strip of a list card: padding, a rule above, and what it holds. */
function CardFooter({ children }: { children: React.ReactNode }) {
  const t = useTokens();
  return <View style={{ gap: t.space.xs, paddingVertical: t.space.row, paddingHorizontal: t.compact ? t.space.row : t.space.md, borderTopWidth: 1, borderTopColor: t.color.borderSubtle }}>{children}</View>;
}

/** Up to five things worth a look, the rest behind "N more", and the lines that say what was checked. */
function TidyCard({ title, findings, none, notes, onOpen }: { title: string; findings: Finding[] | null; none: string; notes: string[]; onOpen: (action: FindingAction) => void }) {
  const t = useTokens();
  const [all, setAll] = useState(false);
  const count = findings?.length ?? 0;
  const tone: Status = findings?.some((finding) => finding.severity === "error") ? "error" : count ? "attention" : "ok";
  return (
    <Card padded={false} title={title} icon="ListChecks" {...(findings ? { iconTone: tone } : {})} trailing={findings ? <Tag label={String(count)} tone={tone} /> : null}>
      {findings && count ? findings.slice(0, all ? 100 : 5).map((finding, index) => <FindingRow key={finding.id} finding={finding} first={index === 0} onOpen={onOpen} />) : null}
      {findings && count > 5 ? (
        <CardFooter>
          <Link label={all ? PLAIN.tidy.fewer : PLAIN.tidy.more(count - 5)} onPress={() => setAll(!all)} />
        </CardFooter>
      ) : null}
      {findings && !count ? (
        <View style={{ padding: t.compact ? t.space.row : t.space.md }}>
          <Text style={t.text.body}>{none}</Text>
        </View>
      ) : null}
      {notes.length ? (
        <CardFooter>
          {notes.map((line) => (
            <Text key={line} style={t.text.caption}>
              {line}
            </Text>
          ))}
        </CardFooter>
      ) : null}
    </Card>
  );
}

function SearchBox({ hostId, onOpen }: { hostId: string; onOpen: (sourceId: string, key?: string) => void }) {
  const t = useTokens();
  const plain = usePlain();
  const names = useSourceNames(hostId);
  const inventory = useInventory(hostId);
  const call = useRpc(search);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const results = useQuery({ queryKey: [KEY, hostId, "search", query], queryFn: () => call({ query, limit: 30 }), enabled: query.length > 0, retry: 1 });
  // Plain mode leaves out hits in Codex's own working files.
  const internal = new Set((inventory.data?.sources ?? []).filter(isCodexInternal).map((source) => source.id));
  const hits = (results.data?.results ?? []).filter((hit) => !plain || !internal.has(hit.sourceId));
  return (
    <Card title={plain ? PLAIN.search.title : "Search"} icon="Search">
      <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "flex-end" }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Field value={draft} onChangeText={setDraft} placeholder={plain ? PLAIN.search.placeholder : "Search every memory and instruction file, e.g. webhooks"} />
        </View>
        <Button label={PLAIN.search.button} icon="Search" onPress={() => setQuery(draft.trim())} disabled={!draft.trim()} />
      </View>
      {results.isFetching ? <Loading label={PLAIN.search.busy} /> : null}
      {results.error ? <ErrorText>{plainError(results.error)}</ErrorText> : null}
      {results.data ? (
        <View style={{ gap: t.space.sm }}>
          {plain ? (hits.length ? null : <Text style={t.text.body}>{`No note mentions "${results.data.query}".`}</Text>) : <Text style={t.text.caption}>{results.data.checked}</Text>}
          {hits.length ? (
            <Card padded={false} level={2}>
              {hits.map((hit, index) => (
                <Row
                  key={`${hit.sourceId}#${hit.key}`}
                  first={index === 0}
                  title={hit.title}
                  subtitle={plain ? names.byId(hit.sourceId) : `${AGENT_LABELS[hit.agent] ?? hit.agent} · ${scopeLabel(hit.scope)}${hit.projectPath ? ` · ${folderName(hit.projectPath)}` : ""}`}
                  meta={<MarkdownLine text={hit.snippet} lines={2} />}
                  onPress={() => onOpen(hit.sourceId, hit.key)}
                />
              ))}
            </Card>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

/** The host id for rows deep in the tree; set by the Overview. */
const HostContext = React.createContext("");
function useHostId(): string {
  return React.useContext(HostContext);
}

export function Overview(props: Props) {
  const plain = usePlain();
  const inventory = useInventory(props.hostId);
  // The agents with notes here, for "What is Memories?".
  const agents = [...new Set((inventory.data?.accounts ?? []).filter((account) => account.exists && inventory.data!.sources.some((source) => source.accountId === account.id && source.exists)).map((account) => plainAgent(account.agent)))];
  // Open while there is nothing here yet; folded once things work.
  const firstRun = inventory.data ? inventory.data.counts.sources === 0 : false;
  return (
    <HostContext.Provider value={props.hostId}>
      {plain ? <PlainOverview {...props} /> : <TechnicalOverview {...props} />}
      <OverviewGuide key={String(firstRun)} agents={agents} onGuide={() => props.onGo("guide")} open={firstRun} />
      {canOpenScreen() ? <QuietLine icon="Sparkles" links={[{ label: PLAIN.overview.openSkills, onPress: () => openScreenById("skills") }]}>{PLAIN.overview.skillsPointer}</QuietLine> : null}
    </HostContext.Provider>
  );
}

/** Before the first answer: the hero says it is reading, or why it couldn't, with a way to try again. */
function FirstLoad({ query }: { query: UseQueryResult<unknown> }) {
  const t = useTokens();
  if (!query.error) return <HeroCard tone="neutral" icon="Loader" title={PLAIN.hero.loading.title} lead={PLAIN.hero.loading.lead} />;
  return (
    <HeroCard tone="error" icon="CircleAlert" title={PLAIN.hero.cantRead} lead={plainError(query.error)}>
      <View style={{ flexDirection: "row", gap: t.space.sm }}>
        <Button label={PLAIN.hero.tryAgain} icon="RefreshCw" variant="primary" loading={query.isFetching} onPress={() => void query.refetch()} />
      </View>
    </HeroCard>
  );
}

/** At most two buttons under the hero: the next step when there is one (primary), and Add a note. */
function HeroActions({ show, onShow, onAddNote }: { show: boolean; onShow: () => void; onAddNote: () => void }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
      {show ? <Button label={PLAIN.tidy.show} icon="ArrowRight" variant="primary" onPress={onShow} /> : null}
      <Button label={PLAIN.overview.primary} icon="Plus" variant={show ? "secondary" : "primary"} onPress={onAddNote} />
    </View>
  );
}

/** The one muted line under the rows: when it was last checked or changed, and a scan still running. */
function lastEvent(checkedAt: string | undefined, scanNote: string | null): string {
  const when = checkedAt ? `${PLAIN.overview.checkedAt(clockTime(checkedAt))}` : "";
  return [when, scanNote ?? ""].filter(Boolean).join(" ");
}

function PlainOverview({ hostId, onOpen, onAddNote, onGo }: Props) {
  const t = useTokens();
  const inventory = useInventory(hostId);
  const findings = useFindings(hostId);
  const names = useSourceNames(hostId);
  const inv = inventory.data;
  const tidy = findings.data;
  const O = PLAIN.overview;
  if (!inv) return <FirstLoad query={inventory} />;
  if (inv.counts.sources === 0) {
    return (
      <HeroCard tone="neutral" icon="Sparkles" title={PLAIN.nothingYet.title} lead={PLAIN.nothingYet.body}>
        <HeroActions show={false} onShow={() => undefined} onAddNote={onAddNote} />
      </HeroCard>
    );
  }
  const openAction = (action: FindingAction) => action.sourceId && onOpen(action.sourceId, action.key === "MEMORY.md" ? undefined : action.key);
  // Counted from the sources, leaving out Codex's own working files.
  const listed = inv.sources.filter((source) => !isCodexInternal(source));
  const count = (sources: typeof listed) => sources.reduce((sum, source) => sum + (source.isDirectory ? source.files ?? 0 : source.exists ? 1 : 0), 0);
  const accountRows = inv.accounts
    .map((account) => {
      const own = listed.filter((source) => source.accountId === account.id);
      return { account, files: count(own), tokens: own.reduce((sum, source) => sum + source.loaded.tokens, 0) };
    })
    .filter((row) => row.account.exists && row.files > 0)
    .sort((a, b) => b.files - a.files);
  // At most three agent rows and the projects row; the rest add up into one.
  const top = accountRows.length > 3 ? accountRows.slice(0, 2) : accountRows;
  const rest = accountRows.length > 3 ? accountRows.slice(2) : [];
  const projectFiles = count(listed.filter((source) => source.scope === "project" && !source.accountId));
  const shown = tidy ? plainFindings(tidy.findings, inv.sources) : [];
  const next = tidy ? plainNextStep(tidy.nextStep, shown[0], shown.length, names.byId) : null;
  const scanNote = tidy ? scanProgressNote(tidy.symbolScan) : null;
  const notes = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;
  const hero = tidy ? heroFor(shown, next?.title) : waitingHero(Boolean(findings.error));
  const action = shown[0]?.action?.sourceId ? shown[0].action : null;
  return (
    <>
      <QueryState query={inventory} what="what your agents remember" />
      <HeroCard tone={hero.tone} icon={hero.icon} title={hero.title} lead={hero.lead}>
        <View style={{ gap: t.space.xs }}>
          {top.map((row) => (
            <StatusLine key={row.account.id} label={`${plainAgent(row.account.agent)}${row.account.origin !== "default" ? ` · ${row.account.email ?? row.account.label}` : ""}`} value={notes(row.files)} status="neutral" hint={O.readAtStart(plainWords(row.tokens))} />
          ))}
          {rest.length ? <StatusLine label={O.otherAgents} value={notes(rest.reduce((sum, row) => sum + row.files, 0))} status="neutral" hint={O.readAtStart(plainWords(rest.reduce((sum, row) => sum + row.tokens, 0)))} action={{ label: PLAIN.tabLabels.user, onPress: () => onGo("user") }} /> : null}
          <StatusLine label={O.projectNotes} value={notes(projectFiles)} status="neutral" action={{ label: PLAIN.tabLabels.projects, onPress: () => onGo("projects") }} />
        </View>
        {!tidy ? <QueryState query={findings} what="the checks" /> : <Meta>{lastEvent(tidy.checkedAt, scanNote)}</Meta>}
        <HeroActions show={Boolean(action)} onShow={() => action && openAction(action)} onAddNote={onAddNote} />
      </HeroCard>
      {tidy && shown.length ? (
        <Disclosure quiet title={O.allWorth(shown.length)} openTitle={O.hideWorth}>
          <TidyCard title={PLAIN.tidy.title} findings={shown} none={PLAIN.tidy.none} notes={[]} onOpen={openAction} />
        </Disclosure>
      ) : null}
      <Disclosure quiet title={PLAIN.search.title}>
        <SearchBox hostId={hostId} onOpen={onOpen} />
      </Disclosure>
    </>
  );
}

function TechnicalOverview({ hostId, onOpen, onAddNote }: Props) {
  const t = useTokens();
  const inventory = useInventory(hostId);
  const findings = useFindings(hostId);
  const inv = inventory.data;
  const tidy = findings.data;
  if (!inv) return <FirstLoad query={inventory} />;
  if (inv.counts.sources === 0) {
    return (
      <HeroCard tone="neutral" icon="Sparkles" title="Nothing to show yet" lead={inv.checked[0] ?? "No agent on this host has written memory or instruction files yet."}>
        <HeroActions show={false} onShow={() => undefined} onAddNote={onAddNote} />
      </HeroCard>
    );
  }
  const openAction = (action: FindingAction) => action.sourceId && onOpen(action.sourceId, action.key === "MEMORY.md" ? undefined : action.key);
  const accountRows = inv.accounts
    .map((account) => {
      const groups = inv.groups.filter((group) => group.accountId === account.id);
      return { account, files: groups.reduce((sum, group) => sum + group.files, 0), bytes: groups.reduce((sum, group) => sum + group.bytes, 0), tokens: groups.reduce((sum, group) => sum + group.loadedTokens, 0), last: groups.map((group) => group.lastChanged).sort().pop() ?? "" };
    })
    .filter((row) => row.account.exists && row.files > 0);
  const projectFiles = inv.groups.filter((group) => group.scope === "project" && !group.accountId);
  const hero = tidy ? heroFor(tidy.findings, tidy.nextStep.title) : waitingHero(Boolean(findings.error));
  const action = tidy?.nextStep.action?.sourceId ? tidy.nextStep.action : null;
  return (
    <>
      <QueryState query={inventory} what="what your agents remember" />
      <HeroCard tone={hero.tone} icon={hero.icon} title={hero.title} lead={hero.lead}>
        <View style={{ gap: t.space.xs }}>
          <StatusLine label="Claude memory" value={plural(inv.counts.claudeMemoryFiles, "file")} status="neutral" hint={`in ${plural(inv.counts.claudeMemoryFolders, "project")}`} />
          <StatusLine label="Codex homes" value={String(inv.counts.codexHomes)} status="neutral" />
          <StatusLine label="Sources in all" value={plural(inv.counts.sources, "source")} status="neutral" hint={formatBytes(inv.counts.bytes)} />
          {tidy ? <StatusLine label="Needs tidying" value={String(tidy.findings.length)} status={tidy.findings.length ? "attention" : "ok"} /> : null}
        </View>
        {!tidy ? <QueryState query={findings} what="the tidy checks" /> : <Meta>{[tidy.checked[0] ?? "", tidy.symbolScan.note].filter(Boolean).join(" ")}</Meta>}
        <HeroActions show={Boolean(action)} onShow={() => action && openAction(action)} onAddNote={onAddNote} />
      </HeroCard>
      <Disclosure quiet title={`What your agents remember (${plural(accountRows.length, "account")})`}>
        <Card padded={false}>
          {accountRows.map((row, index) => (
            <Row
              key={row.account.id}
              first={index === 0}
              title={`${AGENT_LABELS[row.account.agent] ?? row.account.agent}${row.account.email ? ` · ${row.account.email}` : ""}`}
              subtitle={<PathText path={row.account.dir} />}
              meta={<Facts items={[{ value: plural(row.files, "file") }, { value: formatBytes(row.bytes) }, { value: `${formatTokens(row.tokens)} at launch` }]} />}
              trailing={row.account.origin === "default" ? null : <Tag label={row.account.origin === "agent-link" ? "AgentLink" : row.account.origin === "provider-env" ? "Provider" : "Slot"} />}
            />
          ))}
          <Row
            first={accountRows.length === 0}
            title="Project files"
            subtitle="CLAUDE.md, AGENTS.md and the like inside your projects"
            meta={<Facts items={[{ value: plural(projectFiles.reduce((sum, group) => sum + group.files, 0), "file") }, { value: formatBytes(projectFiles.reduce((sum, group) => sum + group.bytes, 0)) }]} />}
          />
          <CardFooter>
            {[...inv.checked, ...inv.notes].map((line) => (
              <Text key={line} style={t.text.caption}>
                {line}
              </Text>
            ))}
          </CardFooter>
        </Card>
      </Disclosure>
      {tidy && tidy.findings.length ? (
        <Disclosure quiet title={`Needs tidying (${tidy.findings.length})`}>
          <TidyCard title="Needs tidying" findings={tidy.findings} none="Nothing needs tidying." notes={tidy.notes} onOpen={openAction} />
        </Disclosure>
      ) : null}
      <Disclosure quiet title="Search">
        <SearchBox hostId={hostId} onOpen={onOpen} />
      </Disclosure>
    </>
  );
}
