/**
 * Skills this plugin suggests, each pinned to one commit of a public
 * repository, so what you preview is exactly what gets added whoever pushes
 * next. Checked on 2026-10-04 against GitHub's file list at that commit:
 * the folder's files, their modes, and the name in each SKILL.md header
 * (which equals the folder name for every entry).
 *
 * `scripts`: the folder holds files other than instructions and text, which
 * an agent may run (webapp-testing: Python helpers, one executable;
 * systematic-debugging: a TypeScript example and an executable shell
 * script). Adding one of those needs an explicit confirm. The preview checks
 * the downloaded files again and the stricter answer wins.
 *
 * To update an entry: pick the new commit, preview it, read every file, then
 * change `commit` and `tree` here.
 */

export type CatalogEntry = {
  id: string;
  title: string;
  blurb: string;
  publisher: string;
  owner: string;
  repo: string;
  commit: string;
  path: string;
  /** GitHub's tree id for the folder at `commit` (also what `npx skills` records). */
  tree: string;
  license: string;
  files: number;
  scripts: boolean;
};

const ANTHROPIC = { publisher: "Anthropic", owner: "anthropics", repo: "skills", commit: "8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4", license: "Apache-2.0" } as const;
const SUPERPOWERS = { publisher: "Superpowers (Jesse Vincent)", owner: "obra", repo: "superpowers", commit: "8ca22dba9a94f28898bbce59f2537ff4d87c747d", license: "MIT" } as const;

export const CATALOG: readonly CatalogEntry[] = [
  { id: "test-driven-development", title: "Test first", blurb: "Writes a failing test first, then the code that makes it pass, for every feature and fix.", ...SUPERPOWERS, path: "skills/test-driven-development", tree: "847144cf0824095922c0d4875648b9fa74877e1a", files: 2, scripts: false },
  { id: "writing-plans", title: "Plan before coding", blurb: "Turns a request into a short step-by-step plan before any code is touched.", ...SUPERPOWERS, path: "skills/writing-plans", tree: "cc97fa00eb2ccd4f283e34eb2ba06a48e1e679f7", files: 1, scripts: false },
  { id: "verification-before-completion", title: "Check before saying done", blurb: "Runs the checks and reads their output before claiming anything works.", ...SUPERPOWERS, path: "skills/verification-before-completion", tree: "a4cb0b69aaefeab540947a7f1642bdaad810e37a", files: 1, scripts: false },
  { id: "receiving-code-review", title: "Taking review feedback", blurb: "Weighs review comments on their merits instead of agreeing with everything.", ...SUPERPOWERS, path: "skills/receiving-code-review", tree: "b5e154fc3ec7a6a0b1e710eebacc2168620cc428", files: 1, scripts: false },
  { id: "systematic-debugging", title: "Systematic debugging", blurb: "Finds the real cause of a bug before changing anything: reproduce, narrow down, then fix.", ...SUPERPOWERS, path: "skills/systematic-debugging", tree: "9a48dfda84bf339cba4b03fd803ba0dca2e158e3", files: 11, scripts: true },
  { id: "frontend-design", title: "Front-end design", blurb: "Gives new screens a clear visual direction instead of the usual template look.", ...ANTHROPIC, path: "skills/frontend-design", tree: "d79e2a5bb4df4a386c2adcdd9ab8709bba28c3f6", files: 2, scripts: false },
  { id: "doc-coauthoring", title: "Writing documents together", blurb: "Walks you through drafting a proposal, spec or guide, one section at a time.", ...ANTHROPIC, path: "skills/doc-coauthoring", tree: "d9df960e61fe2bafe9183e37de6f9f6b73b74087", files: 1, scripts: false },
  { id: "internal-comms", title: "Team updates", blurb: "Writes status reports, updates and newsletters in the formats teams expect.", ...ANTHROPIC, path: "skills/internal-comms", tree: "9869687dcf6deb6802ca88ac11e67b6f7278017a", files: 6, scripts: false },
  { id: "brand-guidelines", title: "Brand look and feel", blurb: "Applies one brand's colours and type to documents and slides (Anthropic's own, as an example to copy).", ...ANTHROPIC, path: "skills/brand-guidelines", tree: "1dc8bd3584b80568edae7da16382363e24ecf0f0", files: 2, scripts: false },
  { id: "webapp-testing", title: "Testing web apps in a browser", blurb: "Opens your local web app in a browser to click through it, take screenshots and read its logs.", ...ANTHROPIC, path: "skills/webapp-testing", tree: "5ffb7dc66b9fd4c25c3e400a4c00da99a349b714", files: 6, scripts: true },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.id === id);
}

/** The skill's folder name: the last part of its path. */
export function catalogName(entry: Pick<CatalogEntry, "path">): string {
  return entry.path.split("/").pop() ?? entry.path;
}
