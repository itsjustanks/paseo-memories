import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Probe } from "./files";

/**
 * Git facts from the filesystem alone: panel reads start no process, so no
 * `git`. A `.git` directory marks a repo root; a `.git` FILE marks a worktree
 * or submodule and holds `gitdir: <path>`; that directory's `commondir` names
 * the main repo's `.git`.
 */

/** Folders from the filesystem root down to `directory`, inclusive. */
export function ancestors(directory: string): string[] {
  const out: string[] = [];
  let current = resolve(directory);
  for (;;) {
    out.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

/** The nearest folder at or above `directory` holding any of `markers`; null when none. */
export async function findUpMarker(probe: Probe, directory: string, markers: readonly string[]): Promise<string | null> {
  if (markers.length === 0) return null;
  for (const folder of ancestors(directory).reverse()) {
    for (const marker of markers) if (await probe.exists(join(folder, marker))) return folder;
  }
  return null;
}

export function gitRoot(probe: Probe, directory: string): Promise<string | null> {
  return findUpMarker(probe, directory, [".git"]);
}

/**
 * The main checkout's root for a worktree, else the repo root, else null.
 * Claude Code keys auto memory by this: the folder "is derived from the git
 * repository, so all worktrees and subdirectories within the same repo share
 * one auto memory directory. Outside a git repo, the project root is used."
 * (code.claude.com/docs/en/memory; CLI `canonicalWcRoot`).
 */
export async function canonicalRoot(probe: Probe, directory: string): Promise<string | null> {
  const root = await gitRoot(probe, directory);
  if (!root) return null;
  const dotGit = join(root, ".git");
  if (await probe.isDir(dotGit)) return root;
  const pointer = await probe.text(dotGit);
  const match = pointer ? /^gitdir:\s*(.+?)\s*$/m.exec(pointer) : null;
  if (!match) return root;
  const gitdir = isAbsolute(match[1]!) ? match[1]! : resolve(root, match[1]!);
  const common = await probe.text(join(gitdir, "commondir"));
  if (!common?.trim()) return root; // a submodule: its own root
  const commonDir = isAbsolute(common.trim()) ? common.trim() : resolve(gitdir, common.trim());
  return commonDir.endsWith("/.git") || commonDir.endsWith("\\.git") ? dirname(commonDir) : commonDir;
}

/** A file inside a git work tree (a `.git` above it). CLAUDE.local.md callers pass `false` themselves. */
export async function versionControlled(probe: Probe, path: string): Promise<boolean> {
  return (await gitRoot(probe, dirname(path))) !== null;
}
