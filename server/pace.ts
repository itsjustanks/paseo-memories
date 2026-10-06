/**
 * How hard the background scans (chat-log counting, the code-name scan) may
 * work: at most `share` of one core. 0.5.1 lowered it from a quarter to 4%,
 * so a first read of gigabytes of chat history is slow and quiet rather than
 * quick and noticeable. No single rest is longer than `maxRestMs`, and the
 * CPU is judged over the last `windowMs` at most, so other work in the
 * process (an open page polling) slows a scan down but never stops it.
 * Tests may change these.
 */
export const BACKGROUND_PACE = { busyMs: 20, share: 0.04, maxRestMs: 5_000, windowMs: 60_000 };

/**
 * Background work that never hogs the host: every `busyMs` it checks the
 * whole process's CPU since its window began (every thread: file reads, the
 * collector, other work running meanwhile, and what they did while it
 * rested) against `share` of one core over the same time, and rests until
 * it is back under, at most `maxRestMs` at a time. The window starts again
 * every `windowMs`, so CPU the rest of the process used long ago is never
 * paid off later. In between it lets the RPCs in. Waiting on the disk costs
 * no rest; a pass over a big backlog takes longer; nothing else slows down.
 * With the rest of the process busy, the work still moves: `busyMs` per
 * `maxRestMs` at the least.
 */
export class Pacer {
  private began = performance.now();
  private cpu = process.cpuUsage();
  private since = this.began;

  constructor(
    private readonly busyMs = BACKGROUND_PACE.busyMs,
    private readonly share = BACKGROUND_PACE.share,
    private readonly maxRestMs = BACKGROUND_PACE.maxRestMs,
    private readonly windowMs = BACKGROUND_PACE.windowMs,
  ) {}

  /** Call between pieces of work. */
  async step(): Promise<void> {
    const now = performance.now();
    if (now - this.since < this.busyMs) {
      await new Promise((resolve) => setImmediate(resolve));
      return;
    }
    const used = process.cpuUsage(this.cpu);
    const rest = Math.min(this.maxRestMs, (used.user + used.system) / 1000 / this.share - (now - this.began));
    await new Promise((resolve) => (rest > 0 ? setTimeout(resolve, Math.ceil(rest)) : setImmediate(resolve)));
    this.since = performance.now();
    if (this.since - this.began >= this.windowMs) {
      this.began = this.since;
      this.cpu = process.cpuUsage();
    }
  }
}

/**
 * Work someone waits for (a first read, a Refresh, a write): no rest, but
 * after each `sliceMs` of work it lets the RPCs and I/O in. An `await` on a
 * value already there does not; this does.
 */
export class Slicer {
  private since = performance.now();

  constructor(private readonly sliceMs = 5) {}

  /** Call between pieces of work; returns straight away until the slice is used up. */
  async step(): Promise<void> {
    if (performance.now() - this.since < this.sliceMs) return;
    await new Promise((resolve) => setImmediate(resolve));
    this.since = performance.now();
  }
}

/** Runs a stepped computation (shared code that `yield`s between pieces), letting other work in as `slicer` says. */
export async function runSliced<T>(steps: Generator<void, T>, slicer: Slicer): Promise<T> {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
    await slicer.step();
  }
}
