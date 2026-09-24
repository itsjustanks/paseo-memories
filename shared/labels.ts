/** Plain-English names for what the host sends. Pure; used by the app. */

const KIND: Record<string, string> = {
  "claude-managed": "Managed CLAUDE.md",
  "claude-md": "CLAUDE.md",
  "claude-local": "CLAUDE.local.md (private)",
  "claude-rule": "Claude rule",
  "claude-import": "Imported by a CLAUDE.md",
  "claude-auto-memory": "Claude auto memory",
  "agents-md": "AGENTS.md",
  "codex-memory": "Codex memory",
  "codex-generated": "Codex working file",
  "codex-config": "Codex config",
  "paseo-prompt": "Paseo appended prompt",
  "opencode-md": "OpenCode instructions",
  "opencode-config": "opencode.json instructions",
  "pi-md": "pi instructions",
  "omp-md": "Oh My Pi instructions",
  "omp-generated": "Oh My Pi generated memory",
  "copilot-md": "Copilot instructions",
  "copilot-memory": "Copilot Memory",
};

export function kindLabel(kind: string): string {
  return KIND[kind] ?? kind;
}

const WHEN: Record<string, string> = { launch: "At launch", "on-demand": "On demand", skipped: "Not loaded", missing: "Not there yet" };

export function whenLabel(when: string): string {
  return WHEN[when] ?? when;
}

export function scopeLabel(scope: string): string {
  return ({ managed: "Managed", user: "User", project: "Project", host: "This host" } as Record<string, string>)[scope] ?? scope;
}

/** Last two parts of a path, for list rows. */
export function shortPath(path: string): string {
  if (!path.includes("/")) return path;
  const parts = path.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

export function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

/** Where imported items would go, as a person would say it: "Claude memory · acme-web", "Your Codex AGENTS.md". */
export function targetTitle(
  source: { kind: string; scope: string; agent: string; path: string; projectPath?: string; slug?: string },
  /** Named when it is not the agent's default folder, so two accounts' files can be told apart. */
  account?: { origin: string; email?: string; label: string },
): string {
  const title = baseTargetTitle(source);
  return account && account.origin !== "default" && source.scope === "user" ? `${title} · ${account.email ?? account.label}` : title;
}

function baseTargetTitle(source: { kind: string; scope: string; agent: string; path: string; projectPath?: string; slug?: string }): string {
  const project = source.projectPath ? folderName(source.projectPath) : undefined;
  const file = folderName(source.path);
  if (source.kind === "claude-auto-memory") return `Claude memory · ${project ?? source.slug ?? "other project"}`;
  if (source.scope === "user") {
    if (source.agent === "codex" && file.startsWith("AGENTS")) return `Your Codex ${file}`;
    if (source.kind === "claude-md") return "Your CLAUDE.md";
    if (source.kind === "claude-rule") return `Your Claude rule ${file}`;
    return `Your ${kindLabel(source.kind)} (${file})`;
  }
  if (source.kind === "claude-rule") return `Claude rule ${file}${project ? ` · ${project}` : ""}`;
  return `Project ${file}${project ? ` · ${project}` : ""}`;
}
