/**
 * Test sandbox: the fixture HOME copied into a fresh temp folder, every agent
 * variable pointed at it, and a guard that fails the test on any write
 * outside it. Import this module first, call `makeSandbox()`, THEN import
 * server code (paseo-mcp gotcha: set the environment before the import).
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeSlug } from "../shared/slug";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const AGENT_VARS = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "AGENT_LINK_HOME",
  "AGENT_AUTH_HOME",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
  "PI_CODING_AGENT_DIR",
  "COPILOT_HOME",
  "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
  "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
  "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE",
];

export const LONG_NAME = `a-very-long-project-folder-name-${"x".repeat(150)}`;

export type JobState = "done" | "running" | "running-expired" | "running-stale" | "error" | "strange" | "no-row" | "no-db";

export type Sandbox = {
  root: string;
  home: string;
  paseoHome: string;
  managed: string;
  app: string;
  worktree: string;
  plain: string;
  big: string;
  long: string;
  claude: string;
  codex: string;
  slot: { claude: string; codex: string };
  appMemory: string;
  longMemory: string;
  codexDb: string;
  cleanup(): void;
};

// ------------------------------------------------------------------ write guard

let guardRoot: string | null = null;
export const violations: string[] = [];

function checkPath(method: string, target: unknown): void {
  if (guardRoot === null) return;
  const path = target instanceof URL ? fileURLToPath(target.href) : typeof target === "string" ? resolve(target) : null;
  if (path === null) return;
  if (path === guardRoot || path.startsWith(`${guardRoot}/`)) return;
  // tsx keeps its compile cache in the temp folder while test code imports modules.
  if (TSX_CACHE.some((prefix) => path.startsWith(prefix))) return;
  violations.push(`${method} ${path}`);
  const error = new Error(`write guard: ${method} outside the sandbox: ${path}`) as NodeJS.ErrnoException;
  error.code = "EPERM";
  throw error;
}

const WRITE_FLAGS = /[wax+]/;
const TSX_CACHE = [join(tmpdir(), "tsx-"), join(fs.realpathSync(tmpdir()), "tsx-")];

function patchWrites(): void {
  const promises = fsp as unknown as Record<string, (...args: unknown[]) => unknown>;
  const sync = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  const guardFirst = ["writeFile", "appendFile", "unlink", "rm", "rmdir", "mkdir", "chmod", "utimes", "truncate", "lchmod", "lutimes"];
  const guardBoth = ["rename"];
  const guardSecond = ["copyFile", "cp", "symlink", "link"];
  for (const [target, suffix] of [[promises, ""], [sync, "Sync"], [sync, ""]] as const) {
    for (const name of [...guardFirst, ...guardBoth, ...guardSecond, "open"]) {
      const key = `${name}${suffix}`;
      const original = target[key];
      if (typeof original !== "function" || (original as { guarded?: boolean }).guarded) continue;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        if (name === "open") {
          const flags = args[1];
          if (typeof flags === "string" && WRITE_FLAGS.test(flags)) checkPath(key, args[0]);
          if (typeof flags === "number" && flags !== 0) checkPath(key, args[0]);
        } else if (guardSecond.includes(name)) {
          checkPath(key, args[1]);
        } else {
          checkPath(key, args[0]);
          if (guardBoth.includes(name)) checkPath(key, args[1]);
        }
        return original.apply(this, args);
      };
      (wrapped as unknown as { guarded: boolean }).guarded = true;
      target[key] = wrapped;
    }
  }
  syncBuiltinESMExports();
}

patchWrites();

// ------------------------------------------------------------------ sandbox

function renameGitDirs(folder: string): void {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      renameGitDirs(path);
      if (entry.name === "_git") fs.renameSync(path, join(folder, ".git"));
    }
  }
}

export async function writeCodexDb(path: string, state: JobState, { wal = false } = {}): Promise<void> {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${path}${suffix}`, { force: true });
  if (state === "no-db") return;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE jobs (
    kind TEXT NOT NULL, job_key TEXT NOT NULL, status TEXT NOT NULL, worker_id TEXT, ownership_token TEXT,
    started_at INTEGER, finished_at INTEGER, lease_until INTEGER, retry_at INTEGER, retry_remaining INTEGER NOT NULL,
    last_error TEXT, input_watermark INTEGER, last_success_watermark INTEGER, PRIMARY KEY (kind, job_key))`);
  const now = Math.floor(Date.now() / 1000);
  const insert = db.prepare("INSERT INTO jobs (kind, job_key, status, started_at, finished_at, lease_until, retry_remaining, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("memory_stage1", "thread-1", "done", now - 900, now - 890, null, 3, null);
  const global: Record<Exclude<JobState, "no-row" | "no-db">, [string, number | null, number | null, string | null]> = {
    done: ["done", now - 600, null, null],
    running: ["running", null, now + 3600, null],
    "running-expired": ["running", null, now - 60, null],
    "running-stale": ["running", null, now - 3 * 3600, null],
    error: ["error", now - 60, null, "failed_agent"],
    strange: ["pending", null, null, null],
  };
  if (state !== "no-row") {
    const [status, finished, lease, error] = global[state];
    insert.run("memory_consolidate_global", "global", status, now - 700, finished, lease, 0, error);
  }
  db.close();
}

export async function makeSandbox({ job = "done" as JobState } = {}): Promise<Sandbox> {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "paseo-memories-test-")));
  guardRoot = root;
  const home = join(root, "home");
  fs.cpSync(join(FIXTURES, "home"), home, { recursive: true });
  fs.cpSync(join(FIXTURES, "managed"), join(root, "managed"), { recursive: true });
  renameGitDirs(home);
  const app = join(home, "code", "app");
  const worktree = join(home, "code", "app-wt");
  const long = join(home, "code", LONG_NAME);
  fs.writeFileSync(join(worktree, ".git"), `gitdir: ${join(app, ".git", "worktrees", "app-wt")}\n`);
  fs.writeFileSync(join(app, ".git", "worktrees", "app-wt", "gitdir"), `${join(worktree, ".git")}\n`);
  fs.mkdirSync(long, { recursive: true });
  fs.writeFileSync(join(long, "CLAUDE.md"), "Long project rules.\n");
  const projects = join(home, ".claude", "projects");
  fs.renameSync(join(projects, "@app"), join(projects, claudeSlug(app)));
  fs.renameSync(join(projects, "@long"), join(projects, claudeSlug(long)));
  const plain = join(home, "code", "plain");
  const big = join(home, "code", "big");
  fs.writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" }, projects: Object.fromEntries([app, worktree, plain, big, long].map((path) => [path, {}])) }),
  );
  const codexDb = join(home, ".codex", "memories_1.sqlite");
  await writeCodexDb(codexDb, job);
  process.env.HOME = home;
  process.env.PASEO_HOME = join(home, ".paseo");
  process.env.PASEO_MEMORIES_MANAGED_DIR = join(root, "managed");
  for (const name of AGENT_VARS) delete process.env[name];
  return {
    root,
    home,
    paseoHome: join(home, ".paseo"),
    managed: join(root, "managed"),
    app,
    worktree,
    plain,
    big,
    long,
    claude: join(home, ".claude"),
    codex: join(home, ".codex"),
    slot: { claude: join(home, ".agent-link", "accounts", "claude", "slot@example.com"), codex: join(home, ".agent-link", "accounts", "codex", "slot@example.com") },
    appMemory: join(projects, claudeSlug(app), "memory"),
    longMemory: join(projects, claudeSlug(long), "memory"),
    codexDb,
    cleanup() {
      guardRoot = null;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------------ fake daemon

export type FakePaseo = {
  api: never;
  patches: Array<Record<string, unknown>>;
  config: { appendSystemPrompt: string; providers: Record<string, unknown> };
  /** "ok": apply; "ignore": accept but keep the old value; "throw": reject. */
  patchBehaviour: "ok" | "ignore" | "throw";
};

export function fakePaseo(sb: Sandbox, { prompt = "", providers = {} as Record<string, unknown>, extra = [] as Array<{ id: string; path: string }> } = {}): FakePaseo {
  const fake: FakePaseo = { api: null as never, patches: [], config: { appendSystemPrompt: prompt, providers }, patchBehaviour: "ok" };
  const workspaces = [
    { id: "ws-app", name: "app", workspaceDirectory: sb.app, projectRootPath: sb.app },
    { id: "ws-wt", name: "app-wt", workspaceDirectory: sb.worktree, projectRootPath: sb.app },
    { id: "ws-plain", name: "plain", workspaceDirectory: sb.plain, projectRootPath: sb.plain },
    { id: "ws-big-sub", name: "big", workspaceDirectory: join(sb.big, "sub"), projectRootPath: sb.big },
    { id: "ws-long", name: "long", workspaceDirectory: sb.long, projectRootPath: sb.long },
    ...extra.map((entry) => ({ id: entry.id, name: entry.path.split("/").pop()!, workspaceDirectory: entry.path, projectRootPath: entry.path })),
  ];
  fake.api = {
    config: {
      get: async () => ({ requestId: "r", config: structuredClone(fake.config) }),
      patch: async (patch: Record<string, unknown>) => {
        fake.patches.push(structuredClone(patch));
        if (fake.patchBehaviour === "throw") throw new Error("config rejected");
        if (fake.patchBehaviour === "ok") fake.config = { ...fake.config, ...(patch as Partial<FakePaseo["config"]>) };
        return { requestId: "r", config: structuredClone(fake.config) };
      },
    },
    workspaces: { list: async () => ({ entries: workspaces }) },
    projects: { list: async () => ({ entries: [sb.app, sb.plain, sb.big, sb.long, ...extra.map((entry) => entry.path)].map((path) => ({ name: path.split("/").pop(), path })) }) },
  } as never;
  return fake;
}

// ------------------------------------------------------------------ spawn and sync-call counters

export const spawned: string[] = [];
const child = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const method of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const original = child[method]!;
  child[method] = (...args: unknown[]) => {
    spawned.push(`${method} ${String(args[0])}`);
    return original.apply(childProcess, args);
  };
}
syncBuiltinESMExports();

const SYNC_FS = ["readFileSync", "writeFileSync", "statSync", "lstatSync", "readdirSync", "existsSync", "openSync", "readSync", "renameSync", "mkdirSync", "copyFileSync", "accessSync", "realpathSync", "rmSync", "unlinkSync"];

/** Run `fn` with every blocking fs call throwing: RPC handlers must not use them. */
export async function withoutSyncFs<T>(fn: () => Promise<T>): Promise<{ result: T; blocked: string[] }> {
  const target = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  const saved = new Map<string, (...args: unknown[]) => unknown>();
  const blocked: string[] = [];
  for (const name of SYNC_FS) {
    saved.set(name, target[name]!);
    target[name] = (...args: unknown[]) => {
      blocked.push(`${name} ${String(args[0])}`);
      throw new Error(`blocking fs call on the RPC path: ${name}`);
    };
  }
  syncBuiltinESMExports();
  try {
    return { result: await fn(), blocked };
  } finally {
    for (const [name, original] of saved) target[name] = original;
    syncBuiltinESMExports();
  }
}

/** Everything written to the console or stdout/stderr while `fn` runs. */
export async function captureOutput<T>(fn: () => Promise<T>): Promise<{ result: T | undefined; error?: unknown; output: string }> {
  const chunks: string[] = [];
  const consoleSaved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  for (const key of Object.keys(consoleSaved) as Array<keyof typeof consoleSaved>) {
    console[key] = (...args: unknown[]) => void chunks.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg))).join(" "));
  }
  // Record and pass through: the test runner reports over stdout.
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (chunks.push(String(chunk)), (stdout as (...args: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => (chunks.push(String(chunk)), (stderr as (...args: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stderr.write;
  try {
    return { result: await fn(), output: chunks.join("\n") };
  } catch (error) {
    return { result: undefined, error, output: chunks.join("\n") };
  } finally {
    Object.assign(console, consoleSaved);
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}
