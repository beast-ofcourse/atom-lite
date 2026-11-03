import type { Message } from "../types.js";

export interface BuildContextParams {
  systemPrompt: string;
  projectInstructions: string[];
  history: Message[];
}

export function buildMessages(params: BuildContextParams): Message[] {
  const messages: Message[] = [{ role: "system", content: params.systemPrompt }];
  for (const instr of params.projectInstructions) {
    messages.push({ role: "system", content: instr });
  }
  messages.push(...params.history);
  return messages;
}