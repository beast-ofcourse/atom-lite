export function renderDiff(oldText: string, newText: string): string[] {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  // Simple LCS-based unified diff (no context lines beyond changes).
  const out: string[] = [];
  // Use a simple line-by-line diff (Myers-lite): find common prefix/suffix.
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
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