/**
 * Pure helpers for the browser's inline diff renderer.
 *
 * The runtime already produces a flat `string[]` of diff lines (see
 * `src/tools/diff.ts`). This module turns that shape into rows the UI can
 * render without injecting raw text as HTML, and pairs adjacent remove/add
 * runs so changed words can be highlighted.
 */

export const DIFF_MAX_LINES = 400;
export const DIFF_MAX_CHARS = 60_000;

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripSegment(text) {
  return text ? [{ text, changed: false }] : [];
}

/** Split a `-` line and its paired `+` line into common and changed spans. */
export function changedSegments(before, after) {
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  ) {
    start += 1;
  }
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1;
  }
  const beforeEnd = before.length - end;
  const afterEnd = after.length - end;
  return {
    before: [
      ...stripSegment(before.slice(0, start)),
      ...stripSegment(before.slice(start, beforeEnd)).map((part) => ({
        ...part,
        changed: true,
      })),
      ...stripSegment(before.slice(beforeEnd)),
    ],
    after: [
      ...stripSegment(after.slice(0, start)),
      ...stripSegment(after.slice(start, afterEnd)).map((part) => ({
        ...part,
        changed: true,
      })),
      ...stripSegment(after.slice(afterEnd)),
    ],
  };
}

/** Pair adjacent remove/add runs so word-level changes can be highlighted. */
export function pairChangedLines(rows) {
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].kind !== "del") continue;
    const delStart = index;
    let cursor = index;
    while (rows[cursor]?.kind === "del") cursor += 1;
    const addStart = cursor;
    while (rows[cursor]?.kind === "add") cursor += 1;
    const delRows = rows.slice(delStart, addStart);
    const addRows = rows.slice(addStart, cursor);
    const paired = Math.min(delRows.length, addRows.length);
    for (let offset = 0; offset < paired; offset += 1) {
      const segments = changedSegments(
        delRows[offset].text,
        addRows[offset].text,
      );
      delRows[offset].segments = segments.before;
      addRows[offset].segments = segments.after;
    }
    index = cursor - 1;
  }
  return rows;
}

/**
 * Build a bounded, render-ready model from runtime diff lines.
 *
 * `---`/`+++` headers become the path in the diff header, `@@` lines are kept
 * as quiet separators, and an over-long diff keeps its full text for copy but
 * renders only a capped tail.
 */
export function buildDiffModel(input, options = {}) {
  const lines = Array.isArray(input)
    ? input.map(String)
    : String(input ?? "").split("\n");
  const maxLines = options.maxLines ?? DIFF_MAX_LINES;
  const maxChars = options.maxChars ?? DIFF_MAX_CHARS;
  const rows = [];
  let path = options.path ?? "";
  let oldLine = 0;
  let newLine = 0;
  let added = 0;
  let removed = 0;
  let chars = 0;
  let truncated = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (index >= maxLines || chars + line.length > maxChars) {
      truncated = true;
      break;
    }
    chars += line.length;
    if (line.startsWith("--- ")) {
      path = line.slice(4).replace(/^a\//, "") || path;
      continue;
    }
    if (line.startsWith("+++ ")) {
      path = line.slice(4).replace(/^b\//, "") || path;
      continue;
    }
    if (line.startsWith("@@")) {
      const match = line.match(HUNK);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), newLine: newLine++ });
      added += 1;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), oldLine: oldLine++ });
      removed += 1;
    } else if (line.startsWith("... ") || line.startsWith("…")) {
      rows.push({ kind: "meta", text: line });
    } else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({
        kind: "context",
        text,
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }

  return {
    rows: pairChangedLines(rows),
    path,
    added,
    removed,
    truncated,
    total: lines.length,
  };
}
