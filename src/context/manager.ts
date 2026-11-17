import type { Message, AgentLimits } from "../types.js";
import type { ProviderAdapter } from "../providers/types.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadProjectInstructions, statSignature } from "./instructions.js";
import {
  DefaultSkillRegistry,
  skillCacheSignature,
} from "../skills/registry.js";
import { estimateMessageTokens } from "./budget.js";
import { userConfigDir } from "../config/paths.js";
import { recordModelUsage, type UsageLedger } from "../usage/ledger.js";

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
  private skillCache?: { workspace: string; signature: string; index: string };
  private modelContextWindow: number | undefined;
  private compactedThisBuild = false;
  private toolTokenOverhead = 0;
  private lastReportedUsage: number | undefined;
  private lastBuildTokens = 0;
  private forceCompact = false;
  private buildCount = 0;
  private sessionMemory: string | null = null;
  private sessionMemoryCount = 0;
  private lastCompactionSummary: string | null = null;
  private lastCompactionCoveredCount = 0;
  private compactEveryNTurns = 0;
  private staticContext: ContextStaticState | null = null;
  private pendingContinuation: string | null = null;
  private usageContext: { sessionId: string; requestId: string } = {
    sessionId: "",
    requestId: "",
  };

  constructor(opts: ContextManagerOptions) {
    this.opts = opts;
    this.compactEveryNTurns = opts.compactEveryNTurns ?? 0;
  }

  setProvider(provider: ProviderAdapter, model?: string): void {
    this.opts.provider = provider;
    if (model) this.opts.model = model;
  }

  setModelContextWindow(window: number | undefined): void {
    this.modelContextWindow = window;
  }

  getSystemPrompt(): string {
    return this.opts.systemPrompt;
  }

  setSystemPrompt(prompt: string): void {
    this.opts.systemPrompt = prompt;
  }

  /** Drop cached instruction and skill indexes so the next build rescans disk. */
  invalidateCaches(): void {
    this.instructionCache = undefined;
    this.skillCache = undefined;
  }

  setToolTokenOverhead(overhead: number): void {
    if (typeof overhead === "number" && overhead >= 0)
      this.toolTokenOverhead = Math.floor(overhead);
  }

  /** Correlation ids for the next summarizer call issued by this manager. */
  setUsageContext(sessionId: string, requestId: string): void {
    this.usageContext = { sessionId, requestId };
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

  setSessionMemory(summary: string | null, coveredCount?: number): void {
    this.sessionMemory = summary;
    if (summary === null) {
      this.sessionMemoryCount = 0;
    } else if (typeof coveredCount === "number" && coveredCount >= 0) {
      this.sessionMemoryCount = coveredCount;
    }
  }

  getSessionMemory(): string | null {
    return this.sessionMemory;
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
    const keep = Math.min(6, Math.max(1, history.length - 1));
    const older = history.slice(0, history.length - keep);
    if (older.length === 0) return null;
    const summary = await this.summarize(older, focus);
    const coveredCount = history.length - keep;
    this.sessionMemory = summary;
    this.sessionMemoryCount = coveredCount;
    this.lastCompactionSummary = summary;
    this.lastCompactionCoveredCount = coveredCount;
    this.pendingContinuation = this.getContinuation();
    return summary;
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
    return Math.floor(this.budget() * (this.opts.compactAtPercent / 100));
  }

  private async summarize(older: Message[], focus?: string): Promise<string> {
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
    const retention = [
      this.staticContext?.goal,
      this.staticContext?.ledger,
      this.staticContext?.files
        ? `Active files:\n${this.staticContext.files}`
        : null,
    ]
      .filter(Boolean)
      .join("\n\n");
    let summaryText = "";
    try {
      const focusLine = focus ? `\nFocus the summary on: ${focus}` : "";
      const summaryReq = {
        model: this.opts.compactionModel || this.opts.model,
        messages: [
          ...(retention
            ? [
                {
                  role: "system" as const,
                  content: `Retain this state verbatim in the summary:\n${retention}`,
                },
              ]
            : []),
          {
            role: "system" as const,
            content:
              "Summarize the following conversation history compactly. Retain: (1) every user-assigned task and its acceptance criteria, marking completed vs pending; (2) the current task and the next action; (3) files touched and their last known state (paths with a brief change summary); (4) decisions, constraints, and rejected approaches; (5) verification commands and their results. Never drop an open task or a user constraint. Drop: full tool outputs and intermediate reasoning. Output only the summary." +
              focusLine,
          },
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: serialized }],
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
          model: this.opts.compactionModel || this.opts.model,
        },
        resp.usage,
      );
      summaryText =
        resp.message.content
          ?.map((p: any) => (p.type === "text" ? p.text : ""))
          .join("") ?? "";
    } catch {
      summaryText = "";
    }
    if (!summaryText) {
      summaryText = "[Earlier conversation truncated to fit context budget.]";
    }
    return summaryText;
  }

  async build(workspace: string, history: Message[]): Promise<Message[]> {
    this.compactedThisBuild = false;
    this.lastCompactionSummary = null;
    this.pendingContinuation = null;
    const userPath =
      this.opts.userInstructionsPath ?? join(userConfigDir(), "AGENTS.md");
    const instructionSignature =
      `${workspace}|${this.opts.maxProjectInstructionBytes}|` +
      statSignature([
        userPath,
        join(workspace, "AGENTS.md"),
        join(workspace, "CLAUDE.md"),
      ]);
    let instructions: string[];
    if (this.instructionCache?.signature === instructionSignature) {
      instructions = this.instructionCache.text;
    } else {
      instructions = loadProjectInstructions(
        workspace,
        this.opts.maxProjectInstructionBytes,
        userPath,
      );
      this.instructionCache = {
        signature: instructionSignature,
        text: instructions,
      };
    }

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

    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      ...this.staticMessages(),
    ];
    for (const instr of instructions) {
      messages.push({ role: "system", content: instr });
    }
    if (this.sessionMemory) {
      messages.push({
        role: "assistant",
        content: [
          {
            type: "text",
            text: `Context summary from previous compaction:\n${this.sessionMemory}`,
          },
        ],
      });
    }
    // Loop instead of spread: very long histories would exceed V8's
    // max-arguments limit in messages.push(...workingHistory).
    for (const m of workingHistory) messages.push(m);
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
      return messages;
    }
    this.forceCompact = false;

    // Keep as many recent messages as fit in ~40% of the budget so a single
    // huge tool result cannot force an uncompactable tail.
    const budget = this.budget();
    const recentCap = Math.floor(budget * 0.4);
    const maxKeep = Math.max(1, Math.min(6, workingHistory.length - 1));
    let keep = 0;
    let acc = 0;
    for (let i = workingHistory.length - 1; i >= 0; i--) {
      const cost = estimateMessageTokens(workingHistory[i]);
      if (keep > 0 && acc + cost > recentCap) break;
      acc += cost;
      keep++;
      if (keep >= maxKeep) break;
    }
    if (keep < 1) keep = 1;
    const recent = workingHistory.slice(-keep);
    const older = workingHistory.slice(0, workingHistory.length - keep);
    if (older.length === 0) {
      this.forceCompact = false;
      this.lastBuildTokens = total;
      return messages;
    }

    const summary = await this.summarize(older);
    const coveredCount = this.sessionMemoryCount + older.length;
    this.lastCompactionSummary = summary;
    this.sessionMemory = summary;
    this.sessionMemoryCount = coveredCount;
    this.lastCompactionCoveredCount = coveredCount;
    this.compactedThisBuild = true;
    this.lastReportedUsage = undefined;

    const continuation = this.getContinuation();
    this.pendingContinuation = continuation;
    const compacted: Message[] = [
      { role: "system", content: systemPrompt },
      ...this.staticMessages(),
      ...instructions.map((i) => ({ role: "system" as const, content: i })),
      {
        role: "assistant",
        content: [{ type: "text", text: `Context summary: ${summary}` }],
      },
      ...(continuation
        ? [{ role: "system" as const, content: continuation }]
        : []),
      ...recent,
    ];
    // Final value only; the intermediate assign was dead work.
    this.lastBuildTokens =
      compacted.reduce((s, m) => s + estimateMessageTokens(m), 0) +
      this.toolTokenOverhead;
    return compacted;
  }
}
