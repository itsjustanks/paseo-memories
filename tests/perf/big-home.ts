/**
 * A made-up HOME at the size of a busy real one, built inside a test
 * sandbox (never committed as data): 18 Claude memory folders holding 900
 * memory files, 109 project roots with 78 CLAUDE.md and 175 AGENTS.md
 * (5–40 KB, many sections, backticked paths and code names), 65 Paseo
 * workspaces, 120 skills, and chat logs for the usage count (repetitive, as
 * large as asked). Deterministic: the same seed builds the same files.
 */
import fs from "node:fs";
import { join } from "node:path";
import { claudeSlug } from "../../shared/slug";
import type { Sandbox } from "../helpers";

export const BIG = { memoryFolders: 18, memoryFiles: 900, projects: 109, claudeMds: 78, agentsMds: 175, workspaces: 65, skills: 120 };

export type BigHome = {
  projects: string[];
  memoryDirs: string[];
  /** Fake daemon answering 65 workspaces and every project. */
  paseo: { api: never };
  /** Bytes of chat logs written. */
  logBytes: number;
  logFiles: number;
};

let seed = 11;
const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

const WORDS = ["workspace", "member", "channel", "property", "agreement", "portfolio", "render", "fetch", "update", "query", "widget", "handler", "drawer", "panel", "router", "token", "cache", "layout", "search", "upload", "report", "settings", "message", "thread", "invoice", "market", "listing", "client", "brief", "export"];
const VERBS = ["Always", "Never", "Prefer", "Avoid", "Remember to", "Make sure to", "Check that you", "Do not forget to"];
const DIRS = ["src/components", "src/composables", "src/lib", "server", "shared", "tests", "scripts", "supabase/functions", "docs"];
const EXTS = [".ts", ".vue", ".tsx", ".md", ".json", ".sql"];

const word = () => pick(WORDS);
const camel = () => `use${word()[0]!.toUpperCase()}${word().slice(1)}${word()[0]!.toUpperCase()}${word().slice(1)}${Math.floor(random() * 90)}`;
const relPath = () => `${pick(DIRS)}/${word()}-${word()}${Math.floor(random() * 40)}${pick(EXTS)}`;

function sentence(projectFor: () => string | null): string {
  const roll = random();
  const parts = [pick(VERBS), word(), word(), "when", word(), "the", word(), word()];
  if (roll < 0.25) parts.push("in", `\`${relPath()}\``);
  else if (roll < 0.35) {
    const project = projectFor();
    if (project) parts.push("see", `\`${project}/${relPath()}\``);
  } else if (roll < 0.5) parts.push("via", `\`${camel()}\``);
  else if (roll < 0.55) parts.push("at", `\`/${word()}/${word()}\``);
  return `${parts.join(" ")}.`;
}

function paragraph(lines: number, projectFor: () => string | null): string {
  return Array.from({ length: lines }, () => `- ${sentence(projectFor)}`).join("\n");
}

/** Shared boilerplate sections: the same text in many instruction files, as real teams copy them. */
const BOILERPLATE = Array.from({ length: 12 }, (_, i) => ({ title: `Team convention ${i + 1}`, body: paragraph(8, () => null) }));

function instructionFile(target: number, projectFor: () => string | null, title: string): string {
  const out = [`# ${title}`, "", paragraph(3, projectFor), ""];
  let size = out.join("\n").length;
  let n = 0;
  while (size < target) {
    n += 1;
    const block =
      random() < 0.25
        ? (() => {
            const shared = pick(BOILERPLATE);
            return `## ${shared.title}\n\n${shared.body}\n`;
          })()
        : `## ${word()} ${word()} ${n}\n\n${paragraph(4 + Math.floor(random() * 10), projectFor)}\n`;
    out.push(block);
    size += block.length + 1;
  }
  return `${out.join("\n")}\n`;
}

function memoryFile(name: string, target: number, projectFor: () => string | null): string {
  const lines = [`---`, `name: ${name}`, `description: ${word()} ${word()} notes for ${word()}`, `type: ${pick(["project", "feedback", "user", "reference"])}`, `---`, "", `# ${name}`, ""];
  let size = lines.join("\n").length;
  while (size < target) {
    const block = random() < 0.3 ? `## ${word()} ${word()}\n\n${paragraph(3, projectFor)}\n` : `${paragraph(2, projectFor)}\n`;
    lines.push(block);
    size += block.length + 1;
  }
  return `${lines.join("\n")}\n`;
}

/** Repetitive Claude chat log lines: mostly long noise, now and then a skill use. */
function claudeLogChunk(cwd: string, session: string, skills: string[]): string {
  const at = new Date(Date.now() - Math.floor(random() * 20) * 86_400_000).toISOString();
  const lines: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    if (i === 7) lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: pick(skills) } }] }, timestamp: at, sessionId: session, cwd }));
    else lines.push(JSON.stringify({ type: i % 2 ? "assistant" : "user", message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `${sentence(() => null)} `.repeat(30) }] }, timestamp: at, sessionId: session, cwd }));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Builds the big HOME into the sandbox. `logBytes`: total size of the chat
 * logs (the profile uses over 1 GB; the tests far less), spread over
 * `logFiles` sessions, plus `bigLogs` sessions of `bigLogBytes` each (the
 * long-running agents whose logs grow to tens of megabytes).
 */
export function makeBigHome(sb: Sandbox, { logBytes = 64 * 1024 * 1024, logFiles = 2049, bigLogs = 0, bigLogBytes = 16 * 1024 * 1024 } = {}): BigHome {
  seed = 11;
  const home = sb.home;
  const code = join(home, "work");
  const projects: string[] = [];
  for (let i = 0; i < BIG.projects; i += 1) {
    const root = join(code, `proj-${String(i).padStart(3, "0")}-${word()}`);
    projects.push(root);
    fs.mkdirSync(join(root, ".git"), { recursive: true });
    fs.writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    for (const dir of DIRS.slice(0, 5)) fs.mkdirSync(join(root, dir), { recursive: true });
    // Some of the files the notes mention exist; most don't.
    for (let f = 0; f < 6; f += 1) {
      const file = join(root, relPath());
      fs.mkdirSync(join(file, ".."), { recursive: true });
      fs.writeFileSync(file, `export const ${camel()} = 1;\n`);
    }
  }
  const projectFor = () => (random() < 0.6 ? pick(projects) : join(code, `gone-${word()}-${Math.floor(random() * 5)}`));
  // 78 CLAUDE.md and 175 AGENTS.md within four levels of the roots.
  for (let i = 0; i < BIG.claudeMds; i += 1) {
    const root = projects[i % projects.length]!;
    const where = i < projects.length * 0.7 ? root : join(root, "packages", word());
    fs.mkdirSync(where, { recursive: true });
    fs.writeFileSync(join(where, "CLAUDE.md"), instructionFile(5_000 + Math.floor(random() * 35_000), projectFor, `Rules for ${word()}`));
  }
  for (let i = 0; i < BIG.agentsMds; i += 1) {
    const root = projects[i % projects.length]!;
    const where = i < projects.length ? root : join(root, pick(["apps", "packages", "services"]), `${word()}-${i}`);
    fs.mkdirSync(where, { recursive: true });
    fs.writeFileSync(join(where, "AGENTS.md"), instructionFile(5_000 + Math.floor(random() * 35_000), projectFor, `Agent notes for ${word()}`));
  }
  // 18 Claude memory folders, 50 files each; some files copied (exactly or nearly) between folders.
  const memoryDirs: string[] = [];
  const written: string[] = [];
  const perFolder = BIG.memoryFiles / BIG.memoryFolders;
  for (let i = 0; i < BIG.memoryFolders; i += 1) {
    const project = projects[i * 5]!;
    const dir = join(sb.claude, "projects", claudeSlug(project), "memory");
    fs.mkdirSync(dir, { recursive: true });
    memoryDirs.push(dir);
    const index = ["# Memory index", ""];
    for (let f = 0; f < perFolder; f += 1) {
      const name = `${word()}-${word()}-${f}`;
      const roll = random();
      let text: string;
      if (written.length && roll < 0.06) text = pick(written);
      else if (written.length && roll < 0.1) text = pick(written).replace(/ the /, " a ");
      else text = memoryFile(name, 1_500 + Math.floor(random() * 9_000), projectFor);
      written.push(text);
      fs.writeFileSync(join(dir, `${name}.md`), text);
      // A few files the index forgot.
      if (random() < 0.95) index.push(`- [${name}](${name}.md) — ${word()} ${word()}`);
    }
    fs.writeFileSync(join(dir, "MEMORY.md"), `${index.join("\n")}\n`);
  }
  // Claude knows every project; Paseo knows 65 workspaces in them.
  const claudeJson = JSON.parse(fs.readFileSync(join(home, ".claude.json"), "utf8")) as { projects: Record<string, unknown> };
  for (const project of projects) claudeJson.projects[project] = {};
  fs.writeFileSync(join(home, ".claude.json"), JSON.stringify(claudeJson));
  const workspaces = projects.slice(0, BIG.workspaces).map((path, i) => ({ id: `ws-big-${i}`, name: path.split("/").pop()!, workspaceDirectory: path, projectRootPath: path }));
  const paseo = {
    api: {
      config: { get: async () => ({ requestId: "r", config: { appendSystemPrompt: "", providers: {} } }), patch: async () => ({ requestId: "r", config: {} }) },
      workspaces: { list: async () => ({ entries: workspaces }) },
      projects: { list: async () => ({ entries: projects.map((path) => ({ name: path.split("/").pop(), path })) }) },
    } as never,
  };
  // Skills in the shared folder.
  const skills: string[] = [];
  for (let i = 0; i < BIG.skills; i += 1) {
    const name = `${word()}-${word()}-${i}`;
    skills.push(name);
    const folder = join(home, ".agents", "skills", name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: "${sentence(() => null)}"\n---\n\n${paragraph(20, () => null)}\n`);
  }
  // Chat logs: 98 project folders, `logFiles` sessions, `logBytes` in all; one chunk repeated.
  const folders = Array.from({ length: 98 }, (_, i) => join(sb.claude, "projects", claudeSlug(i < projects.length ? projects[i]! : join(code, `old-${i}`))));
  const perFile = Math.max(4096, Math.floor(logBytes / logFiles));
  let total = 0;
  for (let i = 0; i < logFiles; i += 1) {
    const folder = folders[i % folders.length]!;
    fs.mkdirSync(folder, { recursive: true });
    const chunk = Buffer.from(claudeLogChunk(projects[i % projects.length]!, `s${i}`, skills.slice(0, 30)));
    const copies = Math.max(1, Math.floor(perFile / chunk.length));
    const fd = fs.openSync(join(folder, `session-${i}.jsonl`), "w");
    for (let c = 0; c < copies; c += 1) fs.writeSync(fd, chunk);
    fs.closeSync(fd);
    total += copies * chunk.length;
  }
  for (let i = 0; i < bigLogs; i += 1) {
    const folder = folders[i % folders.length]!;
    const chunk = Buffer.from(claudeLogChunk(projects[i % projects.length]!, `big${i}`, skills.slice(0, 30)));
    const copies = Math.max(1, Math.floor(bigLogBytes / chunk.length));
    const fd = fs.openSync(join(folder, `long-session-${i}.jsonl`), "w");
    for (let c = 0; c < copies; c += 1) fs.writeSync(fd, chunk);
    fs.closeSync(fd);
    total += copies * chunk.length;
  }
  return { projects, memoryDirs, paseo: paseo as never, logBytes: total, logFiles: logFiles + bigLogs };
}
