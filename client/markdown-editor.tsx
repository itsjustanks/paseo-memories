import React, { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View, type LayoutChangeEvent, type NativeSyntheticEvent, type TextInputKeyPressEventData, type TextInputSelectionChangeEventData } from "react-native";
import { applyFormat, type Format, type Selection } from "../shared/md-edit";
import { History } from "../shared/md-history";
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
/** The live preview waits this long after typing stops, and shows at most this much of the note. */
const PREVIEW_DELAY_MS = 200;
const PREVIEW_MAX = 100_000;
/** From this length the text box stops guessing the text direction on every key (web only). */
const LONG_TEXT = 20_000;

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
  // Where the cursor is, kept without re-drawing on every move; handed to the text box only after a button or Undo places it.
  const selectionRef = useRef<Selection>({ start: value.length, end: value.length });
  const [placed, setPlaced] = useState<Selection | undefined>(undefined);
  const selection = selectionRef.current;
  const setSelection = (next: Selection) => {
    selectionRef.current = next;
    setPlaced(next);
  };
  const [width, setWidth] = useState<number | null>(null);
  const [mode, setMode] = useState<"write" | "preview">("write");
  // One Undo step per change: button presses and typing (grouped by pauses and words).
  const history = useRef(new History());
  const [canUndo, setCanUndo] = useState(false);
  const wide = !raw && width !== null && width >= SIDE_BY_SIDE;
  // The preview follows the text a moment after typing stops, so a long note never slows typing down.
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (value === shown) return;
    const timer = setTimeout(() => setShown(value), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value]);
  const type = (next: string) => {
    history.current.typing(value, selectionRef.current, next, Date.now());
    setCanUndo(history.current.canUndo);
    onChange(next);
  };
  const format = (kind: Format) => {
    const edit = applyFormat(value, selectionRef.current, kind);
    history.current.button(value, selectionRef.current);
    setCanUndo(true);
    onChange(edit.text);
    setSelection(edit.selection);
  };
  const undo = () => {
    const last = history.current.undo(value);
    setCanUndo(history.current.canUndo);
    if (!last) return;
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
      onChangeText={type}
      {...(placed ? { selection: placed } : {})}
      onSelectionChange={(event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        selectionRef.current = event.nativeEvent.selection;
        // Placed once; from here the text box keeps its own cursor again.
        if (placed) setPlaced(undefined);
      }}
      onKeyPress={onKeyPress}
      placeholder={placeholder}
      placeholderTextColor={t.color.placeholder}
      // The web's automatic text direction re-reads the whole text on every key (about 270 ms at 150 KB); long notes get a fixed one.
      {...(Platform.OS === "web" && value.length > LONG_TEXT ? ({ dir: "ltr" } as object) : {})}
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
      {shown.trim() ? (
        <View style={{ gap: SPACE.sm }}>
          <Markdown text={shown.length > PREVIEW_MAX ? shown.slice(0, PREVIEW_MAX) : shown} frontmatter={frontmatter} limit={PREVIEW_MAX} />
          {shown.length > PREVIEW_MAX ? <Text style={t.text.caption}>{MD_EDITOR.previewStart}</Text> : null}
        </View>
      ) : (
        <Text style={t.text.caption}>{MD_EDITOR.nothingYet}</Text>
      )}
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
