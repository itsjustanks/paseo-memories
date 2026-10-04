import React, { useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { PLAIN } from "../shared/plain";
import { Card, HostIcon, IconBadge, Link, NumberedStep, Tag, TYPE, useTokens } from "./ui";

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
function WhatIsCard({ agents }: { agents: readonly string[] }) {
  const t = useTokens();
  return (
    <Card title={A.whatIsTitle} icon="Brain">
      {A.whatIs.map((line) => (
        <Text key={line} style={t.text.body}>
          {line}
        </Text>
      ))}
      {agents.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm }}>
          <Text style={t.text.caption}>{A.agentsHere}</Text>
          {agents.map((name) => (
            <Tag key={name} label={name} tone="ok" />
          ))}
        </View>
      ) : null}
    </Card>
  );
}

function Arrow({ down }: { down: boolean }) {
  const t = useTokens();
  const glyph = HostIcon ? <HostIcon name={down ? "ArrowDown" : "ArrowRight"} size={20} color={t.color.muted} /> : <Text style={[t.text.lead, { color: t.color.muted }]}>{down ? "↓" : "→"}</Text>;
  return (
    <View accessible={false} style={down ? { width: 48, alignItems: "center", paddingVertical: 2 } : { paddingTop: 16, width: 24, alignItems: "center" }}>
      {glyph}
    </View>
  );
}

/** Four steps with icons and arrows: across on a wide screen, down on a narrow one. */
function HowItWorksCard() {
  const t = useTokens();
  const [width, onLayout] = useWidth();
  const stacked = width === null ? t.compact : width < FLOW_STACK_WIDTH;
  return (
    <Card title={A.howTitle} icon="Workflow">
      <View onLayout={onLayout} style={{ flexDirection: stacked ? "column" : "row", alignItems: stacked ? "stretch" : "flex-start" }}>
        {A.flow.map((step, index) => (
          <React.Fragment key={step.title}>
            {index > 0 ? <Arrow down={stacked} /> : null}
            {stacked ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
                <IconBadge name={step.icon} size={48} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text style={t.text.heading}>{`${index + 1}. ${step.title}`}</Text>
                  <Text style={t.text.body}>{step.text}</Text>
                </View>
              </View>
            ) : (
              <View style={{ flex: 1, minWidth: 0, alignItems: "center", gap: t.space.sm, paddingHorizontal: 4 }}>
                <IconBadge name={step.icon} size={52} />
                <Text style={[t.text.heading, { textAlign: "center" }]}>{`${index + 1}. ${step.title}`}</Text>
                <Text style={{ ...TYPE.secondary, color: t.color.fg, textAlign: "center" }}>{step.text}</Text>
              </View>
            )}
          </React.Fragment>
        ))}
      </View>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: t.space.md, padding: 14, borderRadius: t.radius.md, backgroundColor: t.color.accentSoft }}>
        {HostIcon ? (
          <View style={{ paddingTop: 3 }}>
            <HostIcon name="RotateCcw" size={18} color={t.color.accent} />
          </View>
        ) : null}
        <Text style={[t.text.body, { flex: 1, minWidth: 0 }]}>
          <Text style={{ fontWeight: "700" }}>{A.flowNoteBold}</Text>
          {A.flowNote}
        </Text>
      </View>
    </Card>
  );
}

/** Numbered steps for a first note, and where to see what one agent reads. */
function HowToUseCard({ onGuide }: { onGuide: () => void }) {
  const t = useTokens();
  return (
    <Card title={A.useTitle} icon="ListOrdered">
      {A.steps.map((step, index) => (
        <NumberedStep key={step} n={index + 1}>
          {step}
        </NumberedStep>
      ))}
      <View style={{ gap: 4, padding: 14, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.color.border, backgroundColor: t.color.surface0 }}>
        <Text style={t.text.heading}>{A.boxTitle}</Text>
        <Text style={t.text.body}>{A.boxText}</Text>
        <Link label={A.boxLink} accessibilityLabel="Open the Guide tab" onPress={onGuide} />
      </View>
    </Card>
  );
}

/** One plain line for each word the page uses, two across when there is room. */
function GlossaryCard() {
  const t = useTokens();
  return (
    <Card title={A.wordsTitle} icon="BookOpen">
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 24, rowGap: t.space.lg }}>
        {A.words.map((word) => (
          <View key={word.term} style={{ flexDirection: "row", alignItems: "flex-start", gap: t.space.md, flexBasis: 300, flexGrow: 1, flexShrink: 1 }}>
            <IconBadge name={word.icon} size={30} />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={t.text.heading}>{word.term}</Text>
              <Text style={t.text.body}>{word.text}</Text>
            </View>
          </View>
        ))}
      </View>
    </Card>
  );
}

/** The Overview's guide, top to bottom: what it is, how it works, how to use it, and the words. */
export function OverviewGuide({ agents, onGuide }: { agents: readonly string[]; onGuide: () => void }) {
  return (
    <>
      <WhatIsCard agents={agents} />
      <HowItWorksCard />
      <HowToUseCard onGuide={onGuide} />
      <GlossaryCard />
    </>
  );
}
