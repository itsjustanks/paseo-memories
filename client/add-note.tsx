import { Markdown } from "./markdown";
import { MarkdownEditor } from "./markdown-editor";
import { useRpc } from "@getpaseo/plugin/client";
import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { output as ZodOutput } from "zod";
import { noteAdd, notePreview, type WriteResult } from "../shared/contracts";
import { plainError } from "../shared/errors";
import { PLAIN, plainAgent } from "../shared/plain";
import { useInvalidate, useWorkspaceFolders } from "./data";
import type { DraftStore, Who } from "./note-draft";
import { Button, Card, ErrorText, Field, Notice, Row, Segmented, Tag, useTokens } from "./ui";

/**
 * "Add a note": what to remember, who follows it, where. The host decides
 * which files that means (shared/notes.ts), shows them in plain words with a
 * duplicate check, and saves through the import path.
 */

type Preview = ZodOutput<(typeof notePreview)["output"]>;

const A = PLAIN.addNote;

function ProjectPicker({ workspaces, value, onChange }: { workspaces: Array<{ id: string; name: string; path: string }>; value: string; onChange: (id: string) => void }) {
  const t = useTokens();
  const [filter, setFilter] = useState("");
  const shown = workspaces.filter((entry) => !filter || entry.name.toLowerCase().includes(filter.toLowerCase())).slice(0, 12);
  return (
    <View style={{ gap: t.space.sm }}>
      {workspaces.length > 8 ? <Field value={filter} onChangeText={setFilter} placeholder="Find a project" /> : null}
      <Card padded={false}>
        {shown.map((entry, index) => (
          <Row key={entry.id} first={index === 0} selected={entry.id === value} title={entry.name} onPress={() => onChange(entry.id)} />
        ))}
      </Card>
    </View>
  );
}

/**
 * `closeLabel`: "Back" on the page, "Close" in the sidebar popover. `draft`:
 * where unsaved text is kept (the popover's), so closing never loses it.
 */
export function AddNote({
  hostId,
  workspaceId: initialWorkspace,
  text: initialText,
  onClose,
  closeLabel = "Back",
  draft,
}: {
  hostId: string;
  workspaceId?: string;
  /** The note's text to start with ("/remember …" in a chat); wins over a kept draft. */
  text?: string;
  onClose: () => void;
  closeLabel?: "Back" | "Close";
  draft?: DraftStore;
}) {
  const [kept] = useState(() => draft?.read() ?? null);
  const t = useTokens();
  const previewRpc = useRpc(notePreview);
  const add = useRpc(noteAdd);
  const invalidate = useInvalidate(hostId);
  const folders = useWorkspaceFolders(hostId);
  // One row per project folder: a worktree's workspace and its project share notes.
  const workspaces = (folders.data ?? []).filter((entry, index, all) => entry.path && all.findIndex((other) => other.path === entry.path) === index);
  const [text, setText] = useState(initialText?.trim() ? initialText : (kept?.text ?? ""));
  const [who, setWho] = useState<Who>(kept?.who ?? "all");
  const [where, setWhere] = useState<"everywhere" | "project">(kept?.where ?? (initialWorkspace ? "project" : "everywhere"));
  const [workspaceId, setWorkspaceId] = useState(kept?.workspaceId ?? initialWorkspace ?? "");
  useEffect(() => draft?.write({ text, who, where, workspaceId }), [text, who, where, workspaceId]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const request = { text, who, ...(where === "project" && workspaceId ? { workspaceId } : {}) };
  const ready = text.trim().length > 0 && (where === "everywhere" || Boolean(workspaceId));

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
  const check = () =>
    run("check", async () => {
      setResult(null);
      setPreview(await previewRpc(request));
    });
  const save = () =>
    run("save", async () => {
      if (!preview) return;
      const outcome = await add({ ...request, expected: preview.targets.map((target) => ({ id: target.id, stamp: target.stamp })) });
      setResult(outcome);
      if (outcome.ok) {
        draft?.write(null);
        setPreview(null);
        await invalidate();
      }
    });
  const reset = () => {
    setText("");
    setPreview(null);
    setResult(null);
  };

  if (result?.ok) {
    return (
      <Card title={A.title} icon="CircleCheck" iconTone="ok">
        <View style={{ gap: t.space.row }}>
          <Notice tone="ok">
            <View style={{ gap: t.space.xs }}>
              <Text style={t.text.bodyStrong}>{result.message}</Text>
              {result.warnings.map((warning) => (
                <Text key={warning} style={t.text.caption}>
                  {warning}
                </Text>
              ))}
            </View>
          </Notice>
          <View style={{ flexDirection: "row", gap: t.space.sm, flexWrap: "wrap" }}>
            <Button label={A.again} variant="primary" onPress={reset} />
            <Button label="Done" variant="ghost" onPress={onClose} />
          </View>
        </View>
      </Card>
    );
  }

  // Saved on Save: places the agent reads the note from, without the same note already.
  const fresh = preview?.targets.filter((target) => !target.blocked && target.duplicate !== "exact") ?? [];
  return (
    <Card title={A.title} icon="NotebookPen" trailing={<Button label={closeLabel} icon={closeLabel === "Close" ? "X" : "ArrowLeft"} variant="ghost" onPress={onClose} />}>
      <View style={{ gap: t.space.row }}>
        {preview ? (
          <View style={{ gap: t.space.row }}>
            <Text style={t.text.heading}>{A.addsTo}</Text>
            <View style={{ gap: t.space.sm }}>
              {preview.targets.map((target) => (
                <View key={target.id} style={{ gap: t.space.hair }}>
                  <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "center", flexWrap: "wrap" }}>
                    <Text style={[t.text.body, { flexShrink: 1 }]}>{`•  ${target.label}`}</Text>
                    {target.blocked ? <Tag label={A.wontRead} tone="attention" /> : target.duplicate === "exact" ? <Tag label="Already there" tone="attention" /> : target.duplicate === "near" ? <Tag label="Almost the same is there" tone="attention" /> : null}
                  </View>
                  {target.blocked ? <Text style={[t.text.caption, { color: t.color.warning }]}>{target.blocked}</Text> : null}
                  {target.duplicate === "exact" ? <Text style={t.text.caption}>{`${A.alreadyThere} ${target.label}.`}</Text> : null}
                  {target.duplicate === "near" && target.duplicateOf ? <Text style={t.text.caption}>{`${A.almostSame} "${target.duplicateOf}".`}</Text> : null}
                  {target.private && !target.blocked ? <Text style={t.text.caption}>{A.privateNote}</Text> : null}
                  {target.creates ? <Text style={t.text.caption}>{A.creates}</Text> : null}
                  {(target.blocked ? [] : target.warnings).map((warning) => (
                    <Text key={warning} style={[t.text.caption, { color: t.color.warning }]}>
                      {warning}
                    </Text>
                  ))}
                </View>
              ))}
              {preview.skipped.map((entry) => (
                <Text key={entry.agent} style={t.text.body}>{entry.covered ? entry.reason : `${A.skipped} ${plainAgent(entry.agent)}: ${entry.reason}`}</Text>
              ))}
            </View>
            <View style={{ backgroundColor: t.color.surface2, borderRadius: t.radius.control, padding: t.space.row }}>
              <Markdown text={text.trim()} frontmatter={false} />
            </View>
            {preview.warnings.map((warning) => (
              <Notice key={warning} tone="error">
                {warning}
              </Notice>
            ))}
            {preview.targets.length > 0 && fresh.length === 0 ? <Text style={t.text.body}>{A.nothingNew}</Text> : null}
            <View style={{ flexDirection: "row", gap: t.space.sm, flexWrap: "wrap" }}>
              <Button label={A.save} variant="primary" onPress={() => void save()} loading={busy === "save"} disabled={fresh.length === 0} />
              <Button label={A.edit} variant="ghost" onPress={() => setPreview(null)} />
            </View>
          </View>
        ) : (
          <View style={{ gap: t.space.row }}>
            <MarkdownEditor label={A.what} value={text} onChange={setText} minHeight={140} frontmatter={false} placeholder={A.whatPlaceholder} autoFocus />
            <View style={{ gap: t.space.sm }}>
              <Text style={t.text.heading}>{A.who}</Text>
              <Segmented options={[{ value: "all", label: A.whoAll }, { value: "claude", label: A.whoClaude }, { value: "codex", label: A.whoCodex }]} value={who} onChange={setWho} />
            </View>
            <View style={{ gap: t.space.sm }}>
              <Text style={t.text.heading}>{A.where}</Text>
              <Segmented
                options={[{ value: "everywhere", label: A.everywhere }, { value: "project", label: A.onlyIn, disabled: workspaces.length === 0 }]}
                value={where}
                onChange={setWhere}
              />
              {where === "project" ? <ProjectPicker workspaces={workspaces} value={workspaceId} onChange={setWorkspaceId} /> : null}
              {workspaces.length === 0 && folders.data ? <Text style={t.text.caption}>{A.noProjects}</Text> : null}
            </View>
            <View style={{ flexDirection: "row" }}>
              <Button label={A.next} icon="Eye" variant="primary" onPress={() => void check()} loading={busy === "check"} disabled={!ready} />
            </View>
          </View>
        )}
        {result && !result.ok ? <Notice tone="error">{result.message}</Notice> : null}
        {error ? <ErrorText>{error}</ErrorText> : null}
      </View>
    </Card>
  );
}
