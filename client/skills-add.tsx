import { useRpc } from "@getpaseo/plugin/client";
import React, { useState } from "react";
import type { z } from "zod";
import { Pressable, Text, View } from "react-native";
import { plainError } from "../shared/errors";
import { formatBytes } from "../shared/format";
import { skillsAdd, skillsLink, skillsPreview, type AddSource } from "../shared/skill-contracts";
import { RUNS_COMMANDS } from "../shared/skill-md";
import { SKILLS_PLAIN as S, plainSkillMessage } from "../shared/skills-plain";
import { QueryState } from "./data";
import { usePlain } from "./mode";
import { useSkillsCatalog, useSkillsRefresh } from "./skills-data";
import type { AddMode } from "./skills-nav";
import { Bullets, Button, Card, CodeBlock, Disclosure, Field, Meta, Notice, PathText, Row, Segmented, Tag, Toggle, useTokens } from "./ui";

/**
 * Add a skill: from the plugin's own list (pinned versions), from a GitHub
 * link, or written here. Nothing is written before the preview: what it is,
 * every file, and where it goes. A skill with code shows its files and needs
 * "I've looked at the files" ticked. The add sends the preview's plan back;
 * the host refuses it if anything changed since.
 */

type Preview = z.output<(typeof skillsPreview)["output"]>;
type Result = { ok: boolean; message: string; warnings: string[]; skillId?: string; linkRetry?: boolean };

export function AddSkill({ hostId, mode, onMode, onOpen, compact }: { hostId: string; mode: AddMode; onMode: (mode: AddMode) => void; onOpen?: (skillId: string) => void; compact?: boolean }) {
  const t = useTokens();
  const plain = usePlain();
  const preview = useRpc(skillsPreview);
  const add = useRpc(skillsAdd);
  const link = useRpc(skillsLink);
  const refresh = useSkillsRefresh(hostId);
  const [source, setSource] = useState<AddSource | null>(null);
  const [shown, setShown] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const say = (text: string) => (plain ? plainSkillMessage(text) : text);

  const check = async (next: AddSource) => {
    setSource(next);
    setBusy(true);
    setError(null);
    setResult(null);
    setConfirmed(false);
    try {
      setShown(await preview({ source: next }));
    } catch (failure) {
      setError(plainError(failure));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!source || !shown) return;
    setBusy(true);
    try {
      const done = await add({ source, planHash: shown.planHash, ...(shown.scripts ? { confirmScripts: confirmed } : {}) });
      setResult({ ok: done.ok, message: done.message, warnings: done.warnings, ...(done.skillId ? { skillId: done.skillId } : {}), ...(done.linkRetry ? { linkRetry: true } : {}) });
      if (done.ok || done.skillId) setShown(null);
      void refresh();
    } catch (failure) {
      setError(plainError(failure));
    } finally {
      setBusy(false);
    }
  };
  const back = () => {
    setShown(null);
    setSource(null);
    setError(null);
  };

  if (result) {
    return (
      <>
        <Notice tone={result.ok ? "ok" : result.skillId ? "attention" : "error"}>
          <View style={{ gap: t.space.xs }}>
            <Text style={t.text.bodyStrong}>{say(result.message)}</Text>
            {result.warnings.map((warning) => (
              <Text key={warning} style={t.text.caption}>
                {say(warning)}
              </Text>
            ))}
            {result.ok ? <Text style={t.text.caption}>{S.add.restartNote}</Text> : null}
          </View>
        </Notice>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
          {result.linkRetry && result.skillId ? (
            <Button
              label={S.add.linkForClaude}
              icon="Link"
              variant="primary"
              loading={busy}
              onPress={() => {
                setBusy(true);
                void link({ skillId: result.skillId! })
                  .then((done) => setResult({ ok: done.ok, message: done.message, warnings: done.warnings, skillId: result.skillId!, ...(done.ok ? {} : { linkRetry: true }) }))
                  .catch((failure) => setError(plainError(failure)))
                  .finally(() => (setBusy(false), void refresh()));
              }}
            />
          ) : null}
          {result.skillId && onOpen ? <Button label="Open it" variant={result.linkRetry ? "secondary" : "primary"} onPress={() => onOpen(result.skillId!)} /> : null}
          <Button label="Add another" onPress={() => (setResult(null), back())} />
        </View>
      </>
    );
  }
  if (shown) return <PreviewCard preview={shown} busy={busy} confirmed={confirmed} onConfirmed={setConfirmed} onAdd={() => void confirm()} onBack={back} onPick={(path) => void check({ kind: "github", link: `${shown.source}/${path}@${shown.commit}` })} error={error} />;
  return (
    <>
      <Segmented<AddMode> options={(["catalog", "github", "write"] as const).map((value) => ({ value, label: S.add.modes[value]! }))} value={mode} onChange={onMode} />
      {error ? <Notice tone="error"><Text style={t.text.body}>{error}</Text></Notice> : null}
      {mode === "catalog" ? <CatalogList hostId={hostId} busy={busy ? source?.id ?? null : null} onPreview={(id) => void check({ kind: "catalog", id })} compact={Boolean(compact)} /> : null}
      {mode === "github" ? <GithubForm busy={busy} onPreview={(link) => void check({ kind: "github", link })} /> : null}
      {mode === "write" ? <WriteForm busy={busy} onPreview={(fields) => void check({ kind: "write", ...fields })} /> : null}
    </>
  );
}

function CatalogList({ hostId, busy, onPreview, compact }: { hostId: string; busy: string | null; onPreview: (id: string) => void; compact: boolean }) {
  const t = useTokens();
  const catalog = useSkillsCatalog(hostId);
  if (!catalog.data) return <QueryState query={catalog} what="the list" />;
  return (
    <>
      <Meta>{S.add.catalogNote}</Meta>
      <Card padded={false}>
        {catalog.data.entries.map((entry, index) => (
          <Row
            key={entry.id}
            first={index === 0}
            title={entry.title}
            meta={
              <>
                {!compact ? <Text style={t.text.body}>{entry.blurb}</Text> : null}
                <Meta>{`${entry.publisher} · ${entry.license}`}</Meta>
              </>
            }
            trailing={entry.alreadyHave ? <Tag label={S.add.added} tone="ok" /> : (
              <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "center" }}>
                {entry.scripts ? <Tag label={S.add.hasCode} tone="attention" /> : null}
                <Button label={S.add.preview} variant="ghost" loading={busy === entry.id} onPress={() => onPreview(entry.id)} />
              </View>
            )}
          />
        ))}
      </Card>
    </>
  );
}

function GithubForm({ busy, onPreview }: { busy: boolean; onPreview: (link: string) => void }) {
  const t = useTokens();
  const [link, setLink] = useState("");
  return (
    <Card>
      <Field label={S.add.linkLabel} value={link} onChangeText={setLink} placeholder={S.add.linkPlaceholder} />
      <View style={{ flexDirection: "row" }}>
        <Button label={S.add.preview} variant="primary" loading={busy} disabled={!link.trim()} onPress={() => onPreview(link.trim())} />
      </View>
      <Meta>{t.compact ? "" : "Only public github.com folders. Nothing is added until you confirm."}</Meta>
    </Card>
  );
}

function WriteForm({ busy, onPreview }: { busy: boolean; onPreview: (fields: { name: string; whenToUse: string; instructions: string }) => void }) {
  const A = S.add;
  const [name, setName] = useState("");
  const [when, setWhen] = useState("");
  const [how, setHow] = useState("");
  return (
    <Card>
      <Field label={A.nameLabel} value={name} onChangeText={(value) => setName(value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder={A.namePlaceholder} hint={A.nameHint} />
      <Field label={A.whenLabel} value={when} onChangeText={setWhen} placeholder={A.whenPlaceholder} multiline minHeight={64} />
      <Field label={A.howLabel} value={how} onChangeText={setHow} placeholder={A.howPlaceholder} multiline minHeight={140} />
      <View style={{ flexDirection: "row" }}>
        <Button label={A.check} variant="primary" loading={busy} disabled={!name || !when.trim() || !how.trim()} onPress={() => onPreview({ name, whenToUse: when, instructions: how })} />
      </View>
    </Card>
  );
}

function PreviewCard({ preview, busy, confirmed, onConfirmed, onAdd, onBack, onPick, error }: { preview: Preview; busy: boolean; confirmed: boolean; onConfirmed: (value: boolean) => void; onAdd: () => void; onBack: () => void; onPick: (path: string) => void; error: string | null }) {
  const t = useTokens();
  const plain = usePlain();
  const A = S.add;
  const say = (text: string) => (plain ? plainSkillMessage(text) : text);
  if (!preview.ok && preview.choices.length) {
    return (
      <Card title={A.pick} icon="FolderTree">
        <Card padded={false} level={2}>
          {preview.choices.map((choice, index) => (
            <Row key={choice.path} first={index === 0} title={choice.name} subtitle={choice.path} onPress={() => onPick(choice.path)} />
          ))}
        </Card>
        <View style={{ flexDirection: "row" }}>
          <Button label={A.startOver} variant="ghost" onPress={onBack} />
        </View>
      </Card>
    );
  }
  const links = preview.targets.filter((target) => target.kind === "link").length;
  const where = plain
    ? [preview.targets.some((target) => target.kind === "canonical") ? A.whereShared : "", links ? A.whereClaude(links) : "", preview.targets.some((target) => target.kind === "lock") ? A.whereList : ""].filter(Boolean)
    : preview.targets.map((target) => `${target.kind}: ${target.path}`);
  // The reasons it can run commands go in the code confirm; a version off the main line is a decision too; the rest are quiet facts.
  const commandReasons = preview.warnings.filter((warning) => warning.startsWith(RUNS_COMMANDS));
  const decisions = preview.warnings.filter((warning) => /main line/.test(warning));
  const warnings = preview.warnings.filter((warning) => !/includes code your agents may run/i.test(warning) && !commandReasons.includes(warning) && !decisions.includes(warning));
  const scripts = preview.files.filter((file) => file.kind === "script");
  return (
    <>
      {error ? <Notice tone="error"><Text style={t.text.body}>{error}</Text></Notice> : null}
      <Card title={preview.name || A.whatWillBeAdded} icon="Sparkles" {...(preview.source ? { subtitle: preview.commit ? `${preview.source} · ${preview.commit.slice(0, 7)}` : preview.source } : {})}>
        {!preview.ok ? <Notice tone="error"><Text style={t.text.body}>{say(preview.problem)}</Text></Notice> : null}
        {preview.description ? <Text style={t.text.body}>{preview.description}</Text> : null}
        {preview.ok ? (
          <>
            <View style={{ gap: t.space.sm }}>
              <Text style={t.text.label}>{A.whereItGoes}</Text>
              {plain ? <Bullets items={where} /> : where.map((line) => <PathText key={line} path={line} style={t.text.caption} />)}
            </View>
            {preview.scripts ? (
              <Notice tone="attention">
                <View style={{ gap: t.space.sm }}>
                  <Text style={t.text.bodyStrong}>{A.codeWarning}</Text>
                  {commandReasons.map((reason) => (
                    <Text key={reason} style={t.text.body}>
                      {reason}
                    </Text>
                  ))}
                  {scripts.map((file) => (
                    <PathText key={file.path} path={`${file.path}${file.executable ? " (can be run)" : ""}`} style={t.text.mono} />
                  ))}
                  <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, flexWrap: "wrap" }}>
                    <Toggle label={A.codeConfirm} value={confirmed} onChange={onConfirmed} />
                    <Pressable accessibilityRole="button" onPress={() => onConfirmed(!confirmed)} style={{ flexShrink: 1 }}>
                      <Text style={t.text.body}>{A.codeConfirm}</Text>
                    </Pressable>
                  </View>
                </View>
              </Notice>
            ) : null}
            {decisions.map((warning) => (
              <Notice key={warning} tone="attention">
                <Text style={t.text.body}>{say(warning)}</Text>
              </Notice>
            ))}
            {warnings.length ? <Meta>{warnings.map(say).join(" ")}</Meta> : null}
            {preview.problems.length ? <Meta>{preview.problems.map((problem) => say(problem.message)).join(" ")}</Meta> : null}
          </>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
          {preview.ok ? <Button label={A.addIt} icon="Plus" variant="primary" loading={busy} disabled={preview.scripts && !confirmed} onPress={onAdd} /> : null}
          <Button label={A.startOver} variant="ghost" onPress={onBack} />
        </View>
      </Card>
      {preview.ok ? (
        <>
          <Disclosure quiet title={`${A.files} (${preview.files.length})`}>
            <Card padded={false}>
              {preview.files.map((file, index) => (
                <Row key={file.path} first={index === 0} title={<PathText path={file.path} style={t.text.body} />} meta={<Meta>{formatBytes(file.bytes)}</Meta>} trailing={file.kind === "script" ? <Tag label={plain ? S.detail.code : "not markdown"} tone="attention" /> : null} />
              ))}
            </Card>
          </Disclosure>
          <Disclosure quiet title={A.instructions}>
            <CodeBlock copy={false}>{preview.skillMd}</CodeBlock>
          </Disclosure>
        </>
      ) : null}
    </>
  );
}
