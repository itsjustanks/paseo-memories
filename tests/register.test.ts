/**
 * The page and sidebar entry use Paseo 0.11's native screens only when the
 * app has them; an older app (0.8-0.10) gets exactly the 0.2 registration.
 * The sidebar's "+" opens Add a note in a popover, or on the page without one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { openFrom, registerMainScreen, sidebarItem, type MemoriesScreenProps, type SidebarRowComponent } from "../client/register";

const Page = (_props: MemoriesScreenProps) => null;
const screen = { id: "memories", title: "Memories", icon: "Brain", Component: Page };
const Row: SidebarRowComponent = () => null;

function fakeClient(modern: { screens?: boolean; sidebar?: boolean }) {
  const calls: Array<[string, unknown]> = [];
  const record = (name: string) => (input: unknown, second?: unknown) => {
    calls.push([name, second === undefined ? input : [input, second]]);
    return () => undefined;
  };
  const client = {
    addSurface: record("addSurface"),
    addSidebarItem: record("addSidebarItem"),
    openSurface: record("openSurface"),
    ...(modern.screens ? { addScreen: record("addScreen"), openScreen: record("openScreen") } : {}),
    ...(modern.sidebar ? { addSidebarHeaderItem: record("addSidebarHeaderItem") } : {}),
  };
  return { client: client as never, calls };
}

test("an app without native screens gets the surface and sidebar item, as in 0.2", () => {
  const { client, calls } = fakeClient({});
  const page = registerMainScreen(client, screen, Row);
  assert.deepEqual([page.screen, page.sidebar], ["surface", "legacy"]);
  assert.deepEqual(calls, [
    ["addSurface", ["memories", Page]],
    ["addSidebarItem", { id: "memories", title: "Memories", icon: "Brain", surface: "memories" }],
  ]);
  page.open("memories");
  assert.deepEqual(calls.at(-1), ["openSurface", "memories"]);
});

test("Paseo 0.11 gets a native screen with its title and the app's own sidebar row", () => {
  const { client, calls } = fakeClient({ screens: true, sidebar: true });
  const page = registerMainScreen(client, screen, Row);
  assert.deepEqual([page.screen, page.sidebar], ["native", "native"]);
  assert.deepEqual(calls[0], ["addScreen", { id: "memories", title: "Memories", Component: Page }]);
  assert.equal(calls[1]![0], "addSidebarHeaderItem");
  assert.ok(!calls.some(([name]) => name === "addSurface" || name === "addSidebarItem"));
  page.open("memories");
  assert.deepEqual(calls.at(-1), ["openScreen", { screenId: "memories" }]);
});

test("without the app's sidebar row, the native screen keeps the old sidebar item", () => {
  const { client, calls } = fakeClient({ screens: true, sidebar: true });
  const page = registerMainScreen(client, screen, undefined);
  assert.deepEqual([page.screen, page.sidebar], ["native", "legacy"]);
  assert.deepEqual(calls.map(([name]) => name), ["addScreen", "addSidebarItem"]);
});

test("the sidebar row is highlighted only while the page is open, and opens it", () => {
  const opened: unknown[] = [];
  const Item = sidebarItem(screen, Row) as unknown as (props: unknown) => React.ReactElement<{ icon: string; active: boolean; onPress(): void }>;
  const closed = Item({ currentScreen: null, openScreen: (input: unknown) => opened.push(input) });
  assert.equal(closed.type, Row);
  assert.equal(closed.props.icon, "Brain");
  assert.equal(closed.props.active, false);
  closed.props.onPress();
  assert.deepEqual(opened, [{ screenId: "memories" }]);
  assert.equal(Item({ currentScreen: { screenId: "memories", params: {} }, openScreen: () => undefined }).props.active, true);
});

test("commands open the page with openScreen where the app has it", () => {
  const seen: unknown[] = [];
  openFrom({ openSurface: (id) => seen.push(["surface", id]) }, "memories");
  openFrom({ openSurface: (id) => seen.push(["surface", id]), openScreen: (input) => seen.push(["screen", input]) }, "memories");
  assert.deepEqual(seen, [["surface", "memories"], ["screen", { screenId: "memories" }]]);
});

// ------------------------------------------------------------------ the sidebar "+"

const Popover = () => null;
const Plus = () => null;
const withPlus = { ...screen, screenTitle: (params: Record<string, string>) => (params.tab ? `Memories · ${params.tab}` : "Memories"), quickAdd: { label: "Add a note", Button: Plus, params: { add: "note" }, Popover } };
type RowElement = React.ReactElement<{ active: boolean; onPress(): void; trailing?: React.ReactElement<{ label: string; color: string; onPress(): void }> }>;
const theme = { colors: { foregroundMuted: "#636c76" } };

test("Paseo 0.11 (screens, header item, popover): the title follows params and every new API is used", () => {
  const { client, calls } = fakeClient({ screens: true, sidebar: true });
  const page = registerMainScreen(client, withPlus, Row);
  assert.deepEqual([page.screen, page.sidebar], ["native", "native"]);
  const added = calls[0]![1] as { title: (params: Record<string, string>) => string };
  assert.equal(typeof added.title, "function");
  assert.equal(added.title({ tab: "projects" }), "Memories · projects");
  page.open("memories", { tab: "user" });
  assert.deepEqual(calls.at(-1), ["openScreen", { screenId: "memories", params: { tab: "user" } }]);
});

test("the old sidebar item keeps a plain string title on Paseo 0.10", () => {
  const { client, calls } = fakeClient({});
  const page = registerMainScreen(client, withPlus, Row);
  assert.deepEqual(calls[1], ["addSidebarItem", { id: "memories", title: "Memories", icon: "Brain", surface: "memories" }]);
  page.open("memories", { tab: "user" });
  assert.deepEqual(calls.at(-1), ["openSurface", "memories"], "no params before 0.11");
});

test("the sidebar \"+\" opens Add a note in a popover where the app has popovers", () => {
  const Item = sidebarItem(withPlus, Row) as unknown as (props: unknown) => RowElement;
  const popovers: unknown[] = [];
  const opened: unknown[] = [];
  const row = Item({ theme, currentScreen: null, openScreen: (input: unknown) => opened.push(input), openPopover: (content: unknown) => popovers.push(content) });
  const plus = row.props.trailing!;
  assert.equal(plus.type, Plus);
  assert.equal(plus.props.label, "Add a note", "its accessibility label");
  assert.equal(plus.props.color, "#636c76", "colored from the theme");
  plus.props.onPress();
  assert.deepEqual(popovers, [Popover]);
  assert.deepEqual(opened, [], "the row's own press is separate");
  row.props.onPress();
  assert.deepEqual(opened, [{ screenId: "memories" }]);
});

test("without popovers, the \"+\" opens the page on Add a note", () => {
  const Item = sidebarItem(withPlus, Row) as unknown as (props: unknown) => RowElement;
  const opened: unknown[] = [];
  const row = Item({ theme, currentScreen: null, openScreen: (input: unknown) => opened.push(input) });
  row.props.trailing!.props.onPress();
  assert.deepEqual(opened, [{ screenId: "memories", params: { add: "note" } }]);
});

test("the row stays highlighted on any of the page's params", () => {
  const Item = sidebarItem(withPlus, Row) as unknown as (props: unknown) => RowElement;
  assert.equal(Item({ theme, currentScreen: { screenId: "memories", params: { tab: "projects" } }, openScreen: () => undefined }).props.active, true);
});
