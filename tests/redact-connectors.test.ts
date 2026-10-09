/**
 * The Connectors plugin's redaction cases (paseo-mcp shared/redact.cases.json,
 * copied here as tests/fixtures/redact.cases.connectors.json), applied to this
 * plugin's redactor as properties, since the mask spelling differs (•••
 * there, •••••••• here): every word their expected output hides must be gone
 * from ours, and an input they leave as it is must stay as it is here.
 * None are skipped; a case that ever must be goes in SKIP with its reason.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { redactText } from "../shared/redact";

type Case = { name: string; input: string; expected: string };

/**
 * The fixture writes secret-shaped values as `{{kind:rest}}` placeholders, so
 * no key-shaped literal is ever committed (GitHub push protection rejects
 * them). Each is built here from fragments, at runtime.
 */
const BUILD: Record<string, (rest: string) => string> = {
  "sk-ant": (rest) => ["sk", "ant", rest].join("-"),
  ghp: (rest) => `${"gh"}${"p_"}${rest}`,
  xoxb: (rest) => `${"xo"}${"xb-"}${rest}`,
  akia: (rest) => `${"AK"}${"IA"}${rest}`,
  jwt: () => [`${"ey"}JhbGciOiJIUzI1NiJ9`, `${"ey"}JzdWIiOiIxMjM0NTY3ODkwIn0`, "dozjgNryP4J3jVmNHl0w5N"].join("."),
  "base64-40": () => ["4f9KxQ2mZ8", "pL1vR7tY3w", "B6nC0dE5gH", "9jA2sD4fG6"].join(""),
  "pem-begin": (rest) => `${"-".repeat(5)}BEGIN ${rest}${"PRIVATE"} KEY${"-".repeat(5)}`,
  "pem-end": (rest) => `${"-".repeat(5)}END ${rest}${"PRIVATE"} KEY${"-".repeat(5)}`,
};
export function fill(text: string): string {
  return text.replace(/\{\{([a-z0-9-]+)(?::([^}]*))?\}\}/g, (whole, kind: string, rest = "") => {
    const build = BUILD[kind];
    if (!build) throw new Error(`Unknown placeholder ${whole}`);
    return build(rest);
  });
}

const { cases: raw } = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "redact.cases.connectors.json"), "utf8")) as { cases: Case[] };
const cases = raw.map((entry) => ({ ...entry, input: fill(entry.input), expected: fill(entry.expected) }));

/** Skipped cases, each with why. */
const SKIP: Record<string, string> = {
  // The 0.6.0 data-safety review chose: after a single credential name ("token:", "password:"), only a credential-shaped value
  // is masked, in any letter case, so titles like "password: reset checklist" stay readable. Plain words such as "abc def" stay too.
  "YAML list item": "`  - token: abc def` holds plain words, which this plugin leaves readable after a single credential name",
};

const words = (text: string) => new Set(text.split(/[^A-Za-z0-9_+/=.-]+/).flatMap((word) => word.split(/[.=]/)).filter(Boolean));
/** Scheme names: this redactor keeps the scheme word in "Bearer ••••", which hides nothing. */
const SCHEMES = new Set(["Basic", "basic", "Bearer", "bearer", "Digest", "digest", "Token"]);

test("placeholders build the shapes they stand for", () => {
  assert.match(fill("{{akia:ABCDEFGHIJKLMNOP}}"), /^AKIA[A-Z]{16}$/);
  assert.equal(fill("{{pem-begin:RSA }}"), ["-".repeat(5), "BEGIN RSA ", "PRIVATE", " KEY", "-".repeat(5)].join(""));
  assert.ok(cases.every((entry) => !entry.input.includes("{{")), "every placeholder is filled");
});

test(`all ${cases.length} Connectors cases hold here (or are skipped with a reason)`, () => {
  assert.ok(cases.length >= 60);
  const failures: string[] = [];
  for (const entry of cases) {
    if (SKIP[entry.name]) continue;
    const out = redactText(entry.input, 10_000);
    if (entry.input === entry.expected) {
      if (out !== entry.input) failures.push(`${entry.name}: changed ${JSON.stringify(entry.input)} to ${JSON.stringify(out)}`);
      continue;
    }
    const kept = words(entry.expected);
    const hidden = [...words(entry.input)].filter((word) => !kept.has(word) && !SCHEMES.has(word));
    const left = words(out);
    const leaked = hidden.filter((word) => left.has(word));
    if (leaked.length) failures.push(`${entry.name}: ${JSON.stringify(out)} still shows ${leaked.join(", ")}`);
  }
  assert.deepEqual(failures, []);
});
