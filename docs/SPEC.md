# Memories (`paseo-memories`) — v1 spec

Approved by the user on 2026-09-24. Research with citations (read it first; it's outside the repo because it holds local inventory):
`memories-research/{claude-code,codex,other-agents-paseo,paseo-mcp-scaffold}.md` (kept outside this repository)

## Goal
One place to see, edit, import, export and tidy what coding agents remember, per daemon:
user level, workspace/project level, per agent and per account.

## Sources and access

| Agent | Source | Scope | Access |
|---|---|---|---|
| Claude | managed `CLAUDE.md` (macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`; check the docs for Linux) | managed | read-only |
| Claude | `<cfg>/CLAUDE.md`, `<cfg>/rules/**/*.md` | user | editable |
| Claude | per folder, root → cwd: `CLAUDE.md` or `.claude/CLAUDE.md`, then `CLAUDE.local.md`; `.claude/rules/**/*.md` | project | editable (warn: version-controlled, except `CLAUDE.local.md`) |
| Claude | auto-memory `<cfg>/projects/<slug>/memory/` (`MEMORY.md` + one file per memory) | project | editable, one entry per file, `MEMORY.md` line kept in sync |
| Codex | `$CODEX_HOME/AGENTS.override.md` or `AGENTS.md` (first non-empty) | user | editable |
| Codex/shared | per folder, git root → cwd: `AGENTS.override.md` > `AGENTS.md` > `project_doc_fallback_filenames` | project | editable |
| Codex | generated `memories/MEMORY.md`, `memories/memory_summary.md` | user | editable WITH guardrails (below) |
| Codex | `raw_memories.md`, `rollout_summaries/`, `extensions/`, `memories_*.sqlite`, `.git` | user | read-only (Codex regenerates them / owns them) |
| Paseo | `daemon.appendSystemPrompt` via `paseo.config.get()/patch()` | host | editable (new and relaunched agents; ACP providers don't get it) |
| OpenCode | `~/.config/opencode/AGENTS.md` (else falls back to `~/.claude/CLAUDE.md`); project `AGENTS.md` > `CLAUDE.md` > `CONTEXT.md`; `opencode.json` `instructions[]` | user/project | files editable; `instructions[]` read-only |
| pi | `~/.pi/agent` (or `PI_CODING_AGENT_DIR`) then ancestors: first of `AGENTS.override.md`/`AGENTS.md`/`CLAUDE.md`; `SYSTEM.md` (replaces), `APPEND_SYSTEM.md` | user/project | editable (warn on SYSTEM.md) |
| omp | `~/.omp/agent/AGENTS.md`, nearest `.omp/AGENTS.md`, `RULES.md`; generated memory | user/project | files editable; generated read-only |
| Copilot | `~/.copilot/copilot-instructions.md` (`COPILOT_HOME`), `~/.copilot/instructions/**/*.instructions.md`, `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md` | user/project | editable; Copilot Memory = "stored online", not shown |
| Cursor, Gemini | — | — | deferred to v1.1 |

A file read by several agents (e.g. `AGENTS.md`) is ONE source with `readBy: Agent[]`.

## Accounts (config dirs)
Order: defaults (`~/.claude`, `~/.codex`), AgentLink/accounts slots (copy paseo-mcp `server/handlers.ts` slot + identity code), then provider env. Env layering per provider: daemon env → base provider env → `config.providers[id].env` → `expandHome` (copy paseo-mcp `server/tool-search.ts:101-103`, extend to `CODEX_HOME`). The Mac has only the defaults; the Docker daemons have slots under `/home/paseo/.agent-link` etc.

## Load estimates ("what an agent started here loads")
Tokens ≈ bytes / 4, always labelled "≈". Apply each agent's real rules:
- Claude: CLAUDE layers concatenated (≤4 MiB each, else skipped); `@imports` expanded up to 4 hops (relative to the importing file, `@~/` ok); rules without `paths:` at launch, path-scoped and subfolder files "on demand"; `AGENTS.md` only when no project `CLAUDE.md`/`.claude/CLAUDE.md`/`CLAUDE.local.md` exists at cwd or above, unless `<cfg>/settings.json` `pluginConfigs["agents-md@builtin"].options.instructionFiles` says otherwise (`claude-md-or-agents-md` default, `claude-md-and-agents-md`, `claude-md`, `managed-only`); `MEMORY.md` first 200 lines or 25,000 bytes; topic files on demand; auto-memory off if `autoMemoryEnabled:false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`; `autoMemoryDirectory` override.
- Claude slug: every char outside `[a-zA-Z0-9]` → `-` (per UTF-16 unit), >200 chars → cut to 200 + `-` + base36 hash (check the binary/docs for the exact hash). Lossy: map forward from known workspace paths; unmatched folders are "other projects (path unknown)". Worktrees share the main repo's folder: resolve the canonical root by reading `.git` file → `gitdir` → `commondir` (fs only, no git).
- Codex: user file + project docs, project docs capped at `project_doc_max_bytes` (32 KiB default) total, the crossing file is cut; the walk stops at `project_root_markers` (default `.git`), cwd only when none; memories: only `memory_summary.md`, truncated to 2,500 tokens, when `[features] memories` and `[memories] use_memories` are on; `developer_instructions`.
- Paseo `appendSystemPrompt` for claude, codex, opencode, pi, omp.

## Codex generated-memory guardrails
- Refuse to save while a consolidation holds the lock: read the Codex state sqlite (`memories_1.sqlite` or current name) READ-ONLY via lazy `await import("node:sqlite")`; look at the global consolidation job row. If `node:sqlite` is missing, the DB can't be opened, the job status is unknown, or state is otherwise unclear → refuse with a plain-English reason (don't guess). A `running` job whose lease expired over an hour ago counts as free (Codex reclaims expired leases itself); the message says so, with the lease time. A lease that expired less than an hour ago is unclear → refuse.
- `memory_summary.md` must keep exactly `v1` as line 1.
- Never write `.git`, the sqlite, `raw_memories.md`, `rollout_summaries/`, `extensions/`.
- Label: "Codex folds this in at its next run; wording may change."
- Warn: an edit triggers a consolidation (a model call) at the next Codex session. Show "consolidation pending: N inputs deleted" when the memory repo has deletions vs its baseline (read `.git` without spawning is hard: it's fine to derive this only from `phase2_workspace_diff.md` presence/age and the sqlite job state).
- After Codex's next run, show whether it kept the edit (compare against our backup).

## Tidy checks (pure code, no LLM)
duplicates (exact + near, e.g. shingled Jaccard) across agents/scopes/projects; "possible conflict" (same name/heading/topic, different text — label it a heuristic); stale paths (backticked or path-like, fs.stat relative to the project root and absolute); stale symbols (identifiers in backticks: bounded background scan of the project, skip node_modules/.git/dist/build, size and file caps, cached by stat, only while the app is connected); Claude index drift (index line → missing file; file not in index); over-limit (MEMORY.md 200 lines / 25 KB, Codex 32 KiB, CLAUDE.md > 200 lines advisory); secrets.

## Import / export
- Bundle JSON: `{ format: "paseo-memories", version: 1, exportedAt, host, items: [{ agent, scope, kind, projectHint?, title, description?, type?, body, masked }] }`. Secrets masked unless the user reveals them per item.
- Inputs: bundle; pasted/uploaded markdown (split by heading); Claude memory files (all three frontmatter shapes); claude.ai memory text (`[date] - text` lines, experimental, documented at support.claude.com/en/articles/12123587); Cursor `.mdc` rules (frontmatter `description`/`globs`/`alwaysApply`).
- Targets: Claude auto-memory (new file + index line), any editable instruction file (append section), another scope or project. "Copy into Codex" writes to an `AGENTS.md` (never to `extensions/`: resources are pruned after 7 days and consolidation then deletes what they supported).
- Every import: preview diff + dedupe against the target before writing.

## Safety (every write)
1. Back up to `$PASEO_HOME/plugin-data/paseo-memories/backups/<timestamp>/<mirrored path>` — NEVER next to the file (a `.bak` in a memory folder becomes a memory; next to a repo file it pollutes git). Keep the last N per file.
2. Write atomically: temp file in the same directory with a name no agent reads (e.g. `.paseo-memories-tmp-<rand>`), fsync, rename; keep mode; new files 0600 in agent config dirs, 0644 in repos.
3. Read back and parse (frontmatter/markdown/index); report per target `{ target, ok, backupPath, readBack: "ok" | "mismatch", error? }`.
4. Refuse writes to read-only sources server-side (not just in the UI).
5. Memory text never reaches logs (log RPC names, timings, counts, paths only). Token-looking values masked in the UI until revealed.
6. Stale-write guard: every save carries the stat (size, mtime) the user saw; refuse if the file changed since.

## Surface and panels
- Sidebar surface **Memories**, tabs: Overview · User · Projects · Import & Export · Guide (copy paseo-mcp `client/navigation.tsx` pattern).
- Overview answers "what do my agents remember, and what needs tidying", with ONE next step.
- Workspace panel: what an agent started in this workspace loads, per provider, with sizes. Agent panel: the same for that agent's provider and account.
- Plain English, restrained UI, theme colours only. Empty states say what was checked ("Checked 36 Claude projects and 1 Codex store: none mention 'supabase'").

## Settings (host scope, version 1 forever, zod default on every field)
e.g. `showOtherAgents: true`, `staleChecks: true`, `maskSecrets: true`, `codexEdits: true`, `backupsToKeep: 20`.

## Rules copied from paseo-mcp (see scaffold brief)
No blocking calls on the RPC path (async fs only; timeouts on daemon calls); panel reads spawn no processes; stat-keyed cache; background work only while an app is connected, with backoff; additive contracts; no `node:` imports reachable from `client/`; `shared/` pure; log slow RPCs by name.

## Hard rules for development
- Never write to the real HOME's memory files, CLAUDE.md, AGENTS.md or Paseo config. Tests use a sandbox HOME fixture copied into a temp dir; HOME and every env var are set before importing server code.
- A read-only smoke script against the real HOME may print counts/sizes only, never memory text.
- No GitHub repo, no push, no `paseo plugin install/add` anywhere (including the Mac) without the user's OK.

## 0.2.0: plain mode (added 2026-09-24)
- Setting `technicalDetails` (default `false`, added to the v1 document). Off: plain names (`shared/plain.ts`), "about N words" (≈tokens × 0.75), note cards for instruction files, plain Claude-note fields, task guides (`shared/guides.ts`), plain panels. On: the 0.1 view unchanged.
- Note cards edit one section through `instruction-write` `sectionKey` (`removeSection` takes one out); additions go through the import path. The whole-file editor stays, folded.
- "Add a note" (`note-preview`, `note-add`): `planNote` in `shared/notes.ts` maps Who × Where to files from each agent's load plan for the provider Paseo starts it with. Everywhere: user CLAUDE.md and the user AGENTS.md Codex reads (override when non-empty). One workspace: a new Claude auto-memory note for that project, and the project AGENTS.md Codex reads (created when missing; git warning). Never Codex generated memory, never the Paseo prompt. Saves use import-apply per target, skip exact duplicates, and refuse if the targets or files changed since the preview. All agents + one project: when Claude's plan reads that AGENTS.md at launch, the Claude note is left out ("one note is enough").
- Plain mode leaves Codex internals (`codex-generated`, `codex-config`, anything read-only Codex owns except its generated memory) out of lists, counts, findings and search.
- A test fails when a plain string contains CLAUDE.md, AGENTS.md, MEMORY.md, frontmatter, token, slug, scope, sqlite, consolidation, markdown, repo or config, or the whole words git or commit.
