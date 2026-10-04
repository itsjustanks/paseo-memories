import { Platform } from "react-native";

/**
 * The only DOM code in the plugin, gated on web. Native clients get no file
 * picker (paste instead), no download (copy instead) and no remembered title
 * mode (plain names until the page reads its settings).
 */

type WebDocument = {
  createElement(tag: string): {
    type: string;
    accept: string;
    multiple: boolean;
    href: string;
    download: string;
    files: ArrayLike<{ name: string; text(): Promise<string> }> | null;
    onchange: (() => void) | null;
    click(): void;
    remove(): void;
  };
  body: { appendChild(node: unknown): void };
};
type WebStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
type WebGlobals = { localStorage?: WebStorage; document?: WebDocument; URL?: { createObjectURL(blob: unknown): string; revokeObjectURL(url: string): void }; Blob?: new (parts: string[], options: { type: string }) => unknown };

const web = (): WebGlobals | null => (Platform.OS === "web" ? (globalThis as unknown as WebGlobals) : null);

export const canPickFiles = (): boolean => Boolean(web()?.document);
export const canDownload = (): boolean => Boolean(web()?.document && web()?.URL && web()?.Blob);

export function pickTextFiles(accept = ".md,.mdc,.json,.txt"): Promise<Array<{ name: string; text: string }>> {
  const g = web();
  if (!g?.document) return Promise.resolve([]);
  return new Promise((resolve) => {
    const input = g.document!.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = true;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      void Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() }))).then(resolve);
    };
    input.click();
  });
}

export function downloadText(name: string, text: string, type = "application/json"): boolean {
  const g = web();
  if (!g?.document || !g.URL || !g.Blob) return false;
  const url = g.URL.createObjectURL(new g.Blob([text], { type }));
  const link = g.document.createElement("a");
  link.href = url;
  link.download = name;
  g.document.body.appendChild(link);
  link.click();
  link.remove();
  g.URL.revokeObjectURL(url);
  return true;
}

const TITLE_MODE_KEY = "paseo-memories:technical-titles";

/** The last "Show technical details" value, for header titles worked out before settings load. Web only; false elsewhere. */
export function recallTechnicalTitles(): boolean {
  try {
    return web()?.localStorage?.getItem(TITLE_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function keepTechnicalTitles(technical: boolean): void {
  try {
    web()?.localStorage?.setItem(TITLE_MODE_KEY, technical ? "1" : "0");
  } catch {
    // Storage off: titles fall back to the plain names until the page reports the mode.
  }
}
