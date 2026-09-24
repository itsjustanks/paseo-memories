import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import React, { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { output as ZodOutput } from "zod";
import { exportMemories, importApply, importParse, importPreview, type Account, type Source, type WriteResult } from "../shared/contracts";
import { plainError } from "../shared/errors";
import { formatBytes, plural } from "../shared/format";
import { folderName, targetTitle } from "../shared/labels";
import { moveBlocker, type ImportItem } from "../shared/transfer";
import { QueryState, WriteReportView, useInvalidate, useInventory } from "./data";
import type { Destination } from "./navigate";
import { Button, Card, CodeBlock, ComboBox, ErrorText, Field, Notice, Row, Section, Segmented, Tag, Toggle, copyToClipboard, useTokens, type Status } from "./ui";
import { canDownload, canPickFiles, downloadText, pickTextFiles } from "./web";

/**
 * Import & Export. Import: paste or pick files, read them into items, pick a
 * target, preview each item's diff and duplicate status, save the ticked
 * ones, read the report. Copy and move between agents use the same path with
 * existing entries instead of text. Export: a bundle or markdown, secrets
 * hidden unless asked for.
 */

type Preview = ZodOutput<(typeof importPreview)["output"]>;
type TargetKind = "claude-memory" | "append";

const DUPLICATE: Record<string, { label: string; tone: Status }> = {
  exact: { label: "Already there", tone: "attention" },
  near: { label: "Nearly the same is there", tone: "attention" },
  batch: { label: "Repeats another item here", tone: "attention" },
  none: { label: "New", tone: "ok" },
};

/** A switch with its words beside it (Toggle's own label is for screen readers). */
function LabelledToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (next: boolean) => void }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
      <Toggle label={label} value={value} onChange={onChange} />
      <Text style={[t.text.body, { flexShrink: 1 }]}>{label}</Text>
    </View>
  );
}

/** Targets as a short list: a friendly name first, the path underneath, a filter when there are many. */
function TargetPicker({ targets, accounts, value, onChange, hint }: { targets: Source[]; accounts: Account[]; value: string; onChange: (id: string) => void; hint: string }) {
  const t = useTokens();
  const title = (source: Source) => targetTitle(source, accounts.find((account) => account.id === source.accountId));
  const [filter, setFilter] = useState("");
  const shown = targets.filter((source) => !filter || `${title(source)} ${source.path}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 12);
  return (
    <View style={{ gap: t.space.sm }}>
      {targets.length > 8 ? <Field value={filter} onChangeText={setFilter} placeholder="Filter by project or file" /> : null}
      <Card padded={false}>
        {shown.length ? (
          shown.map((source, index) => (
            <Row key={source.id} first={index === 0} selected={source.id === value} title={title(source)} subtitle={source.path} onPress={() => onChange(source.id)} />
          ))
        ) : (
          <View style={{ padding: t.space.md }}>
            <Text style={t.text.caption}>{targets.length ? `None of the ${targets.length} places match "${filter}".` : "No place of this kind can take imports on this host."}</Text>
          </View>
        )}
      </Card>
      <Text style={t.text.caption}>{hint}</Text>
    </View>
  );
}

function DiffView({ lines }: { lines: Array<{ op: string; text: string }> }) {
  const t = useTokens();
  return (
    <View style={{ backgroundColor: t.color.surface2, borderRadius: t.radius.sm, padding: t.space.sm }}>
      {lines.map((line, index) => (
        <Text
          key={index}
          selectable
          style={[t.text.mono, { color: line.op === "+" ? t.color.success : line.op === "-" ? t.color.danger : t.color.muted }]}
        >
          {`${line.op === " " ? " " : line.op} ${line.text}`}
        </Text>
      ))}
    </View>
  );
}

function ImportPanel({ hostId, sources, accounts, destination }: { hostId: string; sources: Source[]; accounts: Account[]; destination: Destination | null }) {
  const t = useTokens();
  const parse = useRpc(importParse);
  const previewRpc = useRpc(importPreview);
  const apply = useRpc(importApply);
  const invalidate = useInvalidate(hostId);
  const [text, setText] = useState(destination?.text ?? "");
  const [files, setFiles] = useState<Array<{ name: string; text: string }>>([]);
  const [format, setFormat] = useState<"auto" | "markdown" | "claude-ai">("auto");
  const [items, setItems] = useState<ImportItem[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [from, setFrom] = useState(destination?.from ?? []);
  const [kind, setKind] = useState<TargetKind>((destination?.target?.kind as TargetKind) ?? "claude-memory");
  const [targetId, setTargetId] = useState(destination?.target?.sourceId ?? destination?.target?.path ?? "");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [move, setMove] = useState(false);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const targets = useMemo(
    () =>
      sources.filter((source) =>
        kind === "claude-memory"
          ? source.kind === "claude-auto-memory" && source.access === "editable"
          : source.access === "editable" && !source.isDirectory && ["claude-md", "claude-local", "claude-rule", "agents-md", "opencode-md", "pi-md", "omp-md", "copilot-md"].includes(source.kind),
      ),
    [sources, kind],
  );
  const target = targets.find((source) => source.id === targetId);
  // Move is offered only when every original can be removed (the host checks again).
  const moveBlocked = from.map((ref) => {
    const origin = sources.find((source) => source.id === ref.sourceId);
    return origin ? moveBlocker(origin, ref.key) : "the original is no longer listed";
  }).find(Boolean);
  useEffect(() => {
    if (moveBlocked) setMove(false);
  }, [moveBlocked]);
  const targetInput = target ? (kind === "claude-memory" ? { kind, sourceId: target.id } : { kind, path: target.path }) : null;
  const payload = from.length ? { from } : { items };

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(plainError(failure));
    } finally {
      setBusy("");
    }
  };
  const read = (thenPreview = false) =>
    run("read", async () => {
      const parsed = await parse({ ...(text.trim() ? { text } : {}), ...(files.length ? { files } : {}), format });
      setItems(parsed.items);
      setNotes([...parsed.formats.map((entry) => `${entry.name}: ${plural(entry.items, "item")} (${entry.format})`), ...parsed.warnings]);
      setFrom([]);
      setPreview(null);
      setResult(null);
      if (thenPreview && targetInput && parsed.items.length) {
        const next = await previewRpc({ items: parsed.items, target: targetInput });
        setPreview(next);
        setSelected(new Set(next.items.filter((item) => item.duplicate === "none").map((item) => item.id)));
      }
    });
  const showPreview = () =>
    run("preview", async () => {
      if (!targetInput) return;
      const next = await previewRpc({ ...payload, target: targetInput });
      setPreview(next);
      setSelected(new Set(next.items.filter((item) => item.duplicate === "none").map((item) => item.id)));
      setResult(null);
    });
  const save = () =>
    run("save", async () => {
      if (!targetInput || !preview) return;
      const outcome = await apply({ ...payload, target: targetInput, selected: [...selected], ...(kind === "append" ? { expected: preview.target.stamp } : {}), ...(from.length && move && !moveBlocked ? { move: true } : {}) });
      setResult(outcome);
      if (outcome.ok) {
        setPreview(null);
        await invalidate();
      }
    });

  useEffect(() => {
    if (destination?.text) void read(Boolean(destination.preview));
    else if (destination?.preview && targetInput && from.length) void showPreview();
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const count = from.length || items.length;
  return (
    <Section title="Import">
      <Card>
        <View style={{ gap: t.space.md }}>
          {from.length ? (
            <Notice tone="neutral">
              <View style={{ gap: t.space.sm }}>
                <Text style={t.text.body}>{`Copying ${plural(from.length, "entry", "entries")} you picked. Choose where they go, preview, then save.`}</Text>
                {moveBlocked ? (
                  <Text style={t.text.caption}>{`Move isn't available: ${moveBlocked}. They can be copied.`}</Text>
                ) : (
                  <LabelledToggle label="Move instead: remove the originals once the copies are saved" value={move} onChange={setMove} />
                )}
                <View style={{ flexDirection: "row" }}>
                  <Button label="Import text instead" variant="ghost" onPress={() => setFrom([])} />
                </View>
              </View>
            </Notice>
          ) : (
            <>
              <Text style={t.text.body}>Paste a bundle exported from here, markdown (split at its headings), a Claude memory file, claude.ai memory lines ("[date] - text") or a Cursor .mdc rule.</Text>
              <Field value={text} onChangeText={setText} multiline mono minHeight={140} placeholder="Paste here" />
              <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "center", flexWrap: "wrap" }}>
                <Segmented options={[{ value: "auto", label: "Work it out" }, { value: "markdown", label: "Markdown" }, { value: "claude-ai", label: "claude.ai lines" }]} value={format} onChange={setFormat} />
                {canPickFiles() ? <Button label={files.length ? `${plural(files.length, "file")} picked` : "Pick files…"} variant="ghost" onPress={() => void pickTextFiles().then(setFiles)} /> : null}
                <Button label="Read it" onPress={() => void read(false)} loading={busy === "read"} disabled={!text.trim() && !files.length} />
              </View>
              {notes.map((note) => (
                <Text key={note} style={t.text.caption}>
                  {note}
                </Text>
              ))}
            </>
          )}
          {count ? (
            <View style={{ gap: t.space.sm }}>
              <Text style={t.text.label}>WHERE TO</Text>
              <Segmented
                options={[{ value: "claude-memory", label: "New Claude memories" }, { value: "append", label: "Add to an instruction file" }]}
                value={kind}
                onChange={(value) => {
                  setKind(value);
                  setTargetId("");
                  setPreview(null);
                }}
              />
              <TargetPicker
                targets={targets}
                accounts={accounts}
                value={targetId}
                onChange={(value) => {
                  setTargetId(value);
                  setPreview(null);
                }}
                hint={kind === "append" ? "Each item is added as a section at the end. To copy into Codex, pick its AGENTS.md; Codex's generated memory is never a target." : "Each item becomes one memory file with its line in MEMORY.md."}
              />
              <View style={{ flexDirection: "row" }}>
                <Button label="Preview" onPress={() => void showPreview()} loading={busy === "preview"} disabled={!targetInput} />
              </View>
            </View>
          ) : null}
          {error ? <ErrorText>{error}</ErrorText> : null}
        </View>
      </Card>
      {preview ? (
        <View style={{ gap: t.space.md }}>
          <Text style={t.text.caption}>{preview.checked}</Text>
          {preview.target.access !== "editable" ? <Notice tone="error">{preview.target.reason ?? "That target is read-only."}</Notice> : null}
          {preview.items.map((item) => (
            <Card key={item.id}>
              <View style={{ gap: t.space.sm }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, flexWrap: "wrap" }}>
                  <Toggle
                    label={`Include "${item.title}"`}
                    value={selected.has(item.id)}
                    onChange={(on) => {
                      const next = new Set(selected);
                      if (on) next.add(item.id);
                      else next.delete(item.id);
                      setSelected(next);
                    }}
                  />
                  <Text style={[t.text.bodyStrong, { flexShrink: 1 }]}>{item.title}</Text>
                  <Tag label={DUPLICATE[item.duplicate]?.label ?? item.duplicate} tone={DUPLICATE[item.duplicate]?.tone ?? "neutral"} />
                  {item.masked ? <Tag label="Hidden values" tone="attention" /> : null}
                </View>
                <Text style={t.text.caption}>{item.action === "create" ? `New file ${item.fileName ?? ""}` : `Added to the end of ${preview.target.label}`}{item.duplicateOf ? `. Matches "${item.duplicateOf}".` : ""}</Text>
                {item.warnings.map((warning) => (
                  <Text key={warning} style={[t.text.caption, { color: t.color.warning }]}>
                    {warning}
                  </Text>
                ))}
                <DiffView lines={item.diff} />
              </View>
            </Card>
          ))}
          <View style={{ flexDirection: "row", gap: t.space.sm }}>
            <Button label={`Save ${plural(selected.size, "item")}`} variant="primary" onPress={() => void save()} loading={busy === "save"} disabled={!selected.size || preview.target.access !== "editable"} />
            <Button label="Cancel" variant="ghost" onPress={() => setPreview(null)} />
          </View>
        </View>
      ) : null}
      {result ? <WriteReportView result={result} /> : null}
    </Section>
  );
}

function ExportPanel({ sources, initial }: { sources: Source[]; initial?: boolean }) {
  const t = useTokens();
  const toast = useToast();
  const call = useRpc(exportMemories);
  const [scope, setScope] = useState<"all" | "user" | "project">("all");
  const [project, setProject] = useState("");
  const [format, setFormat] = useState<"bundle" | "markdown">("bundle");
  const [secrets, setSecrets] = useState(false);
  const [out, setOut] = useState<ZodOutput<(typeof exportMemories)["output"]> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const projects = useMemo(() => [...new Set(sources.map((source) => source.projectPath).filter((path): path is string => Boolean(path)))].sort(), [sources]);
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      setOut(await call({ selection: { scope, ...(scope === "project" && project ? { projectPath: project } : {}) }, format, ...(secrets ? { revealAll: true } : {}) }));
    } catch (failure) {
      setError(plainError(failure));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initial) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Section title="Export">
      <Card>
        <View style={{ gap: t.space.md }}>
          <Segmented options={[{ value: "all", label: "Everything" }, { value: "user", label: "User files" }, { value: "project", label: "One project" }]} value={scope} onChange={setScope} />
          {scope === "project" ? <ComboBox label="Project" value={project} allowCustom={false} onChange={setProject} options={projects.map((path) => ({ value: path, label: folderName(path), description: path }))} placeholder="Pick a project" /> : null}
          <Segmented options={[{ value: "bundle", label: "Bundle (to import elsewhere)" }, { value: "markdown", label: "Markdown (to read)" }]} value={format} onChange={setFormat} />
          <LabelledToggle label="Include values that look like secrets (off: they are hidden)" value={secrets} onChange={setSecrets} />
          <View style={{ flexDirection: "row" }}>
            <Button label="Export" onPress={() => void run()} loading={busy} disabled={scope === "project" && !project} />
          </View>
          {error ? <ErrorText>{error}</ErrorText> : null}
        </View>
      </Card>
      {out ? (
        <Card>
          <View style={{ gap: t.space.sm }}>
            <Text style={t.text.bodyStrong}>{`${plural(out.count, "item")} · ${formatBytes(out.text.length)}${out.masked ? ` · ${plural(out.masked, "item")} with hidden values` : ""}`}</Text>
            <View style={{ flexDirection: "row", gap: t.space.sm }}>
              <Button label="Copy" variant="primary" onPress={() => (copyToClipboard(out.text) ? toast.show("Copied the export.", { variant: "success" }) : toast.error("This app cannot copy; select the text instead."))} />
              {canDownload() ? <Button label={`Download ${out.fileName}`} variant="ghost" onPress={() => downloadText(out.fileName, out.text, format === "bundle" ? "application/json" : "text/markdown")} /> : null}
            </View>
            <CodeBlock copy={false}>{out.text.length > 6000 ? `${out.text.slice(0, 6000)}\n… ${formatBytes(out.text.length - 6000)} more` : out.text}</CodeBlock>
          </View>
        </Card>
      ) : null}
    </Section>
  );
}

export function TransferTab({ hostId, destination }: { hostId: string; destination: Destination | null }) {
  const t = useTokens();
  const inventory = useInventory(hostId);
  if (!inventory.data) return <QueryState query={inventory} what="where memories can go" />;
  return (
    <View style={{ gap: t.space.xl }}>
      <ImportPanel key={JSON.stringify(destination?.from ?? destination?.text ?? "")} hostId={hostId} sources={inventory.data.sources} accounts={inventory.data.accounts} destination={destination} />
      <ExportPanel sources={inventory.data.sources} {...(destination?.exportView ? { initial: true } : {})} />
    </View>
  );
}
