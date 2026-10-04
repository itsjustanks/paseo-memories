/**
 * The second page, Skills: registered beside Memories the same way (a native
 * screen and its own sidebar row with "+" on Paseo 0.11, a surface and
 * sidebar item before), and its place in the screen's params is opaque:
 * a tab, a host-made skill id, an Add mode; nothing else survives.
 */
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { registerMainScreen, sidebarItem, type MemoriesScreenProps, type SidebarRowComponent } from "../client/register";
import { skillsLanding, skillsParams, skillsScreenTitle } from "../client/skills-nav";

const Page = (_props: MemoriesScreenProps) => null;
const Row: SidebarRowComponent = () => null;
const Plus = () => null;
const memories = { id: "memories", title: "Memories", icon: "Brain", Component: Page, quickAdd: { label: "Add a note", Button: Plus, params: { add: "note" } } };
const skills = { id: "skills", title: "Skills", screenTitle: skillsScreenTitle, icon: "Sparkles", Component: Page, quickAdd: { label: "Add a skill", Button: Plus, params: { tab: "add" } } };

function client(modern: boolean) {
  const calls: Array<[string, unknown]> = [];
  const record = (name: string) => (input: unknown, second?: unknown) => (calls.push([name, second === undefined ? input : [input, second]]), () => undefined);
  return { calls, api: { addSurface: record("addSurface"), addSidebarItem: record("addSidebarItem"), openSurface: record("openSurface"), ...(modern ? { addScreen: record("addScreen"), openScreen: record("openScreen"), addSidebarHeaderItem: record("addSidebarHeaderItem") } : {}) } as never };
}

test("Paseo 0.11: two native screens, two sidebar rows, each with its own label and +", () => {
  const { calls, api } = client(true);
  registerMainScreen(api, memories, Row);
  registerMainScreen(api, skills, Row);
  assert.deepEqual(calls.map(([name, input]) => [name, (input as { id: string }).id]), [["addScreen", "memories"], ["addSidebarHeaderItem", "memories"], ["addScreen", "skills"], ["addSidebarHeaderItem", "skills"]]);
  const Item = sidebarItem(skills, Row);
  const element = (Item as (props: unknown) => React.ReactElement<{ label: string; icon: string; active: boolean; trailing: React.ReactElement<{ testID: string; label: string }> }>)({ currentScreen: { screenId: "skills", params: {} }, openScreen: () => undefined, openPopover: () => undefined, theme: { colors: {} } });
  assert.equal(element.props.label, "Skills");
  assert.equal(element.props.icon, "Sparkles");
  assert.equal(element.props.active, true);
  assert.equal(element.props.trailing.props.testID, "skills-sidebar-add");
  assert.equal(element.props.trailing.props.label, "Add a skill");
});

test("Paseo 0.8-0.10: two surfaces and two sidebar items, exactly the old API", () => {
  const { calls, api } = client(false);
  registerMainScreen(api, memories, Row);
  registerMainScreen(api, skills, Row);
  assert.deepEqual(calls, [
    ["addSurface", ["memories", Page]],
    ["addSidebarItem", { id: "memories", title: "Memories", icon: "Brain", surface: "memories" }],
    ["addSurface", ["skills", Page]],
    ["addSidebarItem", { id: "skills", title: "Skills", icon: "Sparkles", surface: "skills" }],
  ]);
});

test("Skills' place in the params: a tab, an opaque skill id, an Add mode, nothing else", () => {
  const id = `sk_${"a".repeat(24)}`;
  assert.deepEqual(skillsLanding({}), { tab: "overview" });
  assert.deepEqual(skillsLanding({ tab: "usage" }), { tab: "usage" });
  assert.deepEqual(skillsLanding({ skill: id }), { tab: "skills", skillId: id });
  assert.deepEqual(skillsLanding({ add: "github" }), { tab: "add", add: "github" });
  assert.deepEqual(skillsLanding({ tab: "nope", skill: "/Users/x/.agents/skills/a", add: "rm" }), { tab: "overview" }, "anything else is dropped");
  assert.deepEqual(skillsParams({ tab: "skills", skillId: id }), { tab: "skills", skill: id });
  assert.deepEqual(skillsParams({ tab: "overview" }), {});
  assert.equal(skillsScreenTitle({}), "Skills");
  assert.equal(skillsScreenTitle({ tab: "add" }), "Skills · Add a skill");
});
