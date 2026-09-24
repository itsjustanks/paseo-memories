import type { SettingsDefinition } from "@getpaseo/plugin";
import { join } from "node:path";
import type { ZodType, output as ZodOutput } from "zod";
import { MEMORIES_DEFAULTS, memoriesSettings, type MemoriesSettings } from "../shared/settings";
import { paseoHome } from "./env";
import { readJsonCached } from "./files";

/**
 * The SDK has no server-side settings read, so server modules read the
 * document the daemon persists: $PASEO_HOME/plugin-settings/<pluginId>/<settingsId>.json,
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

export function readMemoriesSettings(): Promise<MemoriesSettings> {
  return readSettingsDocument(memoriesSettings, MEMORIES_DEFAULTS);
}
