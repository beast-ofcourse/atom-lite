export interface CommandContext {
  session: any;
  content: any;
  appendLine: (t: string) => void;
  clearContent: () => void;
  runtime: any;
  approvals: any;
  store: any;
  provider: any;
  modelOverride?: string;
  effortLevel: { value: string };
  setEffort: (v: string) => void;
  updateStatus: () => void;
  runDoctor: () => Promise<string>;
}

export const SLASH_COMMANDS = [
  "/help",
  "/model",
  "/session",
  "/compact",
  "/clear",
  "/approval",
  "/doctor",
  "/effort",
  "/exit",
];

export async function handleSlashCommand(trimmed: string, ctx: CommandContext): Promise<boolean> {
  if (trimmed === "/exit") {
    return true; // caller handles exit
  }
  if (trimmed === "/help") {
    ctx.appendLine(SLASH_COMMANDS.join("\n"));
    return true;
  }
  if (trimmed === "/session") {
    ctx.appendLine(
      `session: ${ctx.session.id}\nworkspace: ${ctx.session.workspace}\nprovider: ${ctx.session.provider}\nmessages: ${ctx.session.messages.length}`,
    );
    return true;
  }
  if (trimmed === "/approval") {
    ctx.appendLine(`approval mode: ${ctx.approvals.mode}\ntrusted this session: ${ctx.approvals.isTrusted()}`);
    return true;
  }
  if (trimmed === "/doctor") {
    const out = await ctx.runDoctor();
    ctx.appendLine(out);
    return true;
  }
  if (trimmed === "/clear") {
    ctx.session.messages.length = 0;
    ctx.clearContent();
    ctx.appendLine("started new session");
    return true;
  }
  if (trimmed === "/compact") {
    ctx.appendLine("compaction is automatic");
    return true;
  }
  if (trimmed.startsWith("/model")) {
    ctx.appendLine("model switching at safe boundaries is not implemented in this skeleton");
    return true;
  }
  if (trimmed.startsWith("/effort")) {
    const lvl = trimmed.split(/\s+/)[1];
    if (lvl === "low" || lvl === "medium" || lvl === "high") {
      ctx.setEffort(lvl);
      ctx.updateStatus();
      ctx.appendLine(`effort set to ${lvl}`);
    } else {
      ctx.appendLine("usage: /effort low|medium|high");
    }
    return true;
  }
  return false;
}