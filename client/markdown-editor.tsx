import React, { useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View, type LayoutChangeEvent, type NativeSyntheticEvent, type TextInputKeyPressEventData, type TextInputSelectionChangeEventData } from "react-native";
import { applyFormat, type Format, type Selection } from "../shared/md-edit";
import { MD_EDITOR } from "../shared/plain";
import { Markdown } from "./markdown";
import { HostIcon, RADIUS, SPACE, Segmented, TYPE, useTokens, wrapAnywhere } from "./ui";

/**
 * Editing a note with formatting buttons and a live preview. The buttons
 * only insert Markdown at the selection (shared/md-edit.ts): nothing else in
 * the note is rewritten, so a save changes only what you changed. With room
 * (the editor 600 px or wider, about a 900 px window): text and preview side
 * by side. Narrow: Write / Preview.
 * `raw` (the whole-file editor): monospaced, no buttons, the Preview toggle
 * only. Undo steps back through button presses. On the web, Cmd/Ctrl+B and
 * Cmd/Ctrl+I work too.
 */

/** Side by side when the editor itself has this much room (about a 900 px window with the list beside it). */
const SIDE_BY_SIDE = 600;

const BUTTONS: ReadonlyArray<{ format: Format; icon: string; label: string; short: string }> = [
  { format: "bold", icon: "Bold", label: MD_EDITOR.bold, short: "B" },
  { format: "italic", icon: "Italic", label: MD_EDITOR.italic, short: "I" },
  { format: "heading", icon: "Heading", label: MD_EDITOR.heading, short: "H" },
  { format: "bullets", icon: "List", label: MD_EDITOR.bullets, short: "•" },
  { format: "numbers", icon: "ListOrdered", label: MD_EDITOR.numbers, short: "1." },
  { format: "link", icon: "Link", label: MD_EDITOR.link, short: "↗" },
  { format: "code", icon: "Code", label: MD_EDITOR.code, short: "<>" },
];

function ToolButton({ icon, label, short, onPress, disabled }: { icon: string; label: string; short: string; onPress: () => void; disabled?: boolean }) {
  const t = useTokens();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={t.control.hit}
      // Keeps the text field's selection on the web: the button never takes focus.
      {...(Platform.OS === "web" ? ({ onMouseDown: (event: { preventDefault(): void }) => event.preventDefault() } as object) : {})}
      style={({ pressed }) => ({ minWidth: 34, height: 32, paddingHorizontal: SPACE.sm, borderRadius: RADIUS.control, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? t.color.surface2 : "transparent", opacity: disabled ? 0.4 : 1 })}
    >
      {HostIcon ? <HostIcon name={icon} size={16} color={t.color.fg} /> : <Text style={{ ...TYPE.secondary, fontWeight: "700", color: t.color.fg }}>{short}</Text>}
    </Pressable>
  );
}

export function MarkdownEditor({
  label,
  value,
  onChange,
  placeholder,
  minHeight = 200,
  raw,
  frontmatter = true,
  autoFocus,
}: {
  label?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  minHeight?: number;
  /** The whole-file editor: monospaced, no formatting buttons, Preview toggle only. */
  raw?: boolean;
  /** Hide a leading `---` header block in the preview. */
  frontmatter?: boolean;
  autoFocus?: boolean;
}) {
  const t = useTokens();
  const [selection, setSelection] = useState<Selection>({ start: value.length, end: value.length });
  const [width, setWidth] = useState<number | null>(null);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const history = useRef<Array<{ text: string; selection: Selection }>>([]);
  const [canUndo, setCanUndo] = useState(false);
  const wide = !raw && width !== null && width >= SIDE_BY_SIDE;
  const format = (kind: Format) => {
    const edit = applyFormat(value, selection, kind);
    history.current.push({ text: value, selection });
    if (history.current.length > 50) history.current.shift();
    setCanUndo(true);
    onChange(edit.text);
    setSelection(edit.selection);
  };
  const undo = () => {
    const last = history.current.pop();
    if (!last) return;
    setCanUndo(history.current.length > 0);
    onChange(last.text);
    setSelection(last.selection);
  };
  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next !== width) setWidth(next);
  };
  const onKeyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (raw || Platform.OS !== "web") return;
    const native = event.nativeEvent as TextInputKeyPressEventData & { metaKey?: boolean; ctrlKey?: boolean };
    if (!(native.metaKey || native.ctrlKey)) return;
    const key = native.key.toLowerCase();
    if (key !== "b" && key !== "i") return;
    (event as unknown as { preventDefault?: () => void }).preventDefault?.();
    format(key === "b" ? "bold" : "italic");
  };
  const input = (
    <TextInput
      value={value}
      onChangeText={onChange}
      selection={selection}
      onSelectionChange={(event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => setSelection(event.nativeEvent.selection)}
      onKeyPress={onKeyPress}
      placeholder={placeholder}
      placeholderTextColor={t.color.placeholder}
      accessibilityLabel={label ?? placeholder ?? MD_EDITOR.text}
      multiline
      autoFocus={autoFocus}
      autoCorrect={!raw}
      autoCapitalize={raw ? "none" : "sentences"}
      spellCheck={!raw}
      style={{
        flex: 1,
        minWidth: 0,
        borderWidth: 1,
        borderColor: t.color.border,
        borderRadius: RADIUS.control,
        backgroundColor: t.color.surface0,
        paddingVertical: SPACE.sm + SPACE.hair,
        paddingHorizontal: SPACE.row,
        color: t.color.fg,
        minHeight,
        textAlignVertical: "top",
        ...(raw ? { fontFamily: t.text.mono.fontFamily, fontSize: TYPE.mono.fontSize, lineHeight: TYPE.mono.lineHeight } : { fontSize: TYPE.body.fontSize, lineHeight: TYPE.body.lineHeight }),
        ...wrapAnywhere,
        ...(Platform.OS === "web" ? ({ whiteSpace: "pre-wrap" } as object) : {}),
      }}
    />
  );
  const preview = (
    <View style={{ flex: 1, minWidth: 0, minHeight, borderWidth: 1, borderColor: t.color.borderSubtle, borderRadius: RADIUS.control, padding: SPACE.row, backgroundColor: t.color.surface1 }}>
      {value.trim() ? <Markdown text={value} frontmatter={frontmatter} /> : <Text style={t.text.caption}>{MD_EDITOR.nothingYet}</Text>}
    </View>
  );
  return (
    <View onLayout={onLayout} style={{ gap: SPACE.sm }}>
      {label ? <Text style={t.text.label}>{label}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACE.xs }}>
        {!raw && (wide || mode === "write") ? (
          <View accessibilityRole="toolbar" accessibilityLabel={MD_EDITOR.toolbar} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACE.hair, flexGrow: 1 }}>
            {BUTTONS.map((button) => (
              <ToolButton key={button.format} icon={button.icon} label={button.label} short={button.short} onPress={() => format(button.format)} />
            ))}
            <ToolButton icon="Undo2" label={MD_EDITOR.undo} short="↶" onPress={undo} disabled={!canUndo} />
          </View>
        ) : (
          <View style={{ flexGrow: 1 }} />
        )}
        {wide ? null : (
          <Segmented<"write" | "preview">
            options={[
              { value: "write", label: MD_EDITOR.write },
              { value: "preview", label: MD_EDITOR.preview },
            ]}
            value={mode}
            onChange={setMode}
          />
        )}
      </View>
      {wide ? (
        <View style={{ flexDirection: "row", gap: SPACE.row, alignItems: "stretch" }}>
          {input}
          {preview}
        </View>
      ) : mode === "write" ? (
        input
      ) : (
        preview
      )}
    </View>
  );
}
