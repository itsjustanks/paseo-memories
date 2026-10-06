/**
 * 0.5.0: four tabs per screen, grouped by what people come to do, old tab ids
 * still landing (Guide → Help; Import & Export and Add a skill as pages under
 * a tab), Help's questions and fold-outs in plain words, and the sidebar dot
 * in place of anything in the composer.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PLAIN_GUIDES } from "../shared/guides";
import { PLAIN, jargonIn } from "../shared/plain";
import { SKILL_HOW_TOS, SKILL_TABS, SKILLS_PLAIN, skillLitTab, skillPageFor } from "../shared/skills-plain";
import { sidebarToneFrom } from "../client/freshness";
import { fromScreenParams, moveToTab, normalised, screenTitle, toScreenParams } from "../client/navigate";
import { sidebarItem, SIDEBAR_DOT_LABEL, type SidebarParts, type SidebarRowComponent } from "../client/register";
import { reportSidebarStatus, sidebarStatus } from "../client/sidebar-status";
import { normalSkillsPlace, skillsLanding, skillsParams, skillsScreenTitle } from "../client/skills-nav";
import { LEGACY_TABS, TABS, litTab, pageFor } from "../client/tabs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const strings = (value: unknown): string[] => (typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : []);

// ------------------------------------------------------------------ Memories

test("Memories: four tabs, Overview first and Help last; Import & Export is not a tab", () => {
  assert.deepEqual(TABS.map((tab) => tab.id), ["overview", "user", "projects", "help"]);
  assert.deepEqual(TABS.map((tab) => PLAIN.tabLabels[tab.id]), ["Overview", "Everywhere", "Projects", "Help"]);
  assert.ok(TABS.length <= 4);
});

test("Memories: old tab ids still land, new ones round-trip", () => {
  assert.equal(pageFor("guide"), "help", "the old Guide is Help");
  assert.equal(LEGACY_TABS.guide, "help");
  for (const id of ["overview", "user", "projects", "help", "transfer"]) assert.equal(pageFor(id), id);
  assert.equal(pageFor("nonsense"), undefined);
  assert.equal(pageFor(undefined), undefined);
  assert.deepEqual(fromScreenParams({ tab: "guide" }), { tab: "help" }, "a saved link to the Guide opens Help");
  assert.deepEqual(fromScreenParams({ tab: "transfer" }), { tab: "transfer" }, "a link to Import & Export still opens it");
  assert.deepEqual(fromScreenParams({ tab: "nonsense" }), {}, "an unknown tab lands on the Overview");
  assert.deepEqual(toScreenParams({ tab: "help" }), { tab: "help" });
  assert.equal(screenTitle({ tab: "guide" }), "Memories · Help");
  assert.equal(screenTitle({ tab: "transfer" }), "Memories · Import & Export");
  assert.equal(screenTitle({ tab: "user" }), "Memories · Everywhere");
  // Handed over in memory (a caller still using the old id), not only in params.
  const old = { tab: "guide" } as unknown as Parameters<typeof normalised>[0];
  assert.deepEqual(normalised(old), { tab: "help" });
  assert.deepEqual(toScreenParams(old), { tab: "help" });
  assert.deepEqual(normalised({ tab: "nonsense", sourceId: "s" } as unknown as Parameters<typeof normalised>[0]), { sourceId: "s" });
});

test("Memories: Import & Export keeps the tab it was opened from lit", () => {
  assert.equal(litTab("transfer", "projects"), "projects");
  assert.equal(litTab("transfer", "user"), "user");
  assert.equal(litTab("transfer", null), "user", "from Help, a command or a link: Everywhere");
  assert.equal(litTab("help", "projects"), "help");
  assert.equal(moveToTab({ tab: "transfer", sourceId: "s", entryKey: "k" }, "help").entryKey, "k");
});

test("Memories: text started from /remember stays in memory, never in the screen's params", () => {
  const params = toScreenParams({ addNote: { workspaceId: "ws-1", text: "Invoices go out on the 1st" } });
  assert.deepEqual(params, { add: "note", workspace: "ws-1" });
  assert.ok(!JSON.stringify(params).includes("Invoices"));
  assert.deepEqual(toScreenParams({ tab: "overview", worth: true }), {}, "Tidy memories opens the Overview; the open list travels in memory");
});

test("Memories: no intro block under the tab bar; each tab has at most one plain sentence", () => {
  const navigation = readFileSync(join(ROOT, "client/navigation.tsx"), "utf8");
  const surface = readFileSync(join(ROOT, "client/surface.tsx"), "utf8");
  assert.ok(!/IntroBlock|TabIntro/.test(navigation + surface));
  for (const line of Object.values(PLAIN.lines)) assert.equal(line.split(/(?<=[.!?])\s/).length, 1, line);
});

test("Memories: Help asks plain questions, and says what each tab is for", () => {
  assert.ok(PLAIN_GUIDES.every((guide) => guide.title.endsWith("?")), "each how-to is folded under a question");
  assert.deepEqual(PLAIN.help.tabs.map((entry) => entry.tab), TABS.map((tab) => PLAIN.tabLabels[tab.id]));
  const texts = [...strings(PLAIN.help), ...strings(PLAIN.more), ...strings(PLAIN.lines), ...PLAIN_GUIDES.flatMap((guide) => [guide.title, ...guide.steps, guide.action?.label ?? ""]), PLAIN.whereSavedSummary, PLAIN.wholeFileSummary];
  const hits = texts.flatMap((text) => jargonIn(text).map((word) => `${word} in "${text}"`));
  assert.deepEqual(hits, []);
  assert.ok(!texts.some((text) => /Import & Export tab|open Import & Export|the Guide/.test(text)), "no step points at a tab that's gone");
});

// ------------------------------------------------------------------ Skills

test("Skills: four tabs; Add a skill is a page under Your skills", () => {
  assert.deepEqual(SKILL_TABS.map((tab) => tab.id), ["overview", "skills", "usage", "help"]);
  assert.deepEqual(SKILL_TABS.map((tab) => tab.label), ["Overview", "Your skills", "Usage", "Help"]);
  assert.equal(skillLitTab("add"), "skills");
  assert.equal(skillLitTab("usage"), "usage");
});

test("Skills: old tab ids still land, and Add keeps its params", () => {
  assert.equal(skillPageFor("guide"), "help");
  assert.deepEqual(skillsLanding({ tab: "guide" }), { tab: "help" });
  assert.deepEqual(skillsLanding({ tab: "usage" }), { tab: "usage" });
  assert.deepEqual(skillsLanding({ tab: "add", add: "github" }), { tab: "add", add: "github" });
  assert.deepEqual(skillsLanding({ add: "write" }), { tab: "add", add: "write" }, "the sidebar's + still opens Add");
  assert.deepEqual(skillsLanding({ tab: "nonsense" }), { tab: "overview" });
  assert.deepEqual(skillsParams({ tab: "add", add: "catalog" }), { tab: "add", add: "catalog" });
  assert.deepEqual(skillsParams({ tab: "help" }), { tab: "help" });
  assert.equal(skillsScreenTitle({ tab: "guide" }), "Skills · Help");
  assert.equal(skillsScreenTitle({ tab: "add" }), "Skills · Add a skill");
  // Handed over in memory on apps without screen params.
  assert.deepEqual(normalSkillsPlace({ tab: "guide" } as unknown as Parameters<typeof normalSkillsPlace>[0]), { tab: "help" });
  assert.deepEqual(normalSkillsPlace({ tab: "add", add: "write" }), { tab: "add", add: "write" });
});

test("Skills: Help's questions and the fold-outs read plainly", () => {
  assert.ok(SKILL_HOW_TOS.every((howTo) => howTo.title.endsWith("?")));
  assert.deepEqual(SKILLS_PLAIN.help.tabs.map((entry) => entry.tab), SKILL_TABS.map((tab) => tab.label));
  const texts = [...strings(SKILLS_PLAIN.help), ...strings(SKILLS_PLAIN.more), ...strings(SKILLS_PLAIN.lines), ...SKILL_HOW_TOS.flatMap((howTo) => [howTo.title, ...howTo.steps])];
  const hits = texts.flatMap((text) => jargonIn(text).map((word) => `${word} in "${text}"`));
  assert.deepEqual(hits, []);
  for (const line of Object.values(SKILLS_PLAIN.lines)) assert.ok(line.split(/(?<=[.!?])\s/).length <= 2, line);
});

// ------------------------------------------------------------------ sidebar dot

test("the sidebar dot follows the header: worth a look, urgent, tidy; unchanged while checking", () => {
  assert.equal(sidebarToneFrom({ status: "ok", caption: "" }, true), null);
  assert.equal(sidebarToneFrom({ status: "attention", caption: "" }, true), "attention");
  assert.equal(sidebarToneFrom({ status: "error", caption: "" }, true), "error", "a password in a note");
  assert.equal(sidebarToneFrom({ status: "error", caption: "" }, false), undefined, "couldn't read: keep what it knew");
  assert.equal(sidebarToneFrom({ status: "attention", caption: "", retry: true }, true), undefined, "a failed re-check isn't a finding");
  assert.equal(sidebarToneFrom({ status: "busy", caption: "" }, false), undefined);
  assert.equal(sidebarToneFrom({ status: "neutral", caption: "" }, true), undefined);
});

test("the sidebar row shows a dot beside the + only when a page found something, per host", () => {
  const Row: SidebarRowComponent = ({ trailing }) => React.createElement("row", null, trailing);
  const parts: SidebarParts = { Dot: ({ label, color }) => React.createElement("dot", { title: label, "data-color": color }), Group: ({ children }) => React.createElement("group", null, children) };
  const Plus = ({ label }: { label: string }) => React.createElement("plus", { title: label });
  const Item = sidebarItem({ id: "memories", title: "Memories", icon: "Brain", Component: () => null, quickAdd: { label: "Add a note", Button: Plus, params: { add: "note" } } }, Row, parts) as React.ComponentType<Record<string, unknown>>;
  const props = { currentScreen: null, openScreen: () => undefined, theme: { colors: { statusWarning: "#aa7700", statusDanger: "#cc0000", foregroundMuted: "#888" } }, host: { id: "h1", label: "h1" } };
  const draw = () => renderToStaticMarkup(React.createElement(Item, props));
  assert.ok(!draw().includes("<dot"), "calm: the + alone");
  assert.ok(draw().includes('title="Add a note"'));
  reportSidebarStatus("memories", "h2", "error");
  assert.ok(!draw().includes("<dot"), "another host's state stays there");
  reportSidebarStatus("memories", "h1", "attention");
  assert.equal(sidebarStatus("memories", "h1"), "attention");
  assert.ok(draw().includes(`title="${SIDEBAR_DOT_LABEL.attention}"`) && draw().includes("#aa7700"));
  reportSidebarStatus("memories", "h1", "error");
  assert.ok(draw().includes("#cc0000"));
  reportSidebarStatus("memories", "h1", null);
  assert.ok(!draw().includes("<dot"), "tidy again: the dot goes");
});

test("Memories still adds no composer chip; the common jobs are commands", () => {
  const entry = readFileSync(join(ROOT, "index.client.tsx"), "utf8");
  assert.ok(!/addComposerPill|addComposerChip/.test(entry));
  for (const id of ["add-memory-note", "tidy-memories", "add-skill", "open-skills", "add-workspace-note"]) assert.ok(entry.includes(`id: "${id}"`), id);
  assert.match(entry, /typeof client\.addSlashCommand === "function"/, "slash commands are feature-detected");
  assert.match(entry, /name: "remember"/);
});
