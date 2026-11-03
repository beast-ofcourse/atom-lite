import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { z } from "zod";

const ArgsSchema = z
  .object({
    query: z.string(),
    num_results: z.number().int().positive().optional(),
  })
  .strict();

export const websearchTool: Tool = {
  definition: {
    name: "websearch",
    description: "Search the web for a query and return titles, URLs, and snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        num_results: { type: "integer", minimum: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return { toolCallId: call.id, name: "websearch", content: "TOOL_ARGUMENT_INVALID: " + parsed.error.message, isError: true };
    }
    const { query, num_results = 8 } = parsed.data;
    const limit = Math.min(num_results, 20);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": "atom-lite/0.1" },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      return { toolCallId: call.id, name: "websearch", content: `PROVIDER_CONNECTION_FAILED: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    clearTimeout(timer);
    if (!res.ok) {
      return { toolCallId: call.id, name: "websearch", content: `PROVIDER_INVALID_RESPONSE: ${res.status}`, isError: true };
    }
    const html = await res.text();
    // Parse result blocks
    const results: { title: string; url: string; snippet: string }[] = [];
    const resultBlockRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    const titles: { url: string; title: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = resultBlockRegex.exec(html)) !== null) {
      const rawUrl = m[1];
      const title = stripTags(m[2]).trim();
      // DuckDuckGo wraps URLs in a redirect; extract uddg param
      let finalUrl = rawUrl;
      const uddg = rawUrl.match(/uddg=([^&]+)/);
      if (uddg) finalUrl = decodeURIComponent(uddg[1]);
      titles.push({ url: finalUrl, title });
    }
    const snippets: string[] = [];
    while ((m = snippetRegex.exec(html)) !== null) {
      snippets.push(stripTags(m[1]).trim());
    }
    for (let i = 0; i < Math.min(titles.length, limit); i++) {
      results.push({
        title: titles[i].title,
        url: titles[i].url,
        snippet: snippets[i] ?? "",
      });
    }
    if (results.length === 0) {
      return { toolCallId: call.id, name: "websearch", content: "No results found." };
    }
    const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
    let output = `Search: ${query}\n\n${lines.join("\n\n")}`;
    if (output.length > 30000) output = output.slice(0, 30000) + "\nOUTPUT_TRUNCATED";
    return { toolCallId: call.id, name: "websearch", content: output };
  },
};

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ");
}