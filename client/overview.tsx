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
import { Button, Card, Divider, ErrorText, Facts, Field, HeroCard, Link, Loading, PathText, Row, StatusLine, Tag, useTokens, type Status } from "./ui";

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
  return <View style={{ gap: t.space.xs, paddingVertical: t.space.md, paddingHorizontal: t.compact ? t.space.md : t.space.lg, borderTopWidth: 1, borderTopColor: t.color.borderSubtle }}>{children}</View>;
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
        <View style={{ padding: t.compact ? t.space.md : t.space.lg }}>
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
                  meta={<Text numberOfLines={2} style={t.text.caption}>{hit.snippet}</Text>}
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
  return (
    <HostContext.Provider value={props.hostId}>
      {plain ? <PlainOverview {...props} /> : <TechnicalOverview {...props} />}
      <OverviewGuide agents={agents} onGuide={() => props.onGo("guide")} />
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

/** The actions under every hero: the next step when there is one, and Add a note. */
function HeroActions({ show, onShow, onAddNote }: { show: boolean; onShow: () => void; onAddNote: () => void }) {
  const t = useTokens();
  return (
    <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
        {show ? <Button label={PLAIN.tidy.show} icon="ArrowRight" variant="primary" onPress={onShow} /> : null}
        <Button label={PLAIN.overview.primary} icon="Plus" variant={show ? "secondary" : "primary"} onPress={onAddNote} />
      </View>
      <Text style={t.text.caption}>{PLAIN.overview.primaryHint}</Text>
    </>
  );
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
    .filter((row) => row.account.exists && row.files > 0);
  const projectFiles = count(listed.filter((source) => source.scope === "project" && !source.accountId));
  const shown = tidy ? plainFindings(tidy.findings, inv.sources) : [];
  const next = tidy ? plainNextStep(tidy.nextStep, shown[0], shown.length, names.byId) : null;
  const scanNote = tidy ? scanProgressNote(tidy.symbolScan) : null;
  const notes = (count: number) => `${count} ${count === 1 ? "note" : "notes"}`;
  const hero = tidy ? heroFor(shown, next?.title) : waitingHero(Boolean(findings.error));
  const action = shown[0]?.action?.sourceId ? shown[0].action : null;
  return (
    <>
      <QueryState query={inventory} what="what your agents remember" />
      <HeroCard tone={hero.tone} icon={hero.icon} title={hero.title} lead={hero.lead}>
        <Text style={t.text.label}>{O.remember}</Text>
        <View style={{ gap: 6 }}>
          {accountRows.map((row) => (
            <StatusLine key={row.account.id} label={`${plainAgent(row.account.agent)}${row.account.origin !== "default" ? ` · ${row.account.email ?? row.account.label}` : ""}`} value={notes(row.files)} status="neutral" hint={O.readAtStart(plainWords(row.tokens))} />
          ))}
          <StatusLine label={O.projectNotes} value={notes(projectFiles)} status="neutral" hint={O.projectNotesHint} action={{ label: PLAIN.tabLabels.projects, onPress: () => onGo("projects") }} />
        </View>
        <Divider />
        {tidy && shown.length && next ? <Text style={t.text.body}>{next.detail}</Text> : null}
        {!tidy ? <QueryState query={findings} what="the checks" /> : null}
        <HeroActions show={Boolean(action)} onShow={() => action && openAction(action)} onAddNote={onAddNote} />
      </HeroCard>
      <TidyCard title={PLAIN.tidy.title} findings={tidy ? shown : null} none={PLAIN.tidy.none} notes={scanNote ? [scanNote] : []} onOpen={openAction} />
      <SearchBox hostId={hostId} onOpen={onOpen} />
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
        <Text style={t.text.body}>
          {`${plural(inv.counts.claudeMemoryFiles, "Claude memory file")} in ${plural(inv.counts.claudeMemoryFolders, "project")}, ${plural(inv.counts.codexHomes, "Codex home")}, ${plural(inv.counts.sources, "source")} in all (${formatBytes(inv.counts.bytes)}).`}
        </Text>
        <Divider />
        {tidy && tidy.findings.length ? <Text style={t.text.body}>{tidy.nextStep.detail}</Text> : null}
        {!tidy ? <QueryState query={findings} what="the tidy checks" /> : null}
        <HeroActions show={Boolean(action)} onShow={() => action && openAction(action)} onAddNote={onAddNote} />
      </HeroCard>
      <Card padded={false} title="What your agents remember" icon="Brain">
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
      <TidyCard title="Needs tidying" findings={tidy ? tidy.findings : null} none={`${tidy?.checked[0] ?? ""} Nothing needs tidying.`.trim()} notes={tidy ? [tidy.symbolScan.note, ...tidy.notes] : []} onOpen={openAction} />
      <SearchBox hostId={hostId} onOpen={onOpen} />
    </>
  );
}
