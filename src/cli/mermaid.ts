import { render, sourceBox } from "grok-mermaid";

const FENCE_RE = /```mermaid[ \t]*\n([\s\S]*?)```/g;

function renderOne(src: string): string {
  const trimmed = src.trim();
  if (!trimmed) return "```mermaid\n" + src + "```";
  let art = render(trimmed);
  if (!art) {
    try {
      art = sourceBox(trimmed, 100);
    } catch {
      art = null;
    }
  }
  if (!art || !art.plain || art.plain.length === 0) {
    return "```mermaid\n" + src + "```";
  }
  return "```\n" + art.plain.join("\n") + "\n```";
}

export function renderMermaidBlocks(text: string): string {
  return text.replace(FENCE_RE, (_match, src: string) => renderOne(src));
}
