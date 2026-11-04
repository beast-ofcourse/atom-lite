/** Extract bracketed-paste payloads; returns null for non-paste input. */
export function extractPaste(data: string): string | null {
  if (!data.includes("\x1b[200~")) return null;
  return data
    .replace(/\x1b\[200~/g, "")
    .replace(/\x1b\[201~/g, "")
    .replace(/[\x00-\x1f]/g, "");
}
