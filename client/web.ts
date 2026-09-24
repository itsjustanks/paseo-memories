import { Platform } from "react-native";

/**
 * The only DOM code in the plugin, gated on web. Native clients get no file
 * picker (paste instead) and no download (copy instead).
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
type WebGlobals = { document?: WebDocument; URL?: { createObjectURL(blob: unknown): string; revokeObjectURL(url: string): void }; Blob?: new (parts: string[], options: { type: string }) => unknown };

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
