import React from "react";
import { Text, View } from "react-native";
import type { WriteReport } from "../shared/contracts";
import { redactText } from "../shared/redact";
import { plainSkillMessage, reportLines, reportSummary } from "../shared/skills-plain";
import { usePlain } from "./mode";
import { useSkillsInventory } from "./skills-data";
import { Disclosure, Dot, Notice, PathText, useTokens } from "./ui";

/**
 * What a Skills change did, place by place (the per-target reports Memories
 * shows): which agents, accounts and files changed, and which didn't and
 * why. Plain: a count, the places folded behind "Show details" unless one
 * failed. Technical: every path, always.
 */

export type SkillsResultValue = { ok: boolean; message: string; warnings?: string[]; reports?: WriteReport[] };

export function SkillsResult({ hostId, result, onDismiss, children }: { hostId: string; result: SkillsResultValue; onDismiss?: () => void; children?: React.ReactNode }) {
  const t = useTokens();
  const plain = usePlain();
  const home = useSkillsInventory(hostId).data?.home ?? "";
  const lines = reportLines(result.reports ?? [], plain, home);
  const failed = lines.some((line) => !line.ok);
  const say = (text: string) => redactText(plain ? plainSkillMessage(text) : text);
  const list = (
    <View style={{ gap: t.space.xs }}>
      {lines.map((line, index) => (
        <View key={`${line.place}-${index}`} style={{ flexDirection: "row", alignItems: "flex-start", gap: t.space.sm }}>
          <View style={{ paddingTop: t.space.sm - t.space.hair }}>
            <Dot status={line.ok ? "ok" : "error"} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: t.space.hair }}>
            {plain ? <Text style={t.text.label}>{line.place}</Text> : <PathText path={line.place} style={t.text.mono} />}
            <Text style={t.text.caption}>{line.state}</Text>
          </View>
        </View>
      ))}
    </View>
  );
  return (
    <Notice tone={result.ok ? "ok" : failed && lines.some((line) => line.ok) ? "attention" : "error"} {...(onDismiss ? { onDismiss } : {})}>
      <View style={{ gap: t.space.sm }}>
        <Text style={t.text.bodyStrong}>{say(result.message)}</Text>
        {[...new Set((result.warnings ?? []).map(say))].map((warning) => (
          <Text key={warning} style={t.text.caption}>
            {warning}
          </Text>
        ))}
        {lines.length ? (
          plain && !failed ? (
            <Disclosure quiet title={`${reportSummary(lines)} Show details`}>
              {list}
            </Disclosure>
          ) : (
            <>
              {plain ? <Text style={t.text.caption}>{reportSummary(lines)}</Text> : null}
              {list}
            </>
          )
        ) : null}
        {children}
      </View>
    </Notice>
  );
}
