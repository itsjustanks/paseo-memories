import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where things are, read at call time (not at import) so tests can point
 * HOME, PASEO_HOME and every agent variable at a sandbox.
 */

export function userHome(): string {
  return homedir();
}

export function paseoHome(): string {
  const raw = process.env.PASEO_HOME?.trim();
  if (!raw) return join(homedir(), ".paseo");
  return resolve(raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
}

/** This plugin's own data: backups and the record of Codex edits. Never inside an agent's folder or a repo. */
export function pluginDataDir(): string {
  return join(paseoHome(), "plugin-data", "paseo-memories");
}

export function daemonEnv(): Record<string, string | undefined> {
  return process.env;
}

/**
 * Claude Code's managed CLAUDE.md (code.claude.com/docs/en/memory):
 * macOS `/Library/Application Support/ClaudeCode`, Linux and WSL
 * `/etc/claude-code`, Windows `C:\Program Files\ClaudeCode`.
 * `PASEO_MEMORIES_MANAGED_DIR` overrides it (tests only).
 */
export function claudeManagedDir(): string {
  const override = process.env.PASEO_MEMORIES_MANAGED_DIR?.trim();
  if (override) return override;
  const os = platform();
  if (os === "darwin") return "/Library/Application Support/ClaudeCode";
  if (os === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

export function truthyEnv(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}
