/**
 * Subagent tool for Atom-lite. Each task runs in a separate `atom-lite`
 * process, giving it an isolated context window. Modes: single, parallel,
 * chain. Agent definitions are markdown files with Pi-style frontmatter.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, unlink, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig, type AgentScope } from "./agents.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const STDERR_CAP = 64 * 1024;

interface ContentPart {
  type: string;
  text?: string;
  data?: string;
  mime?: string;
}

interface Message {
  role: string;
  content?: ContentPart[] | string;
  toolCalls?: Array<{
    id?: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  toolCallId?: string;
  name?: string;
  isError?: boolean;
  thinking?: string;
}

type StreamRecord =
  | { type: "message_end"; message: Message }
  | {
      type: "usage";
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: number;
      model?: string;
    }
  | { type: "result"; result: string; sessionId: string }
  | { type: "error"; error: string };

interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

type ChildStatus = "pending" | "running" | "completed" | "failed" | "aborted";

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  status: ChildStatus;
  exitCode: number | null;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  errorMessage?: string;
  terminationSignal?: string;
  step?: number;
}

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  results: SingleResult[];
  isError: boolean;
}

interface ResolvedAgent {
  agent?: AgentConfig;
  available: AgentConfig[];
  cwd: string;
  error?: string;
}

interface DispatchDefaults {
  provider?: string;
  model?: string;
  thinking?: string;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      const text = messageText(messages[i]);
      if (text) return text;
    }
  }
  return "";
}

function isFailedResult(result: SingleResult): boolean {
  return result.status === "failed" || result.status === "aborted";
}

function getFailureEvidence(result: SingleResult): string {
  const evidence: string[] = [];
  const seen = new Set<string>();
  const add = (label: string, value: string | undefined) => {
    const text = value?.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    evidence.push(`${label}: ${text}`);
  };
  add("Error", result.errorMessage);
  add("Signal", result.terminationSignal ?? undefined);
  add("stderr", result.stderr);
  add("Assistant output", getFinalOutput(result.messages));
  return evidence.join("\n\n") || "(no output)";
}

function getResultOutput(result: SingleResult): string {
  return isFailedResult(result)
    ? getFailureEvidence(result)
    : getFinalOutput(result.messages) || "(no output)";
}

function truncateBytes(output: string, limit: number): string {
  if (Buffer.byteLength(output, "utf8") <= limit) return output;
  let text = output.slice(0, limit);
  while (Buffer.byteLength(text, "utf8") > limit) text = text.slice(0, -1);
  return `${text}\n\n[Output truncated: ${Buffer.byteLength(output, "utf8") - Buffer.byteLength(text, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const text = messageText(message);
      if (text) items.push({ type: "text", text });
      for (const call of message.toolCalls ?? []) {
        items.push({ type: "toolCall", name: call.name, args: call.arguments });
      }
    } else if (message.role === "tool") {
      items.push({
        type: "toolCall",
        name: message.name ?? "tool",
        args: { content: message.content ?? "" },
      });
    }
  }
  return items;
}

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  theme: Pick<Theme, "fg">,
): string {
  const preview = (value: string) =>
    value.length > 60 ? `${value.slice(0, 60)}...` : value;
  const command = typeof args.command === "string" ? args.command : undefined;
  if (toolName === "bash" && command) {
    return theme.fg("muted", "$ ") + theme.fg("toolOutput", preview(command));
  }
  const path = typeof args.file_path === "string" ? args.file_path : args.path;
  if (
    typeof path === "string" &&
    ["read", "write", "edit", "ls", "find", "grep"].includes(toolName)
  ) {
    return (
      theme.fg("muted", `${toolName} `) +
      theme.fg("accent", preview(path)) +
      (typeof args.pattern === "string"
        ? theme.fg("dim", ` /${preview(args.pattern)}/`)
        : "")
    );
  }
  return (
    theme.fg("accent", toolName) +
    theme.fg("dim", ` ${preview(JSON.stringify(args))}`)
  );
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<TOut>(items.length);
  let next = 0;
  await Promise.all(
    new Array(limit).fill(null).map(async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}

async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "atom-lite-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = join(dir, `prompt-${safeName}.md`);
  await writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, filePath };
}

function getAtomInvocation(args: string[]): {
  command: string;
  args: string[];
} {
  const current = process.argv[1];
  if (
    current &&
    !current.startsWith("/$bunfs/root/") &&
    !/[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(current)
  ) {
    return { command: process.execPath, args: [current, ...args] };
  }
  const runtimeName = basename(process.execPath).toLowerCase();
  if (/^(node|bun)(\.exe)?$/.test(runtimeName)) {
    return { command: "atom-lite", args };
  }
  return { command: process.execPath, args };
}

function inheritDispatchConfig(): DispatchDefaults {
  const defaults: DispatchDefaults = {};
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === "--model") defaults.model = process.argv[i + 1];
    if (process.argv[i] === "--provider")
      defaults.provider = process.argv[i + 1];
    if (process.argv[i] === "--thinking")
      defaults.thinking = process.argv[i + 1];
  }
  return defaults;
}

function resolveAgent(
  defaultCwd: string,
  scope: AgentScope,
  name: string,
  cwd?: string,
): ResolvedAgent {
  const workspace = resolve(defaultCwd);
  const effectiveCwd = resolve(workspace, cwd ?? ".");
  if (effectiveCwd !== workspace && !effectiveCwd.startsWith(workspace + sep)) {
    return {
      available: [],
      cwd: workspace,
      error: `cwd escapes the workspace: ${cwd}`,
    };
  }
  const discovery = discoverAgents(effectiveCwd, scope);
  return {
    agent: discovery.agents.find((agent) => agent.name === name),
    available: discovery.agents,
    cwd: effectiveCwd,
  };
}

function createUnstartedResult(
  agent: string,
  task: string,
  step: number | undefined,
  status: "aborted" | "failed",
  errorMessage?: string,
): SingleResult {
  return {
    agent,
    agentSource: "unknown",
    task,
    status,
    exitCode: null,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    },
    errorMessage,
    step,
  };
}

function buildChildArgs(
  agent: AgentConfig,
  task: string,
  defaults: DispatchDefaults,
  promptPath: string | null,
): string[] {
  const args = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) {
    const slash = agent.model.indexOf("/");
    if (slash > 0) {
      args.push("--provider", agent.model.slice(0, slash));
      args.push("--model", agent.model.slice(slash + 1));
    } else {
      args.push("--model", agent.model);
    }
  } else {
    const model = defaults.model;
    const slash = model?.indexOf("/") ?? -1;
    if (slash > 0 && !defaults.provider) {
      args.push("--provider", model!.slice(0, slash));
      args.push("--model", model!.slice(slash + 1));
    } else {
      if (defaults.provider) args.push("--provider", defaults.provider);
      if (model) args.push("--model", model);
    }
    if (defaults.thinking) args.push("--thinking", defaults.thinking);
  }
  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }
  if (promptPath) args.push("--append-system-prompt", promptPath);
  args.push(`Task: ${task}`);
  return args;
}

type OnUpdateCallback = (partial: {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentDetails;
}) => void;

async function runSingleAgent(
  defaults: DispatchDefaults,
  resolved: ResolvedAgent,
  agentName: string,
  task: string,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
  if (signal?.aborted) {
    return createUnstartedResult(
      agentName,
      task,
      step,
      "aborted",
      "Subagent was aborted before starting",
    );
  }
  if (resolved.error) {
    return createUnstartedResult(
      agentName,
      task,
      step,
      "failed",
      resolved.error,
    );
  }
  const agent = resolved.agent;
  if (!agent) {
    const available =
      resolved.available.map((candidate) => `"${candidate.name}"`).join(", ") ||
      "none";
    return createUnstartedResult(
      agentName,
      task,
      step,
      "failed",
      `Unknown agent: "${agentName}". Available agents: ${available}.`,
    );
  }

  const current: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    status: "running",
    exitCode: null,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    },
    model: agent.model ?? defaults.model,
    step,
  };
  const emitUpdate = () => {
    onUpdate?.({
      content: [
        {
          type: "text",
          text: getFinalOutput(current.messages) || "(running...)",
        },
      ],
      details: makeDetails([current]),
    });
  };

  let promptDir: string | null = null;
  let promptPath: string | null = null;
  try {
    if (agent.systemPrompt.trim()) {
      const temp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      promptDir = temp.dir;
      promptPath = temp.filePath;
    }
    const invocation = getAtomInvocation(
      buildChildArgs(agent, task, defaults, promptPath),
    );
    emitUpdate();
    let killed = false;

    await new Promise<void>((resolvePromise) => {
      let buffer = "";
      let settled = false;
      let exited = false;
      let closed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let proc: ReturnType<typeof spawn>;

      const finish = () => {
        if (settled) return;
        settled = true;
        closed = true;
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", abortProcess);
        resolvePromise();
      };
      const abortProcess = () => {
        if (
          closed ||
          exited ||
          proc.exitCode !== null ||
          proc.signalCode !== null
        )
          return;
        if (!proc.kill("SIGTERM")) return;
        killed = true;
        killTimer = setTimeout(() => {
          if (!closed && !exited) proc.kill("SIGKILL");
        }, 5000);
        killTimer.unref?.();
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let record: StreamRecord;
        try {
          record = JSON.parse(line) as StreamRecord;
        } catch {
          return;
        }
        if (record.type === "message_end") {
          current.messages.push(record.message);
          if (record.message.role === "assistant") current.usage.turns++;
          emitUpdate();
        } else if (record.type === "usage") {
          current.usage.input += record.input ?? 0;
          current.usage.output += record.output ?? 0;
          current.usage.cacheRead += record.cacheRead ?? 0;
          current.usage.cacheWrite += record.cacheWrite ?? 0;
          current.usage.cost += record.cost ?? 0;
          if (record.model) current.model = record.model;
        } else if (record.type === "error") {
          current.errorMessage ||= record.error;
        }
      };

      try {
        proc = spawn(invocation.command, invocation.args, {
          cwd: resolved.cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        current.errorMessage = `Failed to spawn subagent: ${error instanceof Error ? error.message : String(error)}`;
        finish();
        return;
      }

      proc.stdout?.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      proc.stderr?.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        current.stderr = (current.stderr + text).slice(-STDERR_CAP);
      });
      proc.on("exit", () => {
        exited = true;
      });
      proc.on("close", (code, terminationSignal) => {
        if (buffer.trim()) processLine(buffer);
        current.exitCode = code;
        current.terminationSignal = terminationSignal ?? undefined;
        finish();
      });
      proc.on("error", (error) => {
        current.errorMessage ||= `Failed to spawn subagent: ${error.message}`;
        finish();
      });
      if (signal) {
        if (signal.aborted) abortProcess();
        else signal.addEventListener("abort", abortProcess, { once: true });
      }
    });

    if (killed || signal?.aborted) {
      current.status = "aborted";
      current.errorMessage ||= "Subagent was aborted";
    } else if (current.terminationSignal) {
      current.status = "failed";
      current.errorMessage ||= `Subagent terminated by signal ${current.terminationSignal}`;
    } else if (current.exitCode !== 0) {
      current.status = "failed";
      current.errorMessage ||= `Subagent exited with code ${current.exitCode}`;
    } else {
      current.status = "completed";
    }
    return current;
  } finally {
    if (promptPath) await unlink(promptPath).catch(() => {});
    if (promptDir) await rmdir(promptDir).catch(() => {});
  }
}

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the agent process" }),
  ),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({
    description: "Task with optional {previous} placeholder for prior output",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the agent process" }),
  ),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({ description: "Name of the agent to invoke (single mode)" }),
  ),
  task: Type.Optional(
    Type.String({ description: "Task to delegate (single mode)" }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, {
      description: "Array of {agent, task} for parallel execution",
    }),
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, {
      description: "Array of {agent, task} for sequential execution",
    }),
  ),
  agentScope: Type.Optional(
    Type.Union(
      [Type.Literal("user"), Type.Literal("project"), Type.Literal("both")],
      {
        description: 'Which agent directories to use. Default: "user".',
        default: "user",
      },
    ),
  ),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description: "Prompt before running project-local agents. Default: true.",
      default: true,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the agent process (single mode)",
    }),
  ),
});

function makeDetails(
  mode: "single" | "parallel" | "chain",
  forceError = false,
) {
  return (results: SingleResult[]): SubagentDetails => ({
    mode,
    results,
    isError: forceError || results.some(isFailedResult),
  });
}

function renderCall(args: Record<string, any>, theme: Theme): Text {
  const scope = (args.agentScope ?? "user") as string;
  const header = (label: string) =>
    theme.fg("toolTitle", theme.bold("subagent ")) +
    theme.fg("accent", label) +
    theme.fg("muted", ` [${scope}]`);
  if (args.chain?.length) {
    let text = header(`chain (${args.chain.length} steps)`);
    for (const [i, step] of args.chain.slice(0, 3).entries()) {
      const task = String(step.task ?? "")
        .replace(/\{previous\}/g, "")
        .trim();
      text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", String(step.agent))} ${theme.fg("dim", task.slice(0, 40))}`;
    }
    return new Text(text, 0, 0);
  }
  if (args.tasks?.length) {
    let text = header(`parallel (${args.tasks.length} tasks)`);
    for (const task of args.tasks.slice(0, 3)) {
      text += `\n  ${theme.fg("accent", String(task.agent))} ${theme.fg("dim", String(task.task).slice(0, 40))}`;
    }
    return new Text(text, 0, 0);
  }
  const preview = String(args.task ?? "").slice(0, 60);
  return new Text(
    `${header(String(args.agent ?? "..."))}\n  ${theme.fg("dim", preview)}`,
    0,
    0,
  );
}

function aggregateUsage(results: SingleResult[]): UsageStats {
  return results.reduce(
    (total, result) => ({
      input: total.input + result.usage.input,
      output: total.output + result.usage.output,
      cacheRead: total.cacheRead + result.usage.cacheRead,
      cacheWrite: total.cacheWrite + result.usage.cacheWrite,
      cost: total.cost + result.usage.cost,
      turns: total.turns + result.usage.turns,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  );
}

function statusLabel(result: SingleResult, theme: Theme): string {
  if (result.status === "running" || result.status === "pending")
    return ` ${theme.fg("warning", `[${result.status}]`)}`;
  if (isFailedResult(result))
    return ` ${theme.fg("error", `[${result.status}]`)}`;
  return "";
}

function resultIcon(result: SingleResult, theme: Theme): string {
  if (result.status === "pending" || result.status === "running") {
    return theme.fg("warning", "⏳");
  }
  if (isFailedResult(result)) return theme.fg("error", "✗");
  return theme.fg("success", "✓");
}

function renderSingleResult(
  result: SingleResult,
  expanded: boolean,
  theme: Theme,
  anyTheme: any,
) {
  const icon = resultIcon(result, theme);
  const items = getDisplayItems(result.messages);
  const output = getFinalOutput(result.messages);
  if (!expanded) {
    let text = `${icon} ${theme.fg("toolTitle", theme.bold(result.agent))}${theme.fg("muted", ` (${result.agentSource})`)}${statusLabel(result, theme)}`;
    if (result.errorMessage)
      text += `\n${theme.fg("error", result.errorMessage)}`;
    if (result.terminationSignal)
      text += `\n${theme.fg("error", `Signal: ${result.terminationSignal}`)}`;
    if (result.stderr.trim())
      text += `\n${theme.fg("error", `stderr: ${result.stderr.trim()}`)}`;
    if (!result.errorMessage && items.length === 0)
      text += `\n${theme.fg("muted", "(no output)")}`;
    else
      text += `\n${items
        .slice(-COLLAPSED_ITEM_COUNT)
        .map((item) =>
          item.type === "text"
            ? theme.fg(
                "toolOutput",
                item.text.split("\n").slice(0, 3).join("\n"),
              )
            : theme.fg("muted", "→ ") +
              formatToolCall(item.name, item.args, theme),
        )
        .join("\n")}`;
    const usage = formatUsageStats(result.usage, result.model);
    if (usage) text += `\n${theme.fg("dim", usage)}`;
    text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
    return new Text(text, 0, 0);
  }

  const container = new Container();
  container.addChild(
    new Text(
      `${icon} ${theme.fg("toolTitle", theme.bold(result.agent))}${theme.fg("muted", ` (${result.agentSource})`)}${statusLabel(result, theme)}`,
      0,
      0,
    ),
  );
  if (result.errorMessage) {
    container.addChild(new Text(theme.fg("error", result.errorMessage), 0, 0));
  }
  if (result.terminationSignal) {
    container.addChild(
      new Text(theme.fg("error", `Signal: ${result.terminationSignal}`), 0, 0),
    );
  }
  if (result.stderr.trim()) {
    container.addChild(
      new Text(theme.fg("error", `stderr: ${result.stderr.trim()}`), 0, 0),
    );
  }
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
  container.addChild(new Text(theme.fg("dim", result.task), 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
  for (const item of items) {
    if (item.type === "toolCall") {
      container.addChild(
        new Text(
          theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme),
          0,
          0,
        ),
      );
    }
  }
  if (output) container.addChild(new Markdown(output.trim(), 0, 0, anyTheme));
  const usage = formatUsageStats(result.usage, result.model);
  if (usage) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", usage), 0, 0));
  }
  return container;
}

function renderResults(
  details: SubagentDetails,
  expanded: boolean,
  theme: Theme,
  anyTheme: any,
) {
  if (details.mode === "single" && details.results.length === 1) {
    return renderSingleResult(details.results[0], expanded, theme, anyTheme);
  }
  const results = details.results;
  const active = results.some(
    (r) => r.status === "running" || r.status === "pending",
  );
  const failures = results.filter(isFailedResult).length;
  const successes = results.length - failures;
  const icon = active
    ? theme.fg("warning", "⏳")
    : failures > 0
      ? theme.fg("warning", "◐")
      : theme.fg("success", "✓");
  const label = details.mode === "chain" ? "chain" : "parallel";
  const running = results.filter((r) => r.status === "running").length;
  const pending = results.filter((r) => r.status === "pending").length;
  const summary = active
    ? `${successes + failures}/${results.length} done, ${running} running, ${pending} pending`
    : `${successes}/${results.length} ${details.mode === "chain" ? "steps" : "tasks"}`;
  if (!expanded) {
    let text = `${icon} ${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("accent", summary)}`;
    for (const result of results) {
      const line = getDisplayItems(result.messages)
        .slice(-5)
        .map((item) =>
          item.type === "text"
            ? theme.fg(
                "toolOutput",
                item.text.split("\n").slice(0, 3).join("\n"),
              )
            : theme.fg("muted", "→ ") +
              formatToolCall(item.name, item.args, theme),
        )
        .join("\n");
      const prefix = details.mode === "chain" ? `Step ${result.step}: ` : "";
      text += `\n\n${theme.fg("muted", `─── ${prefix}`)}${theme.fg("accent", result.agent)} ${resultIcon(result, theme)}`;
      text += `\n${line || (isFailedResult(result) ? theme.fg("error", getFailureEvidence(result)) : theme.fg("muted", "(no output)"))}`;
    }
    const total = formatUsageStats(aggregateUsage(results));
    if (total) text += `\n\n${theme.fg("dim", `Total: ${total}`)}`;
    text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
    return new Text(text, 0, 0);
  }
  const container = new Container();
  container.addChild(
    new Text(
      `${icon} ${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("accent", summary)}`,
      0,
      0,
    ),
  );
  for (const result of results) {
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        `${theme.fg("muted", details.mode === "chain" ? `─── Step ${result.step}: ` : "─── ")}${theme.fg("accent", result.agent)} ${resultIcon(result, theme)}`,
        0,
        0,
      ),
    );
    container.addChild(
      new Text(
        theme.fg("muted", "Task: ") + theme.fg("dim", result.task),
        0,
        0,
      ),
    );
    if (result.errorMessage)
      container.addChild(
        new Text(theme.fg("error", result.errorMessage), 0, 0),
      );
    if (result.terminationSignal)
      container.addChild(
        new Text(
          theme.fg("error", `Signal: ${result.terminationSignal}`),
          0,
          0,
        ),
      );
    if (result.stderr.trim())
      container.addChild(
        new Text(theme.fg("error", `stderr: ${result.stderr.trim()}`), 0, 0),
      );
    for (const item of getDisplayItems(result.messages)) {
      if (item.type === "toolCall")
        container.addChild(
          new Text(
            theme.fg("muted", "→ ") +
              formatToolCall(item.name, item.args, theme),
            0,
            0,
          ),
        );
    }
    const output = getResultOutput(result);
    if (output) container.addChild(new Markdown(output, 0, 0, anyTheme));
    const usage = formatUsageStats(result.usage, result.model);
    if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
  }
  const total = formatUsageStats(aggregateUsage(results));
  if (total) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", `Total: ${total}`), 0, 0));
  }
  return container;
}

export default function (pi: any) {
  pi.on("tool_result", (event: any) => {
    if (event?.name !== "subagent") return;
    if ((event.details as SubagentDetails | undefined)?.isError) {
      return { isError: true };
    }
    return undefined;
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context.",
      "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
      'Default agent scope is "user" (from ~/.pi/agent/agents). Use agentScope: "both" to include project-local agents.',
    ].join(" "),
    parameters: SubagentParams,
    renderCall,
    renderResult(result: any, options: any, theme: Theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content?.[0];
        return new Text(
          text?.type === "text" ? text.text : "(no output)",
          0,
          0,
        );
      }
      return renderResults(details, options?.expanded === true, theme, theme);
    },

    async execute(
      toolCallId: string,
      params: Record<string, any>,
      signal: AbortSignal | undefined,
      onUpdate: OnUpdateCallback | undefined,
      ctx: any,
    ) {
      void toolCallId;
      const agentScope: AgentScope = params.agentScope ?? "user";
      const defaults = inheritDispatchConfig();
      const cwd: string = ctx?.workspace ?? process.cwd();
      const discovery = discoverAgents(cwd, agentScope);
      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
        const available =
          discovery.agents
            .map((agent) => `${agent.name} (${agent.source})`)
            .join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
            },
          ],
          details: makeDetails("single", true)([]),
        };
      }

      if (
        (agentScope === "project" || agentScope === "both") &&
        params.confirmProjectAgents !== false &&
        ctx?.hasUI
      ) {
        const realDir = (path?: string): string | undefined => {
          try {
            return path ? realpathSync(path) : undefined;
          } catch {
            return undefined;
          }
        };
        const selected: Array<{ agent: string; cwd?: string }> = hasChain
          ? params.chain
          : hasTasks
            ? params.tasks
            : [{ agent: params.agent as string, cwd: params.cwd }];
        const selectedAgents = selected
          .map((step): ResolvedAgent =>
            resolveAgent(cwd, agentScope, step.agent, step.cwd),
          )
          .map((resolved): AgentConfig | undefined => resolved.agent)
          .filter(
            (agent): agent is AgentConfig =>
              agent !== undefined && agent.source === "project",
          );
        const trustedDir = ctx.trusted
          ? realDir(discovery.projectAgentsDir ?? undefined)
          : undefined;
        const projectAgents = [
          ...new Map(
            selectedAgents
              .filter(
                (agent) =>
                  !trustedDir ||
                  realDir(dirname(agent.filePath)) !== trustedDir,
              )
              .map((agent) => [agent.filePath, agent]),
          ).values(),
        ];
        if (projectAgents.length > 0) {
          const sources = projectAgents
            .map((agent) => `- ${agent.name}: ${agent.filePath}`)
            .join("\n");
          const ok = await ctx.ui.confirm(
            "Run project-local agents?",
            `Sources:\n${sources}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
          );
          if (!ok) {
            return {
              content: [
                {
                  type: "text",
                  text: "Canceled: project-local agents not approved.",
                },
              ],
              details: makeDetails(
                hasChain ? "chain" : hasTasks ? "parallel" : "single",
              )([]),
            };
          }
        }
      }

      if (hasChain) {
        const results: SingleResult[] = [];
        let previous = "";
        for (const [i, step] of params.chain.entries()) {
          const task = String(step.task).replace(/\{previous\}/g, previous);
          const chainUpdate: OnUpdateCallback | undefined = onUpdate
            ? (partial) => {
                const current = partial.details.results[0];
                if (current)
                  onUpdate({
                    content: partial.content,
                    details: makeDetails("chain")([...results, current]),
                  });
              }
            : undefined;
          const result = await runSingleAgent(
            defaults,
            resolveAgent(cwd, agentScope, step.agent, step.cwd),
            step.agent,
            task,
            i + 1,
            signal,
            chainUpdate,
            makeDetails("chain"),
          );
          results.push(result);
          if (isFailedResult(result)) {
            return {
              content: [
                {
                  type: "text",
                  text: truncateBytes(
                    `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}`,
                    PER_TASK_OUTPUT_CAP,
                  ),
                },
              ],
              details: makeDetails("chain")(results),
            };
          }
          previous = getFinalOutput(result.messages);
        }
        return {
          content: [
            {
              type: "text",
              text:
                getFinalOutput(results[results.length - 1].messages) ||
                "(no output)",
            },
          ],
          details: makeDetails("chain")(results),
        };
      }

      if (hasTasks) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return {
            content: [
              {
                type: "text",
                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
              },
            ],
            details: makeDetails("parallel", true)([]),
          };
        }
        const allResults: SingleResult[] = params.tasks.map((task: any) => ({
          ...createUnstartedResult(task.agent, task.task, undefined, "failed"),
          status: "pending",
          errorMessage: undefined,
        }));
        const emitParallelUpdate = () => {
          if (!onUpdate) return;
          const running = allResults.filter(
            (r) => r.status === "running",
          ).length;
          const pending = allResults.filter(
            (r) => r.status === "pending",
          ).length;
          const done = allResults.length - running - pending;
          onUpdate({
            content: [
              {
                type: "text",
                text: `Parallel: ${done}/${allResults.length} done, ${running} running, ${pending} pending...`,
              },
            ],
            details: makeDetails("parallel")([...allResults]),
          });
        };
        const results = await mapWithConcurrencyLimit(
          params.tasks,
          MAX_CONCURRENCY,
          async (task: any, index: number) => {
            const result = await runSingleAgent(
              defaults,
              resolveAgent(cwd, agentScope, task.agent, task.cwd),
              task.agent,
              task.task,
              undefined,
              signal,
              onUpdate
                ? (partial) => {
                    const current = partial.details.results[0];
                    if (current) {
                      allResults[index] = current;
                      emitParallelUpdate();
                    }
                  }
                : undefined,
              makeDetails("parallel"),
            );
            allResults[index] = result;
            emitParallelUpdate();
            return result;
          },
        );
        const successCount = results.filter(
          (result) => !isFailedResult(result),
        ).length;
        const summaries = results.map(
          (result) =>
            `### [${result.agent}] ${result.status}\n\n${truncateBytes(getResultOutput(result), PER_TASK_OUTPUT_CAP)}`,
        );
        return {
          content: [
            {
              type: "text",
              text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
            },
          ],
          details: makeDetails("parallel")(results),
        };
      }

      const result = await runSingleAgent(
        defaults,
        resolveAgent(cwd, agentScope, params.agent, params.cwd),
        params.agent,
        params.task,
        undefined,
        signal,
        onUpdate,
        makeDetails("single"),
      );
      if (isFailedResult(result)) {
        return {
          content: [
            {
              type: "text",
              text: truncateBytes(
                `Agent ${result.status}: ${getResultOutput(result)}`,
                PER_TASK_OUTPUT_CAP,
              ),
            },
          ],
          details: makeDetails("single")([result]),
        };
      }
      return {
        content: [
          {
            type: "text",
            text: truncateBytes(
              getFinalOutput(result.messages) || "(no output)",
              50 * 1024,
            ),
          },
        ],
        details: makeDetails("single")([result]),
      };
    },
  });
}

export async function test(ctx: any) {
  ctx.assert.equal(
    ctx.tools.length,
    1,
    "subagent extension registers one tool",
  );
  ctx.assert.equal(ctx.tools[0].name, "subagent");
  const result = (await ctx.tools[0].execute("test", {}, undefined, undefined, {
    workspace: process.cwd(),
    hasUI: false,
    ui: {},
  })) as { content: Array<{ text: string }> };
  ctx.assert.match(result.content[0].text, /Invalid parameters/);
}
