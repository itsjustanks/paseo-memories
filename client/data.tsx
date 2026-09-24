import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import React from "react";
import { Text, View } from "react-native";
import { findings, inventory, sourceDetail, type WriteResult } from "../shared/contracts";
import { plainError } from "../shared/errors";
import { PLAIN, plainMessage } from "../shared/plain";
import { clockTime } from "../shared/schedule";
import { usePlain } from "./plain-context";
import { ErrorText, Loading, Notice, StaleNote, Tag, useTokens } from "./ui";

/**
 * Shared queries and the three states every view has: loading, error, and
 * "as of HH:MM" when a refresh failed but earlier data is still on screen.
 * The host turns refetch-on-mount off, so every visit asks again.
 */

export const KEY = "paseo-memories";

export function useInventory(hostId: string) {
  const call = useRpc(inventory);
  return useQuery({ queryKey: [KEY, hostId, "inventory"], queryFn: () => call({}), retry: 1, refetchOnMount: "always" });
}

export function useFindings(hostId: string) {
  const call = useRpc(findings);
  return useQuery({
    queryKey: [KEY, hostId, "findings"],
    queryFn: () => call({}),
    retry: 1,
    refetchOnMount: "always",
    // While the code-name scan runs in the background, look again shortly.
    refetchInterval: (query) => (query.state.data?.symbolScan.state === "running" ? 5_000 : false),
  });
}

export function useSourceDetail(hostId: string, sourceId: string | null, workspaceId?: string) {
  const call = useRpc(sourceDetail);
  return useQuery({
    queryKey: [KEY, hostId, "source", sourceId, workspaceId ?? ""],
    queryFn: () => call({ sourceId: sourceId!, ...(workspaceId ? { workspaceId } : {}) }),
    enabled: Boolean(sourceId),
    retry: 1,
    refetchOnMount: "always",
  });
}

/** Folders Paseo knows as workspaces, so they list before "other projects". */
export function useWorkspaceFolders(hostId: string) {
  const paseo = usePaseo();
  return useQuery({
    queryKey: [KEY, hostId, "workspace-folders"],
    queryFn: async () => {
      const result = (await paseo.workspaces.list()) as unknown as { entries?: Array<{ id: string; name: string; workspaceDirectory?: string; projectRootPath?: string }> };
      return (result.entries ?? []).map((entry) => ({ id: entry.id, name: entry.name, path: entry.workspaceDirectory || entry.projectRootPath || "" }));
    },
    retry: 1,
    refetchOnMount: "always",
  });
}

/** After any save: everything that shows files is out of date. */
export function useInvalidate(hostId: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: [KEY, hostId] });
}

/** Loading, a first-load error, or a stale-but-shown note; renders nothing once data is fresh. */
export function QueryState({ query, what, empty }: { query: UseQueryResult<unknown>; what: string; empty?: boolean }) {
  if (query.isLoading) return <Loading label={`Reading ${what}`} />;
  if (query.error && !query.data) return <ErrorText>{plainError(query.error)}</ErrorText>;
  if (query.error && query.data) {
    return <StaleNote what={what} at={clockTime(new Date(query.dataUpdatedAt).toISOString())} reason={plainError(query.error)} onRetry={() => void query.refetch()} />;
  }
  void empty;
  return null;
}

/** What a save did, per file: backup, read-back, errors. */
export function WriteReportView({ result }: { result: WriteResult }) {
  const t = useTokens();
  const plain = usePlain();
  if (plain) {
    // The outcome in plain words; what was written where stays under technical details.
    return (
      <Notice tone={result.ok ? "ok" : result.needsConfirm ? "attention" : "error"}>
        <View style={{ gap: t.space.xs }}>
          <Text style={t.text.bodyStrong}>{plainMessage(result.message)}</Text>
          {[...new Set(result.warnings.map(plainMessage))].map((warning) => (
            <Text key={warning} style={t.text.caption}>
              {warning}
            </Text>
          ))}
          {result.ok && result.reports.some((report) => report.backupPath) ? <Text style={t.text.caption}>{PLAIN.backupNote}</Text> : null}
        </View>
      </Notice>
    );
  }
  return (
    <Notice tone={result.ok ? "ok" : result.needsConfirm ? "attention" : "error"}>
      <View style={{ gap: t.space.xs }}>
        <Text style={t.text.bodyStrong}>{result.message}</Text>
        {result.warnings.map((warning) => (
          <Text key={warning} style={t.text.caption}>
            {warning}
          </Text>
        ))}
        {result.reports.map((report, index) => (
          <View key={`${report.target}-${index}`} style={{ gap: 2 }}>
            <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "center", flexWrap: "wrap" }}>
              <Tag label={report.ok ? report.action : "failed"} tone={report.ok ? "ok" : "error"} />
              <Text style={[t.text.mono, { flexShrink: 1 }]}>{report.target}</Text>
            </View>
            <Text style={t.text.caption}>
              {[
                report.readBack === "ok" ? "Read back and checked." : report.readBack === "mismatch" ? "Read back differently from what was written." : "",
                report.backupPath ? `Backup: ${report.backupPath}` : report.action === "created" ? "New file, nothing to back up." : "",
                report.versionControlled ? "In a git repository." : "",
                report.error ?? "",
              ]
                .filter(Boolean)
                .join(" ")}
            </Text>
          </View>
        ))}
      </View>
    </Notice>
  );
}
