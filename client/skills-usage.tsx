import { useRpc } from "@getpaseo/plugin/client";
import React, { useState } from "react";
import { Text, View } from "react-native";
import { plainError } from "../shared/errors";
import { skillsToggle } from "../shared/skill-contracts";
import { SKILLS_PLAIN as S, plainSkillMessage, plainWordsFromChars, sinceText } from "../shared/skills-plain";
import { QueryState } from "./data";
import { SkillsResult, type SkillsResultValue } from "./skills-report";
import { usePlain } from "./mode";
import { useSkillsInventory, useSkillsRefresh, useSkillsUsage } from "./skills-data";
import { Button, Card, Disclosure, Facts, Meta, Notice, Row, Segmented, useTokens } from "./ui";

/**
 * Which skills ran, and how often, over 7, 30 or 90 days: the busiest first,
 * each with a small strip of its days. Skills nobody used fold away at the
 * end with a way to turn each off. Claude's counts are exact, Codex's are
 * estimates, said once.
 */

type Days = "7" | "30" | "90";

/** One bar per day, as tall as that day's share of the busiest. */
function DayStrip({ perDay }: { perDay: number[] }) {
  const t = useTokens();
  const max = Math.max(1, ...perDay);
  return (
    <View accessible={false} style={{ flexDirection: "row", alignItems: "flex-end", gap: t.space.hair / 2, height: 20, maxWidth: 240 }}>
      {perDay.map((count, index) => (
        <View key={index} style={{ flex: 1, height: count ? Math.max(3, Math.round((count / max) * 20)) : 1, borderRadius: t.space.hair / 2, backgroundColor: count ? t.color.accent : t.color.border }} />
      ))}
    </View>
  );
}

export function SkillsUsage({ hostId, onOpen }: { hostId: string; onOpen: (skillId: string) => void }) {
  const t = useTokens();
  const plain = usePlain();
  const inventory = useSkillsInventory(hostId);
  const [days, setDays] = useState<Days>(String(inventory.data?.windowDays ?? 30) === "7" ? "7" : String(inventory.data?.windowDays ?? 30) === "90" ? "90" : "30");
  const usage = useSkillsUsage(hostId, Number(days));
  const toggle = useRpc(skillsToggle);
  const refresh = useSkillsRefresh(hostId);
  const [result, setResult] = useState<SkillsResultValue | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const U = S.usage;
  const data = usage.data;
  const state = data?.state.state;
  const turnOff = async (skillId: string) => {
    const skill = inventory.data?.skills.find((entry) => entry.id === skillId);
    if (!skill) return;
    setBusy(skillId);
    try {
      // Every agent's change listed together, place by place.
      const all: SkillsResultValue = { ok: true, message: "", reports: [], warnings: [] };
      for (const agent of skill.can.turnOff) {
        const done = await toggle({ skillId, agent, on: false });
        all.ok = all.ok && done.ok;
        all.message = all.message ? `${all.message} ${done.message}` : done.message;
        all.reports!.push(...done.reports);
        if (!done.ok) break;
      }
      setResult(all);
    } catch (error) {
      setResult({ ok: false, message: plainError(error) });
    } finally {
      setBusy(null);
      void refresh();
    }
  };
  return (
    <>
      <Segmented<Days> options={(["7", "30", "90"] as const).map((value) => ({ value, label: U.days(Number(value)) }))} value={days} onChange={setDays} />
      <QueryState query={usage} what="which skills ran" />
      {result ? <SkillsResult hostId={hostId} result={result} onDismiss={() => setResult(null)} /> : null}
      {data ? (
        <>
          <Meta>{state === "off" ? U.off : state === "waiting" || state === "checking" ? (data.state.asOf ? U.partial : U.waiting) : !data.state.complete ? U.partial : U.total(data.totals.uses, data.rows.length)}</Meta>
          {data.rows.length ? (
            <Card padded={false}>
              {data.rows.map((row, index) => (
                <Row
                  key={row.name}
                  first={index === 0}
                  {...(row.skillId ? { onPress: () => onOpen(row.skillId!) } : {})}
                  title={row.name}
                  meta={
                    <View style={{ gap: t.space.xs }}>
                      <DayStrip perDay={row.perDay} />
                      <Facts items={[{ value: U.by(row.claude, row.codex) }, row.typed ? { value: U.typed(row.typed) } : null, row.lastUsed ? { value: U.lastUsed(sinceText(row.lastUsed)) } : null]} />
                    </View>
                  }
                  trailing={<Text style={t.text.heading}>{String(row.total)}</Text>}
                />
              ))}
            </Card>
          ) : state === "ready" ? (
            <Text style={t.text.body}>{U.none(data.days)}</Text>
          ) : null}
          {data.neverUsed.length ? (
            <Disclosure quiet title={U.neverTitle(data.neverUsed.length)}>
              <Meta>{U.neverHint}</Meta>
              <Card padded={false}>
                {data.neverUsed.map((entry, index) => {
                  const skill = inventory.data?.skills.find((item) => item.id === entry.skillId);
                  const can = Boolean(skill?.can.turnOff.length) && !skill?.can.turnOff.every((agent) => skill.state[agent] === "off");
                  return (
                    <Row
                      key={entry.skillId}
                      first={index === 0}
                      title={entry.name}
                      meta={entry.listingChars ? <Meta>{plain ? plainWordsFromChars(entry.listingChars) : `${entry.listingChars} characters`}</Meta> : null}
                      trailing={can ? <Button label="Turn off" variant="ghost" loading={busy === entry.skillId} onPress={() => void turnOff(entry.skillId)} /> : <Button label={S.show} variant="ghost" onPress={() => onOpen(entry.skillId)} />}
                    />
                  );
                })}
              </Card>
            </Disclosure>
          ) : null}
          <Meta>{U.estimated}</Meta>
        </>
      ) : null}
    </>
  );
}
