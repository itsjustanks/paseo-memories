import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { AGENT_LABELS } from "../shared/agents";
import {
  claudeMemoryCreate,
  claudeMemoryDelete,
  claudeMemoryUpdate,
  codexMemoryWrite,
  entryBody,
  instructionWrite,
  promptGet,
  promptSet,
  type Entry,
  type FileStamp,
  type Source,
  type WriteResult,
} from "../shared/contracts";
import { plainError } from "../shared/errors";
import { formatBytes, formatTokens, plural } from "../shared/format";
import { MEMORY_TYPES, folderName, kindLabel, scopeLabel } from "../shared/labels";
import { KEY, QueryState, WriteReportView, useInvalidate, useSourceDetail } from "./data";
import { edit, isDirty, keepEditing, receive, reload, type Draft } from "./draft";
import { Button, Card, CodeBlock, ConfirmButton, Facts, Field, Loading, Notice, Row, Section, Segmented, Tag, useTokens } from "./ui";

/**
 * One source: what it is, who reads it, and a viewer or editor. Read-only
 * sources say why inline. Every save shows its per-file report.
 */

type Props = {
  hostId: string;
  sourceId: string;
  workspaceId?: string;
  entryKey: string | null;
  onOpenEntry: (key: string | null) => void;
  onCopy: (from: Array<{ sourceId: string; key?: string }>) => void;
};

function agents(list: string[]): string {
  return list.map((agent) => AGENT_LABELS[agent] ?? agent).join(", ");
}

function SourceHeader({ source }: { source: Source }) {
  const t = useTokens();
  return (
    <Card>
      <View style={{ gap: t.space.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, flexWrap: "wrap" }}>
          <Text style={t.text.heading}>{source.kind === "claude-auto-memory" ? `Claude memory · ${source.projectPath ? folderName(source.projectPath) : "project path unknown"}` : kindLabel(source.kind)}</Text>
          <Tag label={scopeLabel(source.scope)} />
          {source.access === "editable" ? null : <Tag label={source.access === "online" ? "Stored online" : "Read-only"} tone="neutral" />}
          {source.exists ? null : <Tag label="Not there yet" tone="attention" />}
        </View>
        <Text selectable style={t.text.mono}>
          {source.path}
        </Text>
        <Facts
          items={[
            source.exists ? { value: source.isDirectory ? plural(source.files ?? 0, "file") : `${formatBytes(source.bytes)} · ${plural(source.lines, "line")}` } : null,
            source.loaded.tokens ? { value: `${formatTokens(source.loaded.tokens)} at launch` } : { value: "nothing at launch" },
            source.readBy.length ? { value: `read by ${agents(source.readBy)}` } : null,
          ]}
        />
        {source.loaded.note ? <Text style={t.text.caption}>{source.loaded.note}</Text> : null}
      </View>
    </Card>
  );
}

function Notes({ source, warnings, codex }: { source: Source; warnings: string[]; codex?: { lock: string; lockReason: string; pending?: string } }) {
  const t = useTokens();
  return (
    <View style={{ gap: t.space.sm }}>
      {source.access !== "editable" && source.reason ? <Notice tone="neutral">{source.reason}</Notice> : null}
      {source.label ? <Notice tone="attention">{source.label}</Notice> : null}
      {codex?.pending ? <Notice tone="attention">{codex.pending}</Notice> : null}
      {codex ? <Text style={t.text.caption}>{`Codex's clean-up lock: ${codex.lock === "free" ? "free" : codex.lock === "locked" ? "held" : "unclear"}. ${codex.lockReason}`}</Text> : null}
      {source.versionControlled ? <Notice tone="attention">This file is in a git repository: a change here shows up in git and may be shared with your team.</Notice> : null}
      {warnings.map((warning) => (
        <Text key={warning} style={t.text.caption}>
          {warning}
        </Text>
      ))}
    </View>
  );
}

function RevealBar({ secrets, revealed, onReveal }: { secrets: number; revealed: boolean; onReveal: (value: boolean) => void }) {
  const t = useTokens();
  if (!secrets) return null;
  return (
    <Notice tone="attention">
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, flexWrap: "wrap" }}>
        <Text style={[t.text.body, { flexShrink: 1 }]}>
          {revealed ? `${plural(secrets, "value")} that look like secrets are shown.` : `${plural(secrets, "value")} that look like secrets are hidden. Reveal them to edit this text.`}
        </Text>
        <Button label={revealed ? "Hide" : "Reveal"} variant="ghost" onPress={() => onReveal(!revealed)} />
      </View>
    </Notice>
  );
}

/** The file changed on disk under an unsaved draft. */
function ChangedOnDisk({ onReload, onKeep }: { onReload: () => void; onKeep: () => void }) {
  const t = useTokens();
  return (
    <Notice tone="attention">
      <View style={{ gap: t.space.sm }}>
        <Text style={t.text.body}>Changed on disk since you opened it. Reload to see the new version (your changes here are dropped), or keep editing; saving will then ask you to reload first.</Text>
        <View style={{ flexDirection: "row", gap: t.space.sm }}>
          <Button label="Reload" variant="primary" onPress={onReload} />
          <Button label="Keep editing" variant="ghost" onPress={onKeep} />
        </View>
      </View>
    </Notice>
  );
}

// ------------------------------------------------------------------ Claude memory

type MemoryForm = { name: string; description: string; type: string; body: string };

function MemoryEditor({ hostId, source, entryKey, workspaceId, onDone, onCopy }: { hostId: string; source: Source; entryKey: string; workspaceId?: string; onDone: (key: string | null) => void; onCopy: Props["onCopy"] }) {
  const t = useTokens();
  const creating = entryKey === "__new__";
  const [revealed, setRevealed] = useState(false);
  const read = useRpc(entryBody);
  const body = useQuery({
    queryKey: [KEY, hostId, "entry", source.id, entryKey, revealed],
    queryFn: () => read({ sourceId: source.id, key: entryKey, reveal: revealed, ...(workspaceId ? { workspaceId } : {}) }),
    enabled: !creating,
    retry: 1,
    refetchOnMount: "always",
  });
  const update = useRpc(claudeMemoryUpdate);
  const create = useRpc(claudeMemoryCreate);
  const remove = useRpc(claudeMemoryDelete);
  const invalidate = useInvalidate(hostId);
  const blank: MemoryForm = { name: "", description: "", type: "project", body: "" };
  // The draft survives refetches; a file changed underneath a dirty draft is flagged, not overwritten.
  const [draft, setDraft] = useState<Draft<MemoryForm> | null>(creating ? { value: blank, baseline: blank } : null);
  const [fileName, setFileName] = useState(entryKey);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!body.data) return;
    const incoming: MemoryForm = { name: body.data.fields?.name ?? "", description: body.data.fields?.description ?? "", type: body.data.fields?.type ?? "project", body: body.data.body };
    setDraft((current) => receive(current, { value: incoming, ...(body.data!.stamp ? { stamp: body.data!.stamp } : {}) }));
  }, [body.data]);
  const form = draft?.value ?? blank;
  const setForm = (value: MemoryForm) => setDraft((current) => (current ? edit(current, value) : current));
  const locked = !creating && Boolean(body.data?.masked);
  const editable = source.access === "editable";
  const run = async (action: () => Promise<WriteResult>, after?: (result: WriteResult) => void) => {
    setBusy(true);
    try {
      const outcome = await action();
      setResult(outcome);
      if (outcome.ok) {
        // Saved: the next read starts a fresh draft.
        if (!creating) setDraft(null);
        await invalidate();
        after?.(outcome);
      }
    } catch (error) {
      setResult({ ok: false, message: plainError(error), reports: [], warnings: [] });
    } finally {
      setBusy(false);
    }
  };
  // The file as the draft was loaded from, so a save over a newer version is refused by the host.
  const stamp = draft?.stamp;
  const save = () =>
    creating
      ? run(() => create({ sourceId: source.id, ...(workspaceId ? { workspaceId } : {}), name: form.name, description: form.description, type: form.type, body: form.body }), () => onDone(null))
      : run(() => {
          // Only what changed: an untouched field's frontmatter line stays byte-for-byte.
          const was = draft?.baseline ?? blank;
          return update({
            sourceId: source.id,
            ...(workspaceId ? { workspaceId } : {}),
            key: entryKey,
            expected: stamp!,
            ...(form.name !== was.name ? { name: form.name } : {}),
            ...(form.description !== was.description ? { description: form.description } : {}),
            ...(form.type !== was.type ? { type: form.type } : {}),
            ...(form.body !== was.body ? { body: form.body } : {}),
          });
        });
  if (!creating && !body.data) return <QueryState query={body} what="this memory" />;
  return (
    <Card>
      <View style={{ gap: t.space.md }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={t.text.heading}>{creating ? "New memory" : form.name || entryKey}</Text>
          <Button label="Back to the list" variant="ghost" onPress={() => onDone(null)} />
        </View>
        {!creating ? <RevealBar secrets={body.data?.secrets ?? 0} revealed={revealed} onReveal={setRevealed} /> : null}
        {draft?.newer ? <ChangedOnDisk onReload={() => setDraft(reload(draft))} onKeep={() => setDraft(keepEditing(draft))} /> : null}
        {locked || !editable ? (
          <View style={{ gap: t.space.sm }}>
            <Facts items={[{ value: form.name }, { value: form.type }, { value: form.description }]} />
            <CodeBlock copy={false}>{form.body}</CodeBlock>
          </View>
        ) : (
          <View style={{ gap: t.space.sm }}>
            <Field label="Name" value={form.name} onChangeText={(name) => setForm({ ...form, name })} placeholder="Use pnpm, not npm" />
            <Field label="One-line description" value={form.description} onChangeText={(description) => setForm({ ...form, description })} hint="Also used as the hook on its MEMORY.md line." />
            <Text style={t.text.label}>Type</Text>
            <Segmented options={MEMORY_TYPES.map((value) => ({ value, label: value }))} value={(MEMORY_TYPES as readonly string[]).includes(form.type) ? (form.type as (typeof MEMORY_TYPES)[number]) : "project"} onChange={(type) => setForm({ ...form, type })} />
            <Field label="What Claude should remember" value={form.body} onChangeText={(text) => setForm({ ...form, body: text })} multiline mono minHeight={220} />
          </View>
        )}
        {editable && !locked ? (
          <View style={{ flexDirection: "row", gap: t.space.sm, flexWrap: "wrap", alignItems: "center" }}>
            <Button label={creating ? "Save memory" : "Save"} variant="primary" onPress={() => void save()} loading={busy} disabled={!form.name.trim()} />
            {!creating ? <Button label="Copy or move…" variant="ghost" onPress={() => onCopy([{ sourceId: source.id, key: entryKey }])} /> : null}
            {!creating ? <ConfirmButton label="Delete" confirmLabel="Delete this memory and its MEMORY.md line" onConfirm={() => void run(() => remove({ sourceId: source.id, ...(workspaceId ? { workspaceId } : {}), key: entryKey, expected: stamp! }), () => onDone(null))} /> : null}
          </View>
        ) : null}
        {editable && !locked && !creating ? (
          <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "flex-end", flexWrap: "wrap" }}>
            <View style={{ flexGrow: 1, minWidth: 200 }}>
              <Field label="File name" value={fileName} onChangeText={setFileName} />
            </View>
            <Button label="Rename" onPress={() => void run(() => update({ sourceId: source.id, ...(workspaceId ? { workspaceId } : {}), key: entryKey, expected: stamp!, rename: fileName }), (outcome) => outcome.ok && onDone(fileName))} disabled={!fileName || fileName === entryKey} />
          </View>
        ) : null}
        {result ? <WriteReportView result={result} /> : null}
      </View>
    </Card>
  );
}

function MemoryList({ entries, index, onOpen, editable }: { entries: Entry[]; index?: { missingFiles: string[]; unindexedFiles: string[]; truncated: boolean; loadedLines: number }; onOpen: (key: string) => void; editable: boolean }) {
  const t = useTokens();
  return (
    <Section title={plural(entries.length, "memory", "memories")} trailing={editable ? <Button label="New memory" onPress={() => onOpen("__new__")} /> : null}>
      {entries.length === 0 ? (
        <Text style={t.text.caption}>No memory files in this folder yet.</Text>
      ) : (
        <Card padded={false}>
          {entries.map((entry, i) => (
            <Row
              key={entry.key}
              first={i === 0}
              title={entry.title}
              subtitle={entry.description ?? entry.key}
              onPress={() => onOpen(entry.key)}
              meta={<Facts items={[entry.type ? { value: entry.type } : null, { value: formatBytes(entry.bytes) }, entry.indexed ? null : { value: "not in MEMORY.md", tone: "attention" }, entry.secrets ? { value: "looks like a secret", tone: "error" } : null]} />}
            />
          ))}
        </Card>
      )}
      {index?.missingFiles.length ? <Text style={t.text.caption}>{`MEMORY.md lists ${index.missingFiles.join(", ")}, which ${index.missingFiles.length === 1 ? "does" : "do"} not exist.`}</Text> : null}
    </Section>
  );
}

// ------------------------------------------------------------------ files

function FileEditor({ hostId, source, workspaceId, stamp, codexLock }: { hostId: string; source: Source; workspaceId?: string; stamp?: FileStamp; codexLock?: { lock: string; lockReason: string } }) {
  const t = useTokens();
  const [revealed, setRevealed] = useState(false);
  const read = useRpc(entryBody);
  const body = useQuery({
    queryKey: [KEY, hostId, "entry", source.id, "", revealed],
    queryFn: () => read({ sourceId: source.id, reveal: revealed, ...(workspaceId ? { workspaceId } : {}) }),
    enabled: source.exists,
    retry: 1,
    refetchOnMount: "always",
  });
  const write = useRpc(instructionWrite);
  const codex = useRpc(codexMemoryWrite);
  const invalidate = useInvalidate(hostId);
  const [draft, setDraft] = useState<Draft<string> | null>(source.exists ? null : { value: "", baseline: "" });
  const [result, setResult] = useState<WriteResult | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (body.data) setDraft((current) => receive(current, { value: body.data!.body, ...(body.data!.stamp ? { stamp: body.data!.stamp } : {}) }));
  }, [body.data]);
  const text = draft?.value ?? "";
  const setText = (value: string) => setDraft((current) => (current ? edit(current, value) : current));
  const editable = source.access === "editable";
  const locked = Boolean(body.data?.masked);
  // Codex's lock unclear or held: the host refuses the save, so the button says so first.
  const codexBlocked = source.kind === "codex-memory" && codexLock !== undefined && codexLock.lock !== "free";
  const save = async (confirmPending = false) => {
    setBusy(true);
    try {
      const expected = (draft?.stamp ?? stamp ?? null) as FileStamp | null;
      const outcome =
        source.kind === "codex-memory"
          ? await codex({ sourceId: source.id, text, expected: expected!, ...(confirmPending ? { confirmPending: true } : {}) })
          : await write({ path: source.path, ...(workspaceId ? { workspaceId } : {}), text, expected: source.exists ? expected : null });
      setResult(outcome);
      if (outcome.ok) {
        setDraft(null);
        await invalidate();
      }
    } catch (error) {
      setResult({ ok: false, message: plainError(error), reports: [], warnings: [] });
    } finally {
      setBusy(false);
    }
  };
  if (source.exists && !body.data) return <QueryState query={body} what="this file" />;
  return (
    <Card>
      <View style={{ gap: t.space.md }}>
        <RevealBar secrets={body.data?.secrets ?? 0} revealed={revealed} onReveal={setRevealed} />
        {draft?.newer ? <ChangedOnDisk onReload={() => setDraft(reload(draft))} onKeep={() => setDraft(keepEditing(draft))} /> : null}
        {editable && !locked ? (
          <Field value={text} onChangeText={setText} multiline mono minHeight={320} placeholder={source.exists ? "" : "This file does not exist yet. Write it here and save to create it."} />
        ) : (
          <CodeBlock copy={false}>{text || "(empty)"}</CodeBlock>
        )}
        {source.kind === "codex-memory" && source.path.endsWith("memory_summary.md") ? <Text style={t.text.caption}>Keep "v1" as the first line, or Codex rebuilds this file from scratch.</Text> : null}
        {editable && !locked ? (
          <View style={{ flexDirection: "row", gap: t.space.sm, flexWrap: "wrap" }}>
            <Button label={source.exists ? "Save" : "Create file"} variant="primary" onPress={() => void save()} loading={busy} disabled={codexBlocked || (source.exists && !isDirty(draft))} />
          </View>
        ) : null}
        {codexBlocked ? <Text style={t.text.caption}>{`Saving is off for now: ${codexLock!.lockReason}`}</Text> : null}
        {result ? <WriteReportView result={result} /> : null}
        {result?.needsConfirm ? (
          <View style={{ flexDirection: "row" }}>
            <ConfirmButton label="Save anyway" confirmLabel="I understand: save it" variant="primary" onConfirm={() => void save(true)} />
          </View>
        ) : null}
      </View>
    </Card>
  );
}

function PromptEditor({ hostId }: { hostId: string }) {
  const t = useTokens();
  const get = useRpc(promptGet);
  const set = useRpc(promptSet);
  const invalidate = useInvalidate(hostId);
  const [revealed, setRevealed] = useState(false);
  const query = useQuery({ queryKey: [KEY, hostId, "prompt", revealed], queryFn: () => get({ reveal: revealed }), retry: 1, refetchOnMount: "always" });
  const [draft, setDraft] = useState<Draft<string> | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (query.data) setDraft((current) => receive(current, { value: query.data!.value }));
  }, [query.data]);
  const text = draft?.value ?? "";
  const setText = (value: string) => setDraft((current) => (current ? edit(current, value) : current));
  if (!query.data) return <QueryState query={query} what="Paseo's appended prompt" />;
  return (
    <Card>
      <View style={{ gap: t.space.md }}>
        <Text style={t.text.caption}>{query.data.note}</Text>
        <RevealBar secrets={query.data.secrets ?? 0} revealed={revealed} onReveal={setRevealed} />
        {draft?.newer ? <ChangedOnDisk onReload={() => setDraft(reload(draft))} onKeep={() => setDraft(keepEditing(draft))} /> : null}
        {query.data.masked ? <CodeBlock copy={false}>{text}</CodeBlock> : <Field value={text} onChangeText={setText} multiline mono minHeight={200} placeholder="Nothing is appended today." />}
        <View style={{ flexDirection: "row" }}>
          <Button
            label="Save"
            variant="primary"
            loading={busy}
            disabled={!isDirty(draft) || Boolean(query.data.masked)}
            onPress={() => {
              setBusy(true);
              // The value the draft started from: a prompt changed meanwhile is refused by the host.
              void set({ text, expected: draft?.baseline ?? query.data!.value })
                .then(async (outcome) => {
                  setResult(outcome);
                  if (outcome.ok) {
                    setDraft(null);
                    await Promise.all([invalidate(), query.refetch()]);
                  }
                })
                .catch((error) => setResult({ ok: false, message: plainError(error), reports: [], warnings: [] }))
                .finally(() => setBusy(false));
            }}
          />
        </View>
        {result ? <WriteReportView result={result} /> : null}
      </View>
    </Card>
  );
}

// ------------------------------------------------------------------ the pane

export function SourceDetail({ hostId, sourceId, workspaceId, entryKey, onOpenEntry, onCopy }: Props) {
  const t = useTokens();
  const detail = useSourceDetail(hostId, sourceId, workspaceId);
  if (!detail.data) return <QueryState query={detail} what="this source" />;
  const { source, entries, index, warnings, codex, stamp } = detail.data;
  return (
    <View style={{ gap: t.space.md }}>
      <QueryState query={detail} what="this source" />
      <SourceHeader source={source} />
      <Notes source={source} warnings={warnings} {...(codex ? { codex } : {})} />
      {source.kind === "claude-auto-memory" ? (
        entryKey ? (
          <MemoryEditor key={entryKey} hostId={hostId} source={source} entryKey={entryKey} {...(workspaceId ? { workspaceId } : {})} onDone={onOpenEntry} onCopy={onCopy} />
        ) : (
          <MemoryList entries={entries} {...(index ? { index } : {})} onOpen={onOpenEntry} editable={source.access === "editable"} />
        )
      ) : source.kind === "paseo-prompt" ? (
        <PromptEditor hostId={hostId} />
      ) : source.isDirectory ? (
        <Card padded={false}>
          {entries.length ? entries.map((entry, i) => <Row key={entry.key} first={i === 0} title={entry.title} meta={<Facts items={[{ value: formatBytes(entry.bytes) }]} />} />) : <Loading label="Empty folder" />}
        </Card>
      ) : source.access === "online" ? null : (
        <>
          <FileEditor hostId={hostId} source={source} {...(workspaceId ? { workspaceId } : {})} {...(stamp ? { stamp } : {})} {...(codex ? { codexLock: codex } : {})} />
          {source.exists && entries.length > 1 && source.access === "editable" ? (
            <View style={{ flexDirection: "row" }}>
              <Button label="Copy a section to another agent…" variant="ghost" onPress={() => onCopy(entries.map((entry) => ({ sourceId: source.id, key: entry.key })))} />
            </View>
          ) : null}
        </>
      )}
      {!source.exists && source.kind === "claude-auto-memory" ? <Text style={t.text.caption}>This project has no Claude memory yet; the first memory you save creates the folder.</Text> : null}
    </View>
  );
}
