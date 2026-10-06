# Changelog

## 0.5.0 (2026-10-06)

Both pages are simpler: fewer tabs, no stacked headers, and the technical parts folded into rows you open in place. The same look as Connectors (paseo-mcp 0.19.0).

- **Four tabs on each page**, grouped by what you come to do. Memories: Overview, Everywhere, Projects, Help. Skills: Overview, Your skills, Usage, Help.
- **No intro block under the tabs.** Each tab starts with its own content and at most one plain sentence. "What you can do here" is now a question in Help ("What can I do on each tab?").
- **Help replaces the Guide.** Plain questions, each folded ("How do I move my notes to another Paseo computer?"), with a button where it helps. The technical reference and the agents' own docs fold at the end (open in technical mode).
- **Fold-out rows for the less-used and technical parts** (a card of rows: icon, title, one line saying what's inside). Memories: "Bring notes in", "Take a copy out" and "What was checked" under Everywhere and Projects; "Edit the whole file" and "Where it's saved" under a set of notes. Skills: "Looked after elsewhere" and "What was checked" under Your skills; "Read its instructions", "See its files", why a skill can't be changed, and (technical) where it lives under a skill; skills not used in this time under Usage.
- **Import & Export and Add a skill are pages under a tab**, not tabs: Import & Export keeps Everywhere or Projects lit (whichever you came from) with a way back, and Add a skill keeps Your skills lit. Add a skill is a button on Your skills, as well as on the Overview and the sidebar's "+".
- **Old links still land.** Saved links and screen params with `tab=guide` open Help on both pages; `tab=transfer`, `tab=add`, `tab=usage`, a source, a note and Add a note open where they did. Old ids handed over in memory (Paseo 0.10) are mapped the same way.
- **Fewer things in the chat, more in Paseo's own places.** Memories still adds no composer chip. New command-center items: "Add a note for your agents", "Tidy memories" (opens the list of things worth a look), "Add a skill" and, in a workspace, "Add a note for this project". In a chat, `/remember <text>` opens Add a note for that project with the text filled in, and `/memories` opens what that agent remembers (slash commands only where the app has them). A small dot beside Memories or Skills in the sidebar says something is worth a look (red when a note holds a password); it uses what the page already read, so it costs no extra check, and shows once a page has looked this session.
- **Nothing was removed.** Every option, setting and safety message is still there, one press away.
- For developers: `Accordion`, `AccordionItem`, `TabLine` and `SubPageTop` in `client/ui.tsx`; `client/tabs.ts` (`pageFor`, `litTab`, `LEGACY_TABS`) and `skillPageFor` / `skillLitTab` / `LEGACY_SKILL_TABS` in `shared/skills-plain.ts`; `normalised` (client/navigate.ts) and `normalSkillsPlace` (client/skills-nav.ts) for in-memory hand-overs; `client/sidebar-status.ts` for the dot; `client/guide.tsx` is now `client/help.tsx` and `client/skills-guide.tsx` is `client/skills-help.tsx`. `addSlashCommand` is feature-detected; no new dependencies, settings or SDK import paths; `requirements.paseo` stays `>=0.8.0`. No server changes: the 0.4.1 caching is untouched and `tests/perf/scale.test.ts` still passes.

## 0.4.1 (2026-10-05)

Memories is now light on big hosts. On the busiest one we run (899 memory files, 109 projects, 253 instruction files and 5.8 GB of chat logs), 0.4.0 worked out the whole tidy check again on every read: 12 s each time (41 s at worst, past the 30 s limit for a plugin call), every ~20 s while a page was open, with the plugin at ~950 MB and slowing the daemon's other plugin calls. Thanks to the agent that measured all this on that host (sandbox-97), and started the fix.

- **Answers from a cache, checked in the background.** A page that is open gets the last answer straight away and never waits for a full check. A quick look for changes (one stat per file the answer was built from, at most every 10 s) runs behind it, and only a real change, such as a new or edited note or a mentioned path that appeared or went away, works anything out again. The answer says when it's checking (`checking`), and the page then looks again 3 s later. Refresh, and any change made here, still work everything out at once.
- **Only what changed is read again.** Each note and section is read, split and analysed once per version of its file. A change to one file costs that file, not all of them.
- **No more comparing everything with everything** to find near-duplicates. Exact copies are bucketed first, near ones come from an index of shared word runs, and only pairs whose sizes allow a match are compared. The results are the same as before.
- **Never stalls the other plugin calls.** Long work runs in slices of a few milliseconds and lets everything else in between. The longest stall in our big-host test fell from 2.2 s to about 10–40 ms.
- **A folder that merely exists isn't watched.** A path a note mentions, `/tmp`, your home folder or a project only counts as changed when it appears or disappears, not each time something inside it changes. Listed folders and read files are still watched closely.
- **Memory stays put.** The caches have caps (files kept and megabytes of text) and drop the least recently used past them. The usage count reads chat logs in 256 KB pieces with one buffer per pass, never a whole log, and its buffers peak at about 2 MB (0.4.0: about 12 MB). Over 200 polls the heap stays flat.
- **Fewer calls to the daemon.** The list of Paseo projects is asked for at most every 5 s.
- **Code-name checks are lighter.** A finished background scan shows on the next read without working anything else out again. While nothing changes, scans space out from every 10 minutes up to hourly, and Refresh still starts one at once. A scan works at most a quarter of the time, so a large backlog is read over several passes.

Measured on a MacBook with a generated home of the busy host's size, before (0.4.0) → after: a first findings read 2.6 s → 0.9 s; every later read 2.5 s → under 30 ms; 30 polls of an open page 80 s → 0.14 s of CPU; longest stall 2.2 s → 11 ms; memory ~890 MB → ~285 MB. That host's CPU is about five times slower than the Mac's.

- For developers: `server/revalidate.ts` (cached answers with a background check), `server/pace.ts` (`Pacer` for background work, `Slicer` and `runSliced` for work someone waits for), `duplicateSteps` in `shared/tidy.ts` (a generator that pauses between pieces), and `kindOf` in `server/files.ts` (what an "is it there?" answer depends on). The `inventory` and `findings` replies gain `checking` (additive, defaults to false). `npm test` now also runs `tests/perf/scale.test.ts` on its own after the rest: it builds a home of the busy host's size and checks the speed, memory and stall numbers above. No new dependencies, settings or SDK import paths; `requirements.paseo` stays `>=0.8.0`.

## 0.4.0 (2026-10-04)

The plugin is now **Memories & Skills**: a second page, **Skills**, sits under Memories in the sidebar. And both pages are much calmer.

- **See your skills.** Every skill your agents can use on this computer, in one list, grouped by where it lives: shared by your agents, Claude only, Codex only, in your projects, and (folded away) the ones Paseo, a plugin, claude.ai or your organisation looks after. Each shows who can use it, where it came from, and what it adds to the start of every chat.
- **See which skills are used.** Usage counts the skills your agents ran over 7, 30 or 90 days, from their chat history on this computer, with a small bar for each day. Claude's counts are exact; Codex's are estimates, and it says so. Skills nobody used fold away at the end, each with Turn off. Only counts are kept, never what was said; turn counting off in Settings.
- **Add a skill**, from the page or the "+" beside Skills in the sidebar: pick one from a short list we checked (each pinned to the exact version we read), bring one from a GitHub link, or write your own in three boxes. You always see what it is, every file and where it goes before anything is added. A skill that includes code your agents may run lists that code and needs "I've looked at the files" ticked. Nothing is ever added over a skill with the same name, however it's spelt.
- **Turn a skill off** for Claude or Codex without deleting anything, and back on again. **Remove** one you added: it goes to the backups with its links, so it can be put back.
- **Worth a look** for skills: links to skills that are gone, empty folders, packed files agents can't read, skills without instructions, two different skills with one name, unused skills that still cost every chat, a list too long for Claude to keep whole, and old skills an earlier Paseo left behind. Each has one action. A list is only called too long when we know which model your agents use, so there are no false alarms.
- **The panels show skills too.** The workspace and agent panels (now "Memories & Skills") add how many skills an agent there can use, which ones were used in this chat (or in this folder since the agent started, when Paseo doesn't say which chat it is), and the full list, folded.
- **Calm Overviews.** Both Overviews now show one status card (the state in words, at most four short lines, when it was last checked, and two buttons) and nothing else above the fold. The full list of things worth a look, the search box and the "New to …? How it works" guide are folded behind small links, and the guide is one card instead of four. Every other tab opens with a short intro; "What you can do here" is folded behind a small link. Nothing was removed: every option and every safety message is still where you decide.
- **One spacing scale** for both pages, shared with AI Router and the other plugins.
- **Safer adds (from an independent review).** A skill whose header can run commands (hooks, a shell it may use without asking, a helper agent with every tool, or a `!` command line) now needs the same "includes code" confirm as a script, and says why. A skill that calls itself something other than its folder, has two files that differ only in capitals or accents, or carries another program's marker file is refused. If anything reads back wrong after an add, all of it is undone. A version named by its id that isn't on the project's main line gets a warning. If Claude can't be linked in one account, the skill stays for the others and "Link it for Claude" tries again.
- **Safer changes.** Removing works (or does nothing at all) when your skills folder is a link, for example into a dotfiles folder. Codex switches written by Codex itself (by path) are found and turned back on. Codex's settings keep a comment above the next section, and text inside long strings is never taken for a switch. A move into the backups across disks checks every file's size and contents, and keeps the original if it changed meanwhile.
- **Fairer counts.** Codex only counts a skill as used when it read the instructions (not when it listed, edited or wrote them). A broken log tail is read once within the budget, then left alone.
- **Notes look like notes.** Bold, italics, headings, lists (nested, numbered, with ticks), quotes, code, links and simple tables now show formatted everywhere a note appears: note cards, Claude's notes, Codex's notes, Paseo's instructions for every agent, the Add a note and import previews, a skill's instructions, and search results. Long code and wide tables wrap instead of running off the side; anything that looks like a web page's own code is shown as plain text, never run.
- **Change a note in place, with formatting buttons and a preview.** Every note you can change has a Change button. It opens an editor with Bold, Italic, Heading, Bulleted list, Numbered list, Link and Code buttons (and Undo), and a live preview: beside the text when there is room, behind a Write / Preview switch on a phone. Cmd/Ctrl+B and I work on the web. The buttons only add marks around what you selected, so saving still changes just that note and keeps the rest of the file exactly as it was (including how its lines end). The whole-file editor keeps the raw text and gains a Preview switch. Codex's own notes can now be changed one note at a time too (before, only through the whole-file editor), with the same safety checks as before. We didn't make the text itself editable in its formatted form: that would rewrite the whole note each time.
- **Clearer results.** After adding, removing, turning off or fixing a skill, the result lists each place it touched (for example "Claude's settings (work account): couldn't be read, left as it is"), with details folded until something didn't work.
- **Fast with long notes.** A very long note (megabytes) is read in a fraction of a second instead of minutes, typing in a long note stays quick, and the preview catches up a moment after you stop typing (showing the start of a very long note, and saying so). Undo steps back through your typing too, a word or a pause at a time, not just the formatting buttons. Italic inside bold text now keeps the bold.
- **Stricter about skills that can run commands.** A skill header only counts as harmless when every line is a plain setting this plugin knows; anything else (unusual quoting, settings it doesn't know, YAML tricks) gets the "includes code" confirm.
- **Two more review fixes.** A skill header written with quoted names, or with lines this plugin can't fully read, is treated as able to run commands (the code confirm applies, and the skill's page says so). Picking one skill from a link that holds several now previews that skill instead of failing.
- **Calmer Memories tabs.** Each fact is said once (a note's size no longer appears twice), steady facts are quiet text instead of boxes, the second "Add a note" inside a set of instructions is now "Add to these instructions", and the Guide's how-tos fold so one is open at a time.
- For developers: `shared/md-parse.ts` (a small bounded Markdown reader, no dependency, never HTML), `shared/md-edit.ts` (the formatting buttons as pure edits on a selection), `client/markdown.tsx` and `client/markdown-editor.tsx`. A note card keeps its own spacing under its heading when saved. 12 new RPCs (`paseo-memories.skills-*`, additive, including `skills-link`), two new settings with defaults (`skillsUsage`, `skillsWindowDays`; the settings version is unchanged), no new SDK import paths, `requirements.paseo` stays `>=0.8.0` (`paseo-plugin.json` can't carry a display name: Paseo 0.8 rejects any field but `id` and `requirements`). On Paseo 0.11 Skills is a native screen with its own sidebar row; 0.8–0.10 get a second surface and sidebar item. The writer's allow-list grew for skill folders, Claude account `settings.json`, Codex `config.toml` and `npx skills`' lock file. Paseo's own skill list is read from the running Paseo package (`dist/server/skills`); if it can't be read, no skill is called an orphan.

## 0.3.0 (2026-10-04)

Memories now looks and reads like AI Router and the other Paseo plugins: the same text sizes, header, tabs and plain-English Overview. Every option, setting, safety check and memory operation is unchanged, and so is the technical view.

- **Easier to read.** One type scale everywhere: body text at 15 px, hints at 14, nothing below 13; section titles at 17, tab titles at 20, the page title at 22. Notes and warnings use the full text colour; grey is only for hints, paths and times.
- **A header that says how things are.** The Memories icon and name, then one line with a coloured dot: "Your agents' notes on demo-host · 7 things worth a look", or "everything looks tidy". It reuses the Overview's last check, so other tabs never start a new scan. Refresh sits on the right.
- **Every tab opens with an intro**: an icon, a title, one or two plain sentences, and "What you can do here" (folded behind "Learn more" on a phone). The tab bar shows icons with labels, and icons plus the open tab's name when the labels don't fit.
- **The Overview teaches.** A status card at the top says the state in words ("All set: everything looks tidy", "3 things are worth a look", "Something needs your attention"), with what each agent remembers, the next step, Show me and Add a note. Then Worth a look, Find a note, and a short guide: What is Memories?, How it works (four steps with arrows), How to use it (numbered), and Words you'll see. While it reads, or if the first read fails, the card says so, with Try again.
- **Icon cards throughout**: groups on Everywhere and Projects, the note header, Claude's notes, Import, Export, Add a note, each how-to in the Guide and each part of the reference. Warnings about a note show as notices with an icon. Buttons carry icons and are easier to press.
- **Links to the agents' own docs** at the end of the Guide's reference (Claude Code, Codex, OpenCode, Copilot), opened in your browser. Only on Paseo apps that can open links (0.10 and later); older apps show the Guide as before.
- **A native Memories screen on Paseo 0.11 and later**: the page has its proper title, "Memories", in the app's header (with the 0.2 registration, 0.11 titles it with its id, "memories"), and its sidebar row is the app's own, highlighted while the page is open. Older apps keep the 0.2 sidebar item and page, and every way in (the panels, the command menu, Show me) opens the same page.
- **Remembers where you were (Paseo 0.11 and later).** The open tab, project or note is kept in the page's address, so a reload, Back and Forward bring you to the same place, and the header names the tab ("Memories · Projects", or "Memories · User" with technical details on). The address holds only short codes, never a folder, a user, project or note name, or what a note says. A link to a note that no longer exists opens the same tab with nothing selected. On older apps the page opens as before.
- **Open straight to the right note.** Rows in the workspace and agent panels open that note in Memories; the panel's "Open Memories" goes to this project's first file that loads (never the organisation's managed file), instead of just the Projects tab. A file the Memories lists don't show opens its tab with nothing selected.
- **A "+" on the Memories sidebar row (Paseo 0.11 and later)** opens Add a note right there, in a small window beside the sidebar (a sheet on a phone). Its label for screen readers is "Add a note". Close (or a tap outside) keeps what you typed for next time, until you save it.
- **The header never says "tidy" too early.** After a save, a remove, an import or Refresh, it checks the notes again whichever tab is open, and says "Checking…" until it knows, or "Couldn't check just now" with Try again.
- "Projects →" on the Overview opens the list, not a note left open earlier. In the list, "Followed by …" wraps instead of being cut off.
- **Settings apply at once.** Turning a setting on or off in Settings → Memories takes effect straight away, with no reload (Paseo 0.9 and later). One bad value still resets only that setting.
- **Works on Paseo 0.8 and later; best on 0.11.** Each new feature checks that the app has it first, and older apps keep the 0.2 behaviour.
- Layout: the page is 980 px wide like the other plugins, the list beside a note is a little narrower, and everything works in light and dark, wide and narrow.
- For developers: no settings change (the settings version is unchanged), no new runtime dependencies, no new RPCs, no new SDK import paths; `requirements.paseo` stays `>=0.8.0`. Types come from `@getpaseo/plugin` 0.11.0-beta.3 (dev only). `client/register.ts` holds the version-gated page registration and the sidebar "+" (`tests/register.test.ts`); `client/navigate.ts` turns a destination into screen params and back (`param` keys `tab`, `add`, `workspace`, plus `source` and `entry` as the first 12 hex digits of SHA-256 of the source id and of `<source id>#<note key>`, matched against the lists on the page; `shared/hash.ts` is a plain-JS SHA-256); `server/settings.ts` uses the `registerSettings()` handle (`read`, `subscribe`) when there is one and falls back to the settings file with its per-field rescue; a change that lands during a read wins over it (`tests/paseo011.test.ts`, `tests/review030b.test.ts`); `client/links.ts` looks up `openExternalUrl` at runtime. Preview: runs the real `index.client.tsx` against a fake Paseo 0.11 app; `?legacy` stands in for 0.10, `?chrome` shows the sidebar and header, `?popover` opens the "+", `?nolinks` an app without `openExternalUrl`.

## 0.2.1 (2026-09-25)

- Memories uses far less memory on computers with many projects: the background check for code names that no longer exist now remembers only the names your notes mention, forgets deleted files and projects, and reads at most 128 MB per pass.
- Until that check has reached every project, Worth a look says how far it got, for example "Code names checked in 3 of 11 projects so far; the rest are still being scanned."

## 0.2.0 (2026-09-24)

Memories now works for people who don't work with files every day. Everything from 0.1 is still there: turn on **Show technical details** in Settings → Memories to see it exactly as before.

- **Plain view by default.** Notes have plain names everywhere: "Your instructions for Claude", "Your instructions for Codex", "Claude's notes for acme-web", "What Codex has learned", "Project instructions · acme-web (shared with the team)", "Instructions for every agent on this computer". Sizes read "about 1,200 words". Where a note is saved sits in one folded line.
- **Notes instead of files.** A set of instructions shows as note cards, each with Change, Copy to another agent and a quiet Remove link that asks first ("Remove this note? A copy of the old version is kept, so it can be put back."), and Add a note at the end. Only that note changes; the rest stays exactly as it was. Editing the whole file is still there, folded under "Edit the whole file (technical)".
- **Claude's notes** use plain fields: Title, Short summary, What kind of note ("About you", "How you like things done", "About this project", "Where to find things") and What should Claude remember. File name and Rename moved under Technical details.
- **Add a note**, from the Overview, Everywhere and Projects: write what your agents should remember, choose who follows it (All my agents, Just Claude, Just Codex) and where (Everywhere, or one project), check where it goes and whether something almost the same is already there, then save. Everywhere means your own instructions for Claude and for Codex. One project means a private Claude note for that project, plus the project's instructions for Codex, with "Everyone who works on this project will see this note." when they are shared. When Claude already reads that project's instructions, it gets no second copy: "Claude reads the project instructions too, so one note is enough." Only places the agent actually reads; never Codex's own notes or the instructions for every agent on this computer.
- Add a note only saves where the agent will read it. If Codex would stop reading this project's instructions before the note, or Claude's list of notes for the project is already longer than Claude reads, the preview says so and that place is not saved. If no place is left, Save is off.
- "Already there" means the same words. A note that is only similar ("Node must be >= 18" and "<= 18") gets a warning and is still saved.
- Each place is saved and reported on its own: "Saved to X." and "Couldn't save to Y: why." A new Claude note whose list entry couldn't be written is taken back out, so Claude never has a note it can't find.
- Text copied while a password was hidden (••••) can't be saved as a note; it says to press Show first.
- Note cards never show a file's header (Claude's `paths:`, Copilot's `applyTo:`) as a card, and every Change or Remove keeps it exactly. A `---` line at the top of a CLAUDE.md or AGENTS.md is just a divider, so the text under it shows as a normal note.
- "One note is enough" only applies when Codex will read the project instructions that far; otherwise Claude gets its own note, and the preview says why. Edits keep line endings, indented code and line breaks as they were.
- Your own instructions are only called private when they aren't kept in git. Read-only places say the host's own reason when there is no plainer one.
- One bad value in the settings file now resets only that setting.
- **Plain warnings and findings**: "This note contains something that looks like a password or key…", "Two notes say the same thing", "A note mentions a file or folder that no longer exists", "Codex is still tidying its notes…". The safety rules underneath are unchanged.
- **Guides**: the Guide tab is now six short how-tos that name the real buttons: what your agents remember, adding a note, fixing a note, keeping passwords out, moving notes to another Paseo computer, and what can't be changed here. The full reference is folded under Technical details.
- **Codex's own working files** (raw memories, rollout summaries, extensions, the working diff, its database) stay out of lists, Overview counts, "Worth a look" and search in the plain view. Technical details shows them. Anything Codex reads as instructions stays visible, even when it can't be changed here, and a warning about a password or key is never hidden.
- **Panels** list what an agent started here reads, in order, by plain name, with "about N words", "Read when needed" and "Not read".
- For developers: new setting `technicalDetails` (default off; old settings files still load), RPCs `note-preview` and `note-add`, `instruction-write` takes `removeSection`, all additive. Preview: plain by default, `?technical` for the old view, `?add`, `?add=ws-1`, `?notes`. Tests check every plain string against a jargon list (now including "git" and "commit" as whole words).

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
