import type { Selection } from "./md-edit";

/**
 * The editor's Undo: one step per change, typing included. A formatting
 * button is always a step of its own. Typing is grouped into steps the way
 * people think of it: a new step starts after a pause (over a second), and
 * at the start of each new word once the current step already holds one
 * ("alpha beta gamma" undoes a word at a time). Pure; the editor feeds it.
 */

export type Snapshot = { text: string; selection: Selection };

const PAUSE_MS = 1000;
const MAX_STEPS = 100;

export class History {
  private steps: Snapshot[] = [];
  private open = false;
  private hasWord = false;
  private last = 0;

  private push(snapshot: Snapshot): void {
    this.steps.push(snapshot);
    if (this.steps.length > MAX_STEPS) this.steps.shift();
  }

  /** Before a formatting button changes the text. */
  button(text: string, selection: Selection): void {
    this.push({ text, selection });
    this.open = false;
  }

  /** Before typed text (or a deletion) replaces `before`; `selection` is where the cursor was. */
  typing(before: string, selection: Selection, after: string, now: number): void {
    const at = Math.min(selection.start, selection.end);
    const inserted = after.length >= before.length - Math.abs(selection.end - selection.start) ? after.slice(at, at + Math.max(0, after.length - before.length + Math.abs(selection.end - selection.start))) : "";
    const first = inserted[0] ?? "";
    const previous = before[at - 1] ?? "";
    const wordStart = /\S/.test(first) && (previous === "" || /\s/.test(previous));
    if (!this.open || now - this.last > PAUSE_MS || (this.hasWord && wordStart)) {
      this.push({ text: before, selection });
      this.open = true;
      this.hasWord = false;
    }
    if (/\S/.test(inserted)) this.hasWord = true;
    this.last = now;
  }

  /** The step before `current`, or undefined when there is none. Typing after an undo starts a new step. */
  undo(current: string): Snapshot | undefined {
    this.open = false;
    let step = this.steps.pop();
    // A step identical to what is on screen changes nothing; skip it.
    while (step && step.text === current) step = this.steps.pop();
    return step;
  }

  get canUndo(): boolean {
    return this.steps.length > 0;
  }
}
