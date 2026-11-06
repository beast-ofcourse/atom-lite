import { isWithinWorkspace } from "../security/paths.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { z } from "zod";

const ArgsSchema = z
  .object({
    url: z.string(),
    format: z.enum(["text", "markdown", "html"]).optional(),
    timeout: z.number().int().positive().optional(),
  })
  .strict();

const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT = 30000;
const MAX_TIMEOUT = 120000;

export const webfetchTool: Tool = {
  definition: {
    name: "webfetch",
    description:
      "Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        format: { type: "string", enum: ["text", "markdown", "html"] },
        timeout: { type: "integer", minimum: 1 },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        toolCallId: call.id,
        name: "webfetch",
        content: "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        isError: true,
      };
    }
    const { url, format = "markdown", timeout } = parsed.data;
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return {
        toolCallId: call.id,
        name: "webfetch",
        content:
          "TOOL_ARGUMENT_INVALID: URL must start with http:// or https://",
        isError: true,
      };
    }
    const timeoutMs = Math.min((timeout ?? 30) * 1000, MAX_TIMEOUT);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { "User-Agent": "atom-lite/0.1" };
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      return {
        toolCallId: call.id,
        name: "webfetch",
        content: `PROVIDER_CONNECTION_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
    // Cloudflare challenge retry
    if (res.status === 403) {
      try {
        res = await fetch(url, {
          headers: { ...headers, "User-Agent": "atom-lite/0.1 (compatible)" },
          signal: controller.signal,
        });
      } catch {
        // ignore
      }
    }
    clearTimeout(timer);
    if (!res.ok) {
      return {
        toolCallId: call.id,
        name: "webfetch",
        content: `PROVIDER_INVALID_RESPONSE: ${res.status}`,
        isError: true,
      };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return {
        toolCallId: call.id,
        name: "webfetch",
        content: "OUTPUT_TRUNCATED: response too large",
        isError: true,
      };
    }
    const contentType = res.headers.get("content-type") ?? "";
    const raw = new TextDecoder().decode(buf);
    let output = raw;
    const isHtml =
      contentType.includes("text/html") || raw.trim().startsWith("<");
    if (format === "markdown" && isHtml) {
      try {
        const TurndownService = (await import("turndown")).default;
        const td = new TurndownService({
          headingStyle: "atx",
          codeBlockStyle: "fenced",
        });
        td.remove(["script", "style", "meta", "link", "noscript"]);
        output = td.turndown(raw);
      } catch {
        output = stripHtml(raw);
      }
    } else if (format === "text" && isHtml) {
      output = stripHtml(raw);
    }
    // cap output
    if (output.length > 30000)
      output = output.slice(0, 30000) + "\nOUTPUT_TRUNCATED";
    return { toolCallId: call.id, name: "webfetch", content: output };
  },
};

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
