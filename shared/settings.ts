import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped settings, stored by Paseo under
 * `$PASEO_HOME/plugin-settings/paseo-memories/memories.json`. Version 1
 * forever: every field has a default, keys are never renamed (rename in the
 * UI only), and a new field is added with a default.
 */
export const memoriesSettings = defineSettings({
  id: "memories",
  scope: "host",
  version: 1,
  schema: z.object({
    showOtherAgents: z.boolean().default(true).describe("Show OpenCode, pi, Oh My Pi and Copilot files next to Claude and Codex"),
    staleChecks: z.boolean().default(true).describe("Look for paths and names a memory mentions that no longer exist"),
    maskSecrets: z.boolean().default(true).describe("Hide token-looking values until you reveal them"),
    codexEdits: z.boolean().default(true).describe("Allow edits to Codex's generated MEMORY.md and memory_summary.md"),
    backupsToKeep: z.number().int().min(1).max(500).default(20).describe("Backups kept per file"),
  }),
});

export type MemoriesSettings = z.infer<typeof memoriesSettings.schema>;

/** Schema defaults as a plain object, for callers that cannot reach the store. */
export const MEMORIES_DEFAULTS: MemoriesSettings = memoriesSettings.schema.parse({});
