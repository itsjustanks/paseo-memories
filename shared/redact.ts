import { MASK_FILL, maskSecrets } from "./secrets";

/**
 * The one redactor for what the plugin says about itself (0.6.0): toasts,
 * error and result messages, report lines, and the names Fix all's confirm
 * lists. Notes and skills you open still show as they are (with their own
 * "Hide secrets" setting); this is for messages, which should never carry a key.
 *
 * Structural, so a value is found by where it sits, not by how it looks:
 *   - `Authorization:` with any scheme (the rest of the header goes);
 *   - command-line flags, also inside arrays: `--api-key X`, `--token=X`,
 *     `["--api-key", "X"]`, and `-p X` unless X is a number (a port);
 *   - variables: `FOO_TOKEN=X`, `db_password = X`;
 *   - `name=value` for a credential name, and `name: value` for a compound
 *     one (`api_key:`, `client_secret:`, `accessToken:`): config keys;
 *   - `password: X`, `token: X`, `key: X` (one word) only when X is quoted
 *     or looks like a credential, in any letter case. A title such as
 *     "Password: rotation" or "password: reset checklist" stays readable;
 *   - "token a1b2c3…" and "Basic dXNl…" when what follows looks like a
 *     credential ("Token expired" and "use Basic authentication" stay).
 * A quoted value goes whole, escaped quotes and `"""…"""` blocks included.
 * Names match as whole words: tokenizer, monkey, keyboard and author stay.
 * A value that is already a mask (dots and at most 4 characters) is left as
 * it is; anything else with a • in it is masked like any value. Then
 * `maskSecrets` (known key shapes), credentials in a URL, and long hex or
 * base64 runs that stand alone (a run inside a path is left alone). Pure.
 */

const SINGLE = "secret|token|password|passwd|passphrase|pwd|key|authorization";
const COMPOUND = "api[_-]?key|apikey|access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key";
const FLAG_NAMES = `${COMPOUND}|${SINGLE}|pass|auth|bearer`;
/** A credential name as a whole word (optionally quoted), then `=` or `:`. Group 1: the name, 2: the separator. */
const PAIR = new RegExp(`(?<![A-Za-z0-9_.])(${COMPOUND}|${SINGLE})(?![A-Za-z0-9])["']?\\s*([:=])[^\\S\\n]*`, "gi");
/** `--token=X`, `--api-key X`, `"--api-key", "X"`. */
const FLAG = new RegExp(`(?<![\\w-])--(?:${FLAG_NAMES})(?![A-Za-z0-9-])(?:=|["']?[^\\S\\n]*,[^\\S\\n]*|[^\\S\\n]+)(?=["'\`]?[^\\s"'\`-])`, "gi");
/** `-p X` / `"-p", "X"`: a password unless X is a number. */
const SHORT_P = /(?<![\w-])-p(?![\w-])(?:["']?[^\S\n]*,[^\S\n]*|[^\S\n]+)(?=["'`]?[^\s"'`-])/g;
/** `FOO_TOKEN=X`, `db-password = X`: a name ending in a credential word, as an assignment. */
const VARIABLE = /(?<![\w.-])[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*[_-](?:token|key|secret|password|passwd|pwd|pass)(?![A-Za-z0-9])["']?\s*=\s*/gi;
/** "token a1b2…", "password hunter22": a credential word, a space, then a value (masked only when it looks like a credential). */
const SPOKEN = /(?<![\w.-])(?:token|password|secret|key|passphrase)[^\S\n]+(?=\S)/gi;
/** "Basic dXNl…", "Bearer …": a scheme word, then a value (masked only when it looks encoded). */
const SCHEME = /(?<![\w.-])(?:basic|bearer|digest)[^\S\n]+(?=\S)/gi;
/** A key named for credentials holding an object: every quoted value in it goes. */
const SECRET_OBJECT = /"(?:credentials|secrets?|auth)"\s*:\s*\{[^{}]*\}/gi;
/** OAuth's one-time code and other secrets in a URL's query: `?code=…`, `&access_token=…`. */
const URL_SECRET = /[?&](?:code|access_token|id_token|refresh_token|client_secret|api_key|apikey|key|token|password|secret)=(?=[^&\s#])/gi;
const AUTHORIZATION = /\b(?:proxy-)?authorization[^\S\n]*:[^\S\n]*(?!["'])/gi;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;
const HEX = /(?<![\w/.-])[A-Fa-f0-9]{32,}(?![\w/.-])/g;
const BASE64 = /(?<![\w/.+-])[A-Za-z0-9+_-]{40,}={0,2}(?![\w/.+-])/g;

/** Mixed letters and digits: a random value, not a long word. */
const random = (value: string) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);

/**
 * One value that reads like a credential rather than a word: a known key
 * shape, or 8+ characters mixing letters with digits or symbols, or 16+
 * that aren't all letters. "rotation", "expired" and "checklist" aren't.
 */
export function credentialLike(value: string): boolean {
  if (maskSecrets(value).count > 0) return true;
  const letters = /[A-Za-z]/.test(value);
  if (value.length >= 6 && letters && /\d/.test(value)) return true;
  if (value.length >= 8 && letters && /[^A-Za-z0-9\s]/.test(value) && !/^[A-Za-z]+[-'][A-Za-z]+$/.test(value)) return true;
  return value.length >= 16 && /[^A-Za-z]/.test(value);
}

/** Looks encoded (base64-ish): 8+ characters with mixed case, digits or =+/ . */
const encodedLike = (value: string) => value.length >= 8 && /^[A-Za-z0-9+/=._-]+$/.test(value) && ((/[a-z]/.test(value) && /[A-Z]/.test(value)) || /[\d=+/]/.test(value));

type Value = { start: number; end: number; quoted: boolean; alone: boolean };

/** Where a quoted value ends: its closing quote (skipping escaped ones), or a triple quote's closing triple. */
function quotedEnd(text: string, at: number): number {
  const quote = text[at]!;
  const triple = text.startsWith(quote.repeat(3), at);
  if (triple) {
    const close = text.indexOf(quote.repeat(3), at + 3);
    return close === -1 ? text.length : close + 3;
  }
  for (let i = at + 1; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === quote) return i + 1;
    if (char === "\n") return i;
  }
  return text.length;
}

/** The value starting at `at`: a quoted span, a bare word, (`toEnd`) the rest of the line up to a delimiter, or (`"line"`) the whole rest of the line. */
function valueAt(text: string, at: number, toEnd: boolean | "line" = false): Value | null {
  const first = text[at];
  if (toEnd === "line") {
    const lineEnd = text.indexOf("\n", at);
    let end = lineEnd === -1 ? text.length : lineEnd;
    while (end > at && /\s/.test(text[end - 1]!)) end -= 1;
    return end > at ? { start: at, end, quoted: false, alone: true } : null;
  }
  if (first === '"' || first === "'" || first === "`") {
    const end = quotedEnd(text, at);
    return end > at + 1 ? { start: at, end, quoted: true, alone: true } : null;
  }
  let end = at;
  const stop = toEnd ? /[\n,;}\]"'`&]/ : /[\s"'`,;&]/;
  while (end < text.length && !stop.test(text[end]!)) end += 1;
  while (end > at && /[.:)\]\s]/.test(text[end - 1]!)) end -= 1;
  if (end <= at) return null;
  const rest = text.slice(end).match(/^[^\S\n]*(.?)/)![1]!;
  return { start: at, end, quoted: false, alone: rest === "" || rest === "\n" || /[,;)\]}&]/.test(rest) || /^[.:)\]]/.test(text.slice(end)) };
}

/**
 * A value that is already a mask: dots with at most four characters shown
 * ("•••abcd", "sk-a••••••••"). Anything more ("abc•LEAKEDSECRET") is not,
 * and is masked like any other value.
 */
function alreadyMasked(raw: string): boolean {
  const bare = raw.replace(/^["'`]+|["'`]+$/g, "");
  return /^•{3,}[^•]{0,4}$/.test(bare) || /^[^•]{0,4}•{3,}$/.test(bare);
}

/** Replaces each value `pick` accepts after a match of `re`; quoted values keep their quotes. Already-masked values stay. */
function maskAfter(text: string, re: RegExp, pick: (value: Value, raw: string, match: RegExpExecArray) => boolean, toEnd: (match: RegExpExecArray) => boolean | "line" = () => false): string {
  let out = "";
  let at = 0;
  re.lastIndex = 0;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const value = valueAt(text, match.index + match[0].length, toEnd(match));
    if (!value || value.start < at) continue;
    const raw = text.slice(value.start, value.end);
    if (alreadyMasked(raw) || !pick(value, raw, match)) continue;
    let masked = MASK_FILL;
    if (value.quoted) {
      const quote = text.startsWith(raw[0]!.repeat(3), value.start) ? raw[0]!.repeat(3) : raw[0]!;
      masked = `${quote}${MASK_FILL}${raw.length > quote.length && raw.endsWith(quote) ? quote : ""}`;
    }
    out += text.slice(at, value.start) + masked;
    at = value.end;
    re.lastIndex = Math.max(re.lastIndex, value.end);
  }
  return out + text.slice(at);
}

/** The longest message shown; anything longer is cut. */
export const REDACT_MAX = 400;

export function redactText(text: string, max = REDACT_MAX): string {
  // A header's whole value goes: its scheme and every part (`Digest username="a", response="b"`).
  let out = maskAfter(text, AUTHORIZATION, () => true, () => "line");
  out = out.replace(SECRET_OBJECT, (whole: string) => whole.replace(/(:\s*)"(?:[^"\\]|\\.)*"/g, `$1"${MASK_FILL}"`));
  out = maskAfter(out, URL_SECRET, () => true);
  out = maskAfter(out, FLAG, () => true);
  out = maskAfter(out, SHORT_P, (_value, raw) => !/^["'`]?\d+["'`]?$/.test(raw));
  out = maskAfter(out, VARIABLE, () => true);
  out = maskAfter(
    out,
    PAIR,
    (value, raw, match) => {
      if (match[2] === "=" || value.quoted) return true;
      if (new RegExp(`^(?:${COMPOUND})$`, "i").test(match[1]!)) return true;
      // One word after "password:" / "token:" / "key:", in any case: only a credential-shaped value goes; a title stays.
      return credentialLike(raw);
    },
    (match) => match[2] === ":" && new RegExp(`^(?:${COMPOUND})$`, "i").test(match[1]!),
  );
  out = maskAfter(out, SPOKEN, (_value, raw) => credentialLike(raw));
  out = maskAfter(out, SCHEME, (_value, raw) => encodedLike(raw));
  out = maskSecrets(out).text;
  out = out.replace(URL_CREDENTIALS, (_whole, scheme: string) => `${scheme}${MASK_FILL}@`);
  out = out.replace(HEX, (value) => `${value.slice(0, 4)}${MASK_FILL}`);
  out = out.replace(BASE64, (value) => (random(value) ? `${value.slice(0, 4)}${MASK_FILL}` : value));
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

type ResultLike = { ok: boolean; message: string; warnings?: unknown; reports?: unknown };

/**
 * A write or skills result with its words redacted: the message, the warnings
 * and each report's error. Anything else passes through. The host applies it
 * to every answer (index.server.ts), whatever "Hide secrets" says, and the
 * app again when it shows one.
 */
export function redactResult<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const result = value as unknown as ResultLike;
  if (typeof result.ok !== "boolean" || typeof result.message !== "string") return value;
  const out: Record<string, unknown> = { ...(value as object), message: redactText(result.message) };
  if (Array.isArray(result.warnings)) out.warnings = result.warnings.map((warning) => (typeof warning === "string" ? redactText(warning) : warning));
  if (Array.isArray(result.reports)) {
    out.reports = result.reports.map((report) => (report && typeof report === "object" && typeof (report as { error?: unknown }).error === "string" ? { ...report, error: redactText((report as { error: string }).error) } : report));
  }
  return out as T;
}
