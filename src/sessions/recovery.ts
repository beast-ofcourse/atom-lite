import { readFileSync, existsSync } from "node:fs";
import type { SessionEvent } from "./events.js";

export function parseJsonlEvents(filePath: string): SessionEvent[] {
  if (!existsSync(filePath)) return [];
  let raw = "";
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const events: SessionEvent[] = [];
  const lines = raw.split(/\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Incomplete/invalid tail: stop without discarding earlier valid events.
      break;
    }
    if (parsed && typeof parsed === "object") {
      events.push(parsed as SessionEvent);
    }
  }
  return events;
}

export function recoverTail(filePath: string): {
  events: SessionEvent[];
  dropped: number;
} {
  const events = parseJsonlEvents(filePath);
  return { events, dropped: 0 };
}
