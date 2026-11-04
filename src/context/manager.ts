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
}

const DEFAULT_MAX_INPUT = 128000;

export class ContextManager {
  private opts: ContextManagerOptions;
  private instructionCache?: { signature: string; text: string[] };
  private skillCache?: { workspace: string; signature: string; index: string };
  private modelContextWindow: number | undefined;
  private compactedThisBuild = false;

  constructor(opts: ContextManagerOptions) {
    this.opts = opts;
  }

  /** Update the provider/model used for compaction after a switch. */
  setProvider(provider: ProviderAdapter, model?: string): void {
    this.opts.provider = provider;
    if (model) this.opts.model = model;
  }

  /** Use the selected model's real window unless the user pinned a budget. */
  setModelContextWindow(window: number | undefined): void {
    this.modelContextWindow = window;
  }

  /** True once if the most recent build compacted history. */
  consumeCompaction(): boolean {
    const compacted = this.compactedThisBuild;
    this.compactedThisBuild = false;
    return compacted;
  }

  private budget(): number {
    const max =
      this.opts.maxInputTokens ?? this.modelContextWindow ?? DEFAULT_MAX_INPUT;
    return Math.max(1000, max - this.opts.reserveOutputTokens);
  }

  private threshold(): number {
    return Math.floor(this.budget() * (this.opts.compactAtPercent / 100));
  }

  async build(workspace: string, history: Message[]): Promise<Message[]> {
    this.compactedThisBuild = false;
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
    const messages: Message[] = [{ role: "system", content: systemPrompt }];
    for (const instr of instructions) {
      messages.push({ role: "system", content: instr });
    }
    messages.push(...history);

    const total = messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
    if (total <= this.threshold()) return messages;

    // Compact: keep last 6 messages verbatim, summarize the rest.
    const keep = Math.min(6, history.length);
    const recent = history.slice(-keep);
    const older = history.slice(0, history.length - keep);
    if (older.length === 0) return messages;

    let summaryText = "";
    try {
      const summaryReq = {
        model: this.opts.model,
        messages: [
          {
            role: "system" as const,
            content:
              "Summarize the following conversation history compactly, preserving changed files, decisions, failing tests, and unfinished work. Output only the summary.",
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
      // Fallback: truncate old tool output with marker.
      summaryText = "[Earlier conversation truncated to fit context budget.]";
    }

    this.compactedThisBuild = true;
    const compacted: Message[] = [
      { role: "system", content: this.opts.systemPrompt },
      ...instructions.map((i) => ({ role: "system" as const, content: i })),
      {
        role: "assistant",
        content: [{ type: "text", text: `Context summary: ${summaryText}` }],
      },
      ...recent,
    ];
    return compacted;
  }
}
