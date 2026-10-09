import * as pluginClient from "@getpaseo/plugin/client";
import { copyToClipboard } from "./ui";

/**
 * Paseo 0.10+ hands plugins `openExternalUrl`, which opens the system
 * browser. The 0.8 SDK types do not declare it, so it is looked up at
 * runtime; on an app without it, views that link out show no links, as before.
 */
const openExternalUrl = (pluginClient as unknown as { openExternalUrl?: (url: string) => Promise<void> }).openExternalUrl;

export function canOpenLinks(): boolean {
  return typeof openExternalUrl === "function";
}

/** Opens `url` in the browser; when that fails, copies it instead. Call it straight from a press. */
export async function openLink(url: string): Promise<"opened" | "copied" | "failed"> {
  try {
    if (!openExternalUrl) throw new Error("no opener");
    await openExternalUrl(url);
    return "opened";
  } catch {
    return (await copyToClipboard(url)) ? "copied" : "failed";
  }
}
