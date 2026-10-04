/**
 * The page and sidebar entry use Paseo 0.11's native screens only when the
 * app has them; an older app (0.9/0.10) gets exactly the 0.2 registration.
 */
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { openFrom, registerMainScreen, sidebarItem, type SidebarRowComponent } from "../client/register";

const Page = (() => null) as unknown as React.ComponentType<never>;
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
