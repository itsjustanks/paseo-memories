import { sha256Hex } from "./hash";

/**
 * The files of a skill about to be added: which are instructions and which
 * an agent might run, the plan an add is bound to, and text from outside
 * cleaned before it is shown. Pure.
 */

/** Caps for anything fetched from GitHub. */
export const ADD_LIMITS = { files: 200, fileBytes: 1024 * 1024, totalBytes: 2 * 1024 * 1024, treeBytes: 8 * 1024 * 1024 } as const;

/** Instructions and text: what a skill made only of these can hold. Anything else may be run by an agent. */
const TEXT_EXT = /\.(md|markdown|mdx|txt)$/i;
const TEXT_NAMES = new Set(["license", "licence", "notice", "readme", "copying", "authors"]);

export type FileKind = "instructions" | "script";

export type PlannedFile = {
  /** Relative to the skill folder, `/`-separated. */
  path: string;
  bytes: number;
  executable: boolean;
  kind: FileKind;
};

/** Executable bit (git mode 100755 or the stat mode), a `#!` first line, or anything not instructions or text. */
export function fileKind(path: string, executable: boolean, head: Uint8Array | null): FileKind {
  if (executable) return "script";
  if (head && head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) return "script";
  const name = path.split("/").pop() ?? path;
  if (TEXT_EXT.test(name)) return "instructions";
  if (!name.includes(".") && TEXT_NAMES.has(name.toLowerCase())) return "instructions";
  return "script";
}

/** A relative path inside a skill that is safe to create: no `..`, no absolute parts, no hidden folders except files, no control characters. */
export function safeRelativePath(path: string): boolean {
  if (!path || path.length > 400 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== ".." && !/[\u0000-\u001f\u007f]/.test(part)) && !parts.slice(0, -1).some((part) => part === ".git");
}

/**
 * What an add is bound to: where it came from (the exact commit), the name
 * it gets, every file's path, size, kind and content hash, and the places it
 * will be written. The add RPC takes this back and refuses when it no longer
 * matches, so nothing changed after the preview is written unseen.
 */
export function planHash(input: { source: string; commit: string; name: string; files: Array<PlannedFile & { sha256: string }>; targets: string[] }): string {
  return sha256Hex(JSON.stringify([input.source, input.commit, input.name, input.files.map((file) => [file.path, file.bytes, file.kind, file.executable, file.sha256]), input.targets]));
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/**
 * Characters that change how text reads without being seen: bidi controls,
 * zero-width characters and the other control characters (paseo-mcp
 * `shared/catalog.ts` `cleanText`, copied).
 */
const INVISIBLE = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff]|${LONE_SURROGATE.source}`, "g");

/** Text from outside (a skill's name or description) as it may be shown: one line, nothing invisible. */
export function cleanText(text: string): string {
  return text.replace(/[\t\n\r]+/g, " ").replace(INVISIBLE, "").trim();
}

/** At most `max` UTF-16 units, cut between code points. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const point of text) {
    if (out.length + point.length > max - 1) break;
    out += point;
  }
  return `${out}…`;
}
