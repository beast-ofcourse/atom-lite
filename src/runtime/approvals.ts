export type ApprovalMode = "ask" | "trusted" | "deny";

export type ApprovalDecision = "approve" | "deny" | "trust-session";

export interface ApprovalRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  sandboxed: boolean;
  /** Tool that raised the request, when known (e.g. bash, write, edit, read). */
  tool?: string;
}

export type ApprovalHandler = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision>;

export interface ApprovalContext {
  mode: ApprovalMode;
  handler?: ApprovalHandler;
  isTrusted: () => boolean;
  trustSession: () => void;
  /** Clear session trust, e.g. when the user starts a new conversation. */
  resetTrust?: () => void;
  nonInteractive: boolean;
}

const queues = new WeakMap<ApprovalContext, Promise<void>>();

/** One prompt at a time: a turn may run several tools that all need approval. */
function serialize<T>(ctx: ApprovalContext, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(ctx) ?? Promise.resolve();
  const next = previous.then(task);
  queues.set(ctx, next.then(() => undefined, () => undefined));
  return next;
}

export async function checkApproval(
  ctx: ApprovalContext,
  request: ApprovalRequest,
): Promise<{ allowed: boolean; trusted: boolean }> {
  if (ctx.mode === "deny") {
    return { allowed: false, trusted: false };
  }
  const handler = ctx.handler;
  if (ctx.nonInteractive || !handler) {
    return { allowed: false, trusted: false };
  }
  return serialize(ctx, async () => {
    if (ctx.mode === "trusted" || ctx.isTrusted()) {
      return { allowed: true, trusted: ctx.isTrusted() };
    }
    const decision = await handler(request);
    if (decision === "approve") return { allowed: true, trusted: false };
    if (decision === "trust-session") {
      ctx.trustSession();
      return { allowed: true, trusted: true };
    }
    return { allowed: false, trusted: false };
  });
}
