export type ApprovalMode = "ask" | "trusted" | "deny";

export type ApprovalDecision = "approve" | "deny" | "trust-session";

export interface ApprovalRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  sandboxed: boolean;
}

export type ApprovalHandler = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision>;

export interface ApprovalContext {
  mode: ApprovalMode;
  handler?: ApprovalHandler;
  isTrusted: () => boolean;
  trustSession: () => void;
  nonInteractive: boolean;
}

export async function checkApproval(
  ctx: ApprovalContext,
  request: ApprovalRequest,
): Promise<{ allowed: boolean; trusted: boolean }> {
  if (ctx.mode === "deny") {
    return { allowed: false, trusted: false };
  }
  if (ctx.mode === "trusted" || ctx.isTrusted()) {
    return { allowed: true, trusted: ctx.isTrusted() };
  }
  if (ctx.nonInteractive || !ctx.handler) {
    return { allowed: false, trusted: false };
  }
  const decision = await ctx.handler(request);
  if (decision === "approve") return { allowed: true, trusted: false };
  if (decision === "trust-session") {
    ctx.trustSession();
    return { allowed: true, trusted: true };
  }
  return { allowed: false, trusted: false };
}
