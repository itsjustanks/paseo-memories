import { redactText } from "../shared/redact";

/**
 * The app's newer parts (Paseo 0.10+): toasts, the dialog and its copy, each
 * with a fallback for an app without them (0.6.0). Kept free of react-native
 * so tests can run it; client/ui.tsx hands in what the app has.
 */

export type ToastVariant = "default" | "info" | "success" | "warning" | "error";
export type Toast = {
  show(message: string, options?: { variant?: ToastVariant }): void;
  error(message: string): void;
  /** False on an app without toasts: callers keep their in-place message. */
  available: boolean;
};
type HostToast = { show(message: string, options?: { variant?: ToastVariant }): void; error(message: string): void };

export const NO_TOAST: Toast = { show() {}, error() {}, available: false };

/** Every toast goes through the redactor; a toast that fails to show is dropped, never thrown. */
function redacted(host: HostToast): Toast {
  return {
    show(message, options) {
      try {
        host.show(redactText(message), options);
      } catch {}
    },
    error(message) {
      try {
        host.error(redactText(message));
      } catch {}
    },
    available: true,
  };
}

/**
 * The toast hook, chosen once for the app that loaded the plugin, so it is the
 * same hook (or none) on every render. Paseo's hook throws outside its toast
 * provider after reading the context, so the hooks called stay the same either way.
 */
export function makeUseToast(hostUseToast: unknown): () => Toast {
  if (typeof hostUseToast !== "function") return () => NO_TOAST;
  const use = hostUseToast as () => HostToast;
  return () => {
    try {
      return redacted(use());
    } catch {
      return NO_TOAST;
    }
  };
}

/** The app's dialog, when it has a whole one (with `Content`); null keeps the in-place confirm. */
export function pickModal<M>(modal: M | undefined): M | null {
  return typeof modal === "function" && typeof (modal as { Content?: unknown }).Content === "function" ? modal : null;
}

/**
 * Copy: the app's `copyText` where it has one, else React Native's clipboard.
 * A copy that rejects, throws or answers `false` counts as failed, so the
 * caller says "Couldn't copy" rather than pretending.
 */
export function makeCopy(hostCopy: unknown, fallback: ((text: string) => unknown) | undefined): (text: string) => Promise<boolean> {
  return async (text) => {
    try {
      if (typeof hostCopy === "function") return (await (hostCopy as (text: string) => unknown)(text)) !== false;
      if (typeof fallback !== "function") return false;
      return fallback(text) !== false;
    } catch {
      return false;
    }
  };
}

/**
 * A confirm that acts once (0.6.0): `open` arms it with the items it lists,
 * `confirm` hands them over exactly once (a second press, even in the same
 * tick, gets null), and `close` forgets everything. Opening again re-arms it.
 * Held in a ref, so the guard doesn't wait for a re-render.
 */
export class ConfirmGate<T> {
  private items: T[] | null = null;
  open(items: readonly T[]): T[] {
    this.items = [...items];
    return this.items;
  }
  confirm(): T[] | null {
    const items = this.items;
    this.items = null;
    return items;
  }
  close(): void {
    this.items = null;
  }
  get pending(): readonly T[] | null {
    return this.items;
  }
}

/** A plain once-only switch for the in-place confirms: `arm` when asked, `take` true only for the first press. */
export class Once {
  private armed = false;
  arm(): void {
    this.armed = true;
  }
  take(): boolean {
    const was = this.armed;
    this.armed = false;
    return was;
  }
}

/** This app session, so the host keeps each session's answers apart (one per app start; not a person or a device). */
export const APP_SESSION = `app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/**
 * One Save per preview (0.6.0). `issue` starts a ticket when a preview arrives;
 * `take` hands out its id once (a second press, even in the same tick, gets
 * null while the first is out). `settle` says what the answer allows next:
 *   - "done": something was written; Save needs a new preview;
 *   - "retry": the call never got an answer (it may have run), so a retry
 *     sends the SAME id and the host answers it once;
 *   - "refused": nothing was written; a retry is a new request with a new id.
 */
export class SaveTickets {
  private ticket: { id: string; state: "ready" | "busy" | "done" } | null = null;
  constructor(private readonly newId: () => string = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`) {}
  issue(): string {
    this.ticket = { id: this.newId(), state: "ready" };
    return this.ticket.id;
  }
  take(): string | null {
    if (!this.ticket || this.ticket.state !== "ready") return null;
    this.ticket.state = "busy";
    return this.ticket.id;
  }
  settle(outcome: "done" | "retry" | "refused"): void {
    if (!this.ticket || this.ticket.state !== "busy") return;
    if (outcome === "done") this.ticket.state = "done";
    else if (outcome === "retry") this.ticket.state = "ready";
    else this.issue();
  }
  clear(): void {
    this.ticket = null;
  }
}

/** What a save's answer allows next: written (even partly) means done. */
export function saveOutcome(result: { ok: boolean; reports: ReadonlyArray<{ ok: boolean }> }): "done" | "refused" {
  return result.ok || result.reports.some((report) => report.ok) ? "done" : "refused";
}
