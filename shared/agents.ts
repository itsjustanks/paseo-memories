/**
 * The agents this plugin knows, the environment variable that moves each
 * one's config directory, and Paseo's provider env layering. Pure.
 *
 * `readProviderLaunch`, `inheritedEnv`, `baseCli` and `launchValue` are copied
 * from paseo-mcp 0.11.0 `shared/tool-search.ts` (never imported).
 */

export const AGENTS = ["claude", "codex", "paseo", "opencode", "pi", "omp", "copilot"] as const;
export type Agent = (typeof AGENTS)[number];

export const AGENT_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  paseo: "Paseo",
  opencode: "OpenCode",
  pi: "pi",
  omp: "Oh My Pi",
  copilot: "Copilot CLI",
};

/** Agents with a config directory (an "account" here). Paseo is host config, not a directory. */
export const DIR_AGENTS = ["claude", "codex", "opencode", "pi", "omp", "copilot"] as const;
export type DirAgent = (typeof DIR_AGENTS)[number];

/**
 * The variable that moves each agent's config directory, and its default
 * under HOME. omp shares pi's `PI_CODING_AGENT_DIR` (oh-my-pi docs/context-files.md).
 */
export const CONFIG_DIR_ENV: Record<DirAgent, { env: string; home: string[] }> = {
  claude: { env: "CLAUDE_CONFIG_DIR", home: [".claude"] },
  codex: { env: "CODEX_HOME", home: [".codex"] },
  opencode: { env: "OPENCODE_CONFIG_DIR", home: [".config", "opencode"] },
  pi: { env: "PI_CODING_AGENT_DIR", home: [".pi", "agent"] },
  omp: { env: "PI_CODING_AGENT_DIR", home: [".omp", "agent"] },
  copilot: { env: "COPILOT_HOME", home: [".copilot"] },
};

/** Paseo's built-in providers (@getpaseo/server 0.9.1). */
export const PASEO_BUILTIN_PROVIDERS = ["claude", "codex", "copilot", "opencode", "pi", "omp"] as const;

/** Providers Paseo hands `appendSystemPrompt` to. ACP providers (Copilot, Cursor, Gemini) get nothing. */
export const APPEND_PROMPT_PROVIDERS = ["claude", "codex", "opencode", "pi", "omp"] as const;

/** Base CLI and env per provider entry, from `paseo.config.get()` (flattened or nested `providers`). */
export type ProviderLaunch = Record<string, { extends?: string; env: Record<string, string> }>;

export function readProviderLaunch(config: unknown): ProviderLaunch {
  const root = (config && typeof config === "object" ? config : {}) as { providers?: unknown; agents?: { providers?: unknown } };
  const raw = root.providers ?? root.agents?.providers;
  const out: ProviderLaunch = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = (value && typeof value === "object" ? value : {}) as { extends?: unknown; env?: unknown };
    const env: Record<string, string> = {};
    if (entry.env && typeof entry.env === "object") {
      for (const [key, v] of Object.entries(entry.env as Record<string, unknown>)) if (typeof v === "string") env[key] = v;
    }
    out[id] = { ...(typeof entry.extends === "string" ? { extends: entry.extends } : {}), env };
  }
  return out;
}

/**
 * The base entry's `env` a derived provider starts with under its own
 * (provider-registry.js `mergeRuntimeSettings`: `{ ...base.env, ...own.env }`).
 */
export function inheritedEnv(providerId: string, launch: ProviderLaunch): Record<string, string> | undefined {
  const base = launch[providerId]?.extends;
  if (!base || base === providerId || !(PASEO_BUILTIN_PROVIDERS as readonly string[]).includes(base)) return undefined;
  return launch[base]?.env;
}

/** A provider id's base CLI: the entry's `extends`, the id itself for a built-in, else `fallback`. */
export function baseCli(providerId: string, launch: ProviderLaunch, fallback = ""): string {
  const own = launch[providerId]?.extends;
  if (own) return own;
  if ((PASEO_BUILTIN_PROVIDERS as readonly string[]).includes(providerId)) return providerId;
  return fallback;
}

export type LaunchEnv = {
  daemonEnv?: Record<string, string | undefined>;
  baseEnv?: Record<string, string>;
  providerEnv?: Record<string, string>;
};

/** A variable as the agent sees it: provider env, then its base entry's env, then the daemon's. */
export function launchValue(name: string, inputs: LaunchEnv): string | undefined {
  for (const env of [inputs.providerEnv, inputs.baseEnv, inputs.daemonEnv]) {
    const value = env?.[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** The launch env for one provider id: daemon env, base provider env, then the provider's own. */
export function launchEnvFor(providerId: string, launch: ProviderLaunch, daemonEnv: Record<string, string | undefined>): LaunchEnv {
  return { daemonEnv, baseEnv: inheritedEnv(providerId, launch), providerEnv: launch[providerId]?.env };
}

/** `~` and `~/x` against a home directory. Pure string work; no filesystem. */
export function expandHome(path: string, userHome: string): string {
  if (path === "~") return userHome;
  return path.startsWith("~/") ? `${userHome}/${path.slice(2)}` : path;
}

/** `/Users/me/x` as `~/x` for display. */
export function tilde(path: string, userHome: string): string {
  if (path === userHome) return "~";
  return path.startsWith(`${userHome}/`) ? `~${path.slice(userHome.length)}` : path;
}
