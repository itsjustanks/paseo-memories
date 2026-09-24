import { CLAUDE_SLUG_MAX } from "./limits";

/**
 * Claude Code's project folder name for a path (CLI 2.1.280 `kT`): every
 * UTF-16 unit outside [a-zA-Z0-9] becomes `-`; past 200 characters it is cut
 * to 200, then `-` and the base36 of the absolute Java-style string hash of
 * the ORIGINAL path (`AQ`: `h = (h << 5) - h + code | 0`).
 *
 * Lossy (`/a.b` and `/a_b` meet), so map forward from known paths only.
 */
export function claudeSlug(path: string): string {
  const slug = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length <= CLAUDE_SLUG_MAX) return slug;
  return `${slug.slice(0, CLAUDE_SLUG_MAX)}-${Math.abs(javaHash(path)).toString(36)}`;
}

export function javaHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return hash;
}
