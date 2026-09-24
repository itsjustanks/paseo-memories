/**
 * Regression tests for the round-3 check (R1, R2). Each fails on the
 * round-3 commit.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import fsp from "node:fs/promises";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { fakePaseo, makeSandbox, violations } from "./helpers";

const sb = await makeSandbox();
const { sha256 } = await import("../server/files");
const { claudeUpdate } = await import("../server/claude-memory");
const { maskTextFields } = await import("../shared/secrets");
const { parseIndex } = await import("../shared/memory-index");

afterEach(() => assert.deepEqual(violations, [], "no write outside the sandbox"));
test.after(() => sb.cleanup());

const CANARY = "sk-ant-api03-CANARYsecretVALUE0123456789abcdef";

function stampOf(path: string) {
  const buffer = readFileSync(path);
  const stat = statSync(path);
  return { size: stat.size, mtimeMs: stat.mtimeMs, hash: sha256(buffer) };
}

test("R1: every string under extra is masked, at any depth, under any key; ids and paths are not", () => {
  const path = "/h/code/sk-learn-experiments-notebooks-2026/CLAUDE.md";
  const out = maskTextFields({
    id: path,
    path,
    entries: [{ key: "creds.md", type: CANARY, extra: { api_key: CANARY, nested: { list: [`x ${CANARY}`], n: 3, ok: true } } }],
  });
  assert.equal(out.id, path);
  assert.equal(out.path, path);
  const entry = out.entries[0]!;
  assert.equal(entry.key, "creds.md");
  assert.ok(!JSON.stringify(out).includes(CANARY), JSON.stringify(out));
  assert.match(entry.extra.api_key as string, /^sk-a•+$/);
  assert.deepEqual((entry.extra.nested as { n: number; ok: boolean }).n, 3);
});

test("R2: a case-only rename whose index write fails is renamed back and reported", async () => {
  const paseo = fakePaseo(sb).api;
  const path = join(sb.appMemory, "flat.md");
  const before = readFileSync(path, "utf8");
  const original = fsp.rename;
  (fsp as unknown as { rename: unknown }).rename = async (from: unknown, to: unknown) => {
    if (String(to).endsWith("MEMORY.md")) throw Object.assign(new Error("disk said no"), { code: "EIO" });
    return (original as (a: unknown, b: unknown) => Promise<void>)(from, to);
  };
  let result;
  try {
    result = await claudeUpdate(paseo, { sourceId: sb.appMemory, key: "flat.md", rename: "Flat.md", expected: stampOf(path) });
  } finally {
    (fsp as unknown as { rename: unknown }).rename = original;
  }
  assert.equal(result.ok, false);
  assert.match(result.message, /undone/);
  assert.ok(result.reports.some((report) => report.action === "rolled back" && report.ok), JSON.stringify(result.reports));
  const names = readdirSync(sb.appMemory);
  assert.ok(names.includes("flat.md"), "the old spelling is back");
  assert.ok(!names.includes("Flat.md"));
  assert.equal(readFileSync(path, "utf8"), before);
  assert.ok(parseIndex(readFileSync(join(sb.appMemory, "MEMORY.md"), "utf8")).some((line) => line.file === "flat.md"), "the index and the file agree");
  assert.deepEqual(names.filter((name) => name.startsWith(".paseo-memories-tmp-")), []);
});
