import React, { useMemo } from "react";
import { Text, View, type TextStyle } from "react-native";
import { parseInline, parseMarkdown, type Block, type Inline } from "../shared/md-parse";
import { MD_EDITOR } from "../shared/plain";
import { openLink } from "./links";
import { HostIcon, TYPE, useTokens, wrapAnywhere } from "./ui";

/**
 * Notes shown the way they are meant to read: headings, emphasis, lists,
 * code, quotes, links and tables, drawn with React Native views (the same on
 * web and mobile), on the shared type scale. Code and tables wrap: nothing
 * scrolls sideways. HTML is never rendered (it shows as text). Display only:
 * the note's text is passed through untouched, so hidden values stay hidden.
 */

type Style = TextStyle;

function Runs({ nodes, style }: { nodes: readonly Inline[]; style: Style }) {
  const t = useTokens();
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.t) {
          case "text":
            return node.v;
          case "br":
            return "\n";
          case "code":
            return (
              <Text key={index} style={{ ...TYPE.mono, fontSize: (style.fontSize ?? 15) - 1, color: t.color.fg, backgroundColor: t.color.surface2, ...wrapAnywhere }}>
                {node.v}
              </Text>
            );
          case "strong":
            return (
              <Text key={index} style={{ fontWeight: "700" }}>
                <Runs nodes={node.c} style={style} />
              </Text>
            );
          case "em":
            return (
              <Text key={index} style={{ fontStyle: "italic" }}>
                <Runs nodes={node.c} style={style} />
              </Text>
            );
          case "del":
            return (
              <Text key={index} style={{ textDecorationLine: "line-through" }}>
                <Runs nodes={node.c} style={style} />
              </Text>
            );
          case "link":
            return (
              <Text key={index} accessibilityRole="link" onPress={() => void openLink(node.href)} style={{ color: t.color.accent, textDecorationLine: "underline" }}>
                <Runs nodes={node.c} style={style} />
              </Text>
            );
        }
      })}
    </>
  );
}

function Paragraph({ nodes, style }: { nodes: readonly Inline[]; style: Style }) {
  return (
    <Text style={[style, wrapAnywhere]}>
      <Runs nodes={nodes} style={style} />
    </Text>
  );
}

function headingStyle(level: number, t: ReturnType<typeof useTokens>): Style {
  if (level === 1) return t.text.display;
  if (level === 2) return t.text.section;
  return t.text.heading;
}

function ListView({ block, depth }: { block: Extract<Block, { t: "list" }>; depth: number }) {
  const t = useTokens();
  return (
    <View style={{ gap: t.space.xs }}>
      {block.items.map((item, index) => (
        <View key={index} style={{ flexDirection: "row", alignItems: "flex-start", gap: t.space.sm }}>
          <View style={{ minWidth: block.ordered ? 22 : 14, alignItems: "flex-end", paddingTop: item.task ? t.space.hair : 0 }}>
            {item.task ? (
              HostIcon ? (
                <HostIcon name={item.checked ? "SquareCheck" : "Square"} size={16} color={item.checked ? t.color.accent : t.color.muted} />
              ) : (
                <Text style={t.text.body}>{item.checked ? "☑" : "☐"}</Text>
              )
            ) : (
              <Text style={[t.text.body, { color: t.color.muted }]}>{block.ordered ? `${block.start + index}.` : depth % 2 ? "◦" : "•"}</Text>
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: t.space.xs }}>
            <Blocks blocks={item.blocks} depth={depth + 1} {...(item.task && item.checked ? { done: true } : {})} />
          </View>
        </View>
      ))}
    </View>
  );
}

function TableView({ block }: { block: Extract<Block, { t: "table" }> }) {
  const t = useTokens();
  const align = (index: number): TextStyle => ({ textAlign: block.align[index] ?? "left" });
  const row = (cells: Inline[][], head: boolean, key: string | number) => (
    <View key={key} style={{ flexDirection: "row", borderTopWidth: head ? 0 : 1, borderTopColor: t.color.borderSubtle, backgroundColor: head ? t.color.surface2 : "transparent" }}>
      {block.head.map((_, index) => (
        <View key={index} style={{ flex: 1, minWidth: 0, padding: t.space.sm }}>
          <Text style={[head ? t.text.label : { ...TYPE.secondary, color: t.color.fg }, align(index), wrapAnywhere]}>
            <Runs nodes={cells[index] ?? []} style={TYPE.secondary} />
          </Text>
        </View>
      ))}
    </View>
  );
  return (
    <View style={{ gap: t.space.xs }}>
      <View style={{ borderWidth: 1, borderColor: t.color.border, borderRadius: t.radius.control, overflow: "hidden" }}>
        {row(block.head, true, "head")}
        {block.rows.map((cells, index) => row(cells, false, index))}
      </View>
      {block.more ? <Text style={t.text.caption}>{`${block.more.toLocaleString("en-US")} more rows not shown.`}</Text> : null}
    </View>
  );
}

function Blocks({ blocks, depth, done }: { blocks: readonly Block[]; depth: number; done?: boolean }) {
  const t = useTokens();
  const body: Style = done ? { ...t.text.body, color: t.color.muted, textDecorationLine: "line-through" } : t.text.body;
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.t) {
          case "heading":
            return <Paragraph key={index} nodes={block.c} style={{ ...headingStyle(block.level, t), ...(index > 0 ? { marginTop: t.space.xs } : {}) }} />;
          case "paragraph":
            return <Paragraph key={index} nodes={block.c} style={body} />;
          case "code":
            return (
              <View key={index} style={{ backgroundColor: t.color.surface2, borderRadius: t.radius.control, padding: t.space.row }}>
                <Text style={[t.text.mono, wrapAnywhere]}>{block.v}</Text>
              </View>
            );
          case "quote":
            return (
              <View key={index} style={{ borderLeftWidth: 3, borderLeftColor: t.color.accentLine, paddingLeft: t.space.row, gap: t.space.sm }}>
                <Blocks blocks={block.blocks} depth={depth + 1} />
              </View>
            );
          case "list":
            return <ListView key={index} block={block} depth={depth} />;
          case "table":
            return <TableView key={index} block={block} />;
          case "rule":
            return <View key={index} style={{ height: 1, backgroundColor: t.color.border, marginVertical: t.space.xs }} />;
        }
      })}
    </>
  );
}

/** How much of a note a view draws; a longer note shows its start and says so (the editor and the whole file have all of it). */
export const DISPLAY_MAX = 200_000;

/** A note's text, rendered. `frontmatter: false` shows a leading `---` block as text (for files that don't use one). */
function MarkdownView({ text, frontmatter = true, limit = DISPLAY_MAX }: { text: string; frontmatter?: boolean; limit?: number }) {
  const t = useTokens();
  const cut = text.length > limit;
  const blocks = useMemo(() => parseMarkdown(cut ? text.slice(0, limit) : text, { frontmatter }), [text, frontmatter, limit]);
  return (
    <View style={{ gap: t.space.sm, minWidth: 0 }}>
      {blocks.length ? <Blocks blocks={blocks} depth={0} /> : null}
      {cut ? <Text style={t.text.caption}>{MD_EDITOR.displayStart}</Text> : null}
    </View>
  );
}

/** Drawn again only when its text changes: typing in the editor beside it never re-draws a long preview. */
export const Markdown = React.memo(MarkdownView);

/** One line of text with its inline formatting (bold, code, links), for snippets and titles. */
export function MarkdownLine({ text, style, lines }: { text: string; style?: Style; lines?: number }) {
  const t = useTokens();
  const nodes = useMemo(() => parseInline(text.replace(/\s*\n\s*/g, " ")), [text]);
  const base = style ?? t.text.caption;
  return (
    <Text numberOfLines={lines} style={[base, wrapAnywhere]}>
      <Runs nodes={nodes} style={base} />
    </Text>
  );
}

