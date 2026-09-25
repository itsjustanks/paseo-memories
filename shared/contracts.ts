import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ImportItemSchema } from "./transfer";

/**
 * RPC contracts. Additive only: a new field is `.optional()` or `.default()`,
 * nothing is renamed or removed, and categorical OUTPUT fields that may grow
 * (agent, scope, kind, finding kind) are plain strings with their known values
 * listed here, so an older app reads a newer host. `access` is the one enum
 * the safety rules depend on.
 */

// ------------------------------------------------------------------ vocab

/** Known `Source.kind` values. Plain strings on the wire. */
export const SOURCE_KINDS = [
  "claude-managed", // managed CLAUDE.md (read-only)
  "claude-md", // CLAUDE.md or .claude/CLAUDE.md, user or project
  "claude-local", // CLAUDE.local.md
  "claude-rule", // <cfg>/rules/**/*.md or .claude/rules/**/*.md
  "claude-auto-memory", // <cfg>/projects/<slug>/memory/ (MEMORY.md + one file per memory)
  "agents-md", // AGENTS.md, AGENTS.override.md (Codex user file, or any project's)
  "codex-memory", // generated memories/MEMORY.md, memory_summary.md (guarded edits)
  "codex-generated", // raw_memories.md, rollout_summaries/, extensions/, the diff, the sqlite (read-only)
  "paseo-prompt", // daemon appendSystemPrompt
  "opencode-md", // ~/.config/opencode/AGENTS.md, project CONTEXT.md
  "opencode-config", // opencode.json instructions[] (read-only)
  "pi-md", // pi agent-dir context files, SYSTEM.md, APPEND_SYSTEM.md
  "omp-md", // ~/.omp/agent/AGENTS.md, .omp/AGENTS.md, RULES.md
  "omp-generated", // ~/.omp/agent/memories (read-only)
  "copilot-md", // copilot-instructions.md, *.instructions.md
  "copilot-memory", // Copilot Memory, stored online
] as const;

export const SCOPES = ["managed", "user", "project", "host"] as const;

export const ACCESS = ["editable", "read-only", "online"] as const;
export const AccessSchema = z.enum(ACCESS);
export type Access = z.infer<typeof AccessSchema>;

/** Known `Finding.kind` values (phase C fills them). */
export const FINDING_KINDS = ["duplicate", "conflict", "stale-path", "stale-symbol", "index-drift", "over-limit", "secret"] as const;

// ------------------------------------------------------------------ shapes

/** What the user saw of a file; every save carries it back (stale-write guard). */
export const FileStampSchema = z.object({
  size: z.number(),
  mtimeMs: z.number(),
  /** sha256 of the bytes, hex. Compared when present. */
  hash: z.string().optional(),
});
export type FileStamp = z.infer<typeof FileStampSchema>;

export const AccountSchema = z.object({
  /** `<agent>:<absolute dir>`. */
  id: z.string(),
  agent: z.string(),
  dir: z.string(),
  label: z.string(),
  /** default | agent-link | external | provider-env */
  origin: z.string(),
  email: z.string().optional(),
  /** Paseo provider ids whose agents use this directory. */
  providerIds: z.array(z.string()).default([]),
  exists: z.boolean(),
  /** The variable that points an agent here (CLAUDE_CONFIG_DIR, CODEX_HOME, …). */
  envVar: z.string().optional(),
});
export type Account = z.infer<typeof AccountSchema>;

export const LoadedSchema = z.object({
  /** Bytes an agent started now would read from this source at launch (0 when on demand only). */
  bytes: z.number(),
  /** ≈ bytes / 4. */
  tokens: z.number(),
  note: z.string().default(""),
});
export type Loaded = z.infer<typeof LoadedSchema>;

export const SourceSchema = z.object({
  /** Stable: the absolute path; `paseo:appendSystemPrompt` and `copilot:memory` for the two that are not files. */
  id: z.string(),
  /** The agent the file belongs to; `readBy` says who else reads it. */
  agent: z.string(),
  accountId: z.string().optional(),
  scope: z.string(),
  kind: z.string(),
  path: z.string(),
  /** The project folder this source belongs to, when known. */
  projectPath: z.string().optional(),
  exists: z.boolean().default(true),
  isDirectory: z.boolean().default(false),
  bytes: z.number(),
  lines: z.number(),
  /** Files inside, for a folder source. */
  files: z.number().optional(),
  /** ISO time; "" when missing. */
  modifiedAt: z.string(),
  loaded: LoadedSchema,
  access: AccessSchema,
  /** Why it is read-only, or what to know before editing ("version-controlled"). */
  reason: z.string().optional(),
  readBy: z.array(z.string()).default([]),
  versionControlled: z.boolean().optional(),
  /** Plain-English label ("Codex folds this in at its next run; wording may change."). */
  label: z.string().optional(),
  /** Claude auto-memory folder name (the slug). */
  slug: z.string().optional(),
});
export type Source = z.infer<typeof SourceSchema>;

export const EntrySchema = z.object({
  /** File name for a Claude memory, `<index>:<heading slug>` for a markdown section. */
  key: z.string(),
  title: z.string(),
  description: z.string().optional(),
  type: z.string().optional(),
  /** Claude memory: named in MEMORY.md. */
  indexed: z.boolean().optional(),
  /** The MEMORY.md hook text for this file. */
  hook: z.string().optional(),
  /** nested | flat | flat-session | none | other */
  shape: z.string().optional(),
  /** Frontmatter keys this plugin does not edit; preserved on save. Display only. */
  extra: z.record(z.string(), z.unknown()).default({}),
  path: z.string().optional(),
  bytes: z.number().default(0),
  lines: z.number().default(0),
  modifiedAt: z.string().optional(),
  secrets: z.number().default(0),
});
export type Entry = z.infer<typeof EntrySchema>;

/** kind: open | edit | delete | review | reveal (plain strings; may grow). */
export const FindingActionSchema = z.object({
  label: z.string(),
  kind: z.string(),
  sourceId: z.string().optional(),
  key: z.string().optional(),
});
export type FindingAction = z.infer<typeof FindingActionSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  kind: z.string(),
  /** info | warn | error */
  severity: z.string().default("info"),
  sourceIds: z.array(z.string()).default([]),
  entryKeys: z.array(z.string()).default([]),
  message: z.string(),
  detail: z.string().optional(),
  heuristic: z.boolean().optional(),
  /** The one thing to do about it. */
  action: FindingActionSchema.optional(),
});
export type Finding = z.infer<typeof FindingSchema>;
export type FindingInput = z.input<typeof FindingSchema>;

export const LoadItemSchema = z.object({
  order: z.number(),
  label: z.string(),
  kind: z.string(),
  path: z.string().optional(),
  sourceId: z.string().optional(),
  /** launch | on-demand | skipped | missing */
  when: z.string(),
  bytes: z.number(),
  loadedBytes: z.number(),
  tokens: z.number(),
  truncated: z.boolean().default(false),
  note: z.string().default(""),
  /** For imports: the file that imported this one. */
  via: z.string().optional(),
  /** managed | user | project | host, so the app knows where to open it. */
  scope: z.string().optional(),
});
export type LoadItem = z.infer<typeof LoadItemSchema>;

export const LoadPlanSchema = z.object({
  agent: z.string(),
  providerId: z.string().optional(),
  accountId: z.string().optional(),
  configDir: z.string().optional(),
  directory: z.string(),
  items: z.array(LoadItemSchema),
  total: z.object({ bytes: z.number(), tokens: z.number() }),
  notes: z.array(z.string()).default([]),
  /** Things this plan could not decide; said, never guessed. */
  unsure: z.array(z.string()).default([]),
});
export type LoadPlan = z.infer<typeof LoadPlanSchema>;

export const WriteReportSchema = z.object({
  target: z.string(),
  ok: z.boolean(),
  /** created | updated | deleted | unchanged | refused */
  action: z.string().default("updated"),
  backupPath: z.string().optional(),
  /** ok | mismatch | skipped */
  readBack: z.string(),
  error: z.string().optional(),
  versionControlled: z.boolean().optional(),
  stamp: FileStampSchema.optional(),
});
export type WriteReport = z.infer<typeof WriteReportSchema>;

export const WriteResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  /** Refused only until the user confirms `message` (Codex pending consolidation); send again with the confirm flag. */
  needsConfirm: z.boolean().optional(),
  reports: z.array(WriteReportSchema).default([]),
  warnings: z.array(z.string()).default([]),
});
export type WriteResult = z.infer<typeof WriteResultSchema>;

export const GroupSchema = z.object({
  key: z.string(),
  agent: z.string(),
  accountId: z.string().optional(),
  scope: z.string(),
  sourceIds: z.array(z.string()),
  bytes: z.number(),
  files: z.number(),
  loadedTokens: z.number(),
  lastChanged: z.string(),
});

export const IndexStateSchema = z.object({
  lines: z.array(z.object({ line: z.number(), title: z.string(), file: z.string(), hook: z.string(), exists: z.boolean() })),
  missingFiles: z.array(z.string()).default([]),
  unindexedFiles: z.array(z.string()).default([]),
  loadedLines: z.number(),
  loadedBytes: z.number(),
  truncated: z.boolean(),
});

export const CodexStateSchema = z.object({
  /** free | locked | unsure */
  lock: z.string(),
  lockReason: z.string(),
  memoriesOn: z.boolean().optional(),
  pending: z.string().optional(),
  /** The facts behind `pending`: the diff's time, deleted inputs counted (absent while counting), when the last run failed. */
  pendingInfo: z.object({ asOf: z.string(), deletions: z.number().optional(), failedOn: z.string().optional() }).optional(),
  lastJob: z.object({ status: z.string(), finishedAt: z.string().optional(), error: z.boolean().optional() }).optional(),
  /** After our edit: kept | changed | unchanged | none */
  kept: z.object({ status: z.string(), detail: z.string(), editedAt: z.string().optional() }).optional(),
});

// ------------------------------------------------------------------ read RPCs

export const inventory = defineRpc({
  name: "paseo-memories.inventory",
  input: z.object({ refresh: z.boolean().optional() }),
  output: z.object({
    checkedAt: z.string(),
    accounts: z.array(AccountSchema),
    sources: z.array(SourceSchema),
    groups: z.array(GroupSchema).default([]),
    counts: z.object({
      claudeMemoryFolders: z.number(),
      claudeMemoryFiles: z.number(),
      codexHomes: z.number(),
      projects: z.number(),
      sources: z.number(),
      bytes: z.number(),
    }),
    findings: z.array(FindingSchema).default([]),
    /** What was checked, in words ("Checked 36 Claude projects and 1 Codex store"). */
    checked: z.array(z.string()).default([]),
    notes: z.array(z.string()).default([]),
  }),
});

export const sourceDetail = defineRpc({
  name: "paseo-memories.source",
  input: z.object({ sourceId: z.string(), workspaceId: z.string().optional() }),
  output: z.object({
    source: SourceSchema,
    stamp: FileStampSchema.optional(),
    entries: z.array(EntrySchema).default([]),
    index: IndexStateSchema.optional(),
    imports: z.array(z.object({ ref: z.string(), path: z.string(), exists: z.boolean(), depth: z.number() })).default([]),
    codex: CodexStateSchema.optional(),
    warnings: z.array(z.string()).default([]),
  }),
});

export const entryBody = defineRpc({
  name: "paseo-memories.entry",
  input: z.object({
    sourceId: z.string(),
    /** Omit for the whole file. */
    key: z.string().optional(),
    reveal: z.boolean().optional(),
    workspaceId: z.string().optional(),
  }),
  output: z.object({
    body: z.string(),
    /** For a Claude memory: the fields, so an edit round-trips without reparsing on the client. */
    fields: z.object({ name: z.string().optional(), description: z.string().optional(), type: z.string().optional() }).optional(),
    masked: z.boolean(),
    secrets: z.number(),
    secretKinds: z.array(z.string()).default([]),
    stamp: FileStampSchema.optional(),
    path: z.string().optional(),
  }),
});

export const workspacePlan = defineRpc({
  name: "paseo-memories.workspace-plan",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ directory: z.string(), plans: z.array(LoadPlanSchema), checkedAt: z.string() }),
});

export const agentPlan = defineRpc({
  name: "paseo-memories.agent-plan",
  input: z.object({ workspaceId: z.string(), providerId: z.string(), agentId: z.string().optional() }),
  output: z.object({ directory: z.string(), plan: LoadPlanSchema, checkedAt: z.string() }),
});

// ------------------------------------------------------------------ write RPCs

const MemoryFieldsInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000),
  type: z.string().max(40).optional(),
});

export const claudeMemoryCreate = defineRpc({
  name: "paseo-memories.claude-create",
  input: MemoryFieldsInput.extend({
    sourceId: z.string(),
    /** For a project whose memory folder the inventory does not list yet. */
    workspaceId: z.string().optional(),
    /** Defaults to a name made from `name`. Must end in .md and stay in the folder. */
    fileName: z.string().optional(),
    body: z.string(),
    hook: z.string().max(500).optional(),
  }),
  output: WriteResultSchema,
});

export const claudeMemoryUpdate = defineRpc({
  name: "paseo-memories.claude-update",
  input: z.object({
    sourceId: z.string(),
    workspaceId: z.string().optional(),
    key: z.string(),
    expected: FileStampSchema,
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    type: z.string().max(40).optional(),
    body: z.string().optional(),
    hook: z.string().max(500).optional(),
    /** New file name; the MEMORY.md line follows it. */
    rename: z.string().optional(),
  }),
  output: WriteResultSchema,
});

export const claudeMemoryDelete = defineRpc({
  name: "paseo-memories.claude-delete",
  input: z.object({ sourceId: z.string(), workspaceId: z.string().optional(), key: z.string(), expected: FileStampSchema }),
  output: WriteResultSchema,
});

export const instructionWrite = defineRpc({
  name: "paseo-memories.instruction-write",
  input: z.object({
    /** An existing editable source, or a path from a load plan's `missing` items. */
    path: z.string(),
    /** Needed for project files: the workspace whose folders are allowed. */
    workspaceId: z.string().optional(),
    text: z.string(),
    /** null: create, refuse if the file exists. */
    expected: FileStampSchema.nullable(),
    /** Replace one section only (`Entry.key`); the rest of the file is kept. */
    sectionKey: z.string().optional(),
    /** With `sectionKey`: take that section out entirely (`text` is ignored). */
    removeSection: z.boolean().optional(),
  }),
  output: WriteResultSchema,
});

export const promptGet = defineRpc({
  name: "paseo-memories.prompt-get",
  input: z.object({ reveal: z.boolean().optional() }),
  output: z.object({
    value: z.string(),
    bytes: z.number(),
    tokens: z.number(),
    providers: z.array(z.string()),
    note: z.string(),
    /** Values that look like secrets are hidden in `value`; ask again with `reveal` to edit. */
    masked: z.boolean().optional(),
    secrets: z.number().optional(),
  }),
});

export const promptSet = defineRpc({
  name: "paseo-memories.prompt-set",
  input: z.object({ text: z.string().max(200_000), expected: z.string() }),
  output: WriteResultSchema,
});

export const codexMemoryWrite = defineRpc({
  name: "paseo-memories.codex-write",
  input: z.object({
    sourceId: z.string(),
    text: z.string(),
    expected: FileStampSchema,
    /** The user saw the pending-consolidation warning and wants to save anyway. */
    confirmPending: z.boolean().optional(),
  }),
  output: WriteResultSchema,
});

// ------------------------------------------------------------------ tidy, search, import and export

export const NextStepSchema = z.object({ title: z.string(), detail: z.string(), action: FindingActionSchema.optional() });
export type NextStep = z.infer<typeof NextStepSchema>;

export const findings = defineRpc({
  name: "paseo-memories.findings",
  input: z.object({ refresh: z.boolean().optional() }),
  output: z.object({
    checkedAt: z.string(),
    findings: z.array(FindingSchema),
    nextStep: NextStepSchema,
    checked: z.array(z.string()).default([]),
    /** What the checks could not look at, and why (shown under the list). */
    notes: z.array(z.string()).default([]),
    /** The background scan for stale code names: off | waiting | running | done, with the time of its answer and how many projects have one. */
    symbolScan: z.object({ state: z.string(), asOf: z.string().optional(), checked: z.number().optional(), total: z.number().optional(), note: z.string().default("") }),
  }),
});

export const SearchResultSchema = z.object({
  sourceId: z.string(),
  key: z.string().optional(),
  title: z.string(),
  /** Around the match, secrets masked. Never the whole body. */
  snippet: z.string(),
  agent: z.string(),
  scope: z.string(),
  projectPath: z.string().optional(),
  path: z.string(),
  inTitle: z.boolean().default(false),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const search = defineRpc({
  name: "paseo-memories.search",
  input: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(200).optional() }),
  output: z.object({ query: z.string(), results: z.array(SearchResultSchema), total: z.number(), checked: z.string() }),
});

export const ImportFileSchema = z.object({ name: z.string().max(260), text: z.string().max(2_000_000) });

export const importParse = defineRpc({
  name: "paseo-memories.import-parse",
  input: z.object({
    text: z.string().max(2_000_000).optional(),
    files: z.array(ImportFileSchema).max(50).optional(),
    /** auto | bundle | markdown | claude-memory | claude-ai | mdc */
    format: z.string().optional(),
  }),
  output: z.object({
    items: z.array(ImportItemSchema),
    formats: z.array(z.object({ name: z.string(), format: z.string(), items: z.number() })).default([]),
    warnings: z.array(z.string()).default([]),
  }),
});

/** kind: claude-memory (new memory files in an auto-memory folder) | append (sections at the end of an instruction file). */
export const ImportTargetSchema = z.object({
  kind: z.string(),
  sourceId: z.string().optional(),
  path: z.string().optional(),
  workspaceId: z.string().optional(),
});
export type ImportTarget = z.infer<typeof ImportTargetSchema>;

/** Existing entries to copy or move instead of imported text. */
export const EntryRefSchema = z.object({ sourceId: z.string(), key: z.string().optional(), workspaceId: z.string().optional() });

const DiffLineSchema = z.object({ op: z.string(), text: z.string() });

export const importPreview = defineRpc({
  name: "paseo-memories.import-preview",
  input: z.object({
    items: z.array(ImportItemSchema).max(500).optional(),
    from: z.array(EntryRefSchema).max(200).optional(),
    target: ImportTargetSchema,
    reveal: z.boolean().optional(),
  }),
  output: z.object({
    target: z.object({ kind: z.string(), label: z.string(), path: z.string(), exists: z.boolean(), stamp: FileStampSchema.nullable(), access: AccessSchema, reason: z.string().optional() }),
    items: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        /** create | append | skip */
        action: z.string(),
        fileName: z.string().optional(),
        diff: z.array(DiffLineSchema),
        /** none | exact | near | batch (repeats another item in this import) */
        duplicate: z.string(),
        duplicateOf: z.string().optional(),
        /** The same text is already there, word for word (line endings and outer blank space aside). */
        identical: z.boolean().optional(),
        masked: z.boolean().default(false),
        warnings: z.array(z.string()).default([]),
      }),
    ),
    checked: z.string().default(""),
  }),
});

export const importApply = defineRpc({
  name: "paseo-memories.import-apply",
  input: z.object({
    items: z.array(ImportItemSchema).max(500).optional(),
    from: z.array(EntryRefSchema).max(200).optional(),
    target: ImportTargetSchema,
    selected: z.array(z.string()),
    /** The target file as the preview saw it (append targets); null when it did not exist. */
    expected: FileStampSchema.nullable().optional(),
    /** For `from`: delete the originals once the copies are saved. */
    move: z.boolean().optional(),
  }),
  output: WriteResultSchema,
});

export const exportMemories = defineRpc({
  name: "paseo-memories.export",
  input: z.object({
    selection: z.object({
      /** all | user | project | host */
      scope: z.string().optional(),
      projectPath: z.string().optional(),
      sourceIds: z.array(z.string()).optional(),
      entries: z.array(EntryRefSchema).optional(),
    }),
    /** bundle | markdown */
    format: z.string(),
    /** Unit ids whose secrets to include; everything else is masked. */
    reveal: z.array(z.string()).optional(),
    revealAll: z.boolean().optional(),
  }),
  output: z.object({
    text: z.string(),
    fileName: z.string(),
    count: z.number(),
    masked: z.number(),
    units: z.array(z.object({ id: z.string(), title: z.string(), sourceId: z.string(), secrets: z.number(), masked: z.boolean() })),
  }),
});

// ------------------------------------------------------------------ Add a note (0.2.0)

/** all | claude | codex */
const NoteRequest = z.object({
  text: z.string().min(1).max(20_000),
  who: z.string(),
  /** A Paseo workspace for "Only in <project>"; omitted for "Everywhere". */
  workspaceId: z.string().optional(),
});

export const NoteTargetSchema = z.object({
  /** The file or folder written; also what `note-add` checks the preview against. */
  id: z.string(),
  agent: z.string(),
  /** claude-memory | append */
  kind: z.string(),
  label: z.string(),
  path: z.string(),
  creates: z.boolean().default(false),
  shared: z.boolean().default(false),
  private: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
  /** none | exact (the same text is already there: skipped) | near (almost the same: saved, with a warning) */
  duplicate: z.string().default("none"),
  duplicateOf: z.string().optional(),
  /** Why this place won't get the note (the agent wouldn't read it there); not saved. */
  blocked: z.string().optional(),
  /** Append targets: the file as the preview saw it (null when it does not exist yet). */
  stamp: FileStampSchema.nullable().default(null),
});
export type NoteTarget = z.infer<typeof NoteTargetSchema>;

export const notePreview = defineRpc({
  name: "paseo-memories.note-preview",
  input: NoteRequest,
  output: z.object({
    title: z.string(),
    project: z.string().optional(),
    targets: z.array(NoteTargetSchema),
    /** `covered`: left out because that agent already reads another target ("one note is enough"). */
    skipped: z.array(z.object({ agent: z.string(), reason: z.string(), covered: z.boolean().optional() })).default([]),
    warnings: z.array(z.string()).default([]),
  }),
});

export const noteAdd = defineRpc({
  name: "paseo-memories.note-add",
  input: NoteRequest.extend({
    /** What the preview showed, per target: saves are refused when the places or the files changed since. */
    expected: z.array(z.object({ id: z.string(), stamp: FileStampSchema.nullable() })),
  }),
  output: WriteResultSchema,
});
