import { open, opendir, readFile, stat as statAsync } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { isWithinWorkspace } from "../security/paths.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { z } from "zod";

const CHUNK_BYTES = 256 * 1024;
const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;
const TAIL_LINES = 100;
const MAX_LINE_CHARS = 2000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MEDIA_LIMIT_LABEL = `${MAX_MEDIA_BYTES / (1024 * 1024)} MiB`;
const DEFAULT_OUTPUT_CAP = 30000;
const LINE_TRUNCATED = `... (line truncated to ${MAX_LINE_CHARS} chars)`;

/** Detect media from bytes alone, so an extension cannot turn text into an attachment. */
function detectMediaMime(buf: Uint8Array): string | null {
  const b = buf as Buffer;
  if (buf.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (buf.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && (b.subarray(0, 6).toString() === "GIF87a" || b.subarray(0, 6).toString() === "GIF89a"))
    return "image/gif";
  if (
    buf.length >= 12 &&
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (buf.length >= 5 && b.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  return null;
}

const ArgsSchema = z
  .object({
    path: z.string(),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

interface LineEntry {
  lineNumber: number;
  text: string;
  hasNul: boolean;
}

interface PageInput {
  handle: FileHandle;
  first: Uint8Array;
  displayPath: string;
  size: number;
  offset: number | undefined;
  limit: number | undefined;
  outputCap: number;
}

const continuationHint = (line: number): string => `[Output truncated. Continue reading with offset: ${line}]`;

interface PageLabels {
  empty: string;
  clipped: string;
}

/** Assemble a bounded page from a header and one string per item. */
function renderPaged(
  header: string,
  items: string[],
  firstItem: number,
  next: number | undefined,
  outputCap: number,
  labels: PageLabels,
): string {
  const rendered = [...items];
  const budget = Math.min(MAX_READ_BYTES, outputCap);
  let cursor = next;
  const render = (): string =>
    [header, ...rendered, ...(cursor === undefined ? [] : [continuationHint(cursor)])].join("\n");
  while (rendered.length > 0 && Buffer.byteLength(render()) > budget) {
    rendered.pop();
    cursor = firstItem + rendered.length;
  }
  if (rendered.length === 0 && cursor === undefined) return `${header}\n${labels.empty}`;
  const body = rendered.length > 0 ? rendered.join("\n") : labels.clipped;
  return cursor === undefined ? `${header}\n${body}` : `${header}\n${body}\n${continuationHint(cursor)}`;
}

/** Keep a readable prefix of a very long line, counting code points not UTF-16 units. */
function clampLine(line: string): string {
  const chars = Array.from(line);
  return chars.length <= MAX_LINE_CHARS ? line : chars.slice(0, MAX_LINE_CHARS).join("") + LINE_TRUNCATED;
}

/**
 * Stream the file in bounded chunks, collect only the requested page, and hash
 * every byte so the header still guards the whole file. Memory stays bounded
 * even for the largest permitted file; only the page and a small tail buffer
 * are retained.
 */
async function pageText(input: PageInput): Promise<string> {
  const { handle, first, displayPath, size, offset, limit, outputCap } = input;
  const requested = offset ?? 1;
  const maxLines = Math.min(limit ?? MAX_READ_LINES, MAX_READ_LINES);
  const budget = Math.min(MAX_READ_BYTES, outputCap);
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

  const entries: LineEntry[] = [];
  const tail: LineEntry[] = [];
  let pending = "";
  let lineNo = 0;
  let totalLines = 0;
  let nextToCollect = requested;
  let firstUnseen: number | undefined;
  let byteCount = 0;
  let position = 0;

  const pushLine = (raw: string): void => {
    lineNo++;
    totalLines = lineNo;
    let text = raw;
    if (lineNo === 1 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.endsWith("\r")) text = text.slice(0, -1);
    const entry: LineEntry = { lineNumber: lineNo, text: clampLine(text), hasNul: text.includes("\0") };
    tail.push(entry);
    if (tail.length > TAIL_LINES) tail.shift();
    if (firstUnseen !== undefined || nextToCollect !== lineNo || entries.length >= maxLines) return;
    const cost = Buffer.byteLength(`${lineNo}: ${entry.text}`) + 1;
    if (byteCount + cost > budget) {
      firstUnseen = lineNo;
      return;
    }
    entries.push(entry);
    byteCount += cost;
    nextToCollect = lineNo + 1;
  };

  const consume = (bytes: Uint8Array): void => {
    hash.update(bytes);
    const decoded = decoder.decode(bytes, { stream: true });
    const parts = (pending + decoded).split("\n");
    pending = parts.pop() ?? "";
    for (const part of parts) pushLine(part);
    position += bytes.length;
  };

  consume(first);
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
    if (bytesRead === 0) break;
    consume(buffer.subarray(0, bytesRead));
  }
  pending += decoder.decode();
  if (pending.length > 0) pushLine(pending);

  let selected: LineEntry[];
  let next: number | undefined;
  let pastEnd = false;
  if (requested > totalLines && totalLines > 0) {
    pastEnd = true;
    const from = Math.max(1, totalLines - Math.min(limit ?? TAIL_LINES, TAIL_LINES) + 1);
    selected = tail.filter((entry) => entry.lineNumber >= from);
  } else {
    selected = entries;
    next = firstUnseen;
    if (next === undefined && requested + selected.length <= totalLines) next = requested + selected.length;
  }

  let header = `File: ${displayPath} (${size} bytes, sha256:${hash.digest("hex")})`;
  if (pastEnd) {
    header += ` (offset ${requested} is past the end; the file has ${totalLines} ${
      totalLines === 1 ? "line" : "lines"
    })`;
  } else if (totalLines === 0) {
    header += " (0 lines)";
  }

  if (selected.some((entry) => entry.hasNul)) return `Binary file detected (${size} bytes).`;
  return renderPaged(
    header,
    selected.map((entry) => `${entry.lineNumber}: ${entry.text}`),
    requested,
    next,
    outputCap,
    { empty: "(empty)", clipped: "(no lines fit the output cap)" },
  );
}

interface DirectoryInput {
  displayPath: string;
  directoryPath: string;
  offset: number | undefined;
  limit: number | undefined;
  outputCap: number;
}

/** Stream a directory and retain only the requested slice. Symlinks are shown but never followed. */
async function pageDirectory(input: DirectoryInput): Promise<string> {
  const { displayPath, directoryPath, offset, limit, outputCap } = input;
  const requested = offset ?? 1;
  const maxLines = Math.min(limit ?? MAX_READ_LINES, MAX_READ_LINES);
  const end = requested - 1 + maxLines;
  const directories: string[] = [];
  const files: string[] = [];
  const keep = (names: string[], name: string): void => {
    const index = names.findIndex((current) => current.localeCompare(name) > 0);
    names.splice(index === -1 ? names.length : index, 0, name);
    if (names.length > end) names.pop();
  };
  let total = 0;
  let dir;
  try {
    dir = await opendir(directoryPath);
  } catch {
    return "FILE_NOT_FOUND";
  }
  // `for await` closes the directory handle when iteration ends. Keep only the
  // smallest names needed for this page instead of materializing the whole listing.
  for await (const entry of dir) {
    total++;
    keep(entry.isDirectory() ? directories : files, entry.name);
  }
  const visible = [...directories.map((name) => `${name}/`), ...files].slice(requested - 1, end);
  const next = end < total ? end + 1 : undefined;
  const header =
    visible.length === 0
      ? `Directory: ${displayPath} (0 entries)`
      : `Directory: ${displayPath} (entries ${requested}-${requested + visible.length - 1})`;
  return renderPaged(header, visible, requested, next, outputCap, {
    empty: "(empty)",
    clipped: "(no entries fit the output cap)",
  });
}

export const readTool: Tool = {
  // Read-only: reads never mutate workspace paths, so the executor takes a
  // read lock instead of serializing on a write lock.
  annotations: { readOnlyHint: true },
  definition: {
    name: "read",
    description:
      "Read a file, directory listing, image, or PDF. Use offset and limit to page large files or directories; a truncated result names the next offset.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        toolCallId: call.id,
        name: "read",
        content: "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        isError: true,
      };
    }
    const { path, offset, limit } = parsed.data;
    const resolved = resolve(ctx.workspace, path);
    const within = isWithinWorkspace(ctx.workspace, path);
    if (!within) {
      if (ctx.approvals?.nonInteractive || !ctx.approvals?.handler) {
        return {
          toolCallId: call.id,
          name: "read",
          content: "PATH_OUTSIDE_WORKSPACE",
          isError: true,
        };
      }
      const { checkApproval } = await import("../runtime/approvals.js");
      const decision = await checkApproval(ctx.approvals, {
        command: `read ${path}`,
        cwd: ctx.workspace,
        timeoutMs: 0,
        sandboxed: false,
        tool: "read",
      });
      if (!decision.allowed) {
        return {
          toolCallId: call.id,
          name: "read",
          content: "READ_APPROVAL_REQUIRED",
          isError: true,
        };
      }
    }
    // One async stat replaces the old existsSync+statSync pair: non-blocking
    // (keeps the event loop free for the TUI and parallel tool calls) and a
    // single syscall instead of two.
    let st;
    try {
      st = await statAsync(resolved);
    } catch {
      return {
        toolCallId: call.id,
        name: "read",
        content: "FILE_NOT_FOUND",
        isError: true,
      };
    }
    if (st.isDirectory()) {
      const content = await pageDirectory({
        displayPath: path,
        directoryPath: resolved,
        offset,
        limit,
        outputCap: ctx.maxToolOutputBytes ?? DEFAULT_OUTPUT_CAP,
      });
      return {
        toolCallId: call.id,
        name: "read",
        content,
        ...(content === "FILE_NOT_FOUND" ? { isError: true as const } : {}),
      };
    }
    let handle: FileHandle;
    try {
      handle = await open(resolved, "r");
    } catch {
      return {
        toolCallId: call.id,
        name: "read",
        content: "FILE_NOT_FOUND",
        isError: true,
      };
    }
    try {
      const firstBuffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, st.size || 1));
      const { bytesRead } = await handle.read(firstBuffer, 0, firstBuffer.length, 0);
      const first = firstBuffer.subarray(0, bytesRead);
      const mime = detectMediaMime(first);
      if (mime) {
        if (!ctx.supportsVision) {
          return {
            toolCallId: call.id,
            name: "read",
            content: "vision not supported by current model",
            isError: true,
          };
        }
        if (st.size > MAX_MEDIA_BYTES) {
          return {
            toolCallId: call.id,
            name: "read",
            content: `MEDIA_TOO_LARGE: ${path} exceeds the ${MEDIA_LIMIT_LABEL} ingestion limit`,
            isError: true,
          };
        }
        const buf = await readFile(resolved);
        const kind = mime === "application/pdf" ? "PDF" : "Image";
        return {
          toolCallId: call.id,
          name: "read",
          content: `${kind} file: ${path} (${buf.length} bytes, ${mime})`,
          images: [{ data: buf.toString("base64"), mime }],
        };
      }
      if (st.size > MAX_FILE_BYTES) {
        return {
          toolCallId: call.id,
          name: "read",
          content: "FILE_TOO_LARGE",
          isError: true,
        };
      }
      const cap = ctx.maxToolOutputBytes ?? DEFAULT_OUTPUT_CAP;
      const content = await pageText({
        handle,
        first,
        displayPath: path,
        size: st.size,
        offset,
        limit,
        outputCap: cap,
      });
      return { toolCallId: call.id, name: "read", content };
    } finally {
      await handle.close();
    }
  },
};
