import type { SettingsDefinition } from "@getpaseo/plugin";
import { join } from "node:path";
import type { ZodType, output as ZodOutput } from "zod";
import { MEMORIES_DEFAULTS, memoriesSettings, type MemoriesSettings } from "../shared/settings";
import { paseoHome } from "./env";
import { readJsonCached } from "./files";

/**
 * The SDK has no server-side settings read, so server modules read the
 * document the daemon persists: $PASEO_HOME/plugin-settings/<pluginId>/<settingsId>.json,
 * an envelope `{ version, values }`. Anything unreadable, from another schema
 * version, or invalid yields the defaults; a server module must never guess.
 * (paseo-mcp 0.11.0 `server/settings.ts`, made async.)
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
    const parsed = definition.schema.safeParse(envelope.values ?? {});
    return parsed.success ? (parsed.data as ZodOutput<Schema>) : defaults;
  } catch {
    return defaults;
  }
}

export function readMemoriesSettings(): Promise<MemoriesSettings> {
  return readSettingsDocument(memoriesSettings, MEMORIES_DEFAULTS);
}
