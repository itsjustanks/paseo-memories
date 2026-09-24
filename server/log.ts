/**
 * The plugin's only log lines. Memory text never reaches a log: these take
 * RPC names, paths, counts and outcomes the caller builds from them, nothing
 * else. Paths are fine (SPEC "Safety" 5).
 */

const TAG = "[paseo-memories]";

export function logWrite(rpc: string, path: string, outcome: string): void {
  console.log(`${TAG} ${rpc} ${path}: ${outcome}`);
}

export function logSlow(rpc: string, ms: number): void {
  console.warn(`${TAG} ${rpc} took ${(ms / 1000).toFixed(1)} s`);
}

export function logFailure(rpc: string, error: unknown): void {
  // Only the error's class and code: a message may quote a file.
  const code = (error as { code?: unknown } | null)?.code;
  const name = error instanceof Error ? error.name : typeof error;
  console.warn(`${TAG} ${rpc} failed (${name}${typeof code === "string" ? ` ${code}` : ""})`);
}
