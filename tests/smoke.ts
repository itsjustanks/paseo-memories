/**
 * Read-only smoke run against the REAL home: the inventory and one load plan
 * per agent for this folder, printed as counts and sizes only. No memory
 * text, no writes, no daemon (Paseo's own prompt shows as unknown).
 *
 *   npm run smoke            # inventory + plans for the current folder
 *   npm run smoke -- <dir>   # plans for another folder
 */
import { AGENT_LABELS, tilde } from "../shared/agents";
import { formatBytes, formatTokens } from "../shared/format";

const { inventoryFor, workspacePlans } = await import("../server/read");
const { findingsFor } = await import("../server/tidy");
const { searchFor } = await import("../server/search");
const { pendingSettled } = await import("../server/codex-pending");
const { exportMemories } = await import("../server/transfer");
const { statSync, readdirSync } = await import("node:fs");
const { join } = await import("node:path");
const { discover } = await import("../server/discover");
const { userHome } = await import("../server/env");

// Codex's database files, to prove this run did not touch them.
const codexDir = join(process.env.HOME ?? "", ".codex");
const sqliteStamp = () => {
  try {
    return readdirSync(codexDir).filter((name) => /^memories_\d+\.sqlite/.test(name)).map((name) => `${name} ${statSync(join(codexDir, name)).mtimeMs}`).sort().join("\n");
  } catch {
    return "(no Codex home)";
  }
};
const sqliteBefore = sqliteStamp();
const began = Date.now();
const inv = await inventoryFor(null, true);
const ms = Date.now() - began;
const home = userHome();

console.log(`Inventory in ${ms} ms (no daemon: Paseo's appended prompt not read)`);
console.log(`  Claude memory folders: ${inv.counts.claudeMemoryFolders}`);
console.log(`  Claude memory files:   ${inv.counts.claudeMemoryFiles}`);
console.log(`  Codex homes:           ${inv.counts.codexHomes}`);
console.log(`  Projects checked:      ${inv.counts.projects}`);
console.log(`  Sources:               ${inv.counts.sources} (${formatBytes(inv.counts.bytes)})`);
console.log("Accounts:");
for (const account of inv.accounts) console.log(`  ${account.agent.padEnd(8)} ${account.origin.padEnd(12)} ${tilde(account.dir, home)}${account.exists ? "" : " (missing)"}`);
console.log("Groups (agent / scope: sources, files, size, ≈tokens at launch):");
for (const group of inv.groups.sort((a, b) => a.key.localeCompare(b.key))) {
  console.log(`  ${(AGENT_LABELS[group.agent] ?? group.agent).padEnd(12)} ${group.scope.padEnd(8)} ${String(group.sourceIds.length).padStart(4)} src ${String(group.files).padStart(5)} files ${formatBytes(group.bytes).padStart(9)} ${formatTokens(group.loadedTokens)}`);
}
const folders = inv.sources.filter((source) => source.kind === "claude-auto-memory");
const unknown = folders.filter((source) => !source.projectPath).length;
const over = folders.filter((source) => source.loaded.note.includes("is cut")).length;
console.log(`Claude folders: ${folders.length} (${folders.length - unknown} mapped to a project path, ${unknown} "other projects"), ${over} with MEMORY.md over the limit`);
const codex = inv.sources.filter((source) => source.kind === "codex-memory" || source.kind === "codex-generated");
for (const source of codex) console.log(`  codex ${source.access.padEnd(9)} ${tilde(source.path, home)} ${formatBytes(source.bytes)}`);
for (const line of [...inv.checked, ...inv.notes]) console.log(`  ${line}`);

const directory = process.argv[2] ?? process.cwd();
const discovery = await discover(null);
console.log(`Load plans for ${tilde(directory, home)}:`);
for (const { raw } of await workspacePlans(discovery, directory)) {
  const launch = raw.items.filter((item) => item.when === "launch");
  const bytes = launch.reduce((sum, item) => sum + item.loadedBytes, 0);
  console.log(`  ${(AGENT_LABELS[raw.agent] ?? raw.agent).padEnd(12)} ${String(launch.length).padStart(3)} at launch, ${formatBytes(bytes).padStart(9)}, ${formatTokens(Math.ceil(bytes / 4))}; ${raw.items.filter((item) => item.when === "on-demand").length} on demand; ${raw.unsure.length} unsure`);
}

const tidyStart = Date.now();
await findingsFor(null);
await pendingSettled();
const tidy = await findingsFor(null);
const byKind = new Map<string, number>();
for (const finding of tidy.findings) byKind.set(finding.kind, (byKind.get(finding.kind) ?? 0) + 1);
console.log(`Findings in ${Date.now() - tidyStart} ms: ${tidy.findings.length} (${[...byKind].map(([kind, n]) => `${kind} ${n}`).join(", ")}); code-name scan: ${tidy.symbolScan.state} (not run without a connected app)`);
console.log(`  ${tidy.checked[0]}`);
const hits = await searchFor(null, "pnpm");
console.log(`Search 'pnpm': ${hits.total} matches`);
const exported = await exportMemories(null, { selection: { scope: "all" }, format: "bundle" });
console.log(`Export (all, masked): ${exported.count} items, ${exported.masked} masked, ${formatBytes(exported.text.length)} (not written anywhere)`);
const sqliteAfter = sqliteStamp();
console.log(`Codex sqlite files unchanged: ${sqliteBefore === sqliteAfter ? "yes" : "NO"}`);
