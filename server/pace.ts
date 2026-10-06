/**
 * How hard the background scans (chat-log counting, the code-name scan) may
 * work: at most `share` of one core. 0.5.1 lowered it from a quarter to 4%,
 * so a first read of gigabytes of chat history is slow and quiet rather than
 * quick and noticeable. Tests may raise it.
 */
export const BACKGROUND_PACE = { busyMs: 20, share: 0.04 };

/**
 * Background work that never hogs the host: after each `busyMs` of work it
 * rests long enough that the work takes at most `share` of one core
 * (BACKGROUND_PACE by default), and in between it lets the RPCs in. A pass
 * over a big backlog takes longer; nothing else slows down.
 */
export class Pacer {
  private since = performance.now();

  constructor(
    private readonly busyMs = BACKGROUND_PACE.busyMs,
    private readonly share = BACKGROUND_PACE.share,
  ) {}

  /** Call between pieces of work. */
  async step(): Promise<void> {
    const busy = performance.now() - this.since;
    if (busy >= this.busyMs) await new Promise((resolve) => setTimeout(resolve, Math.ceil(busy * (1 / this.share - 1))));
    else await new Promise((resolve) => setImmediate(resolve));
    if (busy >= this.busyMs) this.since = performance.now();
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
