import fs from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listDir, statSafe } from "./files";

/**
 * Is Codex consolidating memories right now? Read from Codex's own state
 * database, READ-ONLY, and answered "unsure" whenever the answer is not
 * certain: the caller refuses to save on anything but "free".
 *
 * The global consolidation job is the `jobs` row `kind =
 * 'memory_consolidate_global'`; Codex holds it with `status = 'running'` and
 * heartbeats `lease_until` (seconds) while its consolidation agent runs
 * (codex-rs memories/README.md "Phase 2"; schema read from
 * `memories_1.sqlite` on this Mac, codex-cli 0.156.1).
 *
 * WAL gotcha: opening a WAL database read-only when its `-wal`/`-shm` files
 * are absent makes SQLite CREATE them (checked on Node 24). So: both present →
 * a normal read-only open; neither → the database is fully checkpointed and is
 * opened `immutable=1`, which creates nothing; one without the other → unsure.
 * `node:sqlite` is loaded lazily: a Node without it means unsure, not a crash.
 * Its calls are synchronous, but this is one indexed row in a small file.
 */

export type LockState = {
  lock: "free" | "locked" | "unsure";
  reason: string;
  lastJob?: { status: string; finishedAt?: string; error?: boolean };
};

const CONSOLIDATION_KIND = "memory_consolidate_global";
/**
 * Statuses known to mean "not running": `done` and `error` seen in the jobs
 * table, `failed` documented in codex-rs memories/README.md. Anything else
 * refuses (fail closed).
 */
const IDLE = new Set(["done", "error", "failed"]);

/** A `running` lease that ran out longer ago than this is a crashed run, not a live one. */
export const STALE_LEASE_MS = 60 * 60_000;

type SqliteModule = { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb };
type SqliteDb = { prepare(sql: string): { all(...args: unknown[]): unknown[] }; close(): void };

let loader: () => Promise<SqliteModule> = () => import("node:sqlite") as unknown as Promise<SqliteModule>;

/** For tests: pretend `node:sqlite` is missing, or restore it. */
export function setSqliteLoader(next: (() => Promise<SqliteModule>) | null): void {
  loader = next ?? (() => import("node:sqlite") as unknown as Promise<SqliteModule>);
}

/** Codex's newest `memories_<n>.sqlite` in a Codex home. */
export async function codexStateDb(home: string): Promise<string | null> {
  let best: { n: number; name: string } | null = null;
  for (const entry of await listDir(home)) {
    const match = /^memories_(\d+)\.sqlite$/.exec(entry.name);
    if (match && entry.isFile() && (!best || Number(match[1]) > best.n)) best = { n: Number(match[1]), name: entry.name };
  }
  return best ? join(home, best.name) : null;
}

async function journalMode(path: string): Promise<"wal" | "rollback" | null> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(path, "r");
    const header = Buffer.alloc(100);
    const { bytesRead } = await handle.read(header, 0, 100, 0);
    if (bytesRead < 100 || header.toString("latin1", 0, 15) !== "SQLite format 3") return null;
    return header[18] === 2 && header[19] === 2 ? "wal" : "rollback";
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function unsure(reason: string): LockState {
  return { lock: "unsure", reason };
}

export async function codexLockState(home: string, now = Date.now()): Promise<LockState> {
  const db = await codexStateDb(home);
  if (!db) return unsure("Codex's memory database (memories_N.sqlite) was not found, so the plugin cannot tell whether Codex is consolidating.");
  const mode = await journalMode(db);
  if (!mode) return unsure("Codex's memory database could not be read as SQLite.");
  let open = db;
  if (mode === "wal") {
    const wal = Boolean(await statSafe(`${db}-wal`));
    const shm = Boolean(await statSafe(`${db}-shm`));
    if (wal !== shm) return unsure("Codex's database is part-way through a write (one of its -wal/-shm files is missing). Try again in a moment.");
    if (!wal) open = `${pathToFileURL(db).href}?immutable=1`;
  } else if (await statSafe(`${db}-journal`)) {
    return unsure("Codex is writing its memory database right now. Try again in a moment.");
  }
  let sqlite: SqliteModule;
  try {
    sqlite = await loader();
  } catch {
    return unsure("This Paseo runs a Node without built-in SQLite (node:sqlite), so the plugin cannot check whether Codex is consolidating.");
  }
  let handle: SqliteDb | null = null;
  let rows: Array<Record<string, unknown>>;
  try {
    handle = new sqlite.DatabaseSync(open, { readOnly: true });
    rows = handle
      .prepare("SELECT status, lease_until, finished_at, last_error FROM jobs WHERE kind = ?")
      .all(CONSOLIDATION_KIND) as Array<Record<string, unknown>>;
  } catch {
    return unsure("Codex's memory database could not be opened read-only (it may be busy or a newer layout).");
  } finally {
    try {
      handle?.close();
    } catch {
      // closing a read-only handle cannot lose anything
    }
  }
  if (rows.length === 0) return { lock: "free", reason: "Codex has not consolidated memories yet." };
  if (rows.length > 1) return unsure("Codex's database has more than one consolidation job; not sure which is current.");
  const row = rows[0]!;
  const status = String(row.status ?? "");
  const finished = typeof row.finished_at === "number" ? new Date(row.finished_at * 1000).toISOString() : undefined;
  const lastJob = { status, ...(finished ? { finishedAt: finished } : {}), ...(row.last_error ? { error: true } : {}) };
  if (status === "running") {
    const lease = typeof row.lease_until === "number" ? row.lease_until * 1000 : null;
    if (lease !== null && lease > now) {
      return { lock: "locked", reason: `Codex is consolidating memories right now (its lock runs until ${new Date(lease).toISOString()}). Save after it finishes.`, lastJob };
    }
    if (lease !== null && now - lease > STALE_LEASE_MS) {
      // Codex itself takes over a lease that has run out: `try_claim_global_phase2_job`
      // (codex-rs/state/src/runtime/memories.rs:1083, tag rust-v0.156.1) claims the job when
      // `status != 'running' OR lease_until IS NULL OR lease_until <= now` (:1186). So a lease
      // over an hour stale belongs to a run that died, and the next Codex run will take it.
      return { lock: "free", reason: `A Codex clean-up is marked as running, but its lease ran out at ${new Date(lease).toISOString()}, over an hour ago. Codex reclaims expired leases itself, so this counts as free.`, lastJob };
    }
    return { lock: "unsure", reason: "A Codex consolidation is marked running and its lock only just ran out. Try again in an hour, or start a Codex session to let it finish.", lastJob };
  }
  if (!IDLE.has(status)) return { lock: "unsure", reason: `Codex's consolidation job is in a state this plugin does not know ("${status}").`, lastJob };
  return { lock: "free", reason: "No consolidation is running.", lastJob };
}
