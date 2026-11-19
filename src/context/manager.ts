import type { Message, AgentLimits } from "../types.js";
import type { ProviderAdapter } from "../providers/types.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { INSTRUCTION_NAMES, loadProjectInstructions, statSignature } from "./instructions.js";
import {
  DefaultSkillRegistry,
  skillCacheSignature,
} from "../skills/registry.js";
import { estimateMessageTokens } from "./budget.js";
import {
  buildRepoMap,
  clearRepoMapCache,
  type RepoMapOptions,
} from "./repoMap.js";
import { userConfigDir } from "../config/paths.js";
import { recordModelUsage, type UsageLedger } from "../usage/ledger.js";
import {
  attributeSummaryMessages,
  rememberMessageLayout,
  type AttributionCategory,
} from "./attribution.js";
import {
  renderedInstructionTexts,
  type InstructionBaselineState,
} from "./instruction-baseline.js";
import {
  buildSummaryPrompt,
  CHECKPOINT_SCHEMA_VERSION,
  hasAllSummaryHeadings,
  isOverflowError,
  resolveReserve,
  SHRINK_STEPS,
  splitRecentTail,
  summaryNudge,
  thresholdFromReserve,
  withOlder,
  type MemoryCheckpoint,
  type Reserve,
} from "./checkpoint.js";

export type {
  CompactionStrategy,
  MemoryCheckpoint,
} from "./checkpoint.js";
export { SUMMARY_HEADINGS } from "./checkpoint.js";

export interface ContextManagerOptions {
  systemPrompt: string;
  maxInputTokens: number | null;
  reserveOutputTokens: number;
  compactAtPercent: number;
  maxProjectInstructionBytes: number;
  provider: ProviderAdapter;
  model: string;
  userInstructionsPath?: string;
  compactEveryNTurns?: number;
  /** Optional cheaper summarizer model. Unset means use the active model. */
  compactionModel?: string | null;
  /** Optional per-call usage ledger. Inert when absent. */
  usageLedger?: UsageLedger;
  /** Token budget for the retained recent tail beside a checkpoint. */
  keepTokens?: number;
  /** Compaction reserve: percent string such as "15%", or token count. */
  buffer?: string | number | null;
  /** Optional lifecycle callback for compaction start and failure. */
  onCompactionLifecycle?: (
    phase: "started" | "failed",
    detail: { model: string; strategy: string; reason?: string },
  ) => void;
  /** Prompt-cache layout mode. Off preserves the original message order. */
  cacheMode?: "off" | "automatic" | "explicit";
  /** Resolved repo-map settings. Defaults apply when omitted. */
  repoMap?: RepoMapOptions;
}

/** State the runtime injects every turn and feeds into the summarizer. */
export interface ContextStaticState {
  /** Rendered goal (statement, criteria, status, constraints). */
  goal?: string | null;
  /** Rendered task ledger. */
  ledger?: string | null;
  /** Active file paths from recent tool calls, kept across compaction. */
  files?: string | null;
  /** Structured source for the one-shot post-compaction instruction. */
  continuation?: {
    statement: string;
    criteria: string[];
    currentTodo: string;
    nextAction: string;
  } | null;
}

/** Build the one-shot instruction that follows a compaction. */
export function renderContinuation(
  input: NonNullable<ContextStaticState["continuation"]>,
): string {
  return [
    "Continuation after compaction:",
    `Goal: ${input.statement || "(none)"}`,
    `Success criteria: ${input.criteria.length ? input.criteria.join("; ") : "(none declared)"}`,
    `Current todo: ${input.currentTodo || "(none)"}`,
    `Next action: ${input.nextAction || input.statement || "(none)"}`,
    "Continue this work now. Do not redo completed work or re-ask requests that are already satisfied.",
  ].join("\n");
}

const DEFAULT_MAX_INPUT = 128000;

export class ContextManager {
  private opts: ContextManagerOptions;
  private instructionCache?: { signature: string; text: string[] };
  private discoveredInstructionPaths: string[] = [];
  private skillCache?: { workspace: string; signature: string; index: string };
  private instructionState: InstructionBaselineState | null = null;
  private modelContextWindow: number | undefined;
  private compactedThisBuild = false;
  private toolTokenOverhead = 0;
  private lastReportedUsage: number | undefined;
  private lastBuildTokens = 0;
  private forceCompact = false;
  private buildCount = 0;
  private sessionMemory: string | null = null;
  private sessionMemoryCount = 0;
  private checkpoint: MemoryCheckpoint | null = null;
  private lastCompactionSummary: string | null = null;
  private lastCompactionCoveredCount = 0;
  private lastCompactionCheckpoint: MemoryCheckpoint | null = null;
  private lastCompactionFailure: string | null = null;
  private compactEveryNTurns = 0;
  private reserve: Reserve;
  private staticContext: ContextStaticState | null = null;
  private pendingContinuation: string | null = null;
  private usageContext: { sessionId: string; requestId: string } = {
    sessionId: "",
    requestId: "",
  };

  constructor(opts: ContextManagerOptions) {
    this.opts = opts;
    this.compactEveryNTurns = opts.compactEveryNTurns ?? 0;
    this.reserve = resolveReserve(opts.compactAtPercent, opts.buffer);
  }

  setProvider(provider: ProviderAdapter, model?: string): void {
    this.opts.provider = provider;
    if (model) this.opts.model = model;
  }

  setModelContextWindow(window: number | undefined): void {
    this.modelContextWindow = window;
  }

  setCompactionLifecycleCallback(
    callback: NonNullable<ContextManagerOptions["onCompactionLifecycle"]>,
  ): void {
    this.opts.onCompactionLifecycle = callback;
  }

  getSystemPrompt(): string {
    return this.opts.systemPrompt;
  }

  setSystemPrompt(prompt: string): void {
    this.opts.systemPrompt = prompt;
  }

  /** Register instruction files discovered beside reads. Returns true when any path is new. */
  noteDiscoveredInstructions(paths: string[]): boolean {
    let added = false;
    for (const path of paths) {
      if (this.discoveredInstructionPaths.includes(path)) continue;
      this.discoveredInstructionPaths.push(path);
      added = true;
    }
    return added;
  }

  /** Current instruction text from disk, using the existing stat-signature cache. */
  getInstructionTexts(workspace: string): string[] {
    const userPath =
      this.opts.userInstructionsPath ?? join(userConfigDir(), "AGENTS.md");
    const signature =
      `${workspace}|${this.opts.maxProjectInstructionBytes}|` +
      statSignature([
        userPath,
        ...INSTRUCTION_NAMES.map((name) => join(workspace, name)),
        ...this.discoveredInstructionPaths,
      ]);
    if (this.instructionCache?.signature === signature) {
      return this.instructionCache.text;
    }
    const text = loadProjectInstructions(
      workspace,
      this.opts.maxProjectInstructionBytes,
      userPath,
      this.discoveredInstructionPaths,
    );
    this.instructionCache = { signature, text };
    return text;
  }

  setInstructionState(state: InstructionBaselineState | null): void {
    this.instructionState = state;
  }

  getInstructionState(): InstructionBaselineState | null {
    return this.instructionState;
  }

  /** Drop cached instruction, skill, and repo-map indexes so the next build rescans disk. */
  invalidateCaches(): void {
    this.instructionCache = undefined;
    this.skillCache = undefined;
    clearRepoMapCache();
  }

  setToolTokenOverhead(overhead: number): void {
    if (typeof overhead === "number" && overhead >= 0)
      this.toolTokenOverhead = Math.floor(overhead);
  }

  /** Correlation ids for the next summarizer call issued by this manager. */
  setUsageContext(sessionId: string, requestId: string): void {
    this.usageContext = { sessionId, requestId };
  }

  private rememberLayout(
    messages: Message[],
    categories: AttributionCategory[],
    prefixEnd: number,
    compacted: boolean,
  ): void {
    rememberMessageLayout(messages, {
      categories,
      prefixEnd,
      toolTokenOverhead: this.toolTokenOverhead,
      compacted,
    });
  }

  /** Append the trailing repo map with its attribution to a build's arrays. */
  private pushRepoMap(
    messages: Message[],
    categories: AttributionCategory[],
    repoMapMessages: Message[],
  ): void {
    for (const message of repoMapMessages) {
      messages.push(message);
      categories.push("staticMessages");
    }
  }

  noteUsage(used: number): void {
    if (typeof used === "number" && used > 0) this.lastReportedUsage = used;
  }

  resetUsage(): void {
    this.lastReportedUsage = undefined;
  }

  getLastBuildTokens(): number {
    return this.lastBuildTokens;
  }

  consumeCompaction(): boolean {
    const compacted = this.compactedThisBuild;
    this.compactedThisBuild = false;
    return compacted;
  }

  consumeCompactionSummary(): string | null {
    const summary = this.lastCompactionSummary;
    this.lastCompactionSummary = null;
    return summary;
  }

  consumeCompactionCoveredCount(): number {
    const count = this.lastCompactionCoveredCount;
    this.lastCompactionCoveredCount = 0;
    return count;
  }

  getLastCompactionCoveredCount(): number {
    return this.lastCompactionCoveredCount;
  }

  /** Versioned memory checkpoint produced by the latest compaction. */
  getLastCompactionCheckpoint(): MemoryCheckpoint | null {
    return this.lastCompactionCheckpoint;
  }

  consumeCompactionCheckpoint(): MemoryCheckpoint | null {
    const checkpoint = this.lastCompactionCheckpoint;
    this.lastCompactionCheckpoint = null;
    return checkpoint;
  }

  /** Reason the latest summary failed validation, if any. */
  consumeCompactionFailure(): string | null {
    const failure = this.lastCompactionFailure;
    this.lastCompactionFailure = null;
    return failure;
  }

  /** Replace the goal/ledger context injected into builds and summaries. */
  setStaticContext(context: ContextStaticState | null): void {
    this.staticContext = context;
  }

  /** Continuation text derived from the current static context, if any. */
  getContinuation(): string | null {
    return this.staticContext?.continuation
      ? renderContinuation(this.staticContext.continuation)
      : null;
  }

  consumeCompactionContinuation(): string | null {
    const text = this.pendingContinuation;
    this.pendingContinuation = null;
    return text;
  }

  private staticMessages(): Message[] {
    const messages: Message[] = [];
    if (this.staticContext?.goal) {
      messages.push({ role: "system", content: this.staticContext.goal });
    }
    if (this.staticContext?.ledger) {
      messages.push({ role: "system", content: this.staticContext.ledger });
    }
    if (this.staticContext?.files) {
      messages.push({
        role: "system",
        content: `Active files:\n${this.staticContext.files}`,
      });
    }
    return messages;
  }

  setSessionMemory(
    summary: string | null,
    coveredCount?: number,
    checkpoint?: MemoryCheckpoint | null,
  ): void {
    this.sessionMemory = summary;
    if (summary === null) {
      this.sessionMemoryCount = 0;
      this.checkpoint = null;
      return;
    }
    if (typeof coveredCount === "number" && coveredCount >= 0) {
      this.sessionMemoryCount = coveredCount;
    }
    this.checkpoint = checkpoint ?? {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      summary,
      coveredCount: this.sessionMemoryCount,
      coveredTokens: 0,
      keptCount: 0,
      model: this.opts.model,
      strategy: "summary",
    };
  }

  getSessionMemory(): string | null {
    return this.sessionMemory;
  }

  getSessionCheckpoint(): MemoryCheckpoint | null {
    return this.checkpoint;
  }

  setForceCompact(force: boolean): void {
    this.forceCompact = force;
  }

  getCompactEveryNTurns(): number {
    return this.compactEveryNTurns;
  }

  async compactHistory(
    _workspace: string,
    history: Message[],
    focus?: string,
  ): Promise<string | null> {
    this.lastCompactionFailure = null;
    const split = withOlder(
      splitRecentTail(
        history,
        this.opts.keepTokens ?? 15000,
        Math.floor(this.budget() * 0.4),
      ),
    );
    if (split.older.length === 0) return null;
    const result = await this.summarize(split.older, focus);
    if (!result) return null;
    const coveredCount = this.sessionMemoryCount + split.older.length;
    const coveredTokens = split.older.reduce(
      (sum, message) => sum + estimateMessageTokens(message),
      0,
    );
    const checkpoint: MemoryCheckpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      summary: result.summary,
      coveredCount,
      coveredTokens,
      keptCount: split.keptCount,
      model: this.opts.compactionModel || this.opts.model,
      strategy: "summary",
      ...(result.usage ? { usage: result.usage } : {}),
    };
    this.sessionMemory = result.summary;
    this.sessionMemoryCount = coveredCount;
    this.checkpoint = checkpoint;
    this.lastCompactionSummary = result.summary;
    this.lastCompactionCoveredCount = coveredCount;
    this.lastCompactionCheckpoint = checkpoint;
    this.pendingContinuation = this.getContinuation();
    return result.summary;
  }

  private budget(): number {
    // If no window has been resolved yet, do not compact prematurely on the
    // 128K default; wait for the real (possibly 1M) window to arrive.
    if (
      this.opts.maxInputTokens === null &&
      this.modelContextWindow === undefined
    ) {
      return 10_000_000;
    }
    const max =
      this.opts.maxInputTokens ?? this.modelContextWindow ?? DEFAULT_MAX_INPUT;
    return Math.max(1000, max - this.opts.reserveOutputTokens);
  }

  private threshold(): number {
    return thresholdFromReserve(this.budget(), this.reserve);
  }

  private async summarize(
    older: Message[],
    focus?: string,
  ): Promise<{ summary: string; usage?: { input?: number; output?: number } } | null> {
    // Bound the summarizer input so a huge history cannot make the
    // summarization request itself exceed the model window.
    const capChars = Math.max(4000, Math.floor(this.budget() * 4 * 0.6));
    const maxToolChars = 4000;
    const contentText = (message: Message): string => {
      const content = (message as any).content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((part: any) =>
            part?.type === "text" ? String(part.text ?? "") : "",
          )
          .join("");
      }
      return "";
    };
    const isFileRead = (message: Message): boolean =>
      (message as any).role === "tool" &&
      /^read$/i.test(String((message as any).name ?? ""));

    // Drop an earlier file read when a later read already carries the same
    // content. Keep the later copy so the newest state survives.
    const seenReads = new Set<string>();
    const deduped: Message[] = [];
    for (let i = older.length - 1; i >= 0; i--) {
      const message = older[i];
      if (isFileRead(message)) {
        const text = contentText(message);
        if (text && seenReads.has(text)) {
          deduped.push({
            role: "tool",
            toolCallId: (message as any).toolCallId,
            name: "read",
            content: "[duplicate file read omitted]",
          } as any);
          continue;
        }
        if (text) seenReads.add(text);
      }
      deduped.push(message);
    }
    deduped.reverse();

    const clipped = deduped.map((m) => {
      try {
        const json = JSON.stringify(m);
        if (json.length <= 2000) return m;
        if ((m as any).role === "tool") {
          const text = contentText(m);
          if (text.length > maxToolChars) {
            return {
              ...m,
              content: text.slice(0, maxToolChars) + "...[truncated]",
            } as any;
          }
          return m;
        }
        return { role: (m as any).role, content: "[truncated]" } as any;
      } catch {
        return m;
      }
    });
    let serialized = JSON.stringify(clipped);
    if (serialized.length > capChars) {
      serialized = serialized.slice(0, capChars) + "...[truncated]";
    }
    const instructionRetention = this.instructionState
      ? `Project instructions:\n${renderedInstructionTexts(
          this.instructionState,
        ).join("\n\n")}`
      : null;
    const retention = [
      instructionRetention,
      this.staticContext?.goal,
      this.staticContext?.ledger,
      this.staticContext?.files
        ? `Active files:\n${this.staticContext.files}`
        : null,
    ]
      .filter(Boolean)
      .join("\n\n");
    const model = this.opts.compactionModel || this.opts.model;
    this.opts.onCompactionLifecycle?.("started", {
      model,
      strategy: "summary",
    });
    let usage: { input?: number; output?: number } | undefined;
    const deliver = async (prompt: string, body: string): Promise<string> => {
      const summaryReq = {
        model,
        messages: [
          ...(retention
            ? [
                {
                  role: "system" as const,
                  content: `Retain this state verbatim in the summary:\n${retention}`,
                },
              ]
            : []),
          { role: "system" as const, content: prompt },
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: body }],
          },
        ],
        tools: [],
      };
      const resp = await this.opts.provider.generate(summaryReq as any);
      recordModelUsage(
        this.opts.usageLedger,
        {
          sessionId: this.usageContext.sessionId,
          requestId: this.usageContext.requestId,
          provider: this.opts.provider.id,
          model,
          attribution: attributeSummaryMessages(summaryReq.messages as any),
          compacted: true,
        },
        resp.usage,
      );
      if (resp.usage) {
        usage = {
          ...(resp.usage.input !== undefined ? { input: resp.usage.input } : {}),
          ...(resp.usage.output !== undefined
            ? { output: resp.usage.output }
            : {}),
        };
      }
      return (
        resp.message.content
          ?.map((p: any) => (p.type === "text" ? p.text : ""))
          .join("") ?? ""
      );
    };
    const call = async (prompt: string): Promise<string> => {
      for (const step of [1, ...SHRINK_STEPS]) {
        const body =
          step === 1
            ? serialized
            : serialized.slice(0, Math.floor(serialized.length * step)) +
              "...[truncated]";
        try {
          return await deliver(prompt, body);
        } catch (error) {
          if (!isOverflowError(error) || step === SHRINK_STEPS.at(-1)) throw error;
        }
      }
      return "";
    };
    const previous = this.checkpoint?.summary ?? null;
    let summaryText: string;
    try {
      summaryText = await call(buildSummaryPrompt({ focus, previous }));
      if (!hasAllSummaryHeadings(summaryText)) {
        summaryText = await call(
          `${summaryNudge()}\n${buildSummaryPrompt({ focus, previous })}`,
        );
        if (!hasAllSummaryHeadings(summaryText)) {
          return this.failCompaction("summary missing required headings");
        }
      }
    } catch {
      return this.failCompaction("summary request failed");
    }
    if (!summaryText) {
      return this.failCompaction("empty summary");
    }
    return { summary: summaryText, usage };
  }

  private failCompaction(reason: string): null {
    this.lastCompactionFailure = reason;
    this.opts.onCompactionLifecycle?.("failed", {
      model: this.opts.compactionModel || this.opts.model,
      strategy: "summary",
      reason,
    });
    return null;
  }

  async build(workspace: string, history: Message[]): Promise<Message[]> {
    this.compactedThisBuild = false;
    this.lastCompactionSummary = null;
    this.lastCompactionCheckpoint = null;
    this.lastCompactionFailure = null;
    this.pendingContinuation = null;
    const instructions = this.instructionState
      ? renderedInstructionTexts(this.instructionState)
      : this.getInstructionTexts(workspace);

    const skillSignature = skillCacheSignature(workspace);
    let skillIndex: string;
    if (
      this.skillCache?.workspace === workspace &&
      this.skillCache.signature === skillSignature
    ) {
      skillIndex = this.skillCache.index;
    } else {
      const registry = new DefaultSkillRegistry(workspace);
      skillIndex = registry.indexText();
      this.skillCache = {
        workspace,
        signature: skillSignature,
        index: skillIndex,
      };
    }
    const systemPrompt = skillIndex
      ? `${this.opts.systemPrompt}\n\n${skillIndex}`
      : this.opts.systemPrompt;

    // The repo map is a trailing system message, never part of the base system
    // prompt, so the prompt-cache prefix stays stable. It is injected from the
    // same computation in both the normal and compacted builds below.
    const repoMapText = buildRepoMap(
      workspace,
      this.opts.repoMap,
      estimateMessageTokens,
    );
    const repoMapMessages: Message[] = repoMapText
      ? [{ role: "system", content: repoMapText }]
      : [];

    this.buildCount++;
    const periodic =
      this.compactEveryNTurns > 0 &&
      this.buildCount % this.compactEveryNTurns === 0;

    // Restore persisted session memory by injecting it and trimming the
    // replayed tail, so resumed long sessions stay compact.
    let workingHistory = history;
    if (this.sessionMemory) {
      const start = Math.min(this.sessionMemoryCount, history.length);
      workingHistory = history.slice(start);
      if (workingHistory.length === 0) {
        workingHistory = history.slice(-Math.min(6, history.length));
      }
    }

    const statics = this.staticMessages();
    const instructionMessages: Message[] = instructions.map((content) => ({
      role: "system",
      content,
    }));
    const memoryMessages: Message[] = this.sessionMemory
      ? [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `Context summary from previous compaction:\n${this.sessionMemory}`,
              },
            ],
          },
        ]
      : [];
    const cached = this.opts.cacheMode !== "off";
    const messages: Message[] = [{ role: "system", content: systemPrompt }];
    const categories: AttributionCategory[] = ["systemPrompt"];
    // Loop instead of spread: very long histories would exceed V8's
    // max-arguments limit in messages.push(...workingHistory).
    if (cached) {
      // Stable prefix first; volatile goal/ledger/files and project
      // instructions move to a trailing section so the prefix stays
      // byte-identical across turns within a session.
      for (const m of memoryMessages) {
        messages.push(m);
        categories.push("sessionMemory");
      }
      for (const m of workingHistory) {
        messages.push(m);
        categories.push("history");
      }
      for (const m of statics) {
        messages.push(m);
        categories.push("staticMessages");
      }
      for (const m of instructionMessages) {
        messages.push(m);
        categories.push("projectInstructions");
      }
      this.pushRepoMap(messages, categories, repoMapMessages);
    } else {
      for (const m of statics) {
        messages.push(m);
        categories.push("staticMessages");
      }
      for (const m of instructionMessages) {
        messages.push(m);
        categories.push("projectInstructions");
      }
      for (const m of memoryMessages) {
        messages.push(m);
        categories.push("sessionMemory");
      }
      for (const m of workingHistory) {
        messages.push(m);
        categories.push("history");
      }
      this.pushRepoMap(messages, categories, repoMapMessages);
    }
    const prefixEnd = cached
      ? 1 + memoryMessages.length + workingHistory.length
      : 0;
    const total =
      messages.reduce((s, m) => s + estimateMessageTokens(m), 0) +
      this.toolTokenOverhead;
    const threshold = this.threshold();
    const pressureFromEstimate = total > threshold;
    const pressureFromUsage =
      this.lastReportedUsage !== undefined &&
      this.lastReportedUsage > threshold;
    const overThreshold =
      (pressureFromEstimate || pressureFromUsage) && workingHistory.length > 1;

    if (!this.forceCompact && !periodic && !overThreshold) {
      this.lastBuildTokens = total;
      this.rememberLayout(messages, categories, prefixEnd, false);
      return messages;
    }
    this.forceCompact = false;

    // Keep the newest messages that fit the keep budget, bounded by 40% of the
    // usable window, and start the tail on a user message.
    const budget = this.budget();
    const split = withOlder(
      splitRecentTail(
        workingHistory,
        this.opts.keepTokens ?? 15000,
        Math.floor(budget * 0.4),
      ),
    );
    const recent = split.recent;
    const older = split.older;
    if (older.length === 0) {
      this.forceCompact = false;
      this.lastBuildTokens = total;
      this.rememberLayout(messages, categories, prefixEnd, false);
      return messages;
    }

    const result = await this.summarize(older);
    if (!result) {
      // Validation failure leaves prior session memory intact.
      this.forceCompact = false;
      this.lastBuildTokens = total;
      this.rememberLayout(messages, categories, prefixEnd, false);
      return messages;
    }
    const summary = result.summary;
    const coveredCount = this.sessionMemoryCount + older.length;
    const coveredTokens = older.reduce(
      (sum, message) => sum + estimateMessageTokens(message),
      0,
    );
    const checkpoint: MemoryCheckpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      summary,
      coveredCount,
      coveredTokens,
      keptCount: split.keptCount,
      model: this.opts.compactionModel || this.opts.model,
      strategy: "summary",
      ...(result.usage ? { usage: result.usage } : {}),
    };
    this.lastCompactionSummary = summary;
    this.lastCompactionCheckpoint = checkpoint;
    this.sessionMemory = summary;
    this.sessionMemoryCount = coveredCount;
    this.checkpoint = checkpoint;
    this.lastCompactionCoveredCount = coveredCount;
    this.compactedThisBuild = true;
    this.lastReportedUsage = undefined;

    const continuation = this.getContinuation();
    this.pendingContinuation = continuation;
    const compactedMemory: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: `Context summary: ${summary}` }],
      },
      ...(continuation
        ? [{ role: "system" as const, content: continuation }]
        : []),
    ];
    const compactedStatics: Message[] = statics;
    const compactedInstructions: Message[] = instructionMessages;
    const compacted: Message[] = [{ role: "system", content: systemPrompt }];
    const compactedCategories: AttributionCategory[] = ["systemPrompt"];
    if (cached) {
      for (const m of compactedMemory) {
        compacted.push(m);
        compactedCategories.push("sessionMemory");
      }
      for (const m of recent) {
        compacted.push(m);
        compactedCategories.push("history");
      }
      for (const m of compactedStatics) {
        compacted.push(m);
        compactedCategories.push("staticMessages");
      }
      for (const m of compactedInstructions) {
        compacted.push(m);
        compactedCategories.push("projectInstructions");
      }
      this.pushRepoMap(compacted, compactedCategories, repoMapMessages);
    } else {
      for (const m of compactedStatics) {
        compacted.push(m);
        compactedCategories.push("staticMessages");
      }
      for (const m of compactedInstructions) {
        compacted.push(m);
        compactedCategories.push("projectInstructions");
      }
      for (const m of compactedMemory) {
        compacted.push(m);
        compactedCategories.push("sessionMemory");
      }
      for (const m of recent) {
        compacted.push(m);
        compactedCategories.push("history");
      }
      this.pushRepoMap(compacted, compactedCategories, repoMapMessages);
    }
    // Final value only; the intermediate assign was dead work.
    this.lastBuildTokens =
      compacted.reduce((s, m) => s + estimateMessageTokens(m), 0) +
      this.toolTokenOverhead;
    this.rememberLayout(
      compacted,
      compactedCategories,
      cached ? 1 + compactedMemory.length + recent.length : 0,
      true,
    );
    return compacted;
  }
}
