import type { PluginScreenParams } from "@getpaseo/plugin/client";
import { SKILL_ADD_PAGE, SKILL_TABS, skillPageFor, type SkillPageId } from "../shared/skills-plain";
import { openScreenById, screenParamsOn } from "./screens";

/**
 * Where the Skills screen is: a tab, an open skill, and how Add a skill
 * starts. On Paseo 0.11+ it lives in the screen's params, so reload and
 * back/forward land in the same place. A skill id is already opaque (a hash
 * the host made); nothing else that names a person, project or path travels.
 */

export type AddMode = "catalog" | "github" | "write";
/** `tab` is a tab or Add a skill (a page under Your skills). */
export type SkillsPlace = { tab: SkillPageId; skillId?: string; add?: AddMode };

const MODES: readonly AddMode[] = ["catalog", "github", "write"];
const ID = /^sk_[0-9a-f]{24}$/;

export function skillsLanding(params: PluginScreenParams | undefined): SkillsPlace {
  // Old ids still land: a link to the Guide opens Help.
  const tab = skillPageFor(params?.tab) ?? "overview";
  const skillId = params?.skill && ID.test(params.skill) ? params.skill : undefined;
  const add = MODES.find((mode) => mode === params?.add);
  return { tab: skillId ? "skills" : add ? "add" : tab, ...(skillId ? { skillId } : {}), ...(add ? { add } : {}) };
}

export function skillsParams(place: SkillsPlace): PluginScreenParams {
  return {
    ...(place.tab !== "overview" ? { tab: place.tab } : {}),
    ...(place.skillId ? { skill: place.skillId } : {}),
    ...(place.tab === "add" && place.add ? { add: place.add } : {}),
  };
}

export function skillsScreenTitle(params: PluginScreenParams): string {
  const place = skillsLanding(params);
  if (place.tab === "overview") return "Skills";
  return `Skills · ${(SKILL_TABS.find((tab) => tab.id === place.tab) ?? SKILL_ADD_PAGE).label}`;
}

function key(params: PluginScreenParams): string {
  return JSON.stringify(Object.keys(params).sort().map((name) => [name, params[name]]));
}

/** Record where the page is now (a no-op before Paseo 0.11). */
export function syncSkillsParams(next: PluginScreenParams, current: PluginScreenParams | undefined): void {
  if (!screenParamsOn() || key(next) === key(current ?? {})) return;
  openScreenById("skills", next);
}

const listeners = new Set<(place: SkillsPlace) => void>();
let pending: SkillsPlace | null = null;

/** Open Skills at a place: by params on 0.11+, else by telling the mounted page (or the next one). */
export function openSkills(place: SkillsPlace = { tab: "overview" }): void {
  if (screenParamsOn()) {
    openScreenById("skills", skillsParams(place));
    return;
  }
  pending = place;
  for (const listener of listeners) listener(place);
  openScreenById("skills");
}

/** A place with its tab as this version names it: an old id ("guide") becomes its new tab; an unknown one, the Overview. */
export function normalSkillsPlace(place: SkillsPlace): SkillsPlace {
  const tab = skillPageFor(place.tab) ?? "overview";
  return tab === place.tab ? place : { ...place, tab };
}

export function takeSkillsPlace(): SkillsPlace | null {
  const value = pending;
  pending = null;
  return value ? normalSkillsPlace(value) : null;
}

export function onSkillsPlace(listener: (place: SkillsPlace) => void): () => void {
  const heard = (place: SkillsPlace) => listener(normalSkillsPlace(place));
  listeners.add(heard);
  return () => listeners.delete(heard);
}
