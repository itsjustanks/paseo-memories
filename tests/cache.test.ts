import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PARSE_GRACE_MS, Probe, forgetAllFiles, readJsonCached, readTextCached } from "../server/files";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "paseo-memories-cache-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a file is read once per change, and again when it changes", async () => {
  forgetAllFiles();
  const { dir, done } = sandbox();
  try {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ a: 1 }));
    const first = await readJsonCached(path);
    assert.equal(await readJsonCached(path), first, "unchanged: the same parse");
    writeFileSync(path, JSON.stringify({ a: 1, b: 2 }));
    assert.deepEqual(await readJsonCached(path), { a: 1, b: 2 });
    assert.equal(await readTextCached(join(dir, "missing.md")), null);
  } finally {
    done();
  }
});

test("a file caught mid-write keeps its last good parse for a short grace", async () => {
  forgetAllFiles();
  const { dir, done } = sandbox();
  try {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ good: true }));
    const now = Date.now();
    assert.deepEqual(await readJsonCached(path, now), { good: true });
    writeFileSync(path, '{"good": tr');
    assert.deepEqual(await readJsonCached(path, now + 1000), { good: true });
    assert.equal(await readJsonCached(path, now + PARSE_GRACE_MS + 1), null);
  } finally {
    done();
  }
});

test("a probe stats each path once per request", async () => {
  const { dir, done } = sandbox();
  try {
    const probe = new Probe();
    const path = join(dir, "a.md");
    writeFileSync(path, "x");
    const one = probe.stat(path);
    assert.equal(probe.stat(path), one, "the same promise");
    assert.equal(await probe.isFile(path), true);
    assert.equal(await probe.isDir(dir), true);
    assert.equal(await probe.text(path), "x");
  } finally {
    done();
  }
});
