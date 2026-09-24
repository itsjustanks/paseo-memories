/**
 * Calls back into the Paseo daemon, with a deadline. Copied from paseo-mcp
 * 0.11.0 `server/run.ts` without `runFile`: nothing in this plugin starts a
 * process.
 */

/** How long a call back into the Paseo daemon may take before the plugin gives up on it. */
export const DAEMON_CALL_TIMEOUT_MS = 10_000;

/**
 * A daemon call with a deadline and a plain-English failure. The daemon gives
 * a whole RPC 30 s; a single lookup inside one should not be allowed to use
 * all of it.
 */
export function withDeadline<T>(call: Promise<T>, what: string, ms = DAEMON_CALL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Paseo did not return ${what} within ${ms / 1000} s; the daemon may be busy. Try again in a moment.`)), ms);
  });
  return Promise.race([call, deadline]).finally(() => clearTimeout(timer));
}
