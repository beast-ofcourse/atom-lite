/**
 * Line diff used by write/edit so the CLI can render a diff without re-reading
 * files or diffing during a TUI frame.
 */
export function renderDiff(oldText: string, newText: string): string[] {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const out: string[] = [];
  // Myers-lite: strip the common prefix and suffix, then show the middle.
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  if (oldMid.length === 0 && newMid.length === 0) {
    return ["(no changes)"];
  }
  for (const l of oldMid) out.push(`- ${l}`);
  for (const l of newMid) out.push(`+ ${l}`);
  return out;
}

/** Diff for a newly created file: every line is an addition. */
export function renderAddedLines(newText: string): string[] {
  const lines = newText.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => `+ ${l}`);
}
