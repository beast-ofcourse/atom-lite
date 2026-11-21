import type { ModelInfo, ModelThinkingLevel } from "../types.js";

const EXTENDED: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function getSupportedThinkingLevels(model: ModelInfo | undefined): ModelThinkingLevel[] {
  if (!model?.reasoning) return ["off"];
  const map = model.thinkingLevelMap;
  return EXTENDED.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function clampThinkingLevel(
  model: ModelInfo | undefined,
  level: ModelThinkingLevel,
): ModelThinkingLevel {
  const available = getSupportedThinkingLevels(model);
  if (available.includes(level)) return level;
  const requestedIndex = EXTENDED.indexOf(level);
  if (requestedIndex === -1) return available[0] ?? "off";
  for (let i = requestedIndex; i < EXTENDED.length; i++) {
    const candidate = EXTENDED[i];
    if (available.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = EXTENDED[i];
    if (available.includes(candidate)) return candidate;
  }
  return available[0] ?? "off";
}
