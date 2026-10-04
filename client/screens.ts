import type { PluginScreenParams } from "@getpaseo/plugin/client";

/**
 * Opening the other screen: Memories points to Skills and back with one
 * quiet line, and panels open either. The client entry lends the app's
 * opener (0.11 `openScreen`, which takes params, or the older
 * `openSurface`, which doesn't).
 */

type Opener = (id: string, params?: PluginScreenParams) => void;

let opener: Opener | null = null;
let withParams = false;

export function registerScreenOpener(open: Opener | null, { params = false }: { params?: boolean } = {}): void {
  opener = open;
  withParams = Boolean(open) && params;
}

export function canOpenScreen(): boolean {
  return opener !== null;
}

/** The app keeps a screen's place in its params (Paseo 0.11+). */
export function screenParamsOn(): boolean {
  return withParams;
}

export function openScreenById(id: "memories" | "skills", params?: PluginScreenParams): void {
  if (!opener) return;
  if (withParams && params) opener(id, params);
  else opener(id);
}
