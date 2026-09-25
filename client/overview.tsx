import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, View } from "react-native";
import { AGENT_LABELS } from "../shared/agents";
import { search, type Finding, type FindingAction } from "../shared/contracts";
import { plainError } from "../shared/errors";
import { formatBytes, formatTokens, plural } from "../shared/format";
import { folderName, scopeLabel } from "../shared/labels";
import { PLAIN, isCodexInternal, plainAgent, plainFinding, plainFindings, plainNextStep, plainWords, scanProgressNote } from "../shared/plain";
import { KEY, QueryState, useFindings, useInventory } from "./data";
import { usePlain, useSourceNames } from "./mode";
import { Button, Card, Disclosure, EmptyState, ErrorText, Facts, Field, Loading, PathText, Row, Section, Tag, useTokens, type Status } from "./ui";

/**
 * "What do my agents remember, and what needs tidying?" Totals per agent and
 * account, the top findings, exactly one next step, and a search box.
 */

const TONE: Record<string, Status> = { error: "error", warn: "attention", info: "neutral" };

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
        title={<Text style={t.text.body}>{words.title}</Text>}
        meta={words.detail ? <Text style={t.text.caption}>{words.detail}</Text> : null}
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
    <Section title={plain ? PLAIN.search.title : "Search"}>
      <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "flex-end" }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Field value={draft} onChangeText={setDraft} placeholder={plain ? PLAIN.search.placeholder : "Search every memory and instruction file, e.g. webhooks"} />
        </View>
        <Button label={PLAIN.search.button} onPress={() => setQuery(draft.trim())} disabled={!draft.trim()} />
      </View>
      {results.isFetching ? <Loading label={PLAIN.search.busy} /> : null}
      {results.error ? <ErrorText>{plainError(results.error)}</ErrorText> : null}
      {results.data ? (
        <View style={{ gap: t.space.sm }}>
          {plain ? (hits.length ? null : <Text style={t.text.caption}>{`No note mentions "${results.data.query}".`}</Text>) : <Text style={t.text.caption}>{results.data.checked}</Text>}
          {hits.length ? (
            <Card padded={false}>
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
    </Section>
  );
}

/** The host id for rows deep in the tree; set by the Overview. */
const HostContext = React.createContext("");
function useHostId(): string {
  return React.useContext(HostContext);
}

export function Overview(props: { hostId: string; onOpen: (sourceId: string, key?: string) => void; onAddNote: () => void }) {
  const plain = usePlain();
  return <HostContext.Provider value={props.hostId}>{plain ? <PlainOverview {...props} /> : <TechnicalOverview {...props} />}</HostContext.Provider>;
}

function PlainOverview({ hostId, onOpen, onAddNote }: { hostId: string; onOpen: (sourceId: string, key?: string) => void; onAddNote: () => void }) {
  const t = useTokens();
  const inventory = useInventory(hostId);
  const findings = useFindings(hostId);
  const names = useSourceNames(hostId);
  const inv = inventory.data;
  const tidy = findings.data;
  const O = PLAIN.overview;
  const add = (
    <Card>
      <View style={{ gap: t.space.sm }}>
        <Text style={t.text.heading}>{O.primary}</Text>
        <Text style={t.text.body}>{O.primaryHint}</Text>
        <View style={{ flexDirection: "row" }}>
          <Button label={O.primary} variant="primary" onPress={onAddNote} />
        </View>
      </View>
    </Card>
  );
  if (!inv) return <QueryState query={inventory} what="what your agents remember" />;
  if (inv.counts.sources === 0) return <View style={{ gap: t.space.lg }}>{add}<EmptyState title={PLAIN.nothingYet.title} body={PLAIN.nothingYet.body} /></View>;
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
  const shown = plainFindings(tidy?.findings ?? [], inv.sources);
  const next = tidy ? plainNextStep(tidy.nextStep, shown[0], shown.length, names.byId) : null;
  const scanNote = tidy ? scanProgressNote(tidy.symbolScan) : null;
  const notes = (count: number) => `${count} ${count === 1 ? "note" : "notes"}`;
  return (
    <View style={{ gap: t.space.lg }}>
      <QueryState query={inventory} what="what your agents remember" />
      {add}
      <Card tone={shown.length ? "attention" : "ok"}>
        <Text style={t.text.label}>{O.nextStep}</Text>
        {tidy && next ? (
          <>
            <Text style={t.text.heading}>{next.title}</Text>
            <Text style={t.text.body}>{next.detail}</Text>
            {shown[0]?.action?.sourceId ? (
              <View style={{ flexDirection: "row" }}>
                <Button label={PLAIN.tidy.show} variant="primary" onPress={() => openAction(shown[0]!.action!)} />
              </View>
            ) : null}
          </>
        ) : (
          <QueryState query={findings} what="the checks" />
        )}
      </Card>
      <Section title={O.remember}>
        <Card padded={false}>
          {accountRows.map((row, index) => (
            <Row
              key={row.account.id}
              first={index === 0}
              title={`${plainAgent(row.account.agent)}${row.account.origin !== "default" ? ` · ${row.account.email ?? row.account.label}` : ""}`}
              meta={<Facts items={[{ value: notes(row.files) }, { value: O.readAtStart(plainWords(row.tokens)) }]} />}
            />
          ))}
          <Row first={accountRows.length === 0} title={O.projectNotes} subtitle={O.projectNotesHint} meta={<Facts items={[{ value: notes(projectFiles) }]} />} />
        </Card>
      </Section>
      <Section title={PLAIN.tidy.title} trailing={tidy ? <Tag label={String(shown.length)} tone={shown.length ? "attention" : "ok"} /> : null}>
        {tidy ? (
          shown.length ? (
            <>
              <Card padded={false}>
                {shown.slice(0, 5).map((finding, index) => (
                  <FindingRow key={finding.id} finding={finding} first={index === 0} onOpen={openAction} />
                ))}
              </Card>
              {shown.length > 5 ? (
                <Disclosure title={PLAIN.tidy.more(shown.length - 5)}>
                  <Card padded={false}>
                    {shown.slice(5, 100).map((finding, index) => (
                      <FindingRow key={finding.id} finding={finding} first={index === 0} onOpen={openAction} />
                    ))}
                  </Card>
                </Disclosure>
              ) : null}
            </>
          ) : (
            <Text style={t.text.caption}>{PLAIN.tidy.none}</Text>
          )
        ) : null}
        {scanNote ? <Text style={t.text.caption}>{scanNote}</Text> : null}
      </Section>
      <SearchBox hostId={hostId} onOpen={onOpen} />
    </View>
  );
}

function TechnicalOverview({ hostId, onOpen, onAddNote }: { hostId: string; onOpen: (sourceId: string, key?: string) => void; onAddNote: () => void }) {
  const t = useTokens();
  const inventory = useInventory(hostId);
  const findings = useFindings(hostId);
  const inv = inventory.data;
  const tidy = findings.data;
  if (!inv) return <QueryState query={inventory} what="what your agents remember" />;
  if (inv.counts.sources === 0) return <EmptyState title="Nothing to show yet" body={inv.checked[0] ?? "No agent on this host has written memory or instruction files yet."} />;
  const openAction = (action: FindingAction) => action.sourceId && onOpen(action.sourceId, action.key === "MEMORY.md" ? undefined : action.key);
  const accountRows = inv.accounts
    .map((account) => {
      const groups = inv.groups.filter((group) => group.accountId === account.id);
      return { account, files: groups.reduce((sum, group) => sum + group.files, 0), bytes: groups.reduce((sum, group) => sum + group.bytes, 0), tokens: groups.reduce((sum, group) => sum + group.loadedTokens, 0), last: groups.map((group) => group.lastChanged).sort().pop() ?? "" };
    })
    .filter((row) => row.account.exists && row.files > 0);
  const projectFiles = inv.groups.filter((group) => group.scope === "project" && !group.accountId);
  return (
    <View style={{ gap: t.space.lg }}>
      <QueryState query={inventory} what="what your agents remember" />
      <View style={{ flexDirection: "row" }}>
        <Button label={PLAIN.overview.primary} variant="primary" onPress={onAddNote} />
      </View>
      <Card tone={tidy?.findings.length ? "attention" : "ok"}>
        <Text style={t.text.label}>NEXT STEP</Text>
        {tidy ? (
          <>
            <Text style={t.text.heading}>{tidy.nextStep.title}</Text>
            <Text style={t.text.body}>{tidy.nextStep.detail}</Text>
            {tidy.nextStep.action?.sourceId ? (
              <View style={{ flexDirection: "row" }}>
                <Button label="Show me" variant="primary" onPress={() => openAction(tidy.nextStep.action!)} />
              </View>
            ) : null}
          </>
        ) : (
          <QueryState query={findings} what="the tidy checks" />
        )}
      </Card>
      <Section title="What your agents remember">
        <Text style={t.text.body}>
          {`${plural(inv.counts.claudeMemoryFiles, "Claude memory file")} in ${plural(inv.counts.claudeMemoryFolders, "project")}, ${plural(inv.counts.codexHomes, "Codex home")}, ${plural(inv.counts.sources, "source")} in all (${formatBytes(inv.counts.bytes)}).`}
        </Text>
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
        </Card>
        {[...inv.checked, ...inv.notes].map((line) => (
          <Text key={line} style={t.text.caption}>
            {line}
          </Text>
        ))}
      </Section>
      <Section title="Needs tidying" trailing={tidy ? <Tag label={String(tidy.findings.length)} tone={tidy.findings.length ? "attention" : "ok"} /> : null}>
        {tidy ? (
          tidy.findings.length ? (
            <>
              <Card padded={false}>
                {tidy.findings.slice(0, 5).map((finding, index) => (
                  <FindingRow key={finding.id} finding={finding} first={index === 0} onOpen={openAction} />
                ))}
              </Card>
              {tidy.findings.length > 5 ? (
                <Disclosure title={`${tidy.findings.length - 5} more`}>
                  <Card padded={false}>
                    {tidy.findings.slice(5, 100).map((finding, index) => (
                      <FindingRow key={finding.id} finding={finding} first={index === 0} onOpen={openAction} />
                    ))}
                  </Card>
                </Disclosure>
              ) : null}
            </>
          ) : (
            <Text style={t.text.caption}>{tidy.checked[0]} Nothing needs tidying.</Text>
          )
        ) : null}
        {tidy ? <Text style={t.text.caption}>{tidy.symbolScan.note}</Text> : null}
        {(tidy?.notes ?? []).map((note) => (
          <Text key={note} style={t.text.caption}>
            {note}
          </Text>
        ))}
      </Section>
      <SearchBox hostId={hostId} onOpen={onOpen} />
    </View>
  );
}
