/**
 * Wall-clock checks that a busy machine can't fail on its own: a timed case
 * runs up to `tries` times and is judged on its fastest run (stopping early
 * once a run is under the limit). A real regression (say, back to quadratic)
 * is slow every time, so it still fails; a burst of other work only spoils
 * one run. `fn` gets the attempt number, for cases that must not repeat
 * input exactly.
 */
export function fastest(fn: (attempt: number) => unknown, limitMs: number, tries = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < tries && best >= limitMs; attempt += 1) {
    const began = performance.now();
    fn(attempt);
    best = Math.min(best, performance.now() - began);
  }
  return best;
}
