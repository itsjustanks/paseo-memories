# Skills inside Memories (`paseo-memories` 0.4.0) — spec

Approved by the user on 2026-10-04: the plugin becomes **Memories & Skills** and adds a second sidebar item, **Skills**. The plugin id stays `paseo-memories` (existing installs and settings update in place).

Research with citations (outside this repository; read first): `Sandbox/skills-research/{claude-code,codex-others-install,reuse-brief}.md`.
A stopped, uncommitted scaffold from another agent is in a sibling `paseo-skills` folder outside this repository (read-only reference; do not edit or commit it).

## What already exists elsewhere (don't duplicate)
`@gpambrozio/paseo-skills` (plugin id `skills`, on 4 daemons) lists skills, renders SKILL.md and invokes a skill from a composer pill. It has no usage counts and no install/turn-off/remove. Ours focuses on **usage + management + tidy**. No invoke button, no composer pill.

## Where skills live (discover per account and project)
| Agent | Source | Access |
|---|---|---|
| Claude | `<cfg>/skills/<name>/SKILL.md` (cfg = `~/.claude` or each account's `CLAUDE_CONFIG_DIR`) | editable (turn off / remove if user-added) |
| Claude | `<cfg>/skills/synced/*/` (claude.ai) | read-only |
| Claude | project `.claude/skills/` from the workspace dir up to the repo root (worktree root in worktrees) | editable, warn: shared via git if version-controlled |
| Claude | enabled plugins' `skills/` (`<cfg>/plugins/installed_plugins.json` + settings `enabledPlugins`) | read-only |
| Claude | managed (macOS `/Library/Application Support/ClaudeCode/.claude/skills`; Linux path: verify in docs) | read-only |
| Shared | `~/.agents/skills/` (read by Codex, OpenCode, Copilot, Gemini, Cursor; `npx skills` canonical) | editable |
| Codex | `$CODEX_HOME/skills/` (deprecated), `$CODEX_HOME/skills/.system/` (read-only), `/etc/codex/skills` (read-only), project `.agents/skills` walk-up, `.codex/skills` | as labelled |
| pi | `~/.pi/agent/skills`, `.pi/skills` | read-only listing in v1; install links here when pi is present |
| Paseo | any skill dir with `.paseo-managed-files.json` | **read-only** (Paseo rewrites them at daemon start) |

Dedupe by realpath; one skill may be read by several agents (`readBy`). Label provenance: Paseo, `npx skills` (entry in `~/.agents/.skill-lock.json`), added here, Claude plugin, claude.ai, Codex built-in, added by hand.

## Context cost
Show what each agent's skill list costs at the start of every chat: Claude lists name + description (+ `when_to_use`), each cut at 1,536 chars, within about 1% of the context window (descriptions are dropped past it, least-used first); Codex lists name + description (cut at 1,024) within 2% of context, default 8,000 chars. Plain mode: "about N words, read at the start of every chat".

## Usage (which skills ran)
- **Claude (exact):** `<cfg>/projects/*/*.jsonl` and `*/subagents/agent-*.jsonl`. A use is an assistant `tool_use` with `name: "Skill"` → `input.skill`, plus user `<command-name>/name</command-name>` messages that match a known skill. Keep per skill: count per day, per project (cwd), last used, session ids (for the agent panel).
- **Codex (estimated, say so):** `$CODEX_HOME/sessions/**/*.jsonl`: `<skill>…<name>X</name>` user fragments and shell/exec args reading `…/skills/<name>/SKILL.md`.
- **Scanner rules (leak lesson):** incremental append-only reads with a per-file cursor (inode, size, mtime, offset); cheap substring pre-filter before `JSON.parse`; a global byte budget per pass; small aggregates only (never keep line text or substrings: copy names with `own()`); sweep files that disappeared; only while an app is connected, with backoff; 90 days of daily buckets. Extend the scan-memory test to cover it.
- **Agent panel:** "Skills this agent can use" with "used in this chat" (map the Paseo agent to its Claude session id / Codex thread if the SDK exposes it; otherwise match by cwd + time and label it).

## Manage
- **Add a skill** (preview → plan hash → write; refuse a changed plan):
  1. Curated list shipped with the plugin (`shared/skills-catalog.ts`): 6–10 well-known skills, each pinned to a commit SHA, marked "markdown only" or "includes scripts" after checking.
  2. A GitHub link (`owner/repo[/path][@ref]`): fetch over HTTPS (GitHub API tree + raw files; no git, no npx, no spawning), pin the resolved commit, size caps (e.g. 2 MB, 200 files), text only unless confirmed; treat names/descriptions as untrusted (clean, cap).
  3. Write your own: name, "When should agents use it?", instructions → a valid SKILL.md.
  - **Skills with scripts** (any non-markdown file, executable bit or shebang) show their file list and need an explicit confirm: "This skill includes code your agents may run."
  - Install like `npx skills`: canonical copy in `~/.agents/skills/<name>` (atomic: temp dir + rename), symlinks in each Claude account's `skills/` and in pi's if present, and an entry in `~/.agents/.skill-lock.json` v3 (keep the format; atomic write with backup). Names: `a-z0-9-`, 1–64, no clash in any spelling with any existing skill; never overwrite.
- **Turn off / on (nothing deleted):** Claude `skillOverrides: { name: "off" }` in the account's user settings (verify that user-level settings honour it; otherwise say where it works); Codex `[[skills.config]] name = "…" enabled = false` in `$CODEX_HOME/config.toml` (TOML-safe edit, backup). Not available for Paseo, plugin, claude.ai or built-in skills (say why).
- **Remove:** only skills added here, by `npx skills`, or by hand in user/shared dirs. Move the folder into the backup session (never `rm -rf`), remove links that point to it, update the lock file. If the skill is a link, remove only the link.
- **Tidy ("Worth a look"):** broken links, empty folders and stray zips, invalid names/frontmatter, the same name with different content in several places, never used in 30 days but costing context, a skill list over budget, Paseo orphans (managed marker but not in Paseo's current bundle), lock entries missing on disk. One plain action each.

## Surface
- Second sidebar item **Skills** (0.11: own screen + `SidebarRow` with a "+" → **Add a skill** popover; 0.8–0.10: a second surface + sidebar item). Screen params as in Memories (tab + opaque codes, never paths).
- Tabs (plain): Overview · Your skills · Usage · Add a skill · Guide. Technical details switch shared with Memories.
- Panels: add a **Skills** section to the existing workspace and agent panels (no new panels).
- Plugin display name "Memories & Skills" wherever the plugin names itself (manifest name/description if the schema has them, README title, About, Settings title). Memories stays "Memories" in its own sidebar item.
- Plain English, the 0.3.0 design standard, no sideways scroll, empty states that say what was checked.

## Safety (all Memories rules apply)
One writer (`server/write.ts`), extended allow-list for skill folders and the lock file; backups under `$PASEO_HOME/plugin-data/paseo-memories/backups/` (a backup inside a skills folder would load as a skill); refuse symlink escapes, hard links, non-UTF-8 for text edits; stale-write guard; per-target reports; reads never block or spawn; network fetches only on explicit Add (never on reads), size-capped, no telemetry; mask secrets in text fields; synthetic fixtures only.

## Compatibility
Floor stays `>=0.8.0`; every 0.11 API feature-detected; no new SDK import subpaths (Paseo 0.9.1's bundler rejects unknown subpaths even type-only). Settings document stays `version: 1` with zod defaults for every new field (e.g. `skillsUsage: true`, `skillsWindowDays: 30`).
