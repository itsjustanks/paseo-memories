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
  importApply,
  importPreview,
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
import { HIDDEN_TEXT, cardRemoval, cardReplacement, hasHiddenText, noteCards, planCardAdd, usesFrontmatter, type Note } from "../shared/notes";
import { PLAIN, PLAIN_MEMORY_TYPES, plainAgents, plainDetailWarning, plainMemoryType, plainMessage, plainReadOnly, plainWords } from "../shared/plain";
import { KEY, QueryState, WriteReportView, useInvalidate, useSourceDetail } from "./data";
import { edit, isDirty, keepEditing, receive, reload, type Draft } from "./draft";
import { usePlain, useSourceNames } from "./mode";
import { removeSection, replaceSection, splitSections } from "../shared/markdown";
import { MD_EDITOR, TOASTS } from "../shared/plain";
import { scopeLabel as whereItApplies } from "../shared/scope";
import { Markdown } from "./markdown";
import { MarkdownEditor } from "./markdown-editor";
import { Accordion, AccordionItem, Button, Card, CodeBlock, ConfirmButton, ConfirmLink, Disclosure, Facts, Field, IconBadge, Loading, Notice, PathText, Row, Section, Segmented, Tag, useHostToast, useTokens } from "./ui";

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

/** The icon a source is drawn with: what kind of notes it holds, or a lock when it can't be changed here. */
function sourceIcon(source: Source): string {
  if (source.access === "online") return "Cloud";
  if (source.access !== "editable") return "Lock";
  if (source.kind === "claude-auto-memory") return "Brain";
  if (source.kind === "paseo-prompt") return "Monitor";
  if (source.kind === "codex-memory") return "BookOpenText";
  return "ScrollText";
}

/** A source's header card: its icon beside the title, tags and facts. */
function HeaderCard({ source, children }: { source: Source; children: React.ReactNode }) {
  const t = useTokens();
  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: t.space.row }}>
        <IconBadge name={sourceIcon(source)} tone={source.access === "editable" ? "accent" : "neutral"} size={40} />
        <View style={{ flex: 1, minWidth: 0, gap: t.space.xs }}>{children}</View>
      </View>
    </Card>
  );
}

function SourceHeader({ source }: { source: Source }) {
  const t = useTokens();
  return (
    <HeaderCard source={source}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, flexWrap: "wrap" }}>
        <Text style={[t.text.section, { flexShrink: 1 }]}>{source.kind === "claude-auto-memory" ? `Claude memory · ${source.projectPath ? folderName(source.projectPath) : "project path unknown"}` : kindLabel(source.kind)}</Text>
        <Tag label={whereItApplies(source)} />
        {source.access === "editable" ? null : <Tag label={source.access === "online" ? "Stored online" : "Read-only"} tone="neutral" />}
        {source.exists ? null : <Tag label="Not there yet" tone="attention" />}
      </View>
      <PathText path={source.path} full />
      <Facts
        items={[
          source.exists ? { value: source.isDirectory ? plural(source.files ?? 0, "file") : `${formatBytes(source.bytes)} · ${plural(source.lines, "line")}` } : null,
          source.loaded.tokens ? { value: `${formatTokens(source.loaded.tokens)} at launch` } : { value: "nothing at launch" },
          source.readBy.length ? { value: `read by ${agents(source.readBy)}` } : null,
        ]}
      />
      {source.loaded.note ? <Text style={t.text.caption}>{source.loaded.note}</Text> : null}
    </HeaderCard>
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
        <Notice key={warning} tone="attention">
          {warning}
        </Notice>
      ))}
    </View>
  );
}

function RevealBar({ secrets, revealed, onReveal }: { secrets: number; revealed: boolean; onReveal: (value: boolean) => void }) {
  const t = useTokens();
  const plain = usePlain();
  if (!secrets) return null;
  if (plain) {
    return (
      <Notice tone="attention">
        <View style={{ gap: t.space.sm }}>
          <Text style={t.text.body}>{revealed ? PLAIN.secretShown(secrets) : PLAIN.secretHidden(secrets)}</Text>
          {revealed ? null : <Text style={t.text.caption}>{PLAIN.secretWarning}</Text>}
          <View style={{ flexDirection: "row" }}>
            <Button label={revealed ? "Hide" : "Show"} variant="ghost" onPress={() => onReveal(!revealed)} />
          </View>
        </View>
      </Notice>
    );
  }
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
  const plain = usePlain();
  return (
    <Notice tone="attention">
      <View style={{ gap: t.space.sm }}>
        <Text style={t.text.body}>{plain ? PLAIN.changedElsewhere : "Changed on disk since you opened it. Reload to see the new version (your changes here are dropped), or keep editing; saving will then ask you to reload first."}</Text>
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
  const plain = usePlain();
  const M = PLAIN.memory;
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
  // These three leave the editor, and its report with it, so the app's toast says it happened.
  const toast = useHostToast();
  const leave = (message: string, key: string | null) => {
    toast.show(message, { variant: "success" });
    onDone(key);
  };
  // A memory opens to read; Change opens the editor (a new one starts in it).
  const [editing, setEditing] = useState(creating);
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
        // Saved: the next read starts a fresh draft, shown as read.
        if (!creating) setDraft(null);
        setEditing(creating);
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
      ? run(() => create({ sourceId: source.id, ...(workspaceId ? { workspaceId } : {}), name: form.name, description: form.description, type: form.type, body: form.body }), () => leave(TOASTS.noteSaved, null))
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
  const removeNote = () => void run(() => remove({ sourceId: source.id, ...(workspaceId ? { workspaceId } : {}), key: entryKey, expected: stamp! }), () => leave(TOASTS.noteRemoved, null));
  const renameRow = (
    <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "flex-end", flexWrap: "wrap" }}>
      <View style={{ flexGrow: 1, minWidth: 200 }}>
        <Field label={M.fileName} value={fileName} onChangeText={setFileName} />
      </View>
      <Button label={M.rename} onPress={() => void run(() => update({ sourceId: source.id, ...(workspaceId ? { workspaceId } : {}), key: entryKey, expected: stamp!, rename: fileName }), (outcome) => outcome.ok && leave(TOASTS.renamed, fileName))} disabled={!fileName || fileName === entryKey} />
    </View>
  );
  return (
    <Card>
      <View style={{ gap: t.space.row }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: t.space.sm }}>
          <Text style={[t.text.section, { flexShrink: 1 }]}>{creating ? (plain ? M.newTitle : "New memory") : form.name || entryKey}</Text>
          <Button label={M.back} icon="ArrowLeft" variant="ghost" onPress={() => onDone(null)} />
        </View>
        {!creating ? <RevealBar secrets={body.data?.secrets ?? 0} revealed={revealed} onReveal={setRevealed} /> : null}
        {draft?.newer ? <ChangedOnDisk onReload={() => setDraft(reload(draft))} onKeep={() => setDraft(keepEditing(draft))} /> : null}
        {locked || !editable || !editing ? (
          <View style={{ gap: t.space.sm }}>
            <Facts items={[{ value: plain ? plainMemoryType(form.type) : form.type }, { value: form.description }]} />
            {form.body.trim() ? <Markdown text={form.body} frontmatter={false} /> : <Text style={t.text.caption}>{PLAIN.notes.emptyBody}</Text>}
          </View>
        ) : plain ? (
          <View style={{ gap: t.space.sm }}>
            <Field label={M.title} value={form.name} onChangeText={(name) => setForm({ ...form, name })} placeholder={M.titlePlaceholder} />
            <Field label={M.summary} value={form.description} onChangeText={(description) => setForm({ ...form, description })} hint={M.summaryHint} />
            <Text style={t.text.label}>{M.kind}</Text>
            <Segmented options={MEMORY_TYPES.map((value) => ({ value, label: PLAIN_MEMORY_TYPES[value]! }))} value={(MEMORY_TYPES as readonly string[]).includes(form.type) ? (form.type as (typeof MEMORY_TYPES)[number]) : "project"} onChange={(type) => setForm({ ...form, type })} />
            <MarkdownEditor label={M.body} value={form.body} onChange={(text) => setForm({ ...form, body: text })} minHeight={220} frontmatter={false} />
          </View>
        ) : (
          <View style={{ gap: t.space.sm }}>
            <Field label="Name" value={form.name} onChangeText={(name) => setForm({ ...form, name })} placeholder="Use pnpm, not npm" />
            <Field label="One-line description" value={form.description} onChangeText={(description) => setForm({ ...form, description })} hint="Also used as the hook on its MEMORY.md line." />
            <Text style={t.text.label}>Type</Text>
            <Segmented options={MEMORY_TYPES.map((value) => ({ value, label: value }))} value={(MEMORY_TYPES as readonly string[]).includes(form.type) ? (form.type as (typeof MEMORY_TYPES)[number]) : "project"} onChange={(type) => setForm({ ...form, type })} />
            <MarkdownEditor label="What Claude should remember" value={form.body} onChange={(text) => setForm({ ...form, body: text })} minHeight={220} frontmatter={false} />
          </View>
        )}
        {editable && !locked && !editing ? (
          <View style={{ flexDirection: "row", gap: t.space.sm, flexWrap: "wrap", alignItems: "center" }}>
            <Button label={plain ? PLAIN.notes.change : "Edit"} icon="Pencil" variant="primary" onPress={() => setEditing(true)} />
            <Button label={M.copy} variant="ghost" onPress={() => onCopy([{ sourceId: source.id, key: entryKey }])} />
            {plain ? <ConfirmLink label={M.delete} question={PLAIN.notes.removeQuestion} yes={M.deleteConfirm} no={PLAIN.notes.keep} onConfirm={removeNote} /> : <ConfirmButton label="Delete" confirmLabel="Delete this memory and its MEMORY.md line" onConfirm={removeNote} />}
          </View>
        ) : null}
        {editable && !locked && editing ? (
          <View style={{ flexDirection: "row", gap: t.space.sm, flexWrap: "wrap", alignItems: "center" }}>
            <Button label={creating ? (plain ? M.saveNew : "Save memory") : "Save"} variant="primary" onPress={() => void save()} loading={busy} disabled={!form.name.trim()} />
            {!creating ? (
              <Button
                label={PLAIN.notes.cancel}
                variant="ghost"
                onPress={() => {
                  if (draft) setDraft({ ...draft, value: draft.baseline });
                  setEditing(false);
                }}
              />
            ) : null}
          </View>
        ) : null}
        {editable && !locked && !creating && editing ? (plain ? <Disclosure quiet title={PLAIN.technical}>{renameRow}</Disclosure> : renameRow) : null}
        {result ? <WriteReportView result={result} /> : null}
      </View>
    </Card>
  );
}

function MemoryList({ entries, index, onOpen, editable }: { entries: Entry[]; index?: { missingFiles: string[]; unindexedFiles: string[]; truncated: boolean; loadedLines: number }; onOpen: (key: string) => void; editable: boolean }) {
  const t = useTokens();
  const plain = usePlain();
  const M = PLAIN.memory;
  return (
    <Section title={plain ? M.heading(entries.length) : plural(entries.length, "memory", "memories")} icon="StickyNote" trailing={editable ? <Button label={plain ? M.new : "New memory"} icon="Plus" onPress={() => onOpen("__new__")} /> : null}>
      {entries.length === 0 ? (
        <Text style={t.text.body}>{plain ? PLAIN.notes.none : "No memory files in this folder yet."}</Text>
      ) : (
        <Card padded={false}>
          {entries.map((entry, i) => (
            <Row
              key={entry.key}
              first={i === 0}
              title={entry.title}
              subtitle={entry.description ?? (plain ? undefined : entry.key)}
              onPress={() => onOpen(entry.key)}
              meta={
                plain ? (
                  <Facts items={[{ value: plainMemoryType(entry.type) }, entry.indexed ? null : { value: M.notListed, tone: "attention" }, entry.secrets ? { value: M.secret, tone: "error" } : null]} />
                ) : (
                  <Facts items={[entry.type ? { value: entry.type } : null, { value: formatBytes(entry.bytes) }, entry.indexed ? null : { value: "not in MEMORY.md", tone: "attention" }, entry.secrets ? { value: "looks like a secret", tone: "error" } : null]} />
                )
              }
            />
          ))}
        </Card>
      )}
      {index?.missingFiles.length && plain ? <Text style={t.text.body}>{PLAIN.missingNotes}</Text> : null}
      {index?.missingFiles.length && !plain ? <Text style={t.text.body}>{`MEMORY.md lists ${index.missingFiles.join(", ")}, which ${index.missingFiles.length === 1 ? "does" : "do"} not exist.`}</Text> : null}
    </Section>
  );
}

// ------------------------------------------------------------------ files

/** A file that can't be changed here: its text, or (one tap) how it reads. */
function TextOrPreview({ text, frontmatter }: { text: string; frontmatter: boolean }) {
  const t = useTokens();
  const [mode, setMode] = useState<"text" | "preview">("text");
  return (
    <View style={{ gap: t.space.sm }}>
      <View style={{ flexDirection: "row" }}>
        <Segmented<"text" | "preview">
          options={[
            { value: "text", label: "Text" },
            { value: "preview", label: MD_EDITOR.preview },
          ]}
          value={mode}
          onChange={setMode}
        />
      </View>
      {mode === "text" ? <CodeBlock copy={false}>{text || "(empty)"}</CodeBlock> : text.trim() ? <Markdown text={text} frontmatter={frontmatter} /> : <Text style={t.text.caption}>{MD_EDITOR.nothingYet}</Text>}
    </View>
  );
}

function FileEditor({ hostId, source, workspaceId, stamp, codexLock }: { hostId: string; source: Source; workspaceId?: string; stamp?: FileStamp; codexLock?: { lock: string; lockReason: string } }) {
  const t = useTokens();
  const plain = usePlain();
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
      <View style={{ gap: t.space.row }}>
        <RevealBar secrets={body.data?.secrets ?? 0} revealed={revealed} onReveal={setRevealed} />
        {draft?.newer ? <ChangedOnDisk onReload={() => setDraft(reload(draft))} onKeep={() => setDraft(keepEditing(draft))} /> : null}
        {editable && !locked ? (
          <MarkdownEditor raw value={text} onChange={setText} minHeight={320} frontmatter={usesFrontmatter(source)} placeholder={source.exists ? "" : "This file does not exist yet. Write it here and save to create it."} />
        ) : (
          <TextOrPreview text={text} frontmatter={usesFrontmatter(source)} />
        )}
        {source.kind === "codex-memory" && source.path.endsWith("memory_summary.md") ? <Text style={t.text.caption}>{plain ? PLAIN.codexKeepFirstLine : 'Keep "v1" as the first line, or Codex rebuilds this file from scratch.'}</Text> : null}
        {editable && !locked ? (
          <View style={{ flexDirection: "row", gap: t.space.sm, flexWrap: "wrap" }}>
            <Button label={source.exists ? "Save" : "Create file"} variant="primary" onPress={() => void save()} loading={busy} disabled={codexBlocked || (source.exists && !isDirty(draft))} />
          </View>
        ) : null}
        {codexBlocked ? <Text style={t.text.caption}>{plain ? (codexLock!.lock === "locked" ? PLAIN.codexBusy : PLAIN.codexUnsure) : `Saving is off for now: ${codexLock!.lockReason}`}</Text> : null}
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
  const plain = usePlain();
  const get = useRpc(promptGet);
  const set = useRpc(promptSet);
  const invalidate = useInvalidate(hostId);
  const [revealed, setRevealed] = useState(false);
  const query = useQuery({ queryKey: [KEY, hostId, "prompt", revealed], queryFn: () => get({ reveal: revealed }), retry: 1, refetchOnMount: "always" });
  const [draft, setDraft] = useState<Draft<string> | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (query.data) setDraft((current) => receive(current, { value: query.data!.value }));
  }, [query.data]);
  const text = draft?.value ?? "";
  const setText = (value: string) => setDraft((current) => (current ? edit(current, value) : current));
  if (!query.data) return <QueryState query={query} what={plain ? "these instructions" : "Paseo's appended prompt"} />;
  return (
    <Card>
      <View style={{ gap: t.space.row }}>
        <Text style={t.text.caption}>{plain ? PLAIN.prompt.note : query.data.note}</Text>
        <RevealBar secrets={query.data.secrets ?? 0} revealed={revealed} onReveal={setRevealed} />
        {draft?.newer ? <ChangedOnDisk onReload={() => setDraft(reload(draft))} onKeep={() => setDraft(keepEditing(draft))} /> : null}
        {query.data.masked || (plain && !editing) ? (
          text.trim() ? <Markdown text={text} frontmatter={false} /> : <Text style={t.text.caption}>{plain ? PLAIN.prompt.placeholder : "Nothing is appended today."}</Text>
        ) : (
          <MarkdownEditor value={text} onChange={setText} raw={!plain} minHeight={200} frontmatter={false} placeholder={plain ? PLAIN.prompt.placeholder : "Nothing is appended today."} />
        )}
        {plain && !editing && !query.data.masked ? (
          <View style={{ flexDirection: "row" }}>
            <Button label={PLAIN.notes.change} icon="Pencil" onPress={() => setEditing(true)} />
          </View>
        ) : null}
        <View style={{ flexDirection: "row", gap: t.space.sm, display: plain && !editing ? "none" : "flex" }}>
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
                    setEditing(false);
                    await Promise.all([invalidate(), query.refetch()]);
                  }
                })
                .catch((error) => setResult({ ok: false, message: plainError(error), reports: [], warnings: [] }))
                .finally(() => setBusy(false));
            }}
          />
          {plain ? (
            <Button
              label={PLAIN.notes.cancel}
              variant="ghost"
              onPress={() => {
                if (draft) setDraft({ ...draft, value: draft.baseline });
                setEditing(false);
              }}
            />
          ) : null}
        </View>
        {result ? <WriteReportView result={result} /> : null}
      </View>
    </Card>
  );
}

// ------------------------------------------------------------------ plain: notes instead of files

/** Kinds whose sections can be changed one at a time through the instruction-write path. */
const NOTE_KINDS = new Set(["claude-md", "claude-local", "claude-rule", "agents-md", "opencode-md", "pi-md", "omp-md", "copilot-md"]);

function PlainHeader({ source, name }: { source: Source; name: string }) {
  const t = useTokens();
  return (
    <HeaderCard source={source}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, flexWrap: "wrap" }}>
        <Text style={[t.text.section, { flexShrink: 1 }]}>{name}</Text>
        <Tag label={whereItApplies(source)} />
        {source.access === "editable" ? null : <Tag label={source.access === "online" ? "Kept online" : "Can't be changed here"} tone="neutral" />}
        {source.exists ? null : <Tag label="Not written yet" tone="attention" />}
      </View>
      <Facts
        items={[
          // Said once: the size only when it differs from what is read at the start.
          source.exists && !source.isDirectory && plainWords(Math.ceil(source.bytes / 4)) !== plainWords(source.loaded.tokens) ? { value: plainWords(Math.ceil(source.bytes / 4)) } : null,
          source.loaded.tokens ? { value: PLAIN.overview.readAtStart(plainWords(source.loaded.tokens)) } : { value: "Not read at the start" },
          source.readBy.length ? { value: `Followed by ${plainAgents(source.readBy)}` } : null,
        ]}
      />
    </HeaderCard>
  );
}

function PlainNotices({ source, warnings, codex }: { source: Source; warnings: string[]; codex?: { lock: string; lockReason: string; pending?: string } }) {
  const t = useTokens();
  const plainWarnings = [...new Set(warnings.map(plainDetailWarning).filter((line): line is string => Boolean(line)))];
  return (
    <View style={{ gap: t.space.sm }}>
      {/* Steady facts are quiet; notices are kept for what needs a decision (the pending clean-up, sharing, limits). */}
      {source.access !== "editable" ? <Text style={t.text.caption}>{plainReadOnly(source)}</Text> : null}
      {source.kind === "codex-memory" ? <Text style={t.text.caption}>{PLAIN.codexRewrites}</Text> : null}
      {codex?.pending ? <Notice tone="attention">{PLAIN.codexPending}</Notice> : null}
      {codex && codex.lock !== "free" ? <Text style={t.text.caption}>{codex.lock === "locked" ? PLAIN.codexBusy : PLAIN.codexUnsure}</Text> : null}
      {source.versionControlled ? <Notice tone="attention">{PLAIN.shared}</Notice> : null}
      {plainWarnings.map((warning) => (
        <Notice key={warning} tone="attention">
          {warning}
        </Notice>
      ))}
    </View>
  );
}

function NoteCard({
  note,
  editable,
  hidden,
  busy,
  onSave,
  onRemove,
  onCopy,
}: {
  note: Note;
  editable: boolean;
  hidden: boolean;
  busy: boolean;
  onSave: (next: { title: string; body: string }) => Promise<boolean>;
  onRemove: () => void;
  onCopy?: () => void;
}) {
  const t = useTokens();
  const N = PLAIN.notes;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  if (editing) {
    return (
      <Card>
        <View style={{ gap: t.space.sm }}>
          {note.headless ? null : <Field label={N.titleLabel} value={title} onChangeText={setTitle} />}
          <MarkdownEditor label={N.textLabel} value={body} onChange={setBody} minHeight={160} frontmatter={false} autoFocus />
          <View style={{ flexDirection: "row", gap: t.space.sm, flexWrap: "wrap" }}>
            <Button
              label={N.save}
              variant="primary"
              loading={busy}
              disabled={(!note.headless && !title.trim()) || (title === note.title && body === note.body)}
              onPress={() => void onSave({ title, body }).then((ok) => ok && setEditing(false))}
            />
            <Button
              label={N.cancel}
              variant="ghost"
              onPress={() => {
                setTitle(note.title);
                setBody(note.body);
                setEditing(false);
              }}
            />
          </View>
        </View>
      </Card>
    );
  }
  return (
    <Card>
      <View style={{ gap: t.space.sm }}>
        <Text style={t.text.heading}>{note.headless ? N.topTitle : note.title}</Text>
        {note.body.trim() ? <Markdown text={note.body} frontmatter={false} /> : <Text style={t.text.caption}>{N.emptyBody}</Text>}
        {editable ? (
          <View style={{ flexDirection: "row", gap: t.space.sm, flexWrap: "wrap", alignItems: "center" }}>
            <Button label={N.change} icon="Pencil" onPress={() => setEditing(true)} disabled={hidden} />
            {onCopy ? <Button label={N.copy} variant="ghost" onPress={onCopy} /> : null}
            {/* Last in the row, so its question opens below the everyday actions. */}
            <ConfirmLink label={N.remove} question={N.removeQuestion} yes={N.removeConfirm} no={N.keep} onConfirm={onRemove} />
          </View>
        ) : null}
      </View>
    </Card>
  );
}

function AddToFile({ busy, onAdd }: { busy: boolean; onAdd: (note: { title: string; body: string }) => Promise<boolean> }) {
  const t = useTokens();
  const N = PLAIN.notes;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  if (!open) {
    return (
      <View style={{ flexDirection: "row" }}>
        <Button label={N.addHere} icon="Plus" onPress={() => setOpen(true)} />
      </View>
    );
  }
  return (
    <Card>
      <View style={{ gap: t.space.sm }}>
        <Text style={t.text.section}>{N.addHere}</Text>
        <Field label={N.titleLabel} value={title} onChangeText={setTitle} placeholder="Invoices" />
        <MarkdownEditor label={N.textLabel} value={body} onChange={setBody} minHeight={140} frontmatter={false} placeholder="Invoices go out on the 1st of each month." />
        <View style={{ flexDirection: "row", gap: t.space.sm, flexWrap: "wrap" }}>
          <Button
            label={N.save}
            variant="primary"
            loading={busy}
            disabled={!title.trim() || !body.trim()}
            onPress={() =>
              void onAdd({ title: title.trim(), body }).then((ok) => {
                if (!ok) return;
                setTitle("");
                setBody("");
                setOpen(false);
              })
            }
          />
          <Button label={N.cancel} variant="ghost" onPress={() => setOpen(false)} />
        </View>
      </View>
    </Card>
  );
}

/**
 * An instruction file as note cards: each heading is a note with Change,
 * Remove and Copy to another agent, and "Add a note" at the end. Changes go
 * one section at a time (`sectionKey`), additions through the import path,
 * so the rest of the file stays as it was.
 */
function NoteCards({ hostId, source, workspaceId, onCopy }: { hostId: string; source: Source; workspaceId?: string; onCopy: Props["onCopy"] }) {
  const t = useTokens();
  const [revealed, setRevealed] = useState(false);
  const read = useRpc(entryBody);
  const write = useRpc(instructionWrite);
  const preview = useRpc(importPreview);
  const apply = useRpc(importApply);
  const invalidate = useInvalidate(hostId);
  const body = useQuery({
    queryKey: [KEY, hostId, "entry", source.id, "", revealed],
    queryFn: () => read({ sourceId: source.id, reveal: revealed, ...(workspaceId ? { workspaceId } : {}) }),
    enabled: source.exists,
    retry: 1,
    refetchOnMount: "always",
  });
  const [result, setResult] = useState<WriteResult | null>(null);
  const [busy, setBusy] = useState(false);
  // Codex's own notes are changed card by card too, through the guarded Codex save (whole file, lock and clean-up checks on the host).
  const codexNotes = source.kind === "codex-memory";
  const editable = source.access === "editable" && (NOTE_KINDS.has(source.kind) || codexNotes);
  const where = workspaceId ? { workspaceId } : {};
  const codexSave = useRpc(codexMemoryWrite);
  const [pending, setPending] = useState<(() => Promise<WriteResult>) | null>(null);
  const run = async (action: () => Promise<WriteResult>): Promise<boolean> => {
    setBusy(true);
    try {
      const outcome = await action();
      setResult(outcome);
      if (outcome.ok) await Promise.all([invalidate(), body.refetch()]);
      return outcome.ok;
    } catch (error) {
      setResult({ ok: false, message: plainError(error), reports: [], warnings: [] });
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (source.exists && !body.data) return <QueryState query={body} what="these notes" />;
  const text = body.data?.body ?? "";
  const stamp = body.data?.stamp;
  // A header (`paths:`, `applyTo:`) only in the kinds of file that have one.
  const cards = noteCards(text, { frontmatter: usesFrontmatter(source) });
  const refuse = (message: string): WriteResult => ({ ok: false, message, reports: [], warnings: [] });
  const add = (note: { title: string; body: string }) =>
    run(async () => {
      const item = { id: "new", title: note.title, body: note.body, masked: false, format: "note", warnings: [] };
      const target = { kind: "append", path: source.path, ...where };
      const seen = await preview({ items: [item], target });
      // Saved against the file as shown here (a newer file is refused), skipped when the same note is there.
      const plan = planCardAdd({ text: note.body, seen: stamp ?? null, preview: seen.items[0] ?? { duplicate: "none" } });
      if ("skip" in plan) return refuse(plan.skip);
      const outcome = await apply({ items: [item], target, selected: ["new"], expected: plan.expected });
      return plan.warning ? { ...outcome, warnings: [plan.warning, ...outcome.warnings] } : outcome;
    });
  /** Codex: the whole file with one section changed (or taken out), saved through the guarded Codex path; a pending clean-up asks first. */
  const viaCodex = (card: (typeof cards)[number], replacement: string | null) => {
    const section = splitSections(text).find((entry) => entry.key === card.key);
    if (!section) return run(async () => refuse("That part of the notes moved. Reload them; nothing was saved."));
    if (body.data?.masked) return run(async () => refuse(HIDDEN_TEXT));
    const whole = replacement === null ? removeSection(text, section) : replaceSection(text, section, replacement);
    const attempt = (confirm: boolean) => codexSave({ sourceId: source.id, text: whole, expected: stamp!, ...(confirm ? { confirmPending: true } : {}) });
    return run(async () => {
      const outcome = await attempt(false);
      setPending(outcome.needsConfirm ? () => () => attempt(true) : null);
      return outcome;
    });
  };
  const change = (card: (typeof cards)[number], next: { title: string; body: string }) =>
    hasHiddenText(`${next.title}\n${next.body}`)
      ? run(async () => refuse(HIDDEN_TEXT))
      : codexNotes
        ? viaCodex(card, cardReplacement(card, next))
        : run(async () => write({ path: source.path, ...where, text: cardReplacement(card, next), expected: stamp!, sectionKey: card.key }));
  return (
    <View style={{ gap: t.space.row }}>
      <RevealBar secrets={body.data?.secrets ?? 0} revealed={revealed} onReveal={setRevealed} />
      {!editable && cards.length ? <Text style={t.text.body}>{PLAIN.notes.readOnly}</Text> : null}
      {cards.length === 0 ? <Text style={t.text.body}>{PLAIN.notes.none}</Text> : null}
      {cards.map((card) => (
        <NoteCard
          key={`${card.key}:${card.original.length}`}
          note={card.note}
          editable={editable}
          hidden={hasHiddenText(card.original)}
          busy={busy}
          onSave={(next) => change(card, next)}
          onRemove={() => void (codexNotes ? viaCodex(card, cardRemoval(card).removeSection ? null : cardRemoval(card).text) : run(() => write({ path: source.path, ...where, expected: stamp!, sectionKey: card.key, ...cardRemoval(card) })))}
          {...(card.headless ? {} : { onCopy: () => onCopy([{ sourceId: source.id, key: card.key }]) })}
        />
      ))}
      {editable && !codexNotes ? <AddToFile busy={busy} onAdd={add} /> : null}
      {result ? <WriteReportView result={result} /> : null}
      {pending ? (
        <View style={{ flexDirection: "row" }}>
          <ConfirmButton
            label="Save anyway"
            confirmLabel="I understand: save it"
            variant="primary"
            onConfirm={() => {
              const again = pending;
              setPending(null);
              void run(again);
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------------ the pane

export function SourceDetail({ hostId, sourceId, workspaceId, entryKey, onOpenEntry, onCopy }: Props) {
  const t = useTokens();
  const plain = usePlain();
  const names = useSourceNames(hostId);
  const detail = useSourceDetail(hostId, sourceId, workspaceId);
  if (!detail.data) return <QueryState query={detail} what={plain ? "these notes" : "this source"} />;
  const { source, entries, index, warnings, codex, stamp } = detail.data;
  // Plain notes cards can also open the whole file (as before 0.5.0, now a fold-out row).
  const wholeFile = source.exists && source.kind !== "claude-auto-memory" && source.kind !== "paseo-prompt" && !source.isDirectory && source.access !== "online";
  const fileEditor = <FileEditor hostId={hostId} source={source} {...(workspaceId ? { workspaceId } : {})} {...(stamp ? { stamp } : {})} {...(codex ? { codexLock: codex } : {})} />;
  return (
    <View style={{ gap: t.space.row }}>
      <QueryState query={detail} what={plain ? "these notes" : "this source"} />
      {plain ? <PlainHeader source={source} name={names.name(source)} /> : <SourceHeader source={source} />}
      {plain ? <PlainNotices source={source} warnings={warnings} {...(codex ? { codex } : {})} /> : <Notes source={source} warnings={warnings} {...(codex ? { codex } : {})} />}
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
          {entries.length ? entries.map((entry, i) => <Row key={entry.key} first={i === 0} title={entry.title} meta={<Facts items={[{ value: plain ? plainWords(Math.ceil(entry.bytes / 4)) : formatBytes(entry.bytes) }]} />} />) : <Loading label="Empty folder" />}
        </Card>
      ) : source.access === "online" ? null : plain ? (
        <>
          <NoteCards hostId={hostId} source={source} {...(workspaceId ? { workspaceId } : {})} onCopy={onCopy} />
        </>
      ) : (
        <>
          {fileEditor}
          {source.exists && entries.length > 1 && source.access === "editable" ? (
            <View style={{ flexDirection: "row" }}>
              <Button label="Copy a section to another agent…" variant="ghost" onPress={() => onCopy(entries.map((entry) => ({ sourceId: source.id, key: entry.key })))} />
            </View>
          ) : null}
        </>
      )}
      {plain ? (
        // The technical parts of a set of notes, one press away: the whole file, and where it lives.
        <Accordion>
          {wholeFile ? (
            <AccordionItem icon="FileText" title={PLAIN.wholeFile} summary={PLAIN.wholeFileSummary}>
              {fileEditor}
            </AccordionItem>
          ) : null}
          {!source.path.startsWith("paseo:") && !source.path.startsWith("copilot:") ? (
            <AccordionItem icon="FolderOpen" title={PLAIN.whereSaved} summary={PLAIN.whereSavedSummary}>
              <PathText path={source.path} full />
            </AccordionItem>
          ) : null}
        </Accordion>
      ) : null}
      {!source.exists && source.kind === "claude-auto-memory" ? <Text style={t.text.caption}>{plain ? PLAIN.memory.firstNote : "This project has no Claude memory yet; the first memory you save creates the folder."}</Text> : null}
    </View>
  );
}
