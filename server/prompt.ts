import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { APPEND_PROMPT_PROVIDERS } from "../shared/agents";
import type { WriteResult } from "../shared/contracts";
import { plainError } from "../shared/errors";
import { byteLength, tokensFor } from "../shared/limits";
import { hasNewMask, maskSecrets } from "../shared/secrets";
import { readDaemon, startWrite, type Paseo } from "./daemon";
import { forgetDiscovery } from "./discover";
import { logWrite } from "./log";
import { withDeadline } from "./run";
import { readMemoriesSettings } from "./settings";
import { backupsRoot, newSession } from "./write";

/**
 * Paseo's `appendSystemPrompt`, through `paseo.config.get()/patch()` only:
 * the smallest patch, read back, a mismatch reported (paseo-mcp 0.11.0
 * `server/paseo-tools.ts:175-220`). It reaches new and relaunched agents of
 * Claude, Codex, OpenCode, pi and omp; ACP providers get nothing.
 */

const APPLIES = "Agents started or relaunched from now on get it; running agents keep what they started with. Copilot (ACP) never gets it.";

export async function handlePromptGet({ reveal }: { reveal?: boolean }, { paseo }: PluginHandlerContext) {
  const { appendSystemPrompt } = await readDaemon(paseo, true);
  const bytes = byteLength(appendSystemPrompt);
  const settings = await readMemoriesSettings();
  const hidden = maskSecrets(appendSystemPrompt);
  const mask = settings.maskSecrets && !reveal && hidden.count > 0;
  return { value: mask ? hidden.text : appendSystemPrompt, bytes, tokens: tokensFor(bytes), providers: [...APPEND_PROMPT_PROVIDERS], note: APPLIES, masked: mask, secrets: hidden.count };
}

function refuse(message: string): WriteResult {
  return { ok: false, message, reports: [], warnings: [] };
}

export async function promptSet(paseo: Paseo, { text, expected }: { text: string; expected: string }): Promise<WriteResult> {
  const target = "paseo:appendSystemPrompt";
  let before: string;
  try {
    before = (await readDaemon(paseo, true)).appendSystemPrompt;
  } catch (error) {
    return refuse(`Could not read Paseo's settings, so nothing was changed. ${plainError(error)}`);
  }
  if (before !== expected) return refuse("Paseo's appended prompt changed since you opened it (another app or client saved it). Reload it and make your change again; nothing was saved.");
  if (text === before) return { ok: true, message: "No change; nothing was written.", reports: [{ target, ok: true, action: "unchanged", readBack: "ok" }], warnings: [] };
  if (hasNewMask(text, before)) return refuse("The text still has hidden (masked) values in it. Reveal them before editing. Nothing was saved.");
  // Back up the old value like any file, under the plugin's own folder.
  const settings = await readMemoriesSettings();
  const session = newSession(settings.backupsToKeep);
  const backupPath = join(backupsRoot(), session.stamp, "paseo", "appendSystemPrompt.txt");
  try {
    await fs.mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(backupPath, before, { mode: 0o600, flag: "wx" });
  } catch {
    return refuse("Could not back up the current prompt, so nothing was changed.");
  }
  startWrite();
  try {
    await withDeadline(paseo.config.patch({ appendSystemPrompt: text }), "an answer to the settings change");
  } catch (error) {
    startWrite();
    logWrite("prompt-set", target, "failed");
    return { ok: false, message: `Paseo did not accept the change. ${plainError(error)}`, reports: [{ target, ok: false, action: "updated", backupPath, readBack: "skipped", error: "Paseo did not accept the change." }], warnings: [] };
  }
  forgetDiscovery();
  let after: string;
  try {
    after = (await readDaemon(paseo, true)).appendSystemPrompt;
  } catch (error) {
    startWrite();
    return { ok: false, message: `The change was sent but could not be read back, so it is not confirmed. ${plainError(error)}`, reports: [{ target, ok: false, action: "updated", backupPath, readBack: "skipped" }], warnings: [] };
  }
  const ok = after === text;
  logWrite("prompt-set", target, ok ? "updated" : "read-back mismatch");
  return {
    ok,
    message: ok ? `Saved. ${APPLIES}` : "Paseo took the change but reads back a different prompt; a launch flag or another client may hold that setting.",
    reports: [{ target, ok, action: "updated", backupPath, readBack: ok ? "ok" : "mismatch", ...(ok ? {} : { error: "Read back differently." }) }],
    warnings: ok ? [APPLIES] : [],
  };
}

export const handlePromptSet = (input: { text: string; expected: string }, { paseo }: PluginHandlerContext) => promptSet(paseo, input);
