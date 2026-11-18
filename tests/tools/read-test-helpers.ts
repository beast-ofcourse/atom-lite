import { readTool } from "../../dist/tools/index.js";

export interface ReadTestOptions {
  maxToolOutputBytes?: number;
  supportsVision?: boolean;
  mode?: "plan" | "yolo";
}

/** Call the built read tool with a minimal context; tests assert only model-visible results. */
export async function invokeRead(workspace: string, args: Record<string, unknown>, options: ReadTestOptions = {}) {
  return readTool.execute(
    { id: "1", name: "read", arguments: args },
    { workspace, signal: new AbortController().signal, supportsVision: true, ...options } as any,
  );
}
