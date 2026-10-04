import React, { useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { PLAIN } from "../shared/plain";
import { Card, Disclosure, Divider, HostIcon, IconBadge, Link, Meta, NumberedStep, SectionTitle, TYPE, useTokens } from "./ui";

/**
 * The Overview's guide, in the order every plugin uses: what Memories is, how
 * it works, how to use it, and the words it uses. The words live in `PLAIN`,
 * so the jargon test reads them.
 */

const A = PLAIN.about;

/** Below this width the "How it works" steps stack top to bottom instead of left to right. */
const FLOW_STACK_WIDTH = 640;

/** The container's own width, so the flow follows a half-width window as well as a phone. Null until measured. */
function useWidth(): [number | null, (event: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState<number | null>(null);
  return [
    width,
    (event) => {
      const next = Math.round(event.nativeEvent.layout.width);
      if (next !== width) setWidth(next);
    },
  ];
}

/** "What is Memories?", with the agents that have notes on this computer when they are known. */
function WhatIs({ agents }: { agents: readonly string[] }) {
  const t = useTokens();
  return (
    <View style={{ gap: t.space.sm }}>
      <SectionTitle icon="Brain">{A.whatIsTitle}</SectionTitle>
      {A.whatIs.map((line) => (
        <Text key={line} style={t.text.body}>
          {line}
        </Text>
      ))}
      {agents.length ? <Meta>{`${A.agentsHere} ${agents.join(", ")}`}</Meta> : null}
    </View>
  );
}

function Arrow({ down }: { down: boolean }) {
  const t = useTokens();
  const glyph = HostIcon ? <HostIcon name={down ? "ArrowDown" : "ArrowRight"} size={18} color={t.color.muted} /> : <Text style={[t.text.lead, { color: t.color.muted }]}>{down ? "↓" : "→"}</Text>;
  return (
    <View accessible={false} style={down ? { width: 40, alignItems: "center", paddingVertical: t.space.hair } : { paddingTop: t.space.row, width: t.space.section, alignItems: "center" }}>
      {glyph}
    </View>
  );
}

/** Steps with icons and arrows: across on a wide screen, down on a narrow one. */
export function FlowSteps({ steps, note }: { steps: ReadonlyArray<{ icon: string; title: string; text: string }>; note?: React.ReactNode }) {
  const t = useTokens();
  const [width, onLayout] = useWidth();
  const stacked = width === null ? t.compact : width < FLOW_STACK_WIDTH;
  return (
    <>
      <View onLayout={onLayout} style={{ flexDirection: stacked ? "column" : "row", alignItems: stacked ? "stretch" : "flex-start" }}>
        {steps.map((step, index) => (
          <React.Fragment key={step.title}>
            {index > 0 ? <Arrow down={stacked} /> : null}
            {stacked ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.row }}>
                <IconBadge name={step.icon} size={40} />
                <View style={{ flex: 1, minWidth: 0, gap: t.space.hair }}>
                  <Text style={t.text.heading}>{`${index + 1}. ${step.title}`}</Text>
                  <Text style={t.text.body}>{step.text}</Text>
                </View>
              </View>
            ) : (
              <View style={{ flex: 1, minWidth: 0, alignItems: "center", gap: t.space.sm, paddingHorizontal: t.space.xs }}>
                <IconBadge name={step.icon} size={40} />
                <Text style={[t.text.heading, { textAlign: "center" }]}>{`${index + 1}. ${step.title}`}</Text>
                <Text style={{ ...TYPE.secondary, color: t.color.fg, textAlign: "center" }}>{step.text}</Text>
              </View>
            )}
          </React.Fragment>
        ))}
      </View>
      {note ? <Meta>{note}</Meta> : null}
    </>
  );
}

/** Four words with icons, two across when there is room. */
export function Glossary({ words }: { words: ReadonlyArray<{ icon: string; term: string; text: string }> }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: t.space.section, rowGap: t.space.row }}>
      {words.map((word) => (
        <View key={word.term} style={{ flexDirection: "row", alignItems: "flex-start", gap: t.space.row, flexBasis: 300, flexGrow: 1, flexShrink: 1 }}>
          <IconBadge name={word.icon} size={28} />
          <View style={{ flex: 1, minWidth: 0, gap: t.space.hair }}>
            <Text style={t.text.heading}>{word.term}</Text>
            <Text style={t.text.body}>{word.text}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * "New to Memories? How it works": one card, the parts split by rules: what
 * it is, how it works, how to use it, and the words. Open while nothing is
 * set up yet, folded once things work.
 */
export function OverviewGuide({ agents, onGuide, open }: { agents: readonly string[]; onGuide: () => void; open: boolean }) {
  const t = useTokens();
  return (
    <Disclosure title={A.newTo} open={open}>
      <Card>
        <WhatIs agents={agents} />
        <Divider />
        <View style={{ gap: t.space.row }}>
          <SectionTitle icon="Workflow">{A.howTitle}</SectionTitle>
          <FlowSteps steps={A.flow} note={`${A.flowNoteBold}${A.flowNote}`} />
        </View>
        <Divider />
        <View style={{ gap: t.space.row }}>
          <SectionTitle icon="ListOrdered">{A.useTitle}</SectionTitle>
          <Meta>{PLAIN.overview.primaryHint}</Meta>
          {A.steps.map((step, index) => (
            <NumberedStep key={step} n={index + 1}>
              {step}
            </NumberedStep>
          ))}
          <Text style={t.text.body}>{`${A.boxTitle} ${A.boxText}`}</Text>
          <Link label={A.boxLink} accessibilityLabel="Open the Guide tab" onPress={onGuide} />
        </View>
        <Divider />
        <View style={{ gap: t.space.row }}>
          <SectionTitle icon="BookOpen">{A.wordsTitle}</SectionTitle>
          <Glossary words={A.words} />
        </View>
      </Card>
    </Disclosure>
  );
}
