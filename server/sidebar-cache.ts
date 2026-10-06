import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { QuickSummary } from "../shared/finding-groups";
import { pluginDataDir } from "./env";

/**
 * What the sidebar dots last said (0.5.1), so they show from the moment the
 * app loads instead of only after a page has been opened.
 *
 * Nothing here works anything out. The findings and the skills list record
 * their summary here each time they are worked out anyway; the sidebar asks
 * `read()`, which answers from memory, or (once per plugin load) from a small
 * file in the plugin's data folder, so a restart or an update still has the
 * last answer. Only counts and kinds go in, never a note's text or name.
 * Writes happen only when the summary changes, and never fail a read.
 */

const Summary = z.object({ tone: z.enum(["attention", "error"]).nullable(), count: z.number(), groups: z.array(z.object({ key: z.string().max(64), count: z.number() })).max(10) });
const Stored = z.object({
  memories: z.object({ plain: Summary, technical: Summary, at: z.string() }).nullable().default(null),
  skills: z.object({ summary: Summary, at: z.string() }).nullable().default(null),
});
export type SidebarState = z.infer<typeof Stored>;

const MAX_BYTES = 64 * 1024;
const EMPTY: SidebarState = { memories: null, skills: null };

let state: SidebarState | null = null;
let loading: Promise<SidebarState> | null = null;
/**
 * The newest summary each dot has taken, by when its answer was worked out
 * (or the order it was asked for): one that was worked out earlier but lands
 * later never flips the dot back.
 */
const taken = { memories: Number.NEGATIVE_INFINITY, skills: Number.NEGATIVE_INFINITY };
/** Saves one after another, each writing what is held by then (the newest), so the file never ends on an older copy. */
let saving: Promise<void> = Promise.resolve();

export function sidebarStatePath(): string {
  return join(pluginDataDir(), "state", "sidebar.json");
}

async function load(): Promise<SidebarState> {
  try {
    const path = sidebarStatePath();
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size > MAX_BYTES) return EMPTY;
    const parsed = Stored.safeParse(JSON.parse(await fs.readFile(path, "utf8")));
    return parsed.success ? parsed.data : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** The last known summaries: from memory, or the file the first time. */
export async function readSidebarState(): Promise<SidebarState> {
  if (state) return state;
  loading ??= load().then((loaded) => (state ??= loaded));
  return loading;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A temp file renamed over the old one, so a crash leaves the last good copy.
 * Awaited by the call that changed the summary (it is under a kilobyte and
 * written only on a change), so nothing is left running after it, and never
 * a blocking file call on a read.
 */
async function save(next: SidebarState): Promise<void> {
  try {
    const path = sidebarStatePath();
    await fs.mkdir(join(pluginDataDir(), "state"), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temp, JSON.stringify(next), { mode: 0o600 });
    await fs.rename(temp, path);
  } catch {
    // The dot falls back to waiting for a page, as before 0.5.1.
  }
}

function saveLatest(): Promise<void> {
  saving = saving.then(() => (state ? save(state) : undefined));
  return saving;
}

/**
 * The findings were worked out: remember what the Memories dot should say
 * (plain and technical views count differently). `order`: when that answer
 * was worked out; an older one arriving late is ignored. The other dot's
 * summary is taken from what is held now, never from before the wait.
 */
export async function recordMemories(plain: QuickSummary, technical: QuickSummary, order = Date.now(), now = new Date()): Promise<void> {
  await readSidebarState();
  if (order < taken.memories) return;
  taken.memories = order;
  const current = state ?? EMPTY;
  if (current.memories && same(current.memories.plain, plain) && same(current.memories.technical, technical)) return;
  state = { ...current, memories: { plain, technical, at: now.toISOString() } };
  await saveLatest();
}

/** The skills list was worked out: remember what the Skills dot should say. `order` as for `recordMemories`. */
export async function recordSkills(summary: QuickSummary, order = Date.now(), now = new Date()): Promise<void> {
  await readSidebarState();
  if (order < taken.skills) return;
  taken.skills = order;
  const current = state ?? EMPTY;
  if (current.skills && same(current.skills.summary, summary)) return;
  state = { ...current, skills: { summary, at: now.toISOString() } };
  await saveLatest();
}

/** The `sidebar-status` RPC: what is held, nothing worked out. */
export const handleSidebarStatus = () => readSidebarState();

/** For tests: forget what is held in memory (the file stays). */
export function resetSidebarState(): void {
  state = null;
  loading = null;
  taken.memories = Number.NEGATIVE_INFINITY;
  taken.skills = Number.NEGATIVE_INFINITY;
}
