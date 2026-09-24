# Changelog

## 0.1.1 (2026-09-24)

- Long paths, URLs, tokens and code lines no longer make the page scroll sideways: text breaks anywhere it has to, and nothing in a row can push the page wider.
- Paths in lists, group headers and load plans are shortened in the middle (`~/…/acme-web/CLAUDE.md`), so the start and the file name both show. The file view's header shows the whole path, wrapped, with a Copy link.
- The import preview's diff wraps long lines under their own text, keeping the +/- column.
- Buttons and segmented choices with long labels wrap instead of running off the edge. The export's download button is now just "Download", with the file name shown above it.
- Preview: `?long` fills the fixtures with real-world lengths.

## 0.1.0 (2026-09-24)

The v1 spec (`docs/SPEC.md`), phases A to D.

### Read side
- Accounts: defaults, AgentLink and hand-made slots, and each Paseo provider's config folder after Paseo's env layering (daemon env, base provider env, provider env, `~` expanded), for `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and `COPILOT_HOME`.
- Sources for Claude, Codex, Paseo, OpenCode, pi, omp and Copilot; one source per file with `readBy`.
- Load plans per agent and folder, with bytes and ≈tokens.
- RPCs: `inventory`, `source`, `entry` (secrets masked unless revealed), `workspace-plan`, `agent-plan`.

### Write side
- One safe-write path: backup outside the file's folder, temp + fsync + rename, mode kept, read back, per-target report, stale-write guard, server-side refusal of read-only sources.
- RPCs: `claude-create`, `claude-update`, `claude-delete`, `instruction-write`, `prompt-get`, `prompt-set`, `codex-write`.

### Tidy, search, import and export (phase C)
- Findings: exact and near duplicates (shingled Jaccard ≥ 0.8), possible conflicts (a guess), stale paths (an absolute path counts only when its top folder exists here), stale code names (bounded background scan of project source, cached by stat, only while an app is connected, with backoff), `MEMORY.md` drift, over-limit files, secrets, and Codex's pending clean-up. Each has one action; the Overview gets exactly one next step.
- RPCs: `findings`, `search` (masked snippets; an empty result says what was checked), `import-parse`, `import-preview` (never writes), `import-apply`, `export`.
- Import formats: bundle v1, markdown by headings, Claude memory files (all three frontmatter shapes), claude.ai `[date] - text` lines, Cursor `.mdc`. Copy and move between agents, scopes and projects use the same preview. Copying into Codex means its AGENTS.md; generated Codex files are never targets.
- Export: bundle or markdown for everything, user files, one project, or chosen entries. Secrets are hidden unless revealed per item or for all.

### Codex guardrails
- Unknown job statuses refuse (fail closed). A `running` lease that ran out over an hour ago counts as finished, and says so.
- The sqlite is opened only for a Codex save and the Codex memory detail view, never for the inventory or background work.
- A pending clean-up (its working diff still there) warns with the deleted-input count, counted in the background from the diff's `deleted file mode` headers, and the save needs a confirm.

### App (phase D)
- Memories surface: Overview · User · Projects · Import & Export · Guide. Viewer and editor per source, reveal for hidden values, read-only reasons inline, Codex label and pending warning, git warning, per-file save report; create, rename and delete for Claude memories.
- Workspace and agent panels list what loads, in order, with sizes and ≈tokens.
- Loading, empty, error and "as of HH:MM" states throughout. A settings screen.
- Preview harness (`npm run preview:ui`) with fixtures for every view.

### Fix round 1 (review of phases A and B)
- A save through a symlink writes the real file beside itself and keeps the link; a link to a differently named file is allowed only when that file is itself editable here. Hard-linked files are refused.
- The bytes on disk are read again just before the rename and must match what the save was checked against; the backup is those raw bytes; pruning runs after the rename. The remaining one-syscall window is documented in `server/write.ts`.
- `@import` targets are read-only unless also read directly. The write module refuses anything that is not a markdown memory or instruction file by name (dotfiles, `.env`, `auth.json`, `.git`, `.ssh`, Codex's generated files), whatever the caller.
- Files that are not UTF-8 are refused; backups are raw bytes; a byte-order mark and CRLF line breaks survive saves.
- Every RPC response is masked in one place unless it asked to reveal: frontmatter, titles, hooks, headings, the appended prompt, search, findings, previews and export.
- Frontmatter comments survive field edits; no empty MEMORY.md is created; a rename whose index write fails is undone.
- Stale paths are grouped by the missing folder; the secret finding reads "A memory in <project>, "<title>", holds a value that looks like a secret."
- Import targets show a plain name with the path beneath.
- Fixtures, previews and tests use made-up projects and people; a test fails if a name from a real home folder appears.

### Fix round 2 (review of phases C and D)
- New memory file names are compared without case against the folder and the index: a memory called "Memory" becomes `memory_2.md`, never a second `MEMORY.md` (create, rename, import, copy).
- Move removes all chosen sections of one file in one write, found by their text; any original left behind makes the result a failure that says so. Move is refused, and not offered, when an original can't be removed (read-only, managed, Codex's generated memory, a whole file) or when the target is the same file.
- Markdown import keeps text before the first top-level heading as its own item. Markdown export now writes a `#` heading and a `paseo-memories` comment per item, with body headings moved down, so it imports back exactly.
- claude.ai lines that don't start a new entry stay with the one above; stray lines before the first entry are reported.
- Relative paths in Claude memory for a project whose path is unknown are no longer checked; the findings list says so.
- Editors keep unsaved drafts across reloads and show "Changed on disk since you opened it" with Reload / Keep editing; a save still carries the stamp the draft was loaded with.
- An expired Codex lease over an hour old still counts as free; the message now says Codex reclaims expired leases itself, with the lease time. The Codex Save button is off while the lock is held or unclear.
- A leading byte-order mark no longer breaks any import format.
- Duplicates in different projects' Claude memory suggest "Move to your user CLAUDE.md" (identical) or "Keep both" (near), never "Delete the copy".

### Fix round 3 (follow-ups to round 2)
- A case-only rename (`flat.md` → `Flat.md`) is one in-place rename through a temp name, backed up first, then the `MEMORY.md` line is updated. It no longer copies the file onto itself and deletes the only copy on a case-insensitive disk. Renaming onto a different existing file is refused.
- Secret masking in responses covers only human text fields (bodies, snippets, titles, hooks, headings, messages, the prompt). Ids, paths, keys and stamps go back unchanged, so a project folder named like `sk-learn-…` or `xoxb-…` opens, saves and imports. Section keys and new file names are built from the masked text, so a secret can't leak through them.
- A link target is matched to a known file by real path on both sides, so saves work when HOME or a project is reached through a symlinked folder.
- One "can this be saved" rule (`server/writable.ts`) for both the inventory and the write path. Files listed in OpenCode `instructions[]` are read-only. Codex's generated-file names are refused only inside a real Codex home (`<CODEX_HOME>/memories/...`).
- The expired-lease rule now cites Codex's own claim query in the code.

### Fix round 4 (round 3 check)
- Every string under a memory's unknown frontmatter keys (`extra`), and its `type`, is masked in responses unless revealed. Ids, paths, keys and stamps still round-trip.
- Export masks `type` too, and counts secrets in the title, description and type as well as the body.
- A case-only rename whose `MEMORY.md` write fails is renamed back, and the report says so.

### Checked against the installed tools (2026-09-24)
- Claude Code 2.1.280: folder name `kT` (non-alphanumerics to `-`, cut at 200 plus `-` and the base36 of a Java-style hash of the path); MEMORY.md 200 lines / 25,000 bytes; AGENTS.md modes `claude-md`, `claude-md-or-agents-md` (default), `claude-md-and-agents-md`, `managed-only`.
- Codex 0.156.1: the consolidation job is `jobs.kind = 'memory_consolidate_global'`; `running` with a future `lease_until` holds the lock.
- Node 24: opening a WAL database read-only with no `-wal`/`-shm` creates both, so such a database is opened `immutable=1`.
