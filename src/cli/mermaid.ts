import { render, sourceBox } from "grok-mermaid";

const FENCE_RE = /```mermaid[ \t]*\n([\s\S]*?)```/g;
const cache = new Map<string, string>();

function renderOne(src: string): string {
  const trimmed = src.trim();
  if (!trimmed) return "```mermaid\n" + src + "```";
  const cached = cache.get(trimmed);
  if (cached) return cached;
  let art = render(trimmed);
  if (!art) {
    try {
      art = sourceBox(trimmed, 100);
    } catch {
      art = null;
    }
  }
  const result =
    art && art.plain && art.plain.length > 0
      ? "```\n" + art.plain.join("\n") + "\n```"
      : "```mermaid\n" + src + "```";
  cache.set(trimmed, result);
  return result;
}

export function renderMermaidBlocks(text: string): string {
  if (!text.includes("```mermaid")) return text;
  return text.replace(FENCE_RE, (_match, src: string) => renderOne(src));
}
