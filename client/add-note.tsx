import { useRpc } from "@getpaseo/plugin/client";
import React, { useState } from "react";
import { Text, View } from "react-native";
import type { output as ZodOutput } from "zod";
import { noteAdd, notePreview, type WriteResult } from "../shared/contracts";
import { plainError } from "../shared/errors";
import { PLAIN, plainAgent } from "../shared/plain";
import { useInvalidate, useWorkspaceFolders } from "./data";
import { Button, Card, ErrorText, Field, Notice, Row, Segmented, Tag, useTokens } from "./ui";

/**
 * "Add a note": what to remember, who follows it, where. The host decides
 * which files that means (shared/notes.ts), shows them in plain words with a
 * duplicate check, and saves through the import path.
 */

type Preview = ZodOutput<(typeof notePreview)["output"]>;
type Who = "all" | "claude" | "codex";

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

export function AddNote({ hostId, workspaceId: initialWorkspace, onClose }: { hostId: string; workspaceId?: string; onClose: () => void }) {
  const t = useTokens();
  const previewRpc = useRpc(notePreview);
  const add = useRpc(noteAdd);
  const invalidate = useInvalidate(hostId);
  const folders = useWorkspaceFolders(hostId);
  // One row per project folder: a worktree's workspace and its project share notes.
  const workspaces = (folders.data ?? []).filter((entry, index, all) => entry.path && all.findIndex((other) => other.path === entry.path) === index);
  const [text, setText] = useState("");
  const [who, setWho] = useState<Who>("all");
  const [where, setWhere] = useState<"everywhere" | "project">(initialWorkspace ? "project" : "everywhere");
  const [workspaceId, setWorkspaceId] = useState(initialWorkspace ?? "");
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
      <Card>
        <View style={{ gap: t.space.md }}>
          <Text style={t.text.heading}>{A.title}</Text>
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

  const fresh = preview?.targets.filter((target) => target.duplicate !== "exact") ?? [];
  return (
    <Card>
      <View style={{ gap: t.space.md }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: t.space.sm }}>
          <Text style={[t.text.heading, { flexShrink: 1 }]}>{A.title}</Text>
          <Button label="Back" variant="ghost" onPress={onClose} />
        </View>
        {preview ? (
          <View style={{ gap: t.space.md }}>
            <Text style={t.text.bodyStrong}>{A.addsTo}</Text>
            <View style={{ gap: t.space.sm }}>
              {preview.targets.map((target) => (
                <View key={target.id} style={{ gap: 2 }}>
                  <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "center", flexWrap: "wrap" }}>
                    <Text style={[t.text.body, { flexShrink: 1 }]}>{`•  ${target.label}`}</Text>
                    {target.duplicate === "exact" ? <Tag label="Already there" tone="attention" /> : target.duplicate === "near" ? <Tag label="Almost the same is there" tone="attention" /> : null}
                  </View>
                  {target.duplicate === "exact" ? <Text style={t.text.caption}>{`${A.alreadyThere} ${target.label}.`}</Text> : null}
                  {target.duplicate === "near" && target.duplicateOf ? <Text style={t.text.caption}>{`${A.almostSame} "${target.duplicateOf}".`}</Text> : null}
                  {target.private ? <Text style={t.text.caption}>{A.privateNote}</Text> : null}
                  {target.creates ? <Text style={t.text.caption}>{A.creates}</Text> : null}
                  {target.warnings.map((warning) => (
                    <Text key={warning} style={[t.text.caption, { color: t.color.warning }]}>
                      {warning}
                    </Text>
                  ))}
                </View>
              ))}
              {preview.skipped.map((entry) => (
                <Text key={entry.agent} style={t.text.caption}>{entry.covered ? entry.reason : `${A.skipped} ${plainAgent(entry.agent)}: ${entry.reason}`}</Text>
              ))}
            </View>
            <View style={{ backgroundColor: t.color.surface2, borderRadius: t.radius.sm, padding: t.space.md }}>
              <Text style={t.text.body}>{text.trim()}</Text>
            </View>
            {preview.warnings.map((warning) => (
              <Notice key={warning} tone="error">
                {warning}
              </Notice>
            ))}
            {preview.targets.length > 0 && fresh.length === 0 ? <Text style={t.text.caption}>{A.nothingNew}</Text> : null}
            <View style={{ flexDirection: "row", gap: t.space.sm, flexWrap: "wrap" }}>
              <Button label={A.save} variant="primary" onPress={() => void save()} loading={busy === "save"} disabled={fresh.length === 0} />
              <Button label={A.edit} variant="ghost" onPress={() => setPreview(null)} />
            </View>
          </View>
        ) : (
          <View style={{ gap: t.space.md }}>
            <Field label={A.what} value={text} onChangeText={setText} multiline minHeight={120} placeholder={A.whatPlaceholder} autoFocus />
            <View style={{ gap: t.space.sm }}>
              <Text style={t.text.label}>{A.who}</Text>
              <Segmented options={[{ value: "all", label: A.whoAll }, { value: "claude", label: A.whoClaude }, { value: "codex", label: A.whoCodex }]} value={who} onChange={setWho} />
            </View>
            <View style={{ gap: t.space.sm }}>
              <Text style={t.text.label}>{A.where}</Text>
              <Segmented
                options={[{ value: "everywhere", label: A.everywhere }, { value: "project", label: A.onlyIn, disabled: workspaces.length === 0 }]}
                value={where}
                onChange={setWhere}
              />
              {where === "project" ? <ProjectPicker workspaces={workspaces} value={workspaceId} onChange={setWorkspaceId} /> : null}
              {workspaces.length === 0 && folders.data ? <Text style={t.text.caption}>{A.noProjects}</Text> : null}
            </View>
            <View style={{ flexDirection: "row" }}>
              <Button label={A.next} variant="primary" onPress={() => void check()} loading={busy === "check"} disabled={!ready} />
            </View>
          </View>
        )}
        {result && !result.ok ? <Notice tone="error">{result.message}</Notice> : null}
        {error ? <ErrorText>{error}</ErrorText> : null}
      </View>
    </Card>
  );
}
