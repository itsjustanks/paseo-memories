import { join } from "node:path";
import {
  CONFIG_DIR_ENV,
  DIR_AGENTS,
  PASEO_BUILTIN_PROVIDERS,
  baseCli,
  expandHome,
  launchEnvFor,
  launchValue,
  tilde,
  type DirAgent,
  type LaunchEnv,
  type ProviderLaunch,
} from "../shared/agents";
import type { Account } from "../shared/contracts";
import { daemonEnv, userHome } from "./env";
import { listDir, readFresh, readJsonCached, statSafe } from "./files";

/**
 * Every config directory an agent on this host may use, in the SPEC's order:
 * defaults (`~/.claude`, `~/.codex`, …), AgentLink / hand-made account slots
 * (paseo-mcp 0.11.0 `server/handlers.ts:19-45,116-190`), then each Paseo
 * provider's resolved env (daemon env → base provider env → provider env →
 * `~` expanded; paseo-mcp `server/tool-search.ts:101-103`, extended past
 * CLAUDE_CONFIG_DIR to CODEX_HOME and the other agents' variables).
 */

export function accountId(agent: string, dir: string): string {
  return `${agent}:${dir}`;
}

async function hasAccounts(root: string): Promise<boolean> {
  for (const provider of ["claude", "codex"]) if ((await listDir(join(root, "accounts", provider))).length > 0) return true;
  return false;
}

/** AgentLink's home: explicit env, else whichever of ~/.agent-link and ~/.agent-auth holds accounts. */
export async function agentLinkHome(): Promise<string> {
  const explicit = process.env.AGENT_LINK_HOME ?? process.env.AGENT_AUTH_HOME;
  if (explicit) return explicit;
  const home = userHome();
  const link = join(home, ".agent-link");
  const auth = join(home, ".agent-auth");
  if (await hasAccounts(link)) return link;
  if (await hasAccounts(auth)) return auth;
  return (await statSafe(link)) ? link : auth;
}

// Only the account email is read from credential-adjacent files; no token leaves here.
async function claudeAccountEmail(configDir: string): Promise<string> {
  const home = userHome();
  const file = configDir === join(home, ".claude") ? join(home, ".claude.json") : join(configDir, ".claude.json");
  const config = (await readJsonCached(file)) as { oauthAccount?: { emailAddress?: string } } | null;
  return config?.oauthAccount?.emailAddress ?? "";
}

// auth.json is nothing but credentials: read fresh, never cached.
async function codexAccountEmail(codexHome: string): Promise<string> {
  const text = await readFresh(join(codexHome, "auth.json"));
  if (!text) return "";
  try {
    const idToken = (JSON.parse(text) as { tokens?: { id_token?: string } }).tokens?.id_token;
    if (!idToken) return "";
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString()) as { email?: unknown };
    return typeof payload.email === "string" ? payload.email : "";
  } catch {
    return "";
  }
}

export type Accounts = {
  accounts: Account[];
  launch: ProviderLaunch;
  /** Which account each Paseo provider id's agents use. */
  byProvider: Record<string, { agent: DirAgent; accountId: string; env: LaunchEnv }>;
};

export function defaultDir(agent: DirAgent): string {
  return join(userHome(), ...CONFIG_DIR_ENV[agent].home);
}

/**
 * The directory a provider id's agents use for `agent`, by Paseo's env
 * layering. Pure apart from HOME.
 */
export function providerDir(agent: DirAgent, env: LaunchEnv): string {
  const value = launchValue(CONFIG_DIR_ENV[agent].env, env);
  return value ? expandHome(value, userHome()) : defaultDir(agent);
}

export async function discoverAccounts(launch: ProviderLaunch = {}): Promise<Accounts> {
  const home = userHome();
  const accounts: Account[] = [];
  const byId = new Map<string, Account>();
  const add = async (agent: DirAgent, dir: string, origin: string, label: string, alwaysShow: boolean): Promise<Account | null> => {
    const id = accountId(agent, dir);
    const existing = byId.get(id);
    if (existing) return existing;
    const stat = await statSafe(dir);
    if (!stat && !alwaysShow) return null;
    const account: Account = { id, agent, dir, label, origin, providerIds: [], exists: Boolean(stat?.isDirectory), envVar: CONFIG_DIR_ENV[agent].env };
    if (stat?.isDirectory && agent === "claude") account.email = (await claudeAccountEmail(dir)) || undefined;
    if (stat?.isDirectory && agent === "codex") account.email = (await codexAccountEmail(dir)) || undefined;
    byId.set(id, account);
    accounts.push(account);
    return account;
  };

  // 1. Defaults.
  for (const agent of DIR_AGENTS) {
    await add(agent, defaultDir(agent), "default", `Default (${tilde(defaultDir(agent), home)})`, agent === "claude" || agent === "codex");
  }

  // 2. AgentLink and hand-made slots.
  const linkRoot = join(await agentLinkHome(), "accounts");
  for (const agent of ["claude", "codex"] as const) {
    for (const entry of await listDir(join(linkRoot, agent))) {
      if (entry.isDirectory()) await add(agent, join(linkRoot, agent, entry.name), "agent-link", entry.name, true);
    }
  }
  for (const [agent, folder] of [["claude", ".claude-accounts"], ["codex", ".codex-accounts"]] as const) {
    for (const entry of await listDir(join(home, folder))) {
      if (entry.isDirectory()) await add(agent, join(home, folder, entry.name), "external", entry.name, true);
    }
  }

  // 3. Each Paseo provider's resolved directory.
  const byProvider: Accounts["byProvider"] = {};
  const ids = new Set<string>([...PASEO_BUILTIN_PROVIDERS, ...Object.keys(launch)]);
  for (const providerId of ids) {
    const cli = baseCli(providerId, launch);
    if (!(DIR_AGENTS as readonly string[]).includes(cli)) continue;
    const agent = cli as DirAgent;
    const env = launchEnvFor(providerId, launch, daemonEnv());
    const dir = providerDir(agent, env);
    // A provider on the default folder that does not exist (omp not installed) is not an account.
    const account = await add(agent, dir, "provider-env", `${providerId} (${tilde(dir, home)})`, dir !== defaultDir(agent));
    if (account && !account.providerIds.includes(providerId)) account.providerIds.push(providerId);
    byProvider[providerId] = { agent, accountId: accountId(agent, dir), env };
  }
  return { accounts, launch, byProvider };
}

/** The account a provider id's agents use; for a provider Paseo does not know, the agent's default. */
export function accountForProvider(found: Accounts, providerId: string): { agent: string; account: Account | null; env: LaunchEnv } {
  const hit = found.byProvider[providerId];
  if (hit) return { agent: hit.agent, account: found.accounts.find((account) => account.id === hit.accountId) ?? null, env: hit.env };
  return { agent: providerId, account: null, env: { daemonEnv: daemonEnv() } };
}

