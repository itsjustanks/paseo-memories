/** Text-level traits a save must keep. Pure. */

const BOM = "﻿";

/** True when most line breaks are CRLF. */
export function usesCrlf(text: string): boolean {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > 0 && crlf >= lf;
}

/**
 * The file's byte-order mark and CRLF line breaks carried over to new text
 * that arrived without them (an editor or a text field normalises both away).
 */
export function keepTextTraits(original: string, next: string): string {
  let out = next;
  // A CRLF file stays CRLF throughout, including a section spliced in with LF.
  if (usesCrlf(original)) out = out.replace(/\r?\n/g, "\r\n");
  if (original.startsWith(BOM) && !out.startsWith(BOM)) out = BOM + out;
  return out;
}
