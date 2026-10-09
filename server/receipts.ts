import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { WriteResultSchema, type WriteResult } from "../shared/contracts";
import { redactResult } from "../shared/redact";
import { STATE_LIMITS, readStateJson, statePath, writeStateText } from "./state-file";

/**
 * Import receipts (0.6.0 data-safety review): one Save press is one write,
 * across restarts and crashes too.
 *
 *   - A request is keyed by a secret this plugin instance made once (kept in
 *     its state folder), the app session that sent it, and its request id.
 *     A spoofed session id can only dedupe requests on this same instance.
 *   - BEFORE any work, a "started" receipt is saved and synced to disk. If
 *     it can't be (disk, permissions, the size limit), the import is refused
 *     and nothing runs: no work ever happens without a receipt.
 *   - When the work ends, the receipt becomes "finished" with its answer
 *     (redacted). A retry gets that answer and writes nothing.
 *   - A retry that finds "started" but not "finished" (a crash or restart in
 *     the middle) is NOT run again: it answers that the import may already
 *     have run, and where to look.
 *   - While a request runs it is registered in memory at once (before any
 *     await), so the same request again joins it. At most PENDING_MAX run at
 *     a time; more are told the host is busy and write nothing.
 *   - Receipts are kept 24 hours, at most RECEIPTS_MAX; the oldest finished
 *     ones are dropped first, also to stay under the state file size limit.
 */

const FILE = "import-receipts";
export const RECEIPT_TTL_MS = 24 * 60 * 60_000;
export const RECEIPTS_MAX = 500;
export const PENDING_MAX = 10;
export const BUSY = "This host is busy with other saves right now. Nothing was written; try again in a moment.";
export const NO_RECORD = "Couldn't record this import before starting it (this plugin's data folder may be full or read-only), so nothing was done. Try again in a moment.";
const CONFLICT = "That save was already used for something else. Nothing was written; preview again.";
export const mayHaveRun = (where: string) => `This import may have already run: it started earlier but didn't finish (Paseo may have restarted). Check ${where} before trying again; nothing was run this time.`;

const ReceiptSchema = z.object({ at: z.number(), shape: z.string(), state: z.enum(["started", "finished"]), where: z.string().default("where it was going"), result: WriteResultSchema.optional() });
const StoreSchema = z.object({ version: z.literal(2), secret: z.string().min(32), receipts: z.record(z.string(), z.unknown()) });
type Receipt = z.infer<typeof ReceiptSchema>;
type Store = { secret: string; receipts: Map<string, Receipt> };

let store: Promise<Store> | null = null;
let saving: Promise<unknown> = Promise.resolve();
const PENDING = new Map<string, { shape: string; result: Promise<WriteResult> }>();

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function refuse(message: string): WriteResult {
  return { ok: false, message, reports: [], warnings: [] };
}

/** The receipts as saved; a missing or damaged file starts fresh (one bad receipt costs only itself). */
async function load(): Promise<Store> {
  const parsed = StoreSchema.safeParse(await readStateJson(FILE));
  if (!parsed.success) return { secret: randomBytes(32).toString("hex"), receipts: new Map() };
  const receipts = new Map<string, Receipt>();
  for (const [key, value] of Object.entries(parsed.data.receipts)) {
    const receipt = ReceiptSchema.safeParse(value);
    if (receipt.success) receipts.set(key, receipt.data);
  }
  return { secret: parsed.data.secret, receipts };
}

function current(): Promise<Store> {
  store ??= load();
  return store;
}

/**
 * Old receipts out (over 24 h), then the oldest FINISHED ones beyond the cap.
 * A "started" receipt is never trimmed while it's current: dropping it would
 * let a retry run again.
 */
function prune(receipts: Map<string, Receipt>, now: number, keep: string): void {
  for (const [key, receipt] of receipts) if (key !== keep && now - receipt.at > RECEIPT_TTL_MS) receipts.delete(key);
  dropOldestFinished(receipts, receipts.size - RECEIPTS_MAX, keep);
}

/** Drops up to `count` of the oldest finished receipts (never `keep`, never a started one). */
function dropOldestFinished(receipts: Map<string, Receipt>, count: number, keep: string): number {
  if (count <= 0) return 0;
  const order = [...receipts].filter(([key, receipt]) => key !== keep && receipt.state === "finished").sort((a, b) => a[1].at - b[1].at);
  for (const [key] of order.slice(0, count)) receipts.delete(key);
  return Math.min(count, order.length);
}

/** The file's text, trimmed (oldest finished first) until it fits `budget`; null when it can't fit. */
function serialise(state: Store, keep: string, budget: number): string | null {
  for (;;) {
    const text = JSON.stringify({ version: 2, secret: state.secret, receipts: Object.fromEntries(state.receipts) });
    if (Buffer.byteLength(text) <= budget) return text;
    const finished = [...state.receipts].filter(([key, receipt]) => key !== keep && receipt.state === "finished").length;
    if (!dropOldestFinished(state.receipts, Math.max(1, Math.ceil(finished / 10)), keep)) return null;
  }
}

/** The state folder synced too, so a receipt's rename survives a crash. */
async function syncFolder(path: string): Promise<void> {
  const handle = await fs.open(path, "r").catch(() => null);
  if (!handle) return;
  await handle.sync().catch(() => undefined);
  await handle.close().catch(() => undefined);
}

/**
 * Saves one receipt, queued so two saves never race. Old receipts are
 * trimmed FIRST; a "started" one is written within half the size limit, so
 * its answer has room later. True when it is on disk. On any failure what
 * was on record before is put back exactly: a "started" receipt is never
 * deleted or downgraded. Never throws.
 */
async function remember(key: string, receipt: Receipt, now = Date.now()): Promise<boolean> {
  const write = saving.then(async () => {
    const state = await current();
    const before = state.receipts.get(key);
    state.receipts.set(key, receipt.result ? { ...receipt, result: redactResult(receipt.result) } : receipt);
    prune(state.receipts, now, key);
    const budget = receipt.state === "started" ? Math.floor(STATE_LIMITS.maxBytes / 2) : STATE_LIMITS.maxBytes;
    const text = serialise(state, key, budget);
    if (text === null || !(await writeStateText(FILE, text))) {
      if (before) state.receipts.set(key, before);
      else state.receipts.delete(key);
      return false;
    }
    await syncFolder(dirname(statePath(FILE)));
    return true;
  });
  saving = write.catch(() => undefined);
  return write.catch(() => false);
}

/** The persisted key: the instance's secret, the app session and the request id. */
async function receiptKey(clientId: string | undefined, requestId: string): Promise<string> {
  const { secret } = await current();
  return sha256(`${secret}\u0000${clientId ?? "-"}\u0000${requestId}`);
}

/**
 * Runs `work` once per (app session, request id), here and across restarts.
 * `where` names the destination, for "check … before trying again".
 */
export function once(clientId: string | undefined, requestId: string, shape: string, work: () => Promise<WriteResult>, where = "where it was going"): Promise<WriteResult> {
  const live = `${clientId ?? "-"}\u0000${requestId}`;
  const running = PENDING.get(live);
  if (running) return running.shape === shape ? running.result : Promise.resolve(refuse(CONFLICT));
  if (PENDING.size >= PENDING_MAX) return Promise.resolve(refuse(BUSY));
  // Registered before any await: a second identical request arriving now joins this one.
  const result = (async () => {
    const key = await receiptKey(clientId, requestId);
    const known = (await current()).receipts.get(key);
    if (known && Date.now() - known.at <= RECEIPT_TTL_MS) {
      if (known.shape !== shape) return refuse(CONFLICT);
      if (known.state === "finished" && known.result) return known.result;
      return refuse(mayHaveRun(known.where));
    }
    // The intent first, on disk: no work ever runs without a receipt.
    if (!(await remember(key, { at: Date.now(), shape, state: "started", where }))) return refuse(NO_RECORD);
    const answer = await work();
    // If this one can't be saved, the "started" receipt stays: a retry is told it may have run, never run again.
    await remember(key, { at: Date.now(), shape, state: "finished", where, result: answer });
    return answer;
  })().finally(() => PENDING.delete(live));
  PENDING.set(live, { shape, result });
  return result;
}

/** For tests: how many requests are running, and how many receipts are kept (and how many only started). */
export async function receiptCounts(): Promise<{ running: number; kept: number; started: number }> {
  const receipts = (await current()).receipts;
  return { running: PENDING.size, kept: receipts.size, started: [...receipts.values()].filter((receipt) => receipt.state === "started").length };
}

/** For tests: play a restart (forget what is in memory; the file stays). */
export function forgetInMemory(): void {
  store = null;
  saving = Promise.resolve();
  PENDING.clear();
}

/** For tests: save a finished receipt with a given time, to check pruning. */
export const rememberAt = (key: string, at: number) => remember(key, { at, shape: "shape", state: "finished", where: "here", result: refuse("old") }, at);
