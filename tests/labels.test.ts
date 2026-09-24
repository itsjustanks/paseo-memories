import assert from "node:assert/strict";
import test from "node:test";
import { middlePath } from "../shared/labels";

test("middlePath keeps the start and the last two parts of a long path", () => {
  assert.equal(middlePath("~/code/acme-web/CLAUDE.md", 40), "~/code/acme-web/CLAUDE.md");
  assert.equal(middlePath("~/projects/acme-web-storefront/.paseo/worktrees/feature-one/acme-web/CLAUDE.md", 30), "~/…/acme-web/CLAUDE.md");
  assert.equal(middlePath("/home/paseo/projects/a/b/c/acme-web/AGENTS.md", 30), "/home/…/b/c/acme-web/AGENTS.md");
});

test("middlePath cuts characters when the end alone is too long", () => {
  const slug = `-home-paseo-projects-${"x".repeat(200)}-client`;
  const short = middlePath(`~/.claude/projects/${slug}/memory`, 40);
  assert.ok(short.length <= 40, short);
  assert.ok(short.startsWith("~/"), short);
  assert.ok(short.endsWith("client/memory"), short);
  assert.ok(middlePath("x".repeat(100), 20).length <= 20);
});
