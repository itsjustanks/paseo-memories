import type { SettingsDefinition } from "@getpaseo/plugin";
import { join } from "node:path";
import type { ZodType, output as ZodOutput } from "zod";
import { MEMORIES_DEFAULTS, memoriesSettings, type MemoriesSettings } from "../shared/settings";
import { paseoHome } from "./env";
import { readJsonCached } from "./files";

/**
 * Settings on the daemon side. Paseo 0.9+ hands back a live handle from
 * `registerSettings()` (`read()`, `subscribe()`): the values come from it and
 * a change applies at once (`adoptSettingsHandle`). Without a handle (0.8), or
 * when it has nothing valid to give (`invalid`, a failed read), server
 * modules read the document the daemon persists: $PASEO_HOME/plugin-settings/<pluginId>/<settingsId>.json,
 * an envelope `{ version, values }`. Anything unreadable or from another
 * schema version yields the defaults; a server module must never guess. One
 * invalid value resets only its own field, so a bad `technicalDetails` never
 * turns `codexEdits` back on. (paseo-mcp 0.11.0 `server/settings.ts`, made async.)
 */
export function settingsPath(settingsId: string, pluginId = "paseo-memories"): string {
  return join(paseoHome(), "plugin-settings", pluginId, `${settingsId}.json`);
}

export async function readSettingsDocument<Schema extends ZodType>(
  definition: SettingsDefinition<Schema>,
  defaults: ZodOutput<Schema>,
  path = settingsPath(definition.id),
): Promise<ZodOutput<Schema>> {
  try {
    const envelope = (await readJsonCached(path)) as { version?: unknown; values?: unknown } | null;
    if (!envelope || envelope.version !== definition.version) return defaults;
    const values = envelope.values ?? {};
    const parsed = definition.schema.safeParse(values);
    if (parsed.success) return parsed.data as ZodOutput<Schema>;
    return perField(definition.schema, values, defaults);
  } catch {
    return defaults;
  }
}

/** Each field on its own: a valid value is kept, an invalid one takes that field's default. */
function perField<Schema extends ZodType>(schema: Schema, values: unknown, defaults: ZodOutput<Schema>): ZodOutput<Schema> {
  const shape = (schema as unknown as { shape?: Record<string, ZodType> }).shape;
  if (!shape || !values || typeof values !== "object") return defaults;
  const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [key, field] of Object.entries(shape)) {
    const one = field.safeParse((values as Record<string, unknown>)[key]);
    if (one.success) out[key] = one.data;
  }
  return out as ZodOutput<Schema>;
}

/** The handle's state (`PluginSettingsState`), as far as this module relies on it. */
type HandleState = { status: string; values?: unknown };
/** `registerSettings()`'s return on Paseo 0.9+; nothing on 0.8. */
type SettingsHandle = { read(): Promise<HandleState>; subscribe(listener: (state: HandleState) => void | Promise<void>): () => void };

let handle: SettingsHandle | null = null;
/** Told when Paseo says the settings changed (0.9+), e.g. so turning counting off forgets at once. */
const changeListeners = new Set<() => void>();

export function onSettingsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}
/** The values in force until the handle says they changed; null means ask again. */
let current: MemoriesSettings | null = null;
/** Bumped on every change (and handle swap): a read that started before one is older than what it would overwrite. */
let generation = 0;

function isHandle(value: unknown): value is SettingsHandle {
  return Boolean(value) && typeof (value as SettingsHandle).read === "function" && typeof (value as SettingsHandle).subscribe === "function";
}

/** Valid values from a handle state, or null when it has none (invalid, loading, malformed). */
function fromState(state: HandleState | null | undefined): MemoriesSettings | null {
  if (!state || state.status !== "ready" || !state.values || typeof state.values !== "object") return null;
  const parsed = memoriesSettings.schema.safeParse(state.values);
  return parsed.success ? parsed.data : null;
}

/**
 * Use what `registerSettings()` returned. A handle makes reads come from
 * Paseo and keeps them current; anything else leaves the file reader in
 * charge. Returns the cleanup.
 */
export function adoptSettingsHandle(registered: unknown): () => void {
  current = null;
  generation += 1;
  if (!isHandle(registered)) {
    handle = null;
    return () => undefined;
  }
  handle = registered;
  let unsubscribe: () => void = () => undefined;
  try {
    unsubscribe = registered.subscribe((state) => {
      // A change: take the new values, or ask again on the next read.
      generation += 1;
      current = fromState(state);
      for (const listener of changeListeners) {
        try {
          listener();
        } catch {
          // One listener's failure never stops the others.
        }
      }
    });
  } catch {
    // Reads still work without updates; each one asks the handle while nothing is cached.
  }
  return () => {
    if (handle === registered) {
      handle = null;
      current = null;
      generation += 1;
    }
    try {
      unsubscribe();
    } catch {
      // Already gone.
    }
  };
}

export async function readMemoriesSettings(): Promise<MemoriesSettings> {
  if (!handle) return readSettingsDocument(memoriesSettings, MEMORIES_DEFAULTS);
  if (current) return current;
  const asked = generation;
  let state: HandleState | null = null;
  try {
    state = await handle.read();
  } catch {
    // A failed read: the file below, and ask again next time.
  }
  // A change arrived while this read was out: it is newer, so it wins.
  if (asked !== generation) return readMemoriesSettings();
  const values = fromState(state);
  if (values) return (current = values);
  // Stored values Paseo calls invalid: rescue them field by field, and keep that until the next change.
  const rescued = await readSettingsDocument(memoriesSettings, MEMORIES_DEFAULTS);
  if (asked !== generation) return readMemoriesSettings();
  if (state) current = rescued;
  return rescued;
}
