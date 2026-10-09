/**
 * 0.6.0, the Paseo SDK uplift: what a person types to start a skill, the
 * `user-invocable: false` flag that hides Claude's "/" form, toasts that
 * never carry a link or a secret, and the host's newer parts reached only
 * through client/ui.tsx (feature-detected), with no new SDK import paths
 * and a manifest Paseo 0.11.0-beta.5 still accepts.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { fakePaseo, makeSandbox } from "./helpers";
import { addSkills, skillMd, writeSkill } from "./skills-helpers";

const base = await makeSandbox();
const sb = addSkills(base);
writeSkill(join(sb.shared, "quiet-notes"), skillMd("quiet-notes", "Background notes Claude reads on its own.", undefined, "user-invocable: false\n"));
const { discoverSkills, forgetSkillCaches } = await import("../server/skills");
const { skillCommands } = await import("../shared/skills-plain");
const { TOASTS } = await import("../shared/plain");
after(() => sb.cleanup());

const ROOT = join(import.meta.dirname, "..");

test("060-A skillCommands: /name for Claude, $name for Codex, none where it's off or not user-invocable", () => {
  const both = { name: "pdf", readBy: ["claude", "codex"], state: {} };
  assert.deepEqual(skillCommands(both), [
    { agent: "claude", text: "/pdf" },
    { agent: "codex", text: "$pdf" },
  ]);
  assert.deepEqual(skillCommands({ ...both, userInvocable: false }), [{ agent: "codex", text: "$pdf" }]);
  assert.deepEqual(skillCommands({ ...both, state: { claude: "off" } }), [{ agent: "codex", text: "$pdf" }]);
  assert.deepEqual(skillCommands({ name: "toolkit:deploy", readBy: ["claude"], state: {} }), [{ agent: "claude", text: "/toolkit:deploy" }]);
  assert.deepEqual(skillCommands({ name: "x", readBy: ["pi"], state: {} }), []);
});

test("060-B discovery carries user-invocable: false, and only when it's false", async () => {
  forgetSkillCaches();
  const d = await discoverSkills(fakePaseo(sb).api, { refresh: true });
  const quiet = d.skills.find((skill) => skill.name === "quiet-notes");
  const alpha = d.skills.find((skill) => skill.name === "alpha");
  assert.ok(quiet && alpha);
  assert.equal(quiet.userInvocable, false);
  assert.equal("userInvocable" in alpha, false);
  assert.ok(!skillCommands(quiet).some((command) => command.agent === "claude"));
});

test("060-C toasts are short sentences with no links, paths or values", () => {
  const all = Object.values(TOASTS).map((value) => (typeof value === "function" ? (value as (n: number) => string)(3) : value));
  for (const text of all) {
    assert.ok(text.length <= 80, text);
    assert.match(text, /^[A-Z].*\.$/, text);
    assert.doesNotMatch(text, /https?:|\/|~|\$\{/, text);
  }
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("060-D the host's newer parts come only through client/ui.tsx, and no new SDK paths", () => {
  const sources = [...files(join(ROOT, "client")), ...files(join(ROOT, "server")), ...files(join(ROOT, "shared")), join(ROOT, "index.client.tsx"), join(ROOT, "index.server.ts")];
  const known = new Set(["@getpaseo/plugin", "@getpaseo/plugin/client", "@getpaseo/plugin/client/ui", "@getpaseo/plugin/client/react-native", "@getpaseo/plugin/server"]);
  for (const path of sources) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/from "(@getpaseo\/plugin[^"]*)"/g)) assert.ok(known.has(match[1]!), `${path}: ${match[1]}`);
    if (!path.endsWith(join("client", "ui.tsx"))) {
      assert.doesNotMatch(text, /@getpaseo\/plugin\/client\/react-native/, `${path} should use client/ui.tsx's feature-detected helpers`);
      assert.doesNotMatch(text, /\bClipboard\b/, `${path} should copy through copyToClipboard`);
    }
  }
});

test("060-E the manifest keeps to the fields Paseo 0.11.0-beta.5 accepts", () => {
  // beta.5's manifest schema is strict and has no name, icon or media (0.11.1 adds them).
  const manifest = JSON.parse(readFileSync(join(ROOT, "paseo-plugin.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(manifest).sort(), ["description", "id", "requirements"]);
});

// ------------------------------------------------- review lessons (0.6.0)

const { redactText } = await import("../shared/redact");
const { plainError } = await import("../shared/errors");
const { ConfirmGate, Once, NO_TOAST, makeCopy, makeUseToast, pickModal } = await import("../client/host-extras");

// Secret-shaped probes are built from fragments, so no key-shaped literal is committed (GitHub push protection).
const KEY = ["sk", "ant", "api03", "AbCdEf0123456789xyzXYZ0123"].join("-");
const B64 = ["QmFzZTY0", "VmFsdWVX", "aXRoTWl4", "ZWRDYXNl", "QW5kMTIz", "NDU2"].join("");
const HEXKEY = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

test("060-F one redactor: every review probe, masked or left readable", () => {
  // [input, expected output]: the review's probes and the other plugins' (Hosts, AI Router).
  const probes: Array<[string, string]> = [
    ["key: hunter22", "key: ••••••••"],
    ['password="correct horse battery staple"', 'password="••••••••"'],
    ["Password: reset checklist", "Password: reset checklist"],
    ["Key: reset steps for the team", "Key: reset steps for the team"],
    ["password: hunter22 is wrong", "password: •••••••• is wrong"],
    ["the password: hunter22.", "the password: ••••••••."],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "Authorization: ••••••••"],
    ["Authorization: Token abc123def456", "Authorization: ••••••••"],
    ["authorization: s3cr3tvalue", "authorization: ••••••••"],
    ["run with --api-key hunter22secret now", "run with --api-key •••••••• now"],
    ["--token=abc12345", "--token=••••••••"],
    ['--password "two words"', '--password "••••••••"'],
    ["FOO_TOKEN=xyz98765", "FOO_TOKEN=••••••••"],
    ["db_password = opensesame", "db_password = ••••••••"],
    ["X-Api-Key: zz99yy88", "X-Api-Key: ••••••••"],
    ["secret: 'single quoted value'", "secret: '••••••••'"],
    ['{"token": "abc"}', '{"token": "••••••••"}'],
    ["Could not write token=hunter22.zip: permission denied", "Could not write token=••••••••: permission denied"],
    ["key=hunter22 was rejected", "key=•••••••• was rejected"],
    ["https://me:s3cret@github.com/x", "https://••••••••@github.com/x"],
    [`failed with ${KEY}`, "failed with sk-a••••••••"],
    [`digest ${HEXKEY} mismatch`, "digest •••••••• mismatch"],
    [`checksum ${HEXKEY} mismatch`, "checksum 9f86•••••••• mismatch"],
    [`value ${B64} here`, "value QmFz•••••••• here"],
    // The 0.6.0 re-review's probes.
    ['{"password":"hun\\"ter22"}', '{"password":"••••••••"}'],
    ["Password: rotation", "Password: rotation"],
    ['args: ["--api-key", "short-lived-credential"]', 'args: ["--api-key", "••••••••"]'],
    // 0.6.0 data-safety review: plain words after a single credential name stay readable, in any case; only credential shapes go.
    ["  - token: abc def", "  - token: abc def"],
    ["password: reset checklist", "password: reset checklist"],
    ['run --api-key "abc•LEAKEDSECRET"', 'run --api-key "••••••••"'],
    ["--token=x•y•LEAKED", "--token=••••••••"],
    ["api_key: plain yaml value", "api_key: ••••••••"],
    ["Token expired", "Token expired"],
    ["token a1b2c3d4e5", "token ••••••••"],
    ["server -p 3000", "server -p 3000"],
    ["server -p secretpass", "server -p ••••••••"],
    ["use Basic authentication here", "use Basic authentication here"],
    // Whole names only, and plain words stay.
    ["tokenizer=fast monkey: banana keyboard: qwerty author: Jane Smith", "tokenizer=fast monkey: banana keyboard: qwerty author: Jane Smith"],
    ["Tokens: about 2,500 at launch", "Tokens: about 2,500 at launch"],
    ["max_tokens=4096", "max_tokens=4096"],
    ["Added 30 notes to Claude's list. The old list is in the backups.", "Added 30 notes to Claude's list. The old list is in the backups."],
    [`Backups are in plugin-data/paseo-memories/backups/${HEXKEY}/MEMORY.md`, `Backups are in plugin-data/paseo-memories/backups/${HEXKEY}/MEMORY.md`],
    ["Couldn't open a browser, so the link was copied.", "Couldn't open a browser, so the link was copied."],
  ];
  for (const [input, expected] of probes) assert.equal(redactText(input), expected, input);
  for (const secret of ["hunter22", "ter22", "horse", "battery", "staple", "s3cret", "opensesame", "zz99yy88", "short-lived-credential", "secretpass"]) {
    assert.ok(probes.every(([input]) => !redactText(input).includes(secret)), secret);
  }
  assert.equal(redactText("x".repeat(1000)).length, 400);
  assert.ok(!plainError(new Error(`EACCES: token=${KEY}`)).includes(KEY));
});

test("060-G toasts: redacted, and a no-op where the app has none or its hook throws", () => {
  const seen: string[] = [];
  const host = { show: (message: string) => seen.push(`show:${message}`), error: (message: string) => seen.push(`error:${message}`) };
  const toast = makeUseToast(() => host)();
  assert.equal(toast.available, true);
  toast.show(`saved with ${KEY}`);
  toast.error("password=hunter22 failed");
  assert.equal(seen.length, 2);
  assert.ok(seen.every((line) => !line.includes(KEY) && !line.includes("hunter22")), seen.join(" | "));
  assert.equal(makeUseToast(undefined)(), NO_TOAST);
  assert.equal(
    makeUseToast(() => {
      throw new Error("useToast must be used within ToastProvider");
    })(),
    NO_TOAST,
  );
  // A host toast that throws is dropped, never thrown at the caller.
  const shaky = makeUseToast(() => ({ show: () => { throw new Error("x"); }, error: () => { throw new Error("x"); } }))();
  assert.doesNotThrow(() => (shaky.show("a"), shaky.error("b")));
});

test("060-H the dialog: used only when the app has a whole one", () => {
  const Modal = Object.assign(() => null, { Content: () => null });
  assert.equal(pickModal(Modal), Modal);
  assert.equal(pickModal(undefined), null);
  assert.equal(pickModal(() => null), null);
});

test("060-I copy: false, a rejection or a throw is a failure; the old clipboard when the app has no copyText", async () => {
  const copied: string[] = [];
  assert.equal(await makeCopy(async (text: string) => void copied.push(text), undefined)("/pdf"), true);
  assert.deepEqual(copied, ["/pdf"]);
  assert.equal(await makeCopy(async () => false, undefined)("x"), false);
  assert.equal(await makeCopy(async () => { throw new Error("denied"); }, undefined)("x"), false);
  const fallback: string[] = [];
  assert.equal(await makeCopy(undefined, (text) => void fallback.push(text))("$pdf"), true);
  assert.deepEqual(fallback, ["$pdf"]);
  assert.equal(await makeCopy(undefined, () => { throw new Error("no clipboard"); })("x"), false);
  assert.equal(await makeCopy(undefined, undefined)("x"), false);
});

test("060-J Fix all's confirm: Confirm sends the listed items once, Cancel sends none, a double press acts once, closing resets", () => {
  const sent: string[][] = [];
  const gate = new ConfirmGate<{ id: string }>();
  const findings = [{ id: "a" }, { id: "b" }];
  // What client/finding-groups.tsx does on Yes.
  const yes = () => {
    const items = gate.confirm();
    if (items) sent.push(items.map((item) => item.id));
  };
  // Confirm: exactly the items listed when it opened, even if the page's list changes underneath.
  gate.open(findings);
  findings.push({ id: "c" });
  yes();
  assert.deepEqual(sent, [["a", "b"]]);
  // Double press: the second finds it spent.
  gate.open([{ id: "d" }]);
  yes();
  yes();
  assert.deepEqual(sent, [["a", "b"], ["d"]]);
  // Cancel or close: nothing is sent, nothing is left armed.
  gate.open([{ id: "e" }]);
  gate.close();
  assert.equal(gate.pending, null);
  yes();
  assert.deepEqual(sent, [["a", "b"], ["d"]]);
  // Opening again re-arms it.
  gate.open([{ id: "f" }]);
  yes();
  assert.deepEqual(sent, [["a", "b"], ["d"], ["f"]]);
});

test("060-K in-place confirms act once per asking", () => {
  const once = new Once();
  assert.equal(once.take(), false, "not asked yet");
  once.arm();
  assert.equal(once.take(), true);
  assert.equal(once.take(), false, "a second press in the same tick");
  once.arm();
  assert.equal(once.take(), true, "asked again");
});
