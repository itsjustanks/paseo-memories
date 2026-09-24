import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import fs from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { FileStamp, WriteResult } from "../shared/contracts";
import { replaceSection, splitSections } from "../shared/markdown";
import { hasNewMask } from "../shared/secrets";
import { workspaceDirectory, type Paseo } from "./daemon";
import { discover, forgetDiscovery } from "./discover";
import { Probe } from "./files";
import { ancestors, versionControlled } from "./git";
import { logWrite } from "./log";
import { findSource, findSourceByRealPath } from "./read";
import { readMemoriesSettings } from "./settings";
import { newSession, readCurrent, safeWrite, staleReason } from "./write";

/**
 * Instruction files: CLAUDE.md layers and rules, AGENTS.md / override, and
 * the OpenCode, pi, omp and Copilot files. A target must be a file the
 * discovery or a workspace plan already knows (existing or one the user may
 * create), or a new rule file in a rules folder an agent reads. Everything
 * else is refused here, whatever the app sends.
 */

export const INSTRUCTION_KINDS = new Set(["claude-md", "claude-local", "claude-rule", "claude-import", "agents-md", "opencode-md", "pi-md", "omp-md", "copilot-md"]);

function refuse(message: string): WriteResult {
  return { ok: false, message, reports: [], warnings: [] };
}

function inside(path: string, folder: string): boolean {
  return path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);
}

/** A new rule file: `<cfg>/rules/**.md`, `<project>/.claude/rules/**.md`, Copilot `instructions/**.instructions.md`. */
async function newRuleTarget(paseo: Paseo | null, path: string, workspaceId?: string): Promise<{ scope: "user" | "project" } | null> {
  const discovery = await discover(paseo);
  for (const account of discovery.accounts.accounts) {
    if (account.agent === "claude" && inside(path, join(account.dir, "rules")) && path.endsWith(".md")) return { scope: "user" };
    if (account.agent === "copilot" && inside(path, join(account.dir, "instructions")) && path.endsWith(".instructions.md")) return { scope: "user" };
  }
  if (workspaceId && paseo) {
    const directory = await workspaceDirectory(paseo, workspaceId);
    for (const folder of ancestors(directory)) {
      if (inside(path, join(folder, ".claude", "rules")) && path.endsWith(".md")) return { scope: "project" };
      if (inside(path, join(folder, ".github", "instructions")) && path.endsWith(".instructions.md")) return { scope: "project" };
    }
  }
  return null;
}

export async function instructionWrite(
  paseo: Paseo | null,
  input: { path: string; workspaceId?: string; text: string; expected: FileStamp | null; sectionKey?: string },
  /** Imports may carry masked values on purpose; the caller warns. */
  { allowMasked = false } = {},
): Promise<WriteResult> {
  const path = input.path;
  if (resolve(path) !== path || basename(path).startsWith(".paseo-memories-tmp-")) return refuse("That is not a file path this plugin writes.");
  const found = await findSource(paseo, path, input.workspaceId);
  let scope: string;
  if (found) {
    if (found.source.access !== "editable") return refuse(found.source.reason ?? "That file is read-only here.");
    if (!INSTRUCTION_KINDS.has(found.source.kind)) {
      return refuse(found.source.kind === "claude-auto-memory" || found.source.kind === "codex-memory" ? "Edit memories through their own editor, which keeps the index and guardrails in step." : "That is not an instruction file.");
    }
    scope = found.source.scope;
  } else {
    const rule = await newRuleTarget(paseo, path, input.workspaceId);
    if (!rule) return refuse("That file is not one an agent reads here, so the plugin will not write it.");
    scope = rule.scope;
  }
  const current = await readCurrent(path);
  const stale = staleReason(current, input.expected);
  if (stale) return refuse(stale);
  let text = input.text;
  if (input.sectionKey) {
    if (!current.exists) return refuse("That file does not exist yet, so it has no sections.");
    const section = splitSections(current.text).find((entry) => entry.key === input.sectionKey);
    if (!section) return refuse("That section is no longer in the file. Reload it; nothing was saved.");
    text = replaceSection(current.text, section, input.text);
  }
  if (!allowMasked && hasNewMask(text, current.text)) return refuse("The text still has hidden (masked) values in it. Reveal them before editing, so they are not replaced by dots. Nothing was saved.");
  if (!current.exists) {
    const parent = dirname(path);
    // New rule/instruction folders only; a project root must already exist.
    if (/[/\\](rules|instructions)([/\\]|$)/.test(parent) || parent.endsWith(`${sep}.claude`) || parent.endsWith(`${sep}.github`)) await fs.mkdir(parent, { recursive: true, mode: scope === "user" ? 0o700 : 0o755 });
  }
  const tracked = scope === "project" && basename(path) !== "CLAUDE.local.md" ? await versionControlled(new Probe(), path) : false;
  const settings = await readMemoriesSettings();
  const report = await safeWrite(newSession(settings.backupsToKeep), path, text, {
    newMode: scope === "user" ? 0o600 : 0o644,
    current,
    versionControlled: tracked,
    // A link to a differently named file (CLAUDE.md -> AGENTS.md): only when that file is itself one this plugin may edit.
    allowLinkTarget: async (real) => {
      const target = await findSourceByRealPath(paseo, real, input.workspaceId);
      return Boolean(target && target.source.access === "editable" && INSTRUCTION_KINDS.has(target.source.kind));
    },
  });
  forgetDiscovery();
  logWrite("instruction-write", path, report.ok ? report.action : "failed");
  const warnings: string[] = [];
  if (tracked) warnings.push("This file is in a git repository: the change shows up in git.");
  if (basename(path) === "SYSTEM.md" && found?.source.kind === "pi-md") warnings.push("SYSTEM.md replaces pi's whole base prompt.");
  return {
    ok: report.ok,
    message: report.ok ? (report.action === "unchanged" ? "No change; nothing was written." : report.action === "created" ? `Created ${basename(path)}.` : `Saved ${basename(path)}.`) : report.error ?? "The save failed.",
    reports: [report],
    warnings,
  };
}

export const handleInstructionWrite = (input: Parameters<typeof instructionWrite>[1], { paseo }: PluginHandlerContext) => instructionWrite(paseo, input);

export const INSTRUCTION_TARGET_KINDS = INSTRUCTION_KINDS;
