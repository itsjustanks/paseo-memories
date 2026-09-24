/**
 * Token-looking values in memory text, found and masked. Pure; used by the
 * server before any text leaves it and by the client for display.
 *
 * A mask keeps the first four characters and replaces the rest with
 * MASK_FILL, so a masked value is recognisable and a save that still
 * carries a mask can be refused (see `hasMask`).
 */

export const MASK_FILL = "••••••••";

export type SecretMatch = { kind: string; start: number; end: number };

type Pattern = { kind: string; re: RegExp; group?: number };

const PATTERNS: Pattern[] = [
  { kind: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "Anthropic/OpenAI key", re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "Stripe key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { kind: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "Supabase token", re: /\bsbp_[a-f0-9]{40}\b/g },
  { kind: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "bearer token", re: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g, group: 1 },
  {
    kind: "credential value",
    re: /\b(?:api[_-]?key|apikey|access[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|token|auth[_-]?token|password|passwd|pwd)["']?\s*[:=]\s*["']?([A-Za-z0-9+/_.=-]{16,})/gi,
    group: 1,
  },
];

/** A value after `token:` must look random: long hex, or mixed-case base64-ish with a digit. */
function looksRandom(value: string): boolean {
  if (/^[a-f0-9]{24,}$/i.test(value)) return true;
  if (value.length < 20) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((re) => re.test(value)).length;
  return classes >= 3 || (classes >= 2 && value.length >= 32);
}

export function findSecrets(text: string): SecretMatch[] {
  const found: SecretMatch[] = [];
  for (const { kind, re, group } of PATTERNS) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const whole = match.index ?? 0;
      const value = group ? match[group] : match[0];
      if (!value) continue;
      const start = group ? whole + match[0].lastIndexOf(value) : whole;
      if (kind === "credential value" && !looksRandom(value)) continue;
      if (value.includes(MASK_FILL)) continue;
      found.push({ kind, start, end: start + value.length });
    }
  }
  // Keep the earliest, longest match where two overlap.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: SecretMatch[] = [];
  for (const match of found) {
    const last = out[out.length - 1];
    if (last && match.start < last.end) continue;
    out.push(match);
  }
  return out;
}

export function maskSecrets(text: string): { text: string; count: number; kinds: string[] } {
  const matches = findSecrets(text);
  if (matches.length === 0) return { text, count: 0, kinds: [] };
  let out = "";
  let at = 0;
  for (const match of matches) {
    out += text.slice(at, match.start) + text.slice(match.start, match.start + 4) + MASK_FILL;
    at = match.end;
  }
  out += text.slice(at);
  return { text: out, count: matches.length, kinds: [...new Set(matches.map((match) => match.kind))] };
}

/** True when `next` carries a mask the original did not: saving it would destroy a secret. */
export function hasNewMask(next: string, original: string): boolean {
  const count = (text: string) => text.split(MASK_FILL).length - 1;
  return count(next) > count(original);
}

/** Every string inside a value, masked. For RPC responses; objects and arrays are copied, never changed in place. */
export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return maskSecrets(value).text as T;
  if (Array.isArray(value)) return value.map((item) => maskDeep(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = maskDeep(item);
    return out as T;
  }
  return value;
}

/**
 * Fields that carry words a person reads: masked in responses. Everything
 * else (ids, paths, keys, slugs, stamps, file names) is left exactly as is,
 * because the app sends it back: `…/code/sk-learn-experiments` is a folder,
 * not a secret, and masking it breaks every round trip.
 */
export const TEXT_FIELDS = new Set([
  "body", "snippet", "title", "description", "hook", "heading", "message", "text", "value", "name",
  "label", "detail", "note", "notes", "warnings", "checked", "reason", "lockReason", "pending",
  "duplicateOf", "error", "unsure", "type",
]);

/** Free-form maps (unknown frontmatter keys): every string inside is text, whatever its key. */
export const FREE_TEXT_FIELDS = new Set(["extra"]);

/** Masks strings under TEXT_FIELDS (at any depth, including arrays of them) and everything under FREE_TEXT_FIELDS. */
export function maskTextFields<T>(value: T, field?: string): T {
  if (field !== undefined && FREE_TEXT_FIELDS.has(field)) return maskDeep(value);
  if (typeof value === "string") return (field !== undefined && TEXT_FIELDS.has(field) ? maskSecrets(value).text : value) as T;
  if (Array.isArray(value)) return value.map((item) => maskTextFields(item, field)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = maskTextFields(item, key);
    return out as T;
  }
  return value;
}
