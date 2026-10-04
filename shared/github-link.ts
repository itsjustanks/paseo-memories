/**
 * A GitHub link as a person pastes it, read into owner, repository, an
 * optional branch, tag or commit, and an optional folder. Pure. Anything that
 * is not plainly one of these shapes is refused with a sentence, never
 * guessed:
 *
 *   owner/repo                      owner/repo@v1.2
 *   owner/repo/path/to/skill        owner/repo/path/to/skill@main
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/<ref>/<path>
 *   https://github.com/owner/repo/blob/<ref>/<path>/SKILL.md
 *
 * A `tree/<ref>` is read as one path segment; a branch with a slash in its
 * name can be given with `@` instead. (After the read-only paseo-skills
 * scaffold `shared/github.ts`, with the `@ref` form added.)
 */

export type GithubLink = { owner: string; repo: string; ref?: string; path?: string };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,199}$/;
const SEGMENT = /^[A-Za-z0-9._@+ -]{1,200}$/;

function cleanPath(parts: string[]): string | null {
  const kept = parts.filter((part) => part !== "");
  if (kept.some((part) => part === "." || part === ".." || !SEGMENT.test(part))) return null;
  if (kept[kept.length - 1]?.toLowerCase() === "skill.md") kept.pop();
  return kept.join("/");
}

function refOk(ref: string): boolean {
  return REF.test(ref) && !ref.includes("..") && !ref.endsWith("/");
}

export function parseGithubLink(raw: string): GithubLink | { error: string } {
  let text = raw.trim();
  if (!text) return { error: "Paste a GitHub link, or owner/repository." };
  if (text.length > 500 || /[\s<>"'`\\]/.test(text)) return { error: "That link has characters a GitHub address doesn't." };
  text = text.replace(/^git\+/, "").replace(/[?#].*$/, "");
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(text);
  if (/^[a-z]+:\/\//i.test(text) && !url) return { error: "Only github.com links can be added here." };
  if (/^http:\/\//i.test(text)) text = text.replace(/^http:/i, "https:");
  let rest = (url ? url[1]! : text).replace(/\/+$/, "");
  let atRef: string | undefined;
  const at = rest.lastIndexOf("@");
  if (!url && at > 0) {
    atRef = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!refOk(atRef)) return { error: "The branch, tag or version after @ can't be read." };
  }
  const parts = rest.split("/");
  const owner = parts[0] ?? "";
  const repo = (parts[1] ?? "").replace(/\.git$/i, "");
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return { error: "That doesn't look like a GitHub owner/repository. Try the address of the skill's folder on github.com." };
  const tail = parts.slice(2);
  if (tail.length === 0) return { owner, repo, ...(atRef ? { ref: atRef } : {}) };
  if (url && (tail[0] === "tree" || tail[0] === "blob")) {
    const ref = tail[1] ?? "";
    if (!refOk(ref)) return { error: "The branch or tag in that link can't be read." };
    const path = cleanPath(tail.slice(2));
    if (path === null) return { error: "The folder in that link can't be read." };
    return { owner, repo, ref, ...(path ? { path } : {}) };
  }
  if (url && ["pulls", "issues", "releases", "commit", "commits", "actions", "wiki", "tree", "blob"].includes(tail[0]!)) {
    return { error: "Link to the skill's folder (…/tree/main/…), not to a page about the repository." };
  }
  const path = cleanPath(tail);
  if (path === null) return { error: "The folder in that link can't be read." };
  return { owner, repo, ...(atRef ? { ref: atRef } : {}), ...(path ? { path } : {}) };
}

export function repoId(link: Pick<GithubLink, "owner" | "repo">): string {
  return `${link.owner}/${link.repo}`;
}

/** A path inside a repository as a URL path: each segment encoded. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
