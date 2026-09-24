/** Display helpers shared by the app and the smoke script. Pure. */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Always "≈": bytes / 4 is a rule of thumb, not a tokenizer. */
export function formatTokens(tokens: number): string {
  return tokens < 1000 ? `≈${tokens} tokens` : `≈${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k tokens`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}
