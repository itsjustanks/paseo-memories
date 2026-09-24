/**
 * Nothing in this repository may come from a real home folder: fixtures,
 * previews and tests use made-up projects (acme-web, demo-api, notes-site),
 * people (Sam) and facts. This fails if any name from the developer's real
 * machine shows up. The list is base64 so this file does not match itself.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DENY = ["YW5raXQ=", "cGFsaXdhbA==", "dW5mb2xk", "aW52ZXN0b3JraXQ=", "ZGF0YS1nbHVl", "ZGF0YWdsdWU=", "a3lvdG8=", "d2hvbGV0ZWNo", "bWVkaWFu", "c3RhdGVtZW50X3RpbWVvdXQ=", "bGlzdGNoYW5uZWxz", "bWFya19hbGxfbWVzc2FnZXM=", "c3VwZXJzZXQ=", "Y29uZHVjdG9y", "aWNsb3Vk", "YXVzdHJhbGlhbg==", "YXR0aW8=", "Z2xlYXA=", "c29sYWNl", "Zm91cmFjcmU=", "emVuZmxvdw==", "Y2xhdWRlLXdvcmt0cmVlcw=="].map((word) => Buffer.from(word, "base64").toString());
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SKIP_FILES = new Set(["LICENSE", "package-lock.json"]);

function files(folder: string, out: string[] = []): string[] {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files(path, out);
    } else if (!SKIP_FILES.has(entry.name) && statSync(path).size < 2_000_000) out.push(path);
  }
  return out;
}

test("no name from a real home folder appears anywhere in the repository", () => {
  const hits: string[] = [];
  for (const path of files(ROOT)) {
    const rel = relative(ROOT, path);
    const text = `${rel}\n${readFileSync(path, "latin1")}`.toLowerCase();
    for (const word of DENY) if (text.includes(word)) hits.push(`${rel}: ${word}`);
  }
  assert.deepEqual(hits, []);
});
