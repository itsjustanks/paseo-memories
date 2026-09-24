import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, View } from "react-native";
import { AGENT_LABELS } from "../shared/agents";
import { search, type Finding, type FindingAction } from "../shared/contracts";
import { plainError } from "../shared/errors";
import { formatBytes, formatTokens, plural } from "../shared/format";
import { folderName, scopeLabel } from "../shared/labels";
import { KEY, QueryState, useFindings, useInventory } from "./data";
import { Button, Card, Disclosure, EmptyState, ErrorText, Facts, Field, Loading, Row, Section, Tag, useTokens, type Status } from "./ui";

/**
 * "What do my agents remember, and what needs tidying?" Totals per agent and
 * account, the top findings, exactly one next step, and a search box.
 */

const TONE: Record<string, Status> = { error: "error", warn: "attention", info: "neutral" };

function FindingRow({ finding, first, onOpen }: { finding: Finding; first: boolean; onOpen: (action: FindingAction) => void }) {
  const t = useTokens();
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
  const call = useRpc(search);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const results = useQuery({ queryKey: [KEY, hostId, "search", query], queryFn: () => call({ query, limit: 30 }), enabled: query.length > 0, retry: 1 });
  return (
    <Section title="Search">
      <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "flex-end" }}>
        <View style={{ flex: 1 }}>
          <Field value={draft} onChangeText={setDraft} placeholder="Search every memory and instruction file, e.g. webhooks" />
        </View>
        <Button label="Search" onPress={() => setQuery(draft.trim())} disabled={!draft.trim()} />
      </View>
      {results.isFetching ? <Loading label="Searching" /> : null}
      {results.error ? <ErrorText>{plainError(results.error)}</ErrorText> : null}
      {results.data ? (
        <View style={{ gap: t.space.sm }}>
          <Text style={t.text.caption}>{results.data.checked}</Text>
          {results.data.results.length ? (
            <Card padded={false}>
              {results.data.results.map((hit, index) => (
                <Row
                  key={`${hit.sourceId}#${hit.key}`}
                  first={index === 0}
                  title={hit.title}
                  subtitle={`${AGENT_LABELS[hit.agent] ?? hit.agent} · ${scopeLabel(hit.scope)}${hit.projectPath ? ` · ${folderName(hit.projectPath)}` : ""}`}
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

export function Overview({ hostId, onOpen }: { hostId: string; onOpen: (sourceId: string, key?: string) => void }) {
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
              subtitle={row.account.dir}
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
