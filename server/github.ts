import { createHash } from "node:crypto";
import { encodePath, type GithubLink } from "../shared/github-link";
import { ADD_LIMITS } from "../shared/skill-files";

/**
 * GitHub, read-only and without a token: the plugin's only network code,
 * reached only from "Add a skill" (preview and add), never from a read. It
 * calls nothing else (no skills.sh, no telemetry). Every answer is
 * size-capped before it is held, redirects are refused, and every file is
 * checked against the repository's own record of it (its git blob id), so
 * the bytes added are the bytes at the pinned commit. (After the read-only
 * paseo-skills scaffold `server/github.ts`; size caps as paseo-mcp's
 * `server/library.ts`.)
 */

const TIMEOUT_MS = 15_000;
const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init);

/** For tests: answer network calls from a fake (null puts the real one back). */
export function setGithubFetch(next: FetchLike | null): void {
  fetchImpl = next ?? ((url, init) => globalThis.fetch(url, init));
}

export class GithubError extends Error {}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const tooBig = () => new GithubError(`GitHub answered with more than ${Math.round(maxBytes / 1024)} KB, more than a skill should need.`);
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function get(url: string, accept: string, maxBytes: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers: { accept, "user-agent": "paseo-memories" }, signal: controller.signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) throw new GithubError("GitHub sent this address somewhere else (the repository may have moved or been renamed). Use its current address.");
    if (response.status === 404) throw new GithubError("GitHub has nothing at that address. Check the owner, repository, branch and folder; private repositories can't be added here.");
    if (response.status === 403 || response.status === 429) {
      const left = response.headers.get("x-ratelimit-remaining");
      throw new GithubError(left === "0" ? "GitHub's hourly limit for this computer is used up. Try again in an hour." : "GitHub refused the request. Try again in a few minutes.");
    }
    if (!response.ok) throw new GithubError(`GitHub answered with an error (${response.status}). Try again in a moment.`);
    return await readCapped(response, maxBytes);
  } catch (error) {
    if (controller.signal.aborted) throw new GithubError(`GitHub did not answer within ${TIMEOUT_MS / 1000} seconds.`);
    if (error instanceof GithubError) throw error;
    throw new GithubError("Could not reach GitHub from this computer.");
  } finally {
    clearTimeout(timer);
  }
}

/** The commit a branch, tag or the default branch points at now. */
export async function resolveCommit(link: GithubLink): Promise<string> {
  if (link.ref && /^[0-9a-f]{40}$/.test(link.ref)) return link.ref;
  const ref = link.ref ? encodeURIComponent(link.ref) : "HEAD";
  const text = (await get(`${API}/repos/${link.owner}/${link.repo}/commits/${ref}`, "application/vnd.github.sha", 1024)).toString("utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(text)) throw new GithubError("GitHub did not say which version that is.");
  return text;
}

export type TreeEntry = { path: string; mode: string; type: string; sha: string; size?: number };
export type Tree = { sha: string; entries: TreeEntry[]; truncated: boolean };

export async function fetchTree(link: Pick<GithubLink, "owner" | "repo">, commit: string): Promise<Tree> {
  const body = await get(`${API}/repos/${link.owner}/${link.repo}/git/trees/${commit}?recursive=1`, "application/vnd.github+json", ADD_LIMITS.treeBytes);
  let parsed: { sha?: unknown; tree?: unknown; truncated?: unknown };
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new GithubError("GitHub's list of files could not be read.");
  }
  if (typeof parsed.sha !== "string" || !Array.isArray(parsed.tree)) throw new GithubError("GitHub's list of files could not be read.");
  const entries: TreeEntry[] = [];
  for (const raw of parsed.tree as Array<Record<string, unknown>>) {
    if (typeof raw?.path !== "string" || typeof raw.mode !== "string" || typeof raw.type !== "string" || typeof raw.sha !== "string") continue;
    entries.push({ path: raw.path, mode: raw.mode, type: raw.type, sha: raw.sha, ...(typeof raw.size === "number" ? { size: raw.size } : {}) });
  }
  return { sha: parsed.sha, entries, truncated: parsed.truncated === true };
}

/** git's blob id of some bytes. */
export function blobId(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** One file at a commit, checked against its blob id. */
export async function fetchFile(link: Pick<GithubLink, "owner" | "repo">, commit: string, entry: TreeEntry): Promise<Buffer> {
  const bytes = await get(`${RAW}/${link.owner}/${link.repo}/${commit}/${encodePath(entry.path)}`, "application/octet-stream", ADD_LIMITS.fileBytes);
  if (blobId(bytes) !== entry.sha) throw new GithubError(`${entry.path} did not match GitHub's own record of it, so nothing was added.`);
  return bytes;
}

/** Folders holding a SKILL.md, in tree order (the repository root is ""). */
export function skillFolders(tree: Tree): string[] {
  return tree.entries
    .filter((entry) => entry.type === "blob" && (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")))
    .map((entry) => (entry.path === "SKILL.md" ? "" : entry.path.slice(0, -"/SKILL.md".length)));
}

/**
 * Whether a commit is on the repository's default branch (it, or an older
 * commit of it). GitHub serves commits from forks under the original's
 * address, so an id alone doesn't prove whose it is. False when it isn't
 * there, or when GitHub can't say: the caller warns, it doesn't refuse.
 */
export async function onMainLine(link: Pick<GithubLink, "owner" | "repo">, commit: string): Promise<boolean> {
  try {
    const repo = JSON.parse((await get(`${API}/repos/${link.owner}/${link.repo}`, "application/vnd.github+json", 256 * 1024)).toString("utf8")) as { default_branch?: unknown };
    if (typeof repo.default_branch !== "string" || !repo.default_branch) return false;
    const compare = JSON.parse((await get(`${API}/repos/${link.owner}/${link.repo}/compare/${encodeURIComponent(repo.default_branch)}...${commit}`, "application/vnd.github+json", 4 * 1024 * 1024)).toString("utf8")) as { status?: unknown };
    return compare.status === "behind" || compare.status === "identical";
  } catch {
    return false;
  }
}
