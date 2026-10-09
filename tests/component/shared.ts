/** What both component test files render: a Fix all group of three, and the pieces around it. */
import type { ReactTestRenderer } from "react-test-renderer";
import { flush, textOf } from "./harness";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// react-test-renderer still works on React 19 but says it's deprecated on every render; that line only.
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("react-test-renderer is deprecated")) return;
  consoleError(...args);
};

export async function load() {
  const React = (await import("react")).default;
  const { act, create } = await import("react-test-renderer");
  const ui = await import("../../client/ui");
  const { GroupedFindings } = await import("../../client/finding-groups");
  const theme = { colors: new Proxy({}, { get: () => "#336699" }) } as never;
  const t = ui.tokens(theme, false);
  const wrap = (child: React.ReactElement) => React.createElement(ui.TokensProvider, { value: t, children: child });
  const findings = ["a", "b", "c"].map((id) => ({ id, kind: "index-drift", group: "index-missing", severity: "warn", subject: `Note ${id}`, message: `note_${id}.md is not in MEMORY.md.`, action: { kind: "edit" } }));
  const fixAll = (onFixAll: (ids: string[]) => void) =>
    wrap(
      React.createElement(GroupedFindings<(typeof findings)[number]>, {
        page: "memories",
        findings,
        onFixAll: (_group, ids) => onFixAll(ids),
        renderRow: (finding) => React.createElement("Row", { key: finding.id }),
        itemName: (finding) => (finding.id === "c" ? "token=hunter22.zip" : finding.subject),
      }),
    );
  const render = async (element: React.ReactElement): Promise<ReactTestRenderer> => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(element);
      await flush();
    });
    return renderer;
  };
  const pressables = (renderer: ReactTestRenderer, label: string) => renderer.root.findAll((node) => (node.type as unknown) === "Pressable" && node.props.accessibilityLabel === label);
  /** Presses `times` times inside one act: no render in between, as a fast double press. */
  const press = async (renderer: ReactTestRenderer, label: string, times = 1) => {
    const [target] = pressables(renderer, label);
    if (!target) throw new Error(`No button "${label}" in: ${textOf(renderer.toJSON())}`);
    await act(async () => {
      for (let i = 0; i < times; i += 1) target.props.onPress();
      await flush();
    });
  };
  const dialogs = (renderer: ReactTestRenderer) => renderer.root.findAll((node) => (node.type as unknown) === "Dialog");
  const text = (renderer: ReactTestRenderer) => textOf(renderer.toJSON());
  const unmount = (renderer: ReactTestRenderer) => act(async () => renderer.unmount());
  return { React, act, ui, wrap, fixAll, render, press, pressables, dialogs, text, unmount };
}
