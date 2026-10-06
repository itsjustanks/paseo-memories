# Memories & Skills (`paseo-memories`)

A Paseo plugin with two pages. **Memories** shows, edits, imports, exports and tidies what your coding agents remember on a host. **Skills** (0.4.0) shows which skills your agents have and which ones they actually use, and adds, turns off and removes them safely. The plugin id stays `paseo-memories`, so existing installs and settings update in place.

Memories covers: Claude Code, Codex, Paseo's own appended prompt, OpenCode, pi, Oh My Pi and Copilot CLI. It works at user and project level, per agent and per account. The specs are `docs/SPEC.md` (Memories) and `docs/SKILLS-SPEC.md` (Skills).

## For everyone

Memories shows what your AI agents remember and follow, in plain words, and lets you change it.

- **Add a note** (on the Overview) teaches your agents something once: write it, choose who follows it and where, check it, save it. New agents follow it straight away.
- **Everywhere** holds the notes that go with you into every project; **Projects** holds the notes for one project. Open one to change or remove a note.
- **Worth a look** on the Overview points out notes with passwords in them, notes that say the same thing twice, and notes that mention things that are gone.
- **Help** answers common questions, each folded, including how to move your notes to another Paseo computer. **Bring notes in** and **Take a copy out** sit at the bottom of Everywhere and Projects.

**Skills** is the second item in the sidebar:

- **Overview** says in one card how many skills Claude and Codex can use, what that list costs at the start of every chat, and which skills were used lately, with one next step.
- **Your skills** lists every skill by where it lives. Open one to read it, turn it off for Claude or Codex (nothing is deleted), or remove one you added (a copy is kept).
- **Usage** shows which skills ran in the last 7, 30 or 90 days. Claude's counts are exact; Codex's are estimates.
- **Add a skill** (the button on Your skills or the Overview, or the "+" beside Skills in the sidebar): pick one from a short checked list, bring one from a GitHub link, or write your own. You see every file first; a skill that includes code your agents may run needs an extra confirm.
- **Help** answers common questions, each folded, with the technical details folded at the end.

Common jobs are commands too (Paseo's command center): "Add a note for your agents", "Tidy memories", "Add a skill", "Open Skills". In a chat, `/remember <text>` starts Add a note for that project, and `/memories` opens what that agent remembers. When something is worth a look, a small dot shows beside Memories or Skills in the sidebar from the moment Paseo opens; press it for a quick look (how many, the biggest kinds, Show me). Nothing is added to the chat composer.

Nothing technical shows unless you ask for it: turn on **Show technical details** in Settings → Memories & Skills for file names, paths, sizes and whole-file editing. The rest of this page is the technical side.

## Install

Needs Paseo 0.8 or later; best on 0.11 (remembers where you were, "+" in the sidebar). On the daemon host:

```sh
paseo plugin add git:https://github.com/itsjustanks/paseo-memories.git
```

Update with `paseo plugin update paseo-memories`. Memories are per daemon: to move a set to another daemon, export a bundle on one and import it on the other.

## What it does

- **Memories** in the sidebar (a native screen and sidebar row on Paseo 0.11+), with four tabs (0.5.0). Each starts with its own content, at most one plain sentence; the less-used and technical parts fold into rows at the bottom:
  - **Overview**: a status card with what each agent and account remembers (files, size, ≈tokens loaded at launch) and exactly one next step, then the top things to tidy, a search across every memory and instruction file, and a short guide (what Memories is, how it works, how to use it, the words it uses).
  - **User** ("Everywhere"): files every agent of yours reads, grouped by agent and account (default folders, AgentLink slots, Paseo providers with their own `CLAUDE_CONFIG_DIR` / `CODEX_HOME`).
  - **Projects**: Paseo's workspaces first, then other known folders, then Claude memory for projects whose path is unknown. Each source opens a viewer or editor; Claude memories can be created, edited, renamed, deleted, copied and moved.
  - **Import & Export** (a page under Everywhere or Projects, opened from their "Bring notes in" / "Take a copy out" rows, a note's "Copy to another agent", or Help): paste or pick files (a bundle, markdown split at its headings, Claude memory files, claude.ai `[date] - text` lines, Cursor `.mdc` rules), preview the diff and duplicates, then save the items you tick. Export a bundle or markdown, secrets hidden unless you include them.
  - **Help** (the Guide before 0.5.0; old `tab=guide` links open it): common questions, each folded, then how each agent loads memory, with the real numbers, and links to each agent's own docs on Paseo 0.10+, folded too.
- **Workspace panel**: what an agent started in this workspace loads, per provider, in order, with sizes and ≈tokens. **Agent panel**: the same for one agent's provider and account.
- **Tidy checks** (plain code, no LLM): exact and near duplicates, possible conflicts (labelled a guess), paths and code names that no longer exist, `MEMORY.md` lines that point nowhere or files missing from it, over-limit files, values that look like secrets, and a pending Codex clean-up. Each comes with one suggested action.

Numbers used (checked against Claude Code 2.1.280, codex-cli 0.156.1 and their docs): `MEMORY.md` loads its first 200 lines or 25,000 bytes; `@imports` go 4 hops; a CLAUDE.md over 4 MiB is skipped; AGENTS.md is read by Claude only when the project has no CLAUDE file of its own (default); Codex project docs share 32 KiB; Codex injects `memory_summary.md` cut to ≈2,500 tokens; Paseo's appended prompt reaches Claude, Codex, OpenCode, pi and Oh My Pi, never ACP providers. Tokens are bytes ÷ 4, always shown with ≈.

## Skills (0.4.0)

Where skills are found (per account and project): the shared `~/.agents/skills` (Codex, OpenCode, Copilot, Gemini, Cursor and pi read it; `npx skills` installs there), each Claude account's `skills/`, its claude.ai copies (`skills/synced/<account>/`), enabled Claude plugins' `skills/`, Claude's managed `.claude/skills`, Codex's `$CODEX_HOME/skills` (and `.system`), `/etc/codex/skills`, pi's `skills/`, and each Paseo project's `.claude/skills`, `.agents/skills`, `.codex/skills` and `.pi/skills` from its folder up to the repository root. Links are followed and each real folder is one skill, with everyone who reads it.

- **Cost:** Claude keeps 1% of its model's context window for skill names and descriptions (each cut at 1,536 characters); a list is only called "over budget" when the model its agents use is known (1M-token models: `[1m]`, Fable, Sonnet 5+, Opus 4.7+; else 200K). Codex keeps 2% of its model's window; shown as a fact.
- **Usage:** counted in the background from Claude's chat logs (`Skill` tool calls and typed `/name`, exact) and Codex's (`<skill>` blocks and `SKILL.md` reads, estimated): per-file cursors, a byte budget per pass, daily counts only (90 days), never chat text; only while an app is connected. Turn it off in Settings.
- **Add:** one copy in `~/.agents/skills/<name>`, a relative link in each Claude account's `skills/`, and an entry in `npx skills`' lock file (v3, other keys kept). No link for pi: it reads the shared folder. The curated list is pinned to commits; GitHub links are fetched over HTTPS only, pinned to the commit they resolve to, at most 200 files and 2 MB, every file checked against GitHub's own hash. Nothing is written until the preview's plan hash is sent back unchanged.
- **Turn off:** Claude `skillOverrides` in the account's `settings.json` (honoured in user settings; not for plugin skills); Codex `[[skills.config]] name = "…" enabled = false` in `config.toml`, edited line by line (a file that sets skills another way is left alone).
- **Remove:** the folder and its links move into the backups (across disks: copied, checked file by file by hash, then deleted); `npx skills`' entry goes too. A skill that is only a link loses only the link. Paseo's, plugins', claude.ai's, Codex's own and managed skills are never changed; a Paseo skill the running Paseo no longer ships can be moved to the backups.
- **Worth a look:** broken links, empty folders, stray zips, skills without instructions or with a bad header, one name with different instructions in several places, unused skills that still cost every chat, a list over budget, old Paseo skills, and `npx skills` entries with nothing on disk. Each has one action, done on the host.

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

Under **Settings → Memories & Skills** (host scope, `$PASEO_HOME/plugin-settings/paseo-memories/memories.json`): show technical details (off by default: plain names and note cards), show other agents, check for stale mentions, hide secrets, allow Codex memory edits, backups kept per file, count skill use (on), and how many days of skill use to show (30).

## Development and checks

```sh
npm install
npm run typecheck
npm test            # sandbox HOME only; fails on any write outside it
npm run smoke       # read-only inventory, findings and export of your real HOME: counts only
npm run preview:ui  # fixture preview at 127.0.0.1:43299 (PREVIEW_PORT to change)
```

Preview parameters: plain view by default (`?plain`), `?technical` for the technical view, `?add` (Add a note; `?add=ws-1` in a project), `?notes` (instructions as note cards), `?tab=user|projects|transfer|help` (`guide` still works), `?memory`, `?codex`, `?import`, `?export`, `?workspace`, `?agent&provider=claude`, `?settings`, `?dark`, `?empty`, `?error`, `?stale`, `?nolinks` (an app without `openExternalUrl`). The preview runs the real client entry against a fake Paseo 0.11 app (screen params in the URL as `param.*`); `?legacy` stands in for Paseo 0.10, `?chrome` adds the app sidebar and header, `?popover` opens Add a note from the sidebar "+". Skills: `?skills` (`=skills|usage|add|help` for a tab), `?skill` (a skill open), `?addskill=catalog|github|write`, `?skillpopover` (Add a skill from the Skills row's "+").

Client bundle check (Paseo's esbuild; no `node:` import may be reachable from `client/`):

```sh
/Applications/Paseo.app/Contents/Resources/app.asar.unpacked/node_modules/esbuild/bin/esbuild index.client.tsx --bundle --platform=neutral --format=esm --jsx=automatic --outfile=/tmp/paseo-memories-client.js --external:react --external:react/jsx-runtime --external:react-native --external:zod --external:'@getpaseo/*' --external:'@tanstack/*'
```

Tests copy `tests/fixtures/home` into a temp folder and point HOME, PASEO_HOME and every agent variable at it before importing server code.
