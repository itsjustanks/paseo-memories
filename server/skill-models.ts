import { join } from "node:path";
import { launchValue } from "../shared/agents";
import { claudeContextTokens } from "../shared/skill-md";
import type { Accounts } from "./accounts";
import type { Paseo } from "./daemon";
import { truthyEnv } from "./env";
import type { Probe } from "./files";
import { withDeadline } from "./run";

/**
 * Which context window each Claude account's agents actually run with, so a
 * skill list is only called "over budget" against the window in use (the
 * calm rule: no alarm on a guess). From, in order: the models of the Claude
 * agents Paseo has now (the smallest window wins: those are the agents that
 * get cut first), else the account's own default (`model` in its
 * settings.json, or ANTHROPIC_MODEL in the provider's env). Unknown stays
 * unknown.
 */

export type AccountWindow = { contextTokens: number | null; model?: string; from: "agents" | "settings" | "unknown" };

const CACHE_MS = 30_000;
let cached: { at: number; agents: Array<{ provider: string; model: string | null }> } | null = null;

type AgentEntry = { agent?: { provider?: unknown; model?: unknown; archivedAt?: unknown } };

/** Paseo's current agents' providers and models; empty when there is no daemon or it doesn't answer. One read per 30 s. */
async function paseoAgents(paseo: Paseo | null): Promise<Array<{ provider: string; model: string | null }>> {
  if (!paseo) return [];
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.agents;
  const api = (paseo as unknown as { agents?: { list?: () => Promise<{ entries?: AgentEntry[] }> } }).agents;
  if (!api?.list) return [];
  try {
    const result = await withDeadline(api.list(), "its agent list", 5_000);
    const agents = (result.entries ?? [])
      .map((entry) => entry.agent)
      .filter((agent): agent is NonNullable<AgentEntry["agent"]> => Boolean(agent) && !agent!.archivedAt && typeof agent!.provider === "string")
      .map((agent) => ({ provider: agent.provider as string, model: typeof agent.model === "string" && agent.model ? agent.model : null }));
    cached = { at: Date.now(), agents };
    return agents;
  } catch {
    return [];
  }
}

/** For tests. */
export function forgetAgentModels(): void {
  cached = null;
}

async function settingsModel(probe: Probe, dir: string): Promise<string | null> {
  const text = await probe.text(join(dir, "settings.json"));
  if (!text) return null;
  try {
    const model = (JSON.parse(text) as { model?: unknown }).model;
    return typeof model === "string" && model.trim() ? model.trim() : null;
  } catch {
    return null;
  }
}

export async function claudeWindows(paseo: Paseo | null, accounts: Accounts, probe: Probe): Promise<Map<string, AccountWindow>> {
  const out = new Map<string, AccountWindow>();
  const agents = await paseoAgents(paseo);
  for (const account of accounts.accounts) {
    if (account.agent !== "claude" || !account.exists) continue;
    const providers = Object.entries(accounts.byProvider).filter(([, entry]) => entry.accountId === account.id);
    const disable1m = providers.some(([, entry]) => truthyEnv(launchValue("CLAUDE_CODE_DISABLE_1M_CONTEXT", entry.env))) || truthyEnv(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT);
    const fallback = (await settingsModel(probe, account.dir)) ?? providers.map(([, entry]) => launchValue("ANTHROPIC_MODEL", entry.env)).find(Boolean) ?? null;
    const running = agents.filter((agent) => providers.some(([id]) => id === agent.provider));
    const windows = running.map((agent) => ({ model: agent.model ?? fallback, tokens: claudeContextTokens(agent.model ?? fallback, disable1m) }));
    if (windows.length && windows.every((entry) => entry.tokens !== null)) {
      const smallest = windows.reduce((a, b) => (b.tokens! < a.tokens! ? b : a));
      out.set(account.id, { contextTokens: smallest.tokens, ...(smallest.model ? { model: smallest.model } : {}), from: "agents" });
      continue;
    }
    const tokens = windows.length ? null : claudeContextTokens(fallback, disable1m);
    out.set(account.id, tokens ? { contextTokens: tokens, ...(fallback ? { model: fallback } : {}), from: "settings" } : { contextTokens: null, from: "unknown" });
  }
  return out;
}

/** One agent's window, from its own model (else its account's), for the agent panel. */
export function agentWindow(model: string | null | undefined, account: AccountWindow | undefined): AccountWindow {
  const tokens = claudeContextTokens(model, false);
  if (tokens) return { contextTokens: tokens, ...(model ? { model } : {}), from: "agents" };
  return account ?? { contextTokens: null, from: "unknown" };
}
