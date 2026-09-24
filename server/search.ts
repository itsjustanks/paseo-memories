import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { SearchResult } from "../shared/contracts";
import { maskSecrets } from "../shared/secrets";
import { buildCorpus } from "./corpus";
import type { Paseo } from "./daemon";
import { discover } from "./discover";

/**
 * Search titles and bodies of every memory and section. Results carry a
 * short snippet around the match, masked, never a whole body. A match that
 * falls inside a secret is reported without text.
 */

const SNIPPET = 80;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export async function searchFor(paseo: Paseo | null, query: string, limit = 50) {
  const discovery = await discover(paseo);
  const units = await buildCorpus(discovery);
  const needle = query.trim().toLowerCase();
  const hits: SearchResult[] = [];
  for (const unit of units) {
    const inTitle = unit.title.toLowerCase().includes(needle);
    const masked = maskSecrets(unit.text).text;
    const at = masked.toLowerCase().indexOf(needle);
    const inBody = unit.text.toLowerCase().includes(needle);
    if (!inTitle && !inBody) continue;
    let snippet: string;
    if (at >= 0) {
      const start = Math.max(0, at - SNIPPET);
      const end = Math.min(masked.length, at + needle.length + SNIPPET);
      snippet = `${start > 0 ? "…" : ""}${masked.slice(start, end).replace(/\s+/g, " ").trim()}${end < masked.length ? "…" : ""}`;
    } else snippet = inBody ? "(the match is inside a hidden value)" : maskSecrets(unit.text.slice(0, SNIPPET * 2)).text.replace(/\s+/g, " ").trim();
    hits.push({
      sourceId: unit.sourceId,
      key: unit.key,
      title: unit.title,
      snippet,
      agent: unit.agent,
      scope: unit.scope,
      path: unit.path,
      ...(unit.projectPath ? { projectPath: unit.projectPath } : {}),
      inTitle,
    });
  }
  hits.sort((a, b) => Number(b.inTitle) - Number(a.inTitle));
  const folders = discovery.sources.filter((source) => source.kind === "claude-auto-memory").length;
  const codex = discovery.accounts.accounts.filter((account) => account.agent === "codex" && account.exists).length;
  const others = discovery.sources.filter((source) => source.exists && source.kind !== "claude-auto-memory").length;
  const scope = `Checked ${plural(folders, "Claude project")}, ${plural(codex, "Codex store")} and ${plural(others, "other file")}`;
  return {
    query,
    results: hits.slice(0, limit),
    total: hits.length,
    checked: hits.length ? `${scope}: ${plural(hits.length, "match", "matches")}.` : `${scope}: none mention '${query.trim()}'.`,
  };
}

export const handleSearch = ({ query, limit }: { query: string; limit?: number }, { paseo }: PluginHandlerContext) => searchFor(paseo, query, limit);
