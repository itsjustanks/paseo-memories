# Memories (`paseo-memories`)

A Paseo plugin that shows, edits, imports, exports and tidies what your coding agents remember on a host: Claude Code, Codex, Paseo's own appended prompt, OpenCode, pi, Oh My Pi and Copilot CLI. It works at user and project level, per agent and per account. The spec is `docs/SPEC.md`.

## For everyone

Memories shows what your AI agents remember and follow, in plain words, and lets you change it.

- **Add a note** (on the Overview) teaches your agents something once: write it, choose who follows it and where, check it, save it. New agents follow it straight away.
- **Everywhere** holds the notes that go with you into every project; **Projects** holds the notes for one project. Open one to change or remove a note.
- **Worth a look** on the Overview points out notes with passwords in them, notes that say the same thing twice, and notes that mention things that are gone.
- **Guide** has short how-tos, including moving your notes to another Paseo computer.

Nothing technical shows unless you ask for it: turn on **Show technical details** in Settings → Memories for file names, paths, sizes and whole-file editing. The rest of this page is the technical side.

## Install

Needs Paseo 0.8.0 or later. On the daemon host:

```sh
paseo plugin add git:https://github.com/itsjustanks/paseo-memories.git
```

Update with `paseo plugin update paseo-memories`. Memories are per daemon: to move a set to another daemon, export a bundle on one and import it on the other.

## What it does

- **Memories** in the sidebar, with five tabs:
  - **Overview**: what each agent and account remembers (files, size, ≈tokens loaded at launch), the top things to tidy, exactly one next step, and a search across every memory and instruction file.
  - **User**: files every agent of yours reads, grouped by agent and account (default folders, AgentLink slots, Paseo providers with their own `CLAUDE_CONFIG_DIR` / `CODEX_HOME`).
  - **Projects**: Paseo's workspaces first, then other known folders, then Claude memory for projects whose path is unknown. Each source opens a viewer or editor; Claude memories can be created, edited, renamed, deleted, copied and moved.
  - **Import & Export**: paste or pick files (a bundle, markdown split at its headings, Claude memory files, claude.ai `[date] - text` lines, Cursor `.mdc` rules), preview the diff and duplicates, then save the items you tick. Export a bundle or markdown, secrets hidden unless you include them.
  - **Guide**: how each agent loads memory, with the real numbers.
- **Workspace panel**: what an agent started in this workspace loads, per provider, in order, with sizes and ≈tokens. **Agent panel**: the same for one agent's provider and account.
- **Tidy checks** (plain code, no LLM): exact and near duplicates, possible conflicts (labelled a guess), paths and code names that no longer exist, `MEMORY.md` lines that point nowhere or files missing from it, over-limit files, values that look like secrets, and a pending Codex clean-up. Each comes with one suggested action.

Numbers used (checked against Claude Code 2.1.280, codex-cli 0.156.1 and their docs): `MEMORY.md` loads its first 200 lines or 25,000 bytes; `@imports` go 4 hops; a CLAUDE.md over 4 MiB is skipped; AGENTS.md is read by Claude only when the project has no CLAUDE file of its own (default); Codex project docs share 32 KiB; Codex injects `memory_summary.md` cut to ≈2,500 tokens; Paseo's appended prompt reaches Claude, Codex, OpenCode, pi and Oh My Pi, never ACP providers. Tokens are bytes ÷ 4, always shown with ≈.

## What is read-only, and why

| Source | Why |
|---|---|
| Managed CLAUDE.md and managed rules | Set by your organisation. |
| Codex `raw_memories.md`, `rollout_summaries/`, `extensions/`, `phase2_workspace_diff.md`, `memories_*.sqlite`, `.git` | Codex rebuilds or owns them; edits are lost or confuse it. `extensions/` resources are pruned after 7 days. |
| Codex `developer_instructions`, OpenCode `instructions[]` | They live in config files. |
| Oh My Pi generated memory | Rebuilt by Oh My Pi. |
| Copilot Memory | Stored online by GitHub. |

Codex's `memories/MEMORY.md` and `memory_summary.md` **can** be edited. Codex treats a hand edit as signal and folds it in at its next run, so the wording may change; the detail view says afterwards whether it kept your lines. Saves are refused while Codex holds its clean-up lock, or when that can't be read for certain: the plugin opens Codex's sqlite read-only, only for a save or the Codex detail view. `memory_summary.md` must keep `v1` as line 1. If a clean-up is still pending, the save warns you ("Codex hasn't finished its last clean-up… may remove memory backed by N deleted inputs…") and needs a confirm.

## Safety

Every save goes through one path (`server/write.ts`):

1. The old bytes are copied to `$PASEO_HOME/plugin-data/paseo-memories/backups/<time>/<same path>`, never next to the file. The last 20 copies per file are kept.
2. The new text goes to a temp file beside the target, is synced, then renamed over it. The file keeps its mode; new files are 0600 in agent folders and 0644 in repositories.
3. The file is read back and parsed. Each target gets a report: backup path, read-back ok or mismatch, git warning.
4. Refused on the host, whatever the app sends: read-only sources, a file that changed since you opened it (size, mtime, sha256), and a hand edit that still carries hidden values. Imports may carry hidden values on purpose, and warn instead.
5. Memory text never reaches a log: only RPC names, paths and outcomes.

Reads use async fs only, cache by file stat, and start no process. The code-name check scans project source in the background, bounded, and only while an app is connected.

## Settings

Under **Settings → Memories** (host scope, `$PASEO_HOME/plugin-settings/paseo-memories/memories.json`): show technical details (off by default: plain names and note cards), show other agents, check for stale mentions, hide secrets, allow Codex memory edits, backups kept per file.

## Development and checks

```sh
npm install
npm run typecheck
npm test            # sandbox HOME only; fails on any write outside it
npm run smoke       # read-only inventory, findings and export of your real HOME: counts only
npm run preview:ui  # fixture preview at 127.0.0.1:43299 (PREVIEW_PORT to change)
```

Preview parameters: plain view by default (`?plain`), `?technical` for the technical view, `?add` (Add a note; `?add=ws-1` in a project), `?notes` (instructions as note cards), `?tab=user|projects|transfer|guide`, `?memory`, `?codex`, `?import`, `?export`, `?workspace`, `?agent&provider=claude`, `?settings`, `?dark`, `?empty`, `?error`, `?stale`.

Client bundle check (Paseo's esbuild; no `node:` import may be reachable from `client/`):

```sh
/Applications/Paseo.app/Contents/Resources/app.asar.unpacked/node_modules/esbuild/bin/esbuild index.client.tsx --bundle --platform=neutral --format=esm --jsx=automatic --outfile=/tmp/paseo-memories-client.js --external:react --external:react/jsx-runtime --external:react-native --external:zod --external:'@getpaseo/*' --external:'@tanstack/*'
```

Tests copy `tests/fixtures/home` into a temp folder and point HOME, PASEO_HOME and every agent variable at it before importing server code.
