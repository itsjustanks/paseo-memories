import { useRpc } from "@getpaseo/plugin/client";
import React, { useState } from "react";
import { Text, View } from "react-native";
import { plainError } from "../shared/errors";
import { formatBytes } from "../shared/format";
import { plainAgent } from "../shared/plain";
import { skillsLink, skillsRemove, skillsToggle, type Skill } from "../shared/skill-contracts";
import { SKILLS_PLAIN as S, sinceText, plainProvenance, plainReaders, plainSkillMessage, plainState, plainWordsFromChars, technicalProvenance } from "../shared/skills-plain";
import { MD_EDITOR } from "../shared/plain";
import { QueryState } from "./data";
import { SkillsResult, type SkillsResultValue } from "./skills-report";
import { Markdown } from "./markdown";
import { usePlain } from "./mode";
import { useSkillDetail, useSkillsInventory, useSkillsRefresh } from "./skills-data";
import type { SkillsPlace } from "./skills-nav";
import { Accordion, AccordionItem, Button, Card, CodeBlock, ConfirmLink, EmptyState, Field, Link, Meta, Notice, PathText, Row, Pills, Tag, useTokens } from "./ui";

/**
 * Your skills: every skill, grouped by where it lives, with a filter by
 * agent and a search box; one opens to what it does, who uses it, and the
 * two things to do with it (turn off for an agent, remove), then its
 * instructions and files as fold-out rows. Skills looked after elsewhere
 * (Paseo's, plugins', claude.ai's, built-in) and what was checked fold away
 * at the end, still one tap from their reason.
 */

type Filter = "all" | "claude" | "codex";

/** Which group a skill lists under. */
export function groupOf(skill: Skill): string {
  if (skill.access === "read-only") return "other";
  if (skill.scope === "project") return "project";
  if (skill.locations.some((location) => location.root === "shared")) return "shared";
  if (skill.readBy.includes("claude") && !skill.readBy.includes("codex")) return "claude";
  if (skill.readBy.includes("codex") && !skill.readBy.includes("claude")) return "codex";
  return "shared";
}

/** One chip per row: what most needs saying. */
function chipFor(skill: Skill): { label: string; tone?: "attention" | "ok" | "neutral" } | null {
  const off = plainState(skill.state.claude === "off" || skill.state.codex === "off" ? "off" : skill.state.claude === "mixed" || skill.state.codex === "mixed" ? "mixed" : "");
  if (off) return { label: off, tone: "neutral" };
  if (skill.problems.some((problem) => problem.severity === "warn")) return { label: "Worth a look", tone: "attention" };
  if (skill.usage && skill.usage.total > 0) return { label: S.list.usedTimes(skill.usage.total), tone: "ok" };
  return null;
}

function SkillRow({ skill, first, onOpen }: { skill: Skill; first: boolean; onOpen: () => void }) {
  const t = useTokens();
  const plain = usePlain();
  const chip = chipFor(skill);
  return (
    <Row
      first={first}
      onPress={onOpen}
      title={skill.name}
      meta={
        <>
          {skill.description ? (
            <Text numberOfLines={2} style={t.text.caption}>
              {skill.description}
            </Text>
          ) : null}
          {!plain ? <PathText path={skill.path} style={t.text.caption} /> : null}
        </>
      }
      trailing={chip ? <Tag label={chip.label} {...(chip.tone ? { tone: chip.tone } : {})} /> : null}
    />
  );
}

export function SkillsList({ hostId, skillId, onOpen, onGo }: { hostId: string; skillId: string | null; onOpen: (skillId: string | null) => void; onGo: (place: SkillsPlace) => void }) {
  const t = useTokens();
  const inventory = useSkillsInventory(hostId);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const inv = inventory.data;
  if (!inv) return <QueryState query={inventory} what="your agents' skills" />;
  if (skillId) {
    const skill = inv.skills.find((entry) => entry.id === skillId);
    if (skill) return <SkillDetail hostId={hostId} skill={skill} onBack={() => onOpen(null)} />;
  }
  if (inv.skills.length === 0) return <EmptyState icon="Sparkles" title={S.hero.none.title} body={S.list.empty} action={<Button label={S.addButton} icon="Plus" variant="primary" onPress={() => onGo({ tab: "add" })} />} />;
  const words = query.trim().toLowerCase();
  const shown = inv.skills
    .filter((skill) => filter === "all" || skill.readBy.includes(filter))
    .filter((skill) => !words || skill.name.toLowerCase().includes(words) || skill.description.toLowerCase().includes(words))
    .sort((a, b) => a.name.localeCompare(b.name));
  const groups = ["shared", "claude", "codex", "project", "other"].map((id) => ({ id, skills: shown.filter((skill) => groupOf(skill) === id) })).filter((group) => group.skills.length);
  const other = groups.find((group) => group.id === "other");
  const list = (skills: Skill[]) => (
    <Card padded={false}>
      {skills.map((skill, index) => (
        <SkillRow key={skill.id} skill={skill} first={index === 0} onOpen={() => onOpen(skill.id)} />
      ))}
    </Card>
  );
  return (
    <>
      <QueryState query={inventory} what="your agents' skills" />
      <View style={{ gap: t.space.row }}>
        <Pills<Filter>
          label={S.list.filterLabel}
          options={[
            { value: "all", label: S.list.filterAll },
            { value: "claude", label: "Claude" },
            { value: "codex", label: "Codex" },
          ]}
          value={filter}
          onChange={setFilter}
        />
        <Field value={query} onChangeText={setQuery} placeholder={S.list.search} />
      </View>
      {groups.length === 0 ? <Meta>{S.list.none}</Meta> : null}
      {groups
        .filter((group) => group.id !== "other")
        .map((group) => (
          <View key={group.id} style={{ gap: t.space.sm }}>
            <Text style={t.text.section}>{`${S.list.groups[group.id]} (${group.skills.length})`}</Text>
            {list(group.skills)}
          </View>
        ))}
      <Accordion>
        {other ? (
          <AccordionItem key={`other-${words}-${filter}`} icon="Lock" title={`${S.list.groups.other} (${other.skills.length})`} summary={S.more.otherSummary}>
            {list(other.skills)}
          </AccordionItem>
        ) : null}
        {inv.checked.length || inv.notes.length ? (
          <AccordionItem icon="ListChecks" title={S.more.checkedTitle} summary={S.more.checkedSummary}>
            {[...inv.checked, ...inv.notes].map((line) => (
              <Text key={line} style={t.text.caption}>
                {line}
              </Text>
            ))}
          </AccordionItem>
        ) : null}
      </Accordion>
    </>
  );
}

// ------------------------------------------------------------------ one skill

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: t.compact ? "column" : "row", gap: t.compact ? t.space.hair : t.space.row }}>
      <Text style={[t.text.label, { width: t.compact ? undefined : 200 }]}>{label}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>{typeof value === "string" ? <Text style={t.text.body}>{value}</Text> : value}</View>
    </View>
  );
}

function SkillDetail({ hostId, skill, onBack }: { hostId: string; skill: Skill; onBack: () => void }) {
  const t = useTokens();
  const plain = usePlain();
  const [reveal, setReveal] = useState(false);
  const [asText, setAsText] = useState(false);
  const detail = useSkillDetail(hostId, skill.id, reveal);
  const toggle = useRpc(skillsToggle);
  const remove = useRpc(skillsRemove);
  const link = useRpc(skillsLink);
  const refresh = useSkillsRefresh(hostId);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<SkillsResultValue | null>(null);
  const D = S.detail;
  const run = async (key: string, call: () => Promise<SkillsResultValue>, leave = false) => {
    setBusy(key);
    try {
      const done = await call();
      setResult(done);
      if (done.ok && leave) onBack();
    } catch (error) {
      setResult({ ok: false, message: plainError(error) });
    } finally {
      setBusy(null);
      void refresh();
    }
  };
  const words = (chars: number) => (plain ? plainWordsFromChars(chars) : `${chars.toLocaleString("en-US")} characters`);
  const listCost = Math.max(skill.listing.claude, skill.listing.codex);
  const warn = skill.problems.find((problem) => problem.severity === "warn") ?? skill.problems[0];
  const files = detail.data?.fileList ?? [];
  const usage = skill.usage;
  const say = (text: string) => (plain ? plainSkillMessage(text) : text);
  return (
    <>
      <Link label={S.list.back} onPress={onBack} />
      {result ? <SkillsResult hostId={hostId} result={result} onDismiss={() => setResult(null)} /> : null}
      <Card title={skill.name} icon="Sparkles" {...(skill.access === "read-only" ? { subtitle: S.list.readOnly } : {})}>
        {skill.description ? <Text style={t.text.body}>{skill.description}</Text> : null}
        <View style={{ gap: t.space.sm }}>
          <Fact label={D.from} value={plain ? plainProvenance(skill.provenance, skill.provenanceDetail) : technicalProvenance(skill.provenance, skill.provenanceDetail)} />
          <Fact label={D.who} value={plainReaders(skill.readBy)} />
          {listCost ? <Fact label={D.listCost} value={words(listCost)} /> : null}
          <Fact label={plain ? "Files" : "Folder"} value={plain ? (skill.scripts ? D.filesWithCode(skill.files, skill.scripts) : D.files(skill.files)) : `${skill.files} files · ${formatBytes(skill.bytes)}${skill.scripts ? ` · ${skill.scripts} non-markdown` : ""}`} />
          {skill.runsCommands ? <Fact label={D.runs} value={say(skill.runsCommands)} /> : null}
          <Fact label="Use" value={usage ? (usage.total ? `${D.used(usage.total, sinceText(usage.lastUsed))}${usage.estimated ? ` ${D.estimated}` : ""}` : D.neverUsed) : S.rows.countingOff} />
        </View>
        {warn ? <Notice tone={warn.severity === "warn" ? "attention" : "neutral"}><Text style={t.text.body}>{say(warn.message)}</Text></Notice> : null}
        {skill.versionControlled ? <Meta>{plain ? D.shared : skill.reason}</Meta> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm, alignItems: "center" }}>
          {skill.can.turnOff.map((agent) => {
            const off = skill.state[agent] === "off";
            const name = plainAgent(agent);
            return <Button key={agent} label={off ? D.turnOn(name) : D.turnOff(name)} icon="Power" loading={busy === agent} onPress={() => void run(agent, () => toggle({ skillId: skill.id, agent, on: off }))} />;
          })}
          {skill.can.link ? <Button label={S.add.linkForClaude} icon="Link" loading={busy === "link"} onPress={() => void run("link", () => link({ skillId: skill.id }))} /> : null}
          {skill.can.remove ? <ConfirmLink label={D.remove} question={D.removeQuestion} yes={D.removeYes} no={D.keep} onConfirm={() => void run("remove", () => remove({ skillId: skill.id, confirm: true }), true)} /> : null}
        </View>
      </Card>
      <Accordion>
        <AccordionItem icon="BookOpenText" title={D.showInstructions} summary={D.instructionsSummary}>
          <QueryState query={detail} what="its instructions" />
          {detail.data ? (asText ? <CodeBlock copy>{detail.data.body}</CodeBlock> : <Markdown text={detail.data.body} />) : null}
          {detail.data ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: t.space.md, rowGap: t.space.xs }}>
              <Link label={asText ? D.formatted : MD_EDITOR.readAsText} onPress={() => setAsText(!asText)} />
              {detail.data.body.includes("••••") ? <Link label="Show hidden values" onPress={() => setReveal(true)} /> : null}
            </View>
          ) : null}
        </AccordionItem>
        <AccordionItem icon="Files" title={`${D.showFiles} (${skill.files})`}>
          <Card padded={false} level={2}>
            {files.map((file, index) => (
              <Row key={file.path} first={index === 0} title={<PathText path={file.path} style={t.text.body} />} meta={<Meta>{formatBytes(file.bytes)}</Meta>} trailing={file.kind === "script" ? <Tag label={plain ? D.code : file.executable ? "executable" : "not markdown"} tone="attention" /> : null} />
            ))}
          </Card>
        </AccordionItem>
        {!skill.can.turnOff.length || !skill.can.remove ? (
          <AccordionItem icon="Lock" title={!skill.can.turnOff.length ? D.whyNotOff : D.whyNotRemove}>
            {skill.can.turnOffReason ? <Text style={t.text.body}>{say(skill.can.turnOffReason)}</Text> : null}
            {!skill.can.remove && skill.can.removeReason && skill.can.removeReason !== skill.can.turnOffReason ? <Text style={t.text.body}>{say(skill.can.removeReason)}</Text> : null}
          </AccordionItem>
        ) : null}
        {!plain ? (
          <AccordionItem icon="FolderOpen" title={`Where it lives (${skill.locations.length})`}>
            {skill.locations.map((location) => (
              <View key={location.path} style={{ gap: t.space.hair }}>
                <PathText path={location.path} style={t.text.mono} />
                <Meta>{`${location.root}${location.link ? " · link" : ""}`}</Meta>
              </View>
            ))}
            {skill.problems.slice(1).map((problem) => (
              <Meta key={problem.code}>{problem.message}</Meta>
            ))}
          </AccordionItem>
        ) : null}
      </Accordion>
    </>
  );
}
