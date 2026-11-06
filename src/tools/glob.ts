import { existsSync } from "node:fs";
import * as fs from "node:fs";
import { resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { isWithinWorkspace } from "../security/paths.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { z } from "zod";

const ArgsSchema = z
  .object({
    pattern: z.string(),
    path: z.string().optional(),
    max_results: z.number().int().positive().optional(),
  })
  .strict();

const DEFAULT_MAX = 1000;

export const globTool: Tool = {
  definition: {
    name: "glob",
    description: "Find files matching a glob pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        max_results: { type: "integer", minimum: 1 },
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
        name: "glob",
        content: "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        isError: true,
      };
    }
    const {
      pattern,
      path: searchPath,
      max_results = DEFAULT_MAX,
    } = parsed.data;
    const root = searchPath
      ? resolve(ctx.workspace, searchPath)
      : ctx.workspace;
    if (searchPath && !isWithinWorkspace(ctx.workspace, searchPath)) {
      return {
        toolCallId: call.id,
        name: "glob",
        content: "PATH_OUTSIDE_WORKSPACE",
        isError: true,
      };
    }
    if (!existsSync(root)) {
      return {
        toolCallId: call.id,
        name: "glob",
        content: "PATH_NOT_FOUND",
        isError: true,
      };
    }

    // Try ripgrep --files for speed.
    const res = spawnSync("rg", ["--hidden", "--files", "-g", pattern, root], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });

    let matches: string[];
    if (res.error) {
      // Fallback to Node fs.globSync.
      try {
        matches = (fs as any).globSync(pattern, { cwd: root }) as string[];
        matches = matches.map((m: string) => resolve(root, m));
      } catch (err) {
        return {
          toolCallId: call.id,
          name: "glob",
          content:
            "INVALID_GLOB: " +
            (err instanceof Error ? err.message : String(err)),
          isError: true,
        };
      }
    } else {
      matches = (res.stdout || "").split("\n").filter((l) => l.length > 0);
    }

    const out = matches
      .map((m) => relative(ctx.workspace, resolve(root, m)))
      .sort()
      .slice(0, max_results);
    return {
      toolCallId: call.id,
      name: "glob",
      content: out.join("\n") || "(no matches)",
    };
  },
};
