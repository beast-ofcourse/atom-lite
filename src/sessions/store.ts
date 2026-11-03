import type { Message } from "../types.js";

export interface Session {
  readonly id: string;
  readonly workspace: string;
  readonly provider: string;
  messages: Message[];
  append(message: Message): void;
}

export class InMemorySession implements Session {
  readonly id: string;
  readonly workspace: string;
  readonly provider: string;
  messages: Message[] = [];

  constructor(id: string, workspace: string, provider = "fake") {
    this.id = id;
    this.workspace = workspace;
    this.provider = provider;
  }

  append(message: Message): void {
    this.messages.push(message);
  }
}