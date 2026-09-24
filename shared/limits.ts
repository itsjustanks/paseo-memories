/**
 * What each agent loads, in numbers. Sources are in
 * memories-research/{claude-code,codex}.md; the non-obvious ones are cited here.
 */

/** Claude Code loads the first 200 lines or 25,000 bytes of MEMORY.md (CLI 2.1.280: `WO=200,zW=25000`). */
export const CLAUDE_MEMORY_INDEX_LINES = 200;
export const CLAUDE_MEMORY_INDEX_BYTES = 25_000;

/** A CLAUDE.md over 4 MiB is skipped whole ("[CLAUDE.md] skipping … byte limit" in the CLI). */
export const CLAUDE_MD_MAX_BYTES = 4 * 1024 * 1024;

/** `@path` imports are followed at most this many hops. */
export const CLAUDE_IMPORT_HOPS = 4;

/** Advisory only: the docs suggest keeping CLAUDE.md under 200 lines. */
export const CLAUDE_MD_ADVISORY_LINES = 200;

/** Claude's project folder name is cut here, then `-` and a base36 hash (CLI `kT`, `gQ=200`). */
export const CLAUDE_SLUG_MAX = 200;

/** Codex `project_doc_max_bytes` default: 32 KiB across all project docs (codex-rs config_toml.rs:75). */
export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

/** Codex injects `memory_summary.md` cut to 2,500 tokens (codex-rs ext/memories/src/lib.rs:16). */
export const CODEX_MEMORY_SUMMARY_TOKENS = 2_500;

/** Codex rebuilds `memory_summary.md` from scratch unless line 1 is exactly this (consolidation.md:146-148). */
export const CODEX_SUMMARY_FIRST_LINE = "v1";

/** Always shown with "≈": a rough rule, not any agent's tokenizer. */
export function tokensFor(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / 4);
}

export function lineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** UTF-8 byte length without Buffer, so shared code stays pure. */
export function byteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * How much of MEMORY.md Claude reads: whole lines up to 200, stopping before
 * the byte cap. Returns the loaded byte count and whether it was cut.
 */
export function claudeIndexLoad(text: string): { bytes: number; lines: number; truncated: boolean; reason?: "lines" | "bytes" } {
  const lines = text.split("\n");
  const total = byteLength(text);
  let bytes = 0;
  let count = 0;
  for (let i = 0; i < lines.length && count < CLAUDE_MEMORY_INDEX_LINES; i += 1) {
    const isLast = i === lines.length - 1;
    if (isLast && lines[i] === "") break;
    const lineBytes = byteLength(lines[i]!) + (isLast ? 0 : 1);
    if (bytes + lineBytes > CLAUDE_MEMORY_INDEX_BYTES) {
      return { bytes, lines: count, truncated: true, reason: "bytes" };
    }
    bytes += lineBytes;
    count += 1;
  }
  const truncated = bytes < total;
  return truncated ? { bytes, lines: count, truncated, reason: "lines" } : { bytes, lines: count, truncated };
}
