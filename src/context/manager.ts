import type { Message, AgentLimits } from "../types.js";
import type { ProviderAdapter } from "../providers/types.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadProjectInstructions, statSignature } from "./instructions.js";
import { DefaultSkillRegistry, skillCacheSignature } from "../skills/registry.js";
import { estimateMessageTokens } from "./budget.js";

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
}

const DEFAULT_MAX_INPUT = 128000;

export class ContextManager {
  private opts: ContextManagerOptions;
  private instructionCache?: { signature: string; text: string[] };
  private skillCache?: { workspace: string; signature: string; index: string };
  private modelContextWindow: number | undefined;
  private compactedThisBuild = false;
  private forceCompact = false;
  private buildCount = 0;
  private sessionMemory: string | null = null;
  private lastCompactionSummary: string | null = null;
  private compactEveryNTurns = 0;

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

  setSessionMemory(summary: string | null): void {
    this.sessionMemory = summary;
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
    const keep = Math.min(6, history.length);
    const older = history.slice(0, history.length - keep);
    if (older.length === 0) return null;
    const summary = await this.summarize(older, focus);
    this.sessionMemory = summary;
    this.lastCompactionSummary = summary;
    return summary;
  }

  private budget(): number {
    const max =
      this.opts.maxInputTokens ?? this.modelContextWindow ?? DEFAULT_MAX_INPUT;
    return Math.max(1000, max - this.opts.reserveOutputTokens);
  }

  private threshold(): number {
    return Math.floor(this.budget() * (this.opts.compactAtPercent / 100));
  }

  private async summarize(
    older: Message[],
    focus?: string,
  ): Promise<string> {
    let summaryText = "";
    try {
      const focusLine = focus
        ? `\nFocus the summary on: ${focus}`
        : "";
      const summaryReq = {
        model: this.opts.model,
        messages: [
          {
            role: "system" as const,
            content:
              "Summarize the following conversation history compactly, preserving changed files, decisions, failing tests, and unfinished work. Output only the summary." +
              focusLine,
          },
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: JSON.stringify(older) }],
          },
        ],
        tools: [],
      };
      const resp = await this.opts.provider.generate(summaryReq as any);
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
    const userPath = this.opts.userInstructionsPath ?? join(homedir(), ".config", "atom-lite", "AGENTS.md");
    const instructionSignature =
      `${this.opts.maxProjectInstructionBytes}|` +
      statSignature([userPath, join(workspace, "AGENTS.md")]);
    let instructions: string[];
    if (this.instructionCache?.signature === instructionSignature) {
      instructions = this.instructionCache.text;
    } else {
      instructions = loadProjectInstructions(
        workspace,
        this.opts.maxProjectInstructionBytes,
        userPath,
      );
      this.instructionCache = { signature: instructionSignature, text: instructions };
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
      this.skillCache = { workspace, signature: skillSignature, index: skillIndex };
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
    if (this.sessionMemory && history.length > 6) {
      workingHistory = history.slice(-6);
    }

    const messages: Message[] = [{ role: "system", content: systemPrompt }];
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
    messages.push(...workingHistory);

    const total = messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
    const overThreshold =
      total > this.threshold() && workingHistory.length > 6;

    if (!this.forceCompact && !periodic && !overThreshold) {
      return messages;
    }
    this.forceCompact = false;

    const keep = Math.min(6, workingHistory.length);
    const recent = workingHistory.slice(-keep);
    const older = workingHistory.slice(0, workingHistory.length - keep);
    if (older.length === 0) return messages;

    const summary = await this.summarize(older);
    this.lastCompactionSummary = summary;
    this.sessionMemory = summary;
    this.compactedThisBuild = true;

    const compacted: Message[] = [
      { role: "system", content: systemPrompt },
      ...instructions.map((i) => ({ role: "system" as const, content: i })),
      {
        role: "assistant",
        content: [{ type: "text", text: `Context summary: ${summary}` }],
      },
      ...recent,
    ];
    return compacted;
  }
}
