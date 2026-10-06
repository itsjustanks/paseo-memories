import { changedSince, type Seen } from "./files";

/**
 * One cached answer that is never worked out twice at once and never worked
 * out again while nothing it depends on has changed (lesson 11: reads never
 * wait).
 *
 * A computed answer carries what it was built from: `seen`, every path it
 * looked at with how it looked (server/files.ts `Probe.seen`), and `inputs`,
 * a key for everything else (settings, accounts, the daemon's answers,
 * other caches' versions). Checking is cheap: the inputs key, then one stat
 * per path, stopping at the first change. Only a change starts the work
 * again.
 *
 *  - "fresh": work it out now (Refresh, or a write since the last answer);
 *    joins a computation already running for the current write generation.
 *  - "verified": the answer, checked first unless checked in the last
 *    `reuseMs`.
 *  - "stale-ok": the last answer straight away; a check (and, on a change,
 *    the work) runs in the background, at most once per `checkEveryMs` and
 *    only while `checkWhile()` holds (a page is open). The first answer ever,
 *    or the first after a write, is worked out and waited for.
 */

export type Computed<T> = { value: T; seen: Seen; inputs: string };
export type Answer<T> = { value: T; /** When the answer was last known to be right. */ asOf: number; /** A check or new answer is under way. */ checking: boolean; /** Times this answer has been worked out (tests). */ version: number };
export type Mode = "fresh" | "verified" | "stale-ok";
export type Work<T> = { compute: () => Promise<Computed<T>>; inputs: () => Promise<string> };

type Held<T> = Computed<T> & { generation: number; computedAt: number; verifiedAt: number; version: number };

export class Revalidating<T> {
  private held: Held<T> | null = null;
  private computing: { generation: number; promise: Promise<Held<T>> } | null = null;
  private checking: Promise<void> | null = null;
  private versions = 0;
  /** How many times the work ran (tests: a burst of reads runs it once). */
  computations = 0;

  constructor(
    private readonly generation: () => number,
    private readonly opts: { reuseMs: number; checkEveryMs: number; checkWhile?: () => boolean },
  ) {}

  async get(work: Work<T>, mode: Mode): Promise<Answer<T>> {
    const held = this.held;
    const current = held !== null && held.generation === this.generation();
    if (mode === "fresh" || !current) return this.answer(await this.compute(work));
    if (mode === "verified") {
      if (Date.now() - held.verifiedAt >= this.opts.reuseMs) await this.check(work);
      return this.answer(this.held ?? held);
    }
    if (!this.checking && !this.computing && Date.now() - held.verifiedAt >= this.opts.checkEveryMs && (this.opts.checkWhile?.() ?? true)) {
      this.check(work).catch(() => undefined);
    }
    return this.answer(held);
  }

  /** Resolves once no check or computation is running (tests). */
  async settled(): Promise<void> {
    while (this.checking || this.computing) await Promise.allSettled([this.checking, this.computing?.promise]);
  }

  forget(): void {
    this.held = null;
  }

  private answer(held: Held<T>): Answer<T> {
    return { value: held.value, asOf: held.verifiedAt, checking: Boolean(this.checking || this.computing), version: held.version };
  }

  private compute(work: Work<T>): Promise<Held<T>> {
    const generation = this.generation();
    // Join the computation in flight when it started after the last write (a fresh read too: it began moments ago).
    if (this.computing && this.computing.generation === generation) return this.computing.promise;
    const startedAt = Date.now();
    this.computations += 1;
    const promise = work.compute().then((computed) => {
      const held: Held<T> = { ...computed, generation, computedAt: startedAt, verifiedAt: startedAt, version: (this.versions += 1) };
      // Keep it only if no write started meanwhile and nothing newer landed.
      if (generation === this.generation() && (!this.held || this.held.computedAt <= startedAt)) this.held = held;
      return held;
    });
    const entry = { generation, promise };
    this.computing = entry;
    const clear = () => {
      if (this.computing === entry) this.computing = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  /** Re-checks the held answer; works it out again only when something changed. Single-flight. */
  private check(work: Work<T>): Promise<void> {
    if (this.checking) return this.checking;
    const held = this.held;
    if (!held) return Promise.resolve();
    const startedAt = Date.now();
    const run = async () => {
      const unchanged = (await work.inputs()) === held.inputs && !(await changedSince(held.seen));
      if (unchanged && this.held === held) held.verifiedAt = startedAt;
      else if (!unchanged) await this.compute(work);
    };
    const promise = run().finally(() => {
      if (this.checking === promise) this.checking = null;
    });
    this.checking = promise;
    return promise;
  }
}
