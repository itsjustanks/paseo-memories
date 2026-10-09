/**
 * Component tests (0.6.0 review): the real client components rendered with
 * react-test-renderer. react-native and Paseo's host module are swapped for
 * stubs (rn-stub.mjs, host-stub.mjs) through Node's in-process module hooks,
 * and `globalThis.__paseoHost` says which kind of app this test file plays.
 * Each test file is its own process, so one file per kind of app.
 */
import { registerHooks } from "node:module";
import React from "react";

export type App = { toast?: boolean; copy?: "ok" | "false" | "reject"; modal?: boolean };
export type ToastCall = { text: string; variant?: string };

export const toasts: ToastCall[] = [];
export const copied: string[] = [];
export const clipboard: { mode: "ok" | "throw"; last: string } = { mode: "ok", last: "" };
let copyMode: App["copy"] = "ok";
export const setCopy = (mode: App["copy"]) => void (copyMode = mode);

const toastApi = { show: (text: string, options?: { variant?: string }) => void toasts.push({ text, ...(options?.variant ? { variant: options.variant } : {}) }), error: (text: string) => void toasts.push({ text, variant: "error" }) };
/** A real hook, as the app's is, so hook order is exercised. */
const useToast = () => React.useRef(toastApi).current;
/** The app's dialog: draws its children only while open; `onOpenChange(false)` is the close button. */
function Dialog({ title, open, onOpenChange, children }: { title: string; open: boolean; onOpenChange(open: boolean): void; children?: React.ReactNode }) {
  return open ? React.createElement("Dialog", { title, onOpenChange }, children) : null;
}
Dialog.Content = ({ children }: { children?: React.ReactNode }) => React.createElement("DialogContent", null, children);

export async function playApp(app: App) {
  copyMode = app.copy;
  (globalThis as { __paseoHost?: unknown }).__paseoHost = {
    useToast: app.toast ? useToast : undefined,
    copyText: app.copy
      ? async (text: string) => {
          if (copyMode === "reject") throw new Error("denied");
          if (copyMode === "false") return false;
          copied.push(text);
        }
      : undefined,
    Modal: app.modal ? Dialog : undefined,
    clipboard: (text: string) => {
      if (clipboard.mode === "throw") throw new Error("no clipboard");
      clipboard.last = text;
    },
  };
  const stub = (name: string) => new URL(`./${name}`, import.meta.url).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "react-native") return { url: stub("rn-stub.mjs"), shortCircuit: true };
      if (specifier === "@getpaseo/plugin/client/react-native") return { url: stub("host-stub.mjs"), shortCircuit: true };
      return next(specifier, context);
    },
  });
}

type Renderer = import("react-test-renderer").ReactTestRenderer;
type Node = ReturnType<Renderer["toJSON"]>;

export function textOf(node: Node | Node[] | string | null): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  return (node.children ?? []).map((child) => textOf(child as Node)).join(" ");
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
