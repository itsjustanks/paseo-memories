/** Browser stand-in for @getpaseo/plugin: every Memories contract answered from fixtures. */
import React, { useCallback } from "react";
import { Text, View, ScrollView as RNScrollView, TextInput as RNTextInput } from "react-native";
import { compactDiff, lineDiff } from "../../shared/diff";
import { maskSecrets } from "../../shared/secrets";
import { asSection, parseImport } from "../../shared/transfer";

export function defineRpc<T>(contract: T) { return contract; }
export function defineSettings<T>(definition: T) { return definition; }
const params = new URLSearchParams(location.search);
const empty = params.has("empty"), failed = params.has("error"), stale = params.has("stale");
// ?long: real-world lengths (Docker homes, deep worktrees, 200+ char Claude folder names, long lines) to catch sideways overflow.
const long = params.has("long");
let calls = 0;
Object.assign(window, { __calls: () => calls });

const H = long ? "/home/paseo" : "/Users/demo";
const tilde = (path: string) => path.replace(H, "~");
const slug = (path: string) => path.replace(/[/.]/g, "-");
const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3600_000).toISOString();
const loaded = (bytes: number, note = "") => ({ bytes, tokens: Math.ceil(bytes / 4), note });
const src = (s: any) => ({ exists: true, isDirectory: false, lines: 20, readBy: [], modifiedAt: ago(30), loaded: loaded(0), access: "editable", ...s });

const APP = long
  ? `${H}/projects/acme-web-storefront-platform-rebuild/.paseo/worktrees/feature-checkout-payment-provider-webhook-retry-handling-and-idempotency-keys/packages/storefront-web-application-client`
  : `${H}/code/acme-web`;
const DATA = long ? `${H}/projects/demo-api-inventory-and-fulfilment-service-monorepo/services/order-processing-gateway` : `${H}/code/demo-api`;
const NOTES = `${H}/code/notes-site`;
const OLD = long ? `${H}/projects/old-prototype-experimental-checkout-redesign-spike-from-last-year/.paseo/worktrees/spike-one` : `${H}/code/old-prototype`;
const appMemory = `${H}/.claude/projects/${slug(APP)}/memory`;
const dataMemory = `${H}/.claude/projects/${slug(DATA)}/memory`;
const notesMemory = `${H}/.claude/projects/${slug(NOTES)}/memory`;
const oldMemory = `${H}/.claude/projects/${slug(OLD)}/memory`;
const APPT = tilde(APP);
const codexIndex = `${H}/.codex/memories/MEMORY.md`, codexSummary = `${H}/.codex/memories/memory_summary.md`;

const WORK = long ? "platform-engineering-shared-automation-account-for-release-tooling@example-enterprise-subsidiary.example.com" : "work@example.com";
const accounts = [
  { id: `claude:${H}/.claude`, agent: "claude", dir: `${H}/.claude`, label: "Default (~/.claude)", origin: "default", email: "demo@example.com", providerIds: ["claude"], exists: true, envVar: "CLAUDE_CONFIG_DIR" },
  { id: `codex:${H}/.codex`, agent: "codex", dir: `${H}/.codex`, label: "Default (~/.codex)", origin: "default", email: "demo@example.com", providerIds: ["codex"], exists: true, envVar: "CODEX_HOME" },
  { id: `claude:${H}/.agent-link/accounts/claude/${WORK}`, agent: "claude", dir: `${H}/.agent-link/accounts/claude/${WORK}`, label: WORK, origin: "agent-link", email: WORK, providerIds: ["claude-work"], exists: true, envVar: "CLAUDE_CONFIG_DIR" },
  { id: `opencode:${H}/.config/opencode`, agent: "opencode", dir: `${H}/.config/opencode`, label: "Default (~/.config/opencode)", origin: "default", providerIds: ["opencode"], exists: true, envVar: "OPENCODE_CONFIG_DIR" },
];
const [claudeAcc, codexAcc, workAcc] = accounts.map((a) => a.id);

const sources: any[] = empty ? [] : [
  src({ id: `${H}/.claude/CLAUDE.md`, path: `${H}/.claude/CLAUDE.md`, agent: "claude", accountId: claudeAcc, scope: "user", kind: "claude-md", bytes: 5120, lines: 148, readBy: ["claude", "opencode", "omp"], loaded: loaded(5120) }),
  src({ id: `${H}/.claude/rules/testing.md`, path: `${H}/.claude/rules/testing.md`, agent: "claude", accountId: claudeAcc, scope: "user", kind: "claude-rule", bytes: 612, readBy: ["claude"], loaded: loaded(612) }),
  src({ id: `${H}/.agent-link/accounts/claude/${WORK}/CLAUDE.md`, path: `${H}/.agent-link/accounts/claude/${WORK}/CLAUDE.md`, agent: "claude", accountId: workAcc, scope: "user", kind: "claude-md", bytes: 1204, readBy: ["claude"], loaded: loaded(1204) }),
  src({ id: `${H}/.codex/AGENTS.md`, path: `${H}/.codex/AGENTS.md`, agent: "codex", accountId: codexAcc, scope: "user", kind: "agents-md", bytes: 2210, readBy: ["codex"], loaded: loaded(2210) }),
  src({ id: codexSummary, path: codexSummary, agent: "codex", accountId: codexAcc, scope: "user", kind: "codex-memory", bytes: 6400, readBy: ["codex"], loaded: loaded(6400), label: "Codex folds this in at its next run; wording may change." }),
  src({ id: codexIndex, path: codexIndex, agent: "codex", accountId: codexAcc, scope: "user", kind: "codex-memory", bytes: 18200, lines: 610, readBy: ["codex"], loaded: loaded(0, "Searched on demand, never injected."), label: "Codex folds this in at its next run; wording may change." }),
  src({ id: `${H}/.codex/memories/raw_memories.md`, path: `${H}/.codex/memories/raw_memories.md`, agent: "codex", accountId: codexAcc, scope: "user", kind: "codex-generated", bytes: 37, access: "read-only", reason: "Rebuilt from Codex's database at each run; edits here are lost." }),
  src({ id: `${H}/.codex/memories/phase2_workspace_diff.md`, path: `${H}/.codex/memories/phase2_workspace_diff.md`, agent: "codex", accountId: codexAcc, scope: "user", kind: "codex-generated", bytes: 812400, access: "read-only", reason: "Codex's working diff for the next consolidation." }),
  src({ id: "paseo:appendSystemPrompt", path: "paseo:appendSystemPrompt", agent: "paseo", scope: "host", kind: "paseo-prompt", bytes: 412, readBy: ["claude", "codex", "opencode", "pi", "omp"], loaded: loaded(412) }),
  src({ id: `${H}/.config/opencode/AGENTS.md`, path: `${H}/.config/opencode/AGENTS.md`, agent: "opencode", scope: "user", kind: "opencode-md", bytes: 0, exists: false, lines: 0, modifiedAt: "" }),
  src({ id: "copilot:memory", path: "copilot:memory", agent: "copilot", scope: "user", kind: "copilot-memory", bytes: 0, access: "online", reason: "Stored by GitHub, not on this machine. Use /memory in Copilot CLI." }),
  src({ id: appMemory, path: appMemory, agent: "claude", accountId: claudeAcc, scope: "project", kind: "claude-auto-memory", projectPath: APP, isDirectory: true, files: 28, bytes: 71_200, lines: 44, slug: slug(APP), readBy: ["claude"], loaded: loaded(6120, "MEMORY.md at launch; 28 memory files read on demand.") }),
  src({ id: dataMemory, path: dataMemory, agent: "claude", accountId: claudeAcc, scope: "project", kind: "claude-auto-memory", projectPath: DATA, isDirectory: true, files: 12, bytes: 30_400, lines: 19, readBy: ["claude"], loaded: loaded(2410) }),
  src({ id: notesMemory, path: notesMemory, agent: "claude", accountId: claudeAcc, scope: "project", kind: "claude-auto-memory", projectPath: NOTES, isDirectory: true, files: 6, bytes: 14_900, lines: 9, readBy: ["claude"], loaded: loaded(1100) }),
  src({ id: oldMemory, path: oldMemory, agent: "claude", accountId: claudeAcc, scope: "project", kind: "claude-auto-memory", isDirectory: true, files: 3, bytes: 5_300, lines: 4, slug: slug(OLD), readBy: ["claude"], loaded: loaded(380) }),
  src({ id: `${APP}/CLAUDE.md`, path: `${APP}/CLAUDE.md`, agent: "claude", scope: "project", kind: "claude-md", projectPath: APP, bytes: 18_020, lines: 212, readBy: ["claude", "copilot", "omp"], loaded: loaded(18_020), versionControlled: true, reason: "In a git repository: a change here shows up in git." }),
  src({ id: `${APP}/AGENTS.md`, path: `${APP}/AGENTS.md`, agent: "codex", scope: "project", kind: "agents-md", projectPath: APP, bytes: 21_430, readBy: ["codex", "opencode", "pi", "copilot"], loaded: loaded(21_430), versionControlled: true }),
  src({ id: `${DATA}/AGENTS.md`, path: `${DATA}/AGENTS.md`, agent: "codex", scope: "project", kind: "agents-md", projectPath: DATA, bytes: 9_120, readBy: ["codex", "claude"], loaded: loaded(9_120), versionControlled: true }),
];

// Long, unbroken real-world shapes for ?long. All made up.
const URL_LONG = "https://docs.example.com/platform/engineering/runbooks/payments/webhooks/retry-and-idempotency/handling-duplicate-deliveries-from-the-payment-provider-sandbox-and-production-environments?section=backoff-schedule&version=2026-09-01";
const TOKEN_LONG = "c2FtcGxlLWJhc2U2NC1wYXlsb2FkLXRoYXQtbmV2ZXItYnJlYWtzLWJlY2F1c2UtaXQtaGFzLW5vLXNwYWNlcy1hdC1hbGwtYW5kLWp1c3Qta2VlcHMtZ29pbmctZm9yLWV2ZXI=";
const CODE_LONG = `const retryPolicy = createRetryPolicy({ provider: "demo-payments", maxAttempts: 3, backoff: exponentialBackoff({ initialDelayMs: 250, maxDelayMs: 30_000, jitter: "full" }), idempotencyKey: (event) => \`\${event.accountId}:\${event.invoiceId}:\${event.attempt}\`, onGiveUp: (event) => deadLetterQueue.publish("payments.webhooks.failed", event) });`;
const TABLE_WIDE = "| Environment | Webhook endpoint | Signing secret variable | Retry window | Owner team | Alert channel |\n|---|---|---|---|---|---|\n| staging | https://staging.example.com/api/v2/payments/webhooks/provider-callback | DEMO_PAYMENTS_STAGING_WEBHOOK_SIGNING_SECRET | 72 hours | platform-payments-and-billing | #payments-alerts-staging |\n| production | https://www.example.com/api/v2/payments/webhooks/provider-callback | DEMO_PAYMENTS_PRODUCTION_WEBHOOK_SIGNING_SECRET | 72 hours | platform-payments-and-billing | #payments-alerts-production |";
const LONG_ENTRY = { key: "reference_payment_provider_webhook_retry_backoff_schedule_and_idempotency_key_format_for_all_environments.md", title: "Payment provider webhook retries follow the documented backoff schedule and every handler must be idempotent across environments", description: `Where the retry schedule lives: ${URL_LONG}`, type: "reference", indexed: false, shape: "nested", bytes: 4830, lines: 58, secrets: 0 };

const memoryEntries = [
  { key: "payments_retry_limit.md", title: "Payment webhooks retry three times", description: "Why failed webhooks stop after the third try", type: "project", indexed: true, shape: "nested", bytes: 1830, lines: 22, secrets: 0 },
  { key: "feedback_short_answers.md", title: "Keep answers short", description: "How Sam likes answers written", type: "feedback", indexed: true, shape: "flat", bytes: 640, lines: 9, secrets: 0 },
  { key: "staging_deploys.md", title: "Staging deploys go through the CI job", description: "Which job deploys staging", type: "reference", indexed: true, shape: "flat-session", bytes: 910, lines: 12, secrets: 1 },
  { key: "search_index_choice.md", title: "Search uses the built-in index", description: "Why there is no separate search service", type: "project", indexed: false, shape: "nested", bytes: 1204, lines: 15, secrets: 0 },
  ...(long ? [LONG_ENTRY] : []),
].map((e) => ({ extra: {}, path: `${appMemory}/${e.key}`, modifiedAt: ago(48), ...e }));

const bodies: Record<string, { body: string; fields?: any }> = {
  [`${appMemory}#payments_retry_limit.md`]: {
    fields: { name: "Payment webhooks retry three times", description: "Why failed webhooks stop after the third try", type: "project" },
    body: "\nThe payment provider retries a failed webhook three times, then gives up. `handleWebhook()` must answer within 5 s or the retry counts.\n\n**Why:** a slow handler caused duplicate charges in the demo shop.\n\n**How to apply:** queue the work and answer at once; see `src/payments/webhook.ts`.\n" + (long ? `\nRunbook: ${URL_LONG}\n\nSample payload hash: ${TOKEN_LONG}\n\n${CODE_LONG}\n` : ""),
  },
  [`${appMemory}#staging_deploys.md`]: { fields: { name: "Staging deploys go through the CI job", description: "Which job deploys staging", type: "reference" }, body: "\nStaging is deployed by the `deploy-staging` CI job.\nDeploy token: tok_live_1a2b3c4d5e6f7g8h9i0jKLMNOPQRSTUV\n" },
  [codexIndex]: { body: "# Codex memory\n\n## Tooling\n\n- Use the project's package manager; never mix lock files.\n- Tests run with the built-in runner.\n\n## People\n\n- Sam reviews database changes.\n" },
  [`${H}/.claude/CLAUDE.md`]: { body: "# How I work\n\nI run the marketing team. Keep answers short and friendly.\n\n## Writing style\n\nPlain words, short sentences. No jargon unless I use it first.\n\n## Reports\n\nWeekly reports go to the shared drive folder \"Team reports\", named by date.\n\n## Meetings\n\nI prefer summaries as three bullet points: what was decided, who does what, and by when.\n" },
  [`${APP}/CLAUDE.md`]: { body: "# Acme web\n\nA small web shop. State lives in one store; server data is fetched per page.\n\n## Testing\n\nRun the tests before every commit.\n" + (long ? `\n## Payments\n\n${TABLE_WIDE}\n\n\`\`\`ts\n${CODE_LONG}\n\`\`\`\n\nSee ${URL_LONG}\n` : "") },
};

const longFindings = long ? [
  { id: "l1", kind: "stale-path", severity: "warn", sourceIds: [appMemory], entryKeys: [LONG_ENTRY.key], message: `${LONG_ENTRY.key} in ${tilde(APP)} mentions ${tilde(OLD)}/packages/checkout-experiment/src/payments/webhooks/retry-handler.ts, which no longer exists on this machine.`, action: { label: `Update ${LONG_ENTRY.key}`, kind: "edit", sourceId: appMemory, key: LONG_ENTRY.key } },
  { id: "l2", kind: "secret", severity: "error", sourceIds: [`${APP}/CLAUDE.md`], entryKeys: [], message: `${tilde(APP)}/CLAUDE.md holds a value that looks like a secret: ${TOKEN_LONG.slice(0, 12)}•••• near ${URL_LONG}`, action: { label: "Move the secret out of this file", kind: "edit", sourceId: `${APP}/CLAUDE.md` } },
] : [];
const findingsData = empty ? [] : [
  ...longFindings,
  { id: "s1", kind: "secret", severity: "error", sourceIds: [appMemory], entryKeys: ["staging_deploys.md"], message: 'A memory in acme-web, "Staging deploys go through the CI job", holds a value that looks like a secret. Every agent that loads it can see it.', action: { label: "Move the secret out of memory", kind: "edit", sourceId: appMemory, key: "staging_deploys.md" } },
  { id: "p1", kind: "codex-pending", severity: "warn", sourceIds: [codexIndex], entryKeys: [], message: "Codex hasn't finished its last clean-up. When it next runs it may remove memory backed by 42 deleted inputs, and it will fold in your edit at the same time. (As of 2026-09-24.)", action: { label: "Read this before editing Codex's memory", kind: "open", sourceId: codexIndex } },
  { id: "o1", kind: "over-limit", severity: "warn", sourceIds: [`${APP}/CLAUDE.md`], entryKeys: [], message: `${APPT}/CLAUDE.md has 212 lines; Claude's docs suggest under 200.`, action: { label: "Shorten CLAUDE.md", kind: "edit", sourceId: `${APP}/CLAUDE.md` } },
  { id: "i1", kind: "index-drift", severity: "warn", sourceIds: [appMemory], entryKeys: ["search_index_choice.md"], message: "search_index_choice.md in acme-web is not in MEMORY.md, so Claude does not know it is there.", action: { label: "Add search_index_choice.md to MEMORY.md", kind: "edit", sourceId: appMemory, key: "search_index_choice.md" } },
  { id: "d1", kind: "duplicate", severity: "info", sourceIds: [appMemory, `${APP}/AGENTS.md`], entryKeys: [], message: "The same text is in 2 places: acme-web: Keep answers short; acme-web: Writing style.", action: { label: 'Delete the copy "Keep answers short"', kind: "delete", sourceId: appMemory, key: "feedback_short_answers.md" } },
  { id: "t1", kind: "stale-path", severity: "info", sourceIds: [dataMemory, appMemory], entryKeys: [], message: `14 memories mention ${tilde(OLD)}/…, which no longer exists on this machine.`, action: { label: `Update the mentions of ${tilde(OLD)}`, kind: "edit", sourceId: dataMemory } },
  { id: "c1", kind: "conflict", severity: "info", heuristic: true, sourceIds: [appMemory, `${H}/.codex/AGENTS.md`], entryKeys: [], message: 'Possible conflict (a guess): "Release process" appears in 2 places with different text: acme-web: Release process; ~/.codex/AGENTS.md: Release process.', action: { label: 'Compare the "Release process" entries and keep one', kind: "review", sourceId: appMemory } },
];

const planItems = (agent: string) => {
  const item = (order: number, label: string, kind: string, when: string, bytes: number, extra: any = {}) => ({ order, label, kind, when, bytes, loadedBytes: when === "launch" ? (extra.loadedBytes ?? bytes) : 0, tokens: when === "launch" ? Math.ceil((extra.loadedBytes ?? bytes) / 4) : 0, truncated: false, note: "", ...extra });
  if (agent === "claude") return [
    item(0, "~/.claude/CLAUDE.md", "claude-md", "launch", 5120, { path: `${H}/.claude/CLAUDE.md`, sourceId: `${H}/.claude/CLAUDE.md`, scope: "user" }),
    item(1, "~/.claude/rules/testing.md", "claude-rule", "launch", 612, { scope: "user" }),
    item(2, `${APPT}/CLAUDE.md`, "claude-md", "launch", 18020, { scope: "project", path: `${APP}/CLAUDE.md`, sourceId: `${APP}/CLAUDE.md` }),
    item(3, `${APPT}/AGENTS.md`, "agents-md", "skipped", 21430, { note: "A project CLAUDE.md exists, so Claude does not read AGENTS.md (default mode).", scope: "project" }),
    item(4, `${APPT}/src/extensions/CLAUDE.md`, "claude-md", "on-demand", 2230, { note: "Subfolder file: loads when Claude reads a file there.", scope: "project", path: `${APP}/src/extensions/CLAUDE.md` }),
    item(5, `Auto memory (${tilde(appMemory)})`, "claude-auto-memory", "launch", 71200, { loadedBytes: 6120, note: "MEMORY.md at launch; 28 memory files read on demand.", scope: "project", path: appMemory, sourceId: appMemory }),
    item(6, "Paseo: append to system prompt", "paseo-prompt", "launch", 412, { note: "Appended to Claude's system prompt. New and relaunched agents only.", scope: "host" }),
  ];
  if (agent === "codex") return [
    item(0, "~/.codex/AGENTS.md", "agents-md", "launch", 2210, { scope: "user" }),
    item(1, `${APPT}/AGENTS.md`, "agents-md", "launch", 21430, { scope: "project" }),
    item(2, "~/.codex/memories/memory_summary.md", "codex-memory", "launch", 6400, { scope: "user" }),
    item(3, "~/.codex/memories/MEMORY.md", "codex-memory", "on-demand", 18200, { note: "Searched on demand, never injected.", scope: "user" }),
    item(4, "Paseo: append to system prompt", "paseo-prompt", "launch", 412, { note: "Sent as Codex developer instructions. New and relaunched agents only.", scope: "host" }),
  ];
  if (agent === "copilot") return [item(0, "Copilot Memory (stored online)", "copilot-memory", "skipped", 0, { note: "Not shown here." }), item(1, `${APPT}/CLAUDE.md`, "claude-md", "launch", 18020), item(2, `${APPT}/AGENTS.md`, "agents-md", "launch", 21430)];
  return [item(0, "~/.claude/CLAUDE.md", "claude-md", "launch", 5120, { note: "OpenCode has no AGENTS.md of its own, so it reads Claude's." }), item(1, `${APPT}/AGENTS.md`, "agents-md", "launch", 21430), item(2, "Paseo: append to system prompt", "paseo-prompt", "launch", 412)];
};
const plan = (agent: string) => {
  const items = empty ? [] : planItems(agent);
  const bytes = items.reduce((sum: number, item: any) => sum + item.loadedBytes, 0);
  return { agent, providerId: agent, directory: APP, configDir: agent === "claude" ? `${H}/.claude` : agent === "codex" ? `${H}/.codex` : undefined, items, total: { bytes, tokens: Math.ceil(bytes / 4) }, notes: agent === "copilot" ? ["Copilot merges every file and drops duplicates; there is no precedence order.", "Paseo's appended prompt does not reach Copilot (an ACP provider)."] : [], unsure: [] };
};

const groupsOf = () => {
  const map = new Map<string, any>();
  for (const s of sources) {
    const key = `${s.agent}|${s.accountId ?? ""}|${s.scope}`;
    const g = map.get(key) ?? { key, agent: s.agent, accountId: s.accountId, scope: s.scope, sourceIds: [], bytes: 0, files: 0, loadedTokens: 0, lastChanged: "" };
    g.sourceIds.push(s.id); g.bytes += s.bytes; g.files += s.isDirectory ? s.files : s.exists ? 1 : 0; g.loadedTokens += s.loaded.tokens; g.lastChanged = s.modifiedAt;
    map.set(key, g);
  }
  return [...map.values()];
};

const stamp = { size: 100, mtimeMs: now, hash: "f".repeat(64) };
const detailOf = (id: string) => {
  const source = sources.find((s) => s.id === id) ?? src({ id, path: id, agent: "claude", scope: "project", kind: "claude-md", bytes: 0 });
  if (source.kind === "claude-auto-memory") return { source, stamp, entries: source.id === appMemory ? memoryEntries : memoryEntries.slice(0, 2), index: { lines: [], missingFiles: [], unindexedFiles: ["search_index_choice.md"], loadedLines: 44, loadedBytes: 6120, truncated: false }, imports: [], warnings: ["1 memory file is not named in MEMORY.md."] };
  const codex = source.kind === "codex-memory" ? { lock: "free", lockReason: "No consolidation is running.", pending: findingsData.find((f) => f.id === "p1")!.message, pendingInfo: { asOf: ago(3), deletions: 42, failedOn: ago(10) }, lastJob: { status: "error", finishedAt: ago(10), error: true }, kept: { status: "none", detail: "No edit from this plugin." } } : undefined;
  return { source, stamp, entries: [{ key: "1:tooling", title: "Tooling", extra: {}, bytes: 60, lines: 4, secrets: 0 }, { key: "2:people", title: "People", extra: {}, bytes: 40, lines: 3, secrets: 0 }], imports: [], ...(codex ? { codex } : {}), warnings: source.kind === "claude-md" && source.lines > 200 ? [`${source.lines} lines; Claude's docs suggest keeping CLAUDE.md under 200.`] : [] };
};

const importText = (long ? `## Webhook retry runbook\n\n${CODE_LONG}\n\n${TABLE_WIDE}\n\nSee ${URL_LONG}\n\n` : "") + "## Release checklist\n\nTag from main only after the staging smoke tests pass.\n\n## Keep answers short\n\nThree sentences at most unless asked.\n\n## CI token\n\nUse token: tok_live_1a2b3c4d5e6f7g8h9i0jKLMNOPQRSTUV for preview deploys.\n";

function answer(name: string, input: any): unknown {
  switch (name) {
    case "inventory": return { checkedAt: new Date().toISOString(), accounts: empty ? accounts.slice(0, 2) : accounts, sources, groups: groupsOf(), counts: { claudeMemoryFolders: empty ? 0 : 9, claudeMemoryFiles: empty ? 0 : 48, codexHomes: 1, projects: empty ? 0 : 4, sources: sources.length, bytes: sources.reduce((a, s) => a + s.bytes, 0) }, findings: [], checked: [empty ? "Checked 0 Claude memory folders in 1 Claude config folder, 1 Codex home and 0 projects." : "Checked 9 Claude memory folders in 2 Claude config folders, 1 Codex home and 4 projects."], notes: empty ? [] : ['1 Claude memory folder is for projects whose path is not known here ("other projects").'] };
    case "findings": return { checkedAt: new Date().toISOString(), findings: findingsData, nextStep: findingsData.length ? { title: findingsData[0]!.action.label, detail: `${findingsData[0]!.message} ${findingsData.length - 1} more things to look at below.`, action: findingsData[0]!.action } : { title: "Nothing needs tidying", detail: "No duplicates, stale mentions, secrets or over-limit files were found." }, checked: ["Checked 120 memories and sections in 18 sources, and 64 path mentions."], notes: empty ? [] : ["Relative paths in 1 Claude memory folder whose project path is unknown were not checked; only absolute paths were."], symbolScan: { state: "done", asOf: new Date().toISOString(), note: "Code names checked against 4 projects." } };
    case "source": return detailOf(input.sourceId);
    case "entry": {
      const hit = bodies[input.key ? `${input.sourceId}#${input.key}` : input.sourceId] ?? bodies[input.sourceId] ?? { body: "Notes about this project.\n" };
      const masked = maskSecrets(hit.body);
      return { body: input.reveal ? hit.body : masked.text, ...(hit.fields ? { fields: hit.fields } : {}), masked: !input.reveal && masked.count > 0, secrets: masked.count, secretKinds: masked.kinds, stamp, path: input.sourceId };
    }
    case "workspace-plan": return { directory: APP, plans: ["claude", "codex", "opencode", "copilot"].map(plan), checkedAt: new Date().toISOString() };
    case "agent-plan": return { directory: APP, plan: plan(input.providerId || "codex"), checkedAt: new Date().toISOString() };
    case "search": if (long) return { query: input.query, total: 2, checked: `Checked 9 Claude projects, 1 Codex store and 14 other files.`, results: [
      { sourceId: appMemory, key: LONG_ENTRY.key, agent: "claude", scope: "project", projectPath: APP, title: LONG_ENTRY.title, snippet: `…${input.query}: retries follow ${URL_LONG} and hash ${TOKEN_LONG}…` },
      { sourceId: `${APP}/CLAUDE.md`, key: "", agent: "claude", scope: "project", projectPath: APP, title: `${tilde(APP)}/CLAUDE.md`, snippet: CODE_LONG },
    ] };
      return { query: input.query, results: [], total: 0, checked: `Checked 9 Claude projects, 1 Codex store and 14 other files: none mention '${input.query}'.` };
    case "prompt-get": return { value: "Answer briefly. Prefer small functions.", bytes: 412, tokens: 103, providers: ["claude", "codex", "opencode", "pi", "omp"], note: "Agents started or relaunched from now on get it; running agents keep what they started with. Copilot (ACP) never gets it." };
    case "import-parse": { const parsed = parseImport(input.text ?? "", undefined, input.format); return { items: parsed.items, formats: [{ name: "pasted text", format: parsed.format, items: parsed.items.length }], warnings: parsed.warnings }; }
    case "import-preview": {
      const items = input.items ?? [];
      const before = bodies[`${APP}/CLAUDE.md`]!.body;
      return {
        target: { kind: input.target.kind, label: input.target.kind === "claude-memory" ? "Claude memory for acme-web" : `${APPT}/CLAUDE.md`, path: input.target.path ?? appMemory, exists: true, stamp: input.target.kind === "append" ? stamp : null, access: "editable" },
        items: items.map((item: any, index: number) => ({ id: item.id, title: item.title, action: input.target.kind === "claude-memory" ? "create" : "append", ...(input.target.kind === "claude-memory" ? { fileName: `${item.title.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.md` } : {}), diff: compactDiff(lineDiff(before, `${before}\n${asSection(item)}`)).map((line) => ({ ...line, text: maskSecrets(line.text).text })), duplicate: index === 1 ? "exact" : "none", ...(index === 1 ? { duplicateOf: "Writing style" } : {}), masked: false, warnings: index === 2 ? ["Holds values that look like secrets; they are hidden here and saved as they are."] : [] })),
        checked: `Compared with 4 sections already in ${APPT}/CLAUDE.md.`,
      };
    }
    case "import-apply": return { ok: true, message: `Imported ${input.selected.length} items into ${APPT}/CLAUDE.md.`, reports: [{ target: `${APP}/CLAUDE.md`, ok: true, action: "updated", readBack: "ok", backupPath: `${H}/.paseo/plugin-data/paseo-memories/backups/2026-09-24T12-00-00-000Z-a1b2c3${APP}/CLAUDE.md`, versionControlled: true }], warnings: ["This file is in a git repository: the change shows up in git."] };
    case "note-preview": {
      const project = input.workspaceId ? (input.workspaceId === "ws-1" ? "acme-web" : "demo-api") : undefined;
      const claude = project ? { id: appMemory, agent: "claude", kind: "claude-memory", label: `Claude's notes for ${project}`, path: appMemory, creates: false, shared: false, private: true, warnings: [], duplicate: "none", stamp: null } : { id: `${H}/.claude/CLAUDE.md`, agent: "claude", kind: "append", label: "Your instructions for Claude", path: `${H}/.claude/CLAUDE.md`, creates: false, shared: false, private: true, warnings: [], duplicate: "near", duplicateOf: "Writing style", stamp };
      const codex = project ? { id: `${APP}/AGENTS.md`, agent: "codex", kind: "append", label: `Project instructions · ${project} (shared with the team)`, path: `${APP}/AGENTS.md`, creates: false, shared: true, private: false, warnings: ["Everyone who works on this project will see this note."], duplicate: "none", stamp } : { id: `${H}/.codex/AGENTS.md`, agent: "codex", kind: "append", label: "Your instructions for Codex", path: `${H}/.codex/AGENTS.md`, creates: false, shared: false, private: true, warnings: [], duplicate: "none", stamp };
      // demo-api has no project file of Claude's own, so Claude reads its project instructions: one note is enough.
      const covered = input.who === "all" && project === "demo-api";
      const targets = input.who === "claude" ? [claude] : input.who === "codex" || covered ? [codex] : [claude, codex];
      const skipped = covered ? [{ agent: "claude", reason: "Claude reads the project instructions too, so one note is enough.", covered: true }] : [];
      return { title: String(input.text).split("\n")[0]!.slice(0, 60), ...(project ? { project } : {}), targets, skipped, warnings: maskSecrets(input.text).count ? ["This note contains something that looks like a password or key. Anyone whose agent reads it can see it. Remove it?"] : [] };
    }
    case "note-add": return { ok: true, message: "Saved. New agents will follow it; agents already running won't see it until they restart.", reports: [], warnings: input.workspaceId ? ["Everyone who works on this project will see this note."] : [] };
    case "export": return { text: JSON.stringify({ format: "paseo-memories", version: 1, exportedAt: new Date().toISOString(), host: "demo-host", items: memoryEntries.map((e) => ({ agent: "claude", scope: "project", kind: "claude-auto-memory", projectHint: APP, title: e.title, description: e.description, type: e.type, body: e.secrets ? "Deploy token: tok_••••••••\n" : `${e.description}.\n`, masked: e.secrets > 0 })) }, null, 2), fileName: long ? "paseo-memories-demo-build-host-with-a-long-docker-container-name-2026-09-24.json" : "paseo-memories-2026-09-24.json", count: 120, masked: 1, units: [] };
    case "claude-update": case "claude-create": case "claude-delete": case "instruction-write": case "prompt-set": return { ok: true, message: "Saved.", reports: [{ target: input.path ?? input.sourceId, ok: true, action: "updated", readBack: "ok", backupPath: `${H}/.paseo/plugin-data/paseo-memories/backups/2026-09-24T12-00-00-000Z-a1b2c3/x` }], warnings: [] };
    case "codex-write": return input.confirmPending ? { ok: true, message: "Saved. Codex folds this in at its next run; wording may change.", reports: [], warnings: [] } : { ok: false, needsConfirm: true, message: findingsData.find((f) => f.id === "p1")!.message, reports: [], warnings: [] };
    default: throw new Error(`Fixture has no answer for ${name}`);
  }
}

async function call(contract: any, input: unknown) {
  calls += 1;
  await new Promise((resolve) => setTimeout(resolve, 60));
  if (failed || (stale && calls > 3)) throw new Error("Plugin RPC timed out: paseo-memories.inventory");
  return answer(String(contract.name).replace("paseo-memories.", ""), input);
}

export function useRpc(contract: any) { return useCallback((input: unknown) => call(contract, input), [contract]) as any; }
export function usePaseo() { return { workspaces: { list: async () => ({ entries: empty ? [] : [{ id: "ws-1", name: long ? "acme-web-storefront-platform-rebuild · feature-checkout-payment-provider-webhook-retry-handling" : "acme-web", workspaceDirectory: APP, projectRootPath: APP }, { id: "ws-2", name: "demo-api", workspaceDirectory: DATA, projectRootPath: DATA }] }) } } as any; }
export function useWorkspace<T>(_id: string, select: (workspace: { name: string; directory: string }) => T): T { return select({ name: long ? "acme-web-storefront-platform-rebuild" : "acme-web", directory: APP }); }
export function useAgent<T>(_id: string, select: (agent: { provider: string; model: string | null }) => T): T { return select({ provider: params.get("provider") ?? "codex", model: "gpt-5-codex" }); }
// ?technical: the 0.1 view with file names and paths; plain (?plain, or nothing) is the default.
const settingsValues: Record<string, unknown> = { showOtherAgents: true, staleChecks: true, maskSecrets: true, codexEdits: true, backupsToKeep: 20, technicalDetails: params.has("technical") };
export function useSettings(_definition: unknown) {
  return { status: "ready" as const, values: settingsValues, revision: "fixture", saving: false, saveError: null, async save(values: Record<string, unknown>) { Object.assign(settingsValues, values); return true; }, async reset() { return true; }, async reload() {} };
}
export function useToast() { return { show: (message: string) => console.info("[toast]", message), error: (message: string) => console.info("[toast:error]", message) }; }
export async function copyText(_text: string) {}
export const ScrollView = RNScrollView;
export const TextInput = RNTextInput;
const row = (label: string, hint?: string, children?: React.ReactNode) => <View style={{ padding: 12, gap: 4 }}><Text style={{ fontWeight: "600" }}>{label}</Text>{hint ? <Text style={{ opacity: 0.7 }}>{hint}</Text> : null}{children}</View>;
export const SettingsSection = ({ title, children }: any) => <View style={{ gap: 8, padding: 12 }}><Text style={{ fontSize: 16, fontWeight: "700" }}>{title}</Text>{children}</View>;
export const SettingsGroup = SettingsSection;
export const SettingsCard = ({ children }: any) => <View style={{ borderWidth: 1, borderColor: "#8884", borderRadius: 8 }}>{children}</View>;
export const SettingsRow = ({ label, hint, children }: any) => row(label, hint, children);
export const SettingsSwitch = ({ label, hint, value, onValueChange }: any) => row(label, hint, <Text onPress={() => onValueChange(!value)}>{value ? "On" : "Off"}</Text>);
export const SettingsSelect = ({ label, hint, value, options, onValueChange }: any) => row(label, hint, <View style={{ flexDirection: "row", gap: 8 }}>{options.map((o: any) => <Text key={o.value} onPress={() => onValueChange(o.value)} style={{ fontWeight: o.value === value ? "700" : "400" }}>{o.label}</Text>)}</View>);
export const SettingsInput = ({ label, hint }: any) => row(label, hint);
export const SettingsAction = ({ label, actionLabel, onPress }: any) => row(label, undefined, <Text onPress={onPress}>{actionLabel}</Text>);
export const Icon = ({ name, size = 16, color }: { name: string; size?: number; color?: string }) => <Text style={{ fontSize: size - 4, color, fontWeight: "700" }} accessibilityLabel={name}>{name.replace(/[a-z]/g, "").slice(0, 2)}</Text>;
export { importText, appMemory, codexIndex, APP, H };
