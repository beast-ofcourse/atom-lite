import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import * as fs from "node:fs";
import { resolve, relative, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { isWithinWorkspace } from "../security/paths.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { z } from "zod";

const ArgsSchema = z
  .object({
    pattern: z.string(),
    path: z.string().optional(),
    glob: z.string().optional(),
    case_sensitive: z.boolean().optional(),
    context: z.number().int().min(0).optional(),
    max_results: z.number().int().positive().optional(),
    output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
  })
  .strict();

const MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX = 100;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next"]);

function collectFiles(root: string, globPattern?: string): string[] {
  try {
    if (statSync(root).isFile()) return [root];
  } catch {
    // fall through
  }
  if (globPattern) {
    try {
      const matches = (fs as any).globSync(globPattern, {
        cwd: root,
      }) as string[];
      return matches.map((m: string) => resolve(root, m));
    } catch {
      // fall through to walk
    }
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(full);
    }
  };
  walk(root);
  return out;
}

function isBinary(buf: Buffer): boolean {
  for (let i = 0; i < Math.min(buf.length, 8000); i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function grepJs(
  root: string,
  ctx: ToolContext,
  pattern: string,
  caseSensitive: boolean,
  globPattern: string | undefined,
  context: number,
  maxResults: number,
  outputMode: string,
  cap: number,
): string {
  const files = collectFiles(root, globPattern);
  let output = "";
  let matchCount = 0;
  const filesWithMatches = new Set<string>();
  const counts = new Map<string, number>();

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseSensitive ? "g" : "gi");
  } catch (err) {
    return (
      "INVALID_REGEX: " + (err instanceof Error ? err.message : String(err))
    );
  }

  for (const file of files) {
    if (matchCount >= maxResults && outputMode === "content") break;
    let buf: Buffer;
    try {
      const st = statSync(file);
      if (st.size > MAX_FILE_BYTES) continue;
      buf = readFileSync(file);
    } catch {
      continue;
    }
    if (isBinary(buf)) continue;
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    const rel = relative(ctx.workspace, file) || file;
    let fileMatched = false;
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (!regex.test(lines[i])) continue;
      fileMatched = true;
      counts.set(rel, (counts.get(rel) ?? 0) + 1);
      if (outputMode === "content") {
        if (matchCount >= maxResults) continue;
        if (context > 0) {
          const start = Math.max(0, i - context);
          const end = Math.min(lines.length - 1, i + context);
          for (let j = start; j <= end; j++) {
            const prefix = j === i ? `${rel}:${j + 1}:` : `${rel}-${j + 1}-`;
            const line = `${prefix} ${lines[j]}`;
            if (output.length + line.length + 1 > cap) break;
            output += line + "\n";
          }
        } else {
          const line = `${rel}:${i + 1}: ${lines[i]}`;
          if (output.length + line.length + 1 > cap) break;
          output += line + "\n";
        }
        matchCount++;
      }
    }
    if (fileMatched) filesWithMatches.add(rel);
  }

  if (outputMode === "files_with_matches") {
    return (
      [...filesWithMatches].slice(0, maxResults).join("\n") || "(no matches)"
    );
  }
  if (outputMode === "count") {
    return (
      [...counts.entries()]
        .map(([f, n]) => `${f}: ${n}`)
        .slice(0, maxResults)
        .join("\n") || "(no matches)"
    );
  }
  return output.trimEnd() || "(no matches)";
}

function toRelative(p: string, root: string, workspace: string): string {
  const abs = resolve(root, p);
  return relative(workspace, abs) || p;
}

export const grepTool: Tool = {
  definition: {
    name: "grep",
    description: "Search file contents by regular expression.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        case_sensitive: { type: "boolean" },
        context: { type: "integer", minimum: 0 },
        max_results: { type: "integer", minimum: 1 },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  annotations: { readOnlyHint: true },
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        toolCallId: call.id,
        name: "grep",
        content: "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        isError: true,
      };
    }
    const {
      pattern,
      path: searchPath,
      glob: globPattern,
      case_sensitive = true,
      context = 0,
      max_results = DEFAULT_MAX,
      output_mode = "content",
    } = parsed.data;

    const root = searchPath
      ? resolve(ctx.workspace, searchPath)
      : ctx.workspace;
    if (searchPath && !isWithinWorkspace(ctx.workspace, searchPath)) {
      return {
        toolCallId: call.id,
        name: "grep",
        content: "PATH_OUTSIDE_WORKSPACE",
        isError: true,
      };
    }
    if (!existsSync(root)) {
      return {
        toolCallId: call.id,
        name: "grep",
        content: "PATH_NOT_FOUND",
        isError: true,
      };
    }

    // Try ripgrep first for speed.
    const rgArgs: string[] = [];
    if (!case_sensitive) rgArgs.push("-i");
    if (globPattern) rgArgs.push("-g", globPattern);
    if (context > 0) rgArgs.push("-C", String(context));
    if (output_mode === "files_with_matches") rgArgs.push("-l");
    else if (output_mode === "count") rgArgs.push("-c");
    rgArgs.push("--hidden", "--color=never", "-H", "-n");
    rgArgs.push(pattern);
    rgArgs.push(root);

    const res = spawnSync("rg", rgArgs, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });

    if (res.error || (res.status !== 0 && res.status !== 1)) {
      // Fallback to JS implementation.
      const content = grepJs(
        root,
        ctx,
        pattern,
        case_sensitive,
        globPattern,
        context,
        max_results,
        output_mode,
        ctx.maxToolOutputBytes ?? 30000,
      );
      if (content.startsWith("INVALID_REGEX")) {
        return {
          toolCallId: call.id,
          name: "grep",
          content,
          isError: true,
        };
      }
      return { toolCallId: call.id, name: "grep", content };
    }

    const cap = ctx.maxToolOutputBytes ?? 30000;
    let output = "";
    const filesWithMatches = new Set<string>();
    const counts: string[] = [];
    const lines = (res.stdout || "").split("\n").filter((l) => l.length > 0);

    if (output_mode === "files_with_matches") {
      const list = lines
        .map((l) => toRelative(l, root, ctx.workspace))
        .slice(0, max_results);
      return {
        toolCallId: call.id,
        name: "grep",
        content: list.join("\n") || "(no matches)",
      };
    }
    if (output_mode === "count") {
      const list = lines
        .map((l) => {
          const idx = l.lastIndexOf(":");
          const file = l.slice(0, idx);
          const n = l.slice(idx + 1);
          return `${toRelative(file, root, ctx.workspace)}: ${n}`;
        })
        .slice(0, max_results);
      return {
        toolCallId: call.id,
        name: "grep",
        content: list.join("\n") || "(no matches)",
      };
    }

    let matchCount = 0;
    for (const line of lines) {
      if (matchCount >= max_results) break;
      // content or context lines
      const m = line.match(/^(.+?):(\d+):(.*)$/);
      const ctxm = line.match(/^(.+?)-(\d+)-(.*)$/);
      if (m) {
        const file = toRelative(m[1], root, ctx.workspace);
        const outLine = `${file}:${m[2]}: ${m[3]}`;
        if (output.length + outLine.length + 1 > cap) break;
        output += outLine + "\n";
        matchCount++;
      } else if (ctxm) {
        const file = toRelative(ctxm[1], root, ctx.workspace);
        const outLine = `${file}-${ctxm[2]}- ${ctxm[3]}`;
        if (output.length + outLine.length + 1 > cap) break;
        output += outLine + "\n";
      }
    }

    return {
      toolCallId: call.id,
      name: "grep",
      content: output.trimEnd() || "(no matches)",
    };
  },
};
