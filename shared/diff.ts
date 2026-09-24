/** A line diff for previews. Pure; LCS, capped so a huge file cannot stall. */

export type DiffLine = { op: " " | "+" | "-"; text: string };

const MAX_CELLS = 2_000_000;

function lines(text: string): string[] {
  if (text === "") return [];
  const out = text.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);
  // Common head and tail first: an append or one changed section is cheap.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ op: " ", text }));
  if (midA.length * midB.length > MAX_CELLS) {
    out.push(...midA.map((text) => ({ op: "-" as const, text })), ...midB.map((text) => ({ op: "+" as const, text })));
  } else {
    const n = midA.length;
    const m = midB.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ op: " ", text: midA[i]! });
        i += 1;
        j += 1;
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) out.push({ op: "-", text: midA[i++]! });
      else out.push({ op: "+", text: midB[j++]! });
    }
    while (i < n) out.push({ op: "-", text: midA[i++]! });
    while (j < m) out.push({ op: "+", text: midB[j++]! });
  }
  out.push(...a.slice(a.length - tail).map((text) => ({ op: " " as const, text })));
  return out;
}

/** Only changes and `context` lines around them; a skipped run becomes one "…" line. */
export function compactDiff(diff: DiffLine[], context = 2): DiffLine[] {
  const keep = diff.map(() => false);
  diff.forEach((line, index) => {
    if (line.op === " ") return;
    for (let k = Math.max(0, index - context); k <= Math.min(diff.length - 1, index + context); k += 1) keep[k] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  diff.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) out.push({ op: " ", text: `… ${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
      skipped = 0;
      out.push(line);
    } else skipped += 1;
  });
  if (skipped && out.length) out.push({ op: " ", text: `… ${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
  return out;
}
