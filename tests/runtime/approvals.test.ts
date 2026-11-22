// checkApproval: every branch of the approval gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkApproval,
  type ApprovalContext,
  type ApprovalDecision,
} from "../../dist/runtime/approvals.js";

function base(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
  return {
    mode: "ask",
    handler: async () => "approve",
    isTrusted: () => false,
    trustSession: () => {},
    nonInteractive: false,
    ...overrides,
  };
}

test("deny mode refuses everything without consulting the handler", async () => {
  let called = 0;
  const ctx = base({
    mode: "deny",
    handler: async () => {
      called++;
      return "approve";
    },
  });
  const d = await checkApproval(ctx, {
    command: "ls",
    cwd: "/",
    timeoutMs: 0,
    sandboxed: false,
  });
  assert.equal(d.allowed, false);
  assert.equal(called, 0);
});

test("trusted mode allows without prompting", async () => {
  let called = 0;
  const ctx = base({
    mode: "trusted",
    handler: async () => {
      called++;
      return "deny";
    },
  });
  const d = await checkApproval(ctx, {
    command: "ls",
    cwd: "/",
    timeoutMs: 0,
    sandboxed: false,
  });
  assert.equal(d.allowed, true);
  assert.equal(called, 0);
});

test("session trust allows without prompting", async () => {
  const ctx = base({ isTrusted: () => true });
  const d = await checkApproval(ctx, {
    command: "ls",
    cwd: "/",
    timeoutMs: 0,
    sandboxed: false,
  });
  assert.equal(d.allowed, true);
  assert.equal(d.trusted, true);
});

test("approve decision allows", async () => {
  const ctx = base();
  const d = await checkApproval(ctx, {
    command: "npm test",
    cwd: "/",
    timeoutMs: 0,
    sandboxed: false,
  });
  assert.equal(d.allowed, true);
  assert.equal(d.trusted, false);
});

test("trust-session decision allows and marks the session trusted", async () => {
  let trusted = false;
  const ctx = base({
    isTrusted: () => trusted,
    trustSession: () => {
      trusted = true;
    },
  });
  const ctx2 = { ...ctx, handler: async () => "trust-session" as const };
  const d = await checkApproval(ctx2, {
    command: "npm test",
    cwd: "/",
    timeoutMs: 0,
    sandboxed: false,
  });
  assert.equal(d.allowed, true);
  assert.equal(trusted, true);
  // Subsequent calls are allowed without prompting.
  let prompted = 0;
  const ctx3 = {
    ...ctx,
    handler: async () => {
      prompted++;
      return "deny" as const;
    },
  };
  const d2 = await checkApproval(ctx3, {
    command: "npm run build",
    cwd: "/",
    timeoutMs: 0,
    sandboxed: false,
  });
  assert.equal(d2.allowed, true);
  assert.equal(prompted, 0);
});

test("deny decision refuses", async () => {
  const ctx = base({ handler: async () => "deny" });
  const d = await checkApproval(ctx, {
    command: "rm -rf /",
    cwd: "/",
    timeoutMs: 0,
    sandboxed: false,
  });
  assert.equal(d.allowed, false);
});

test("non-interactive runs cannot be approved by a handler", async () => {
  let called = 0;
  const ctx = base({
    nonInteractive: true,
    handler: async () => {
      called++;
      return "approve";
    },
  });
  const d = await checkApproval(ctx, {
    command: "ls",
    cwd: "/",
    timeoutMs: 0,
    sandboxed: false,
  });
  assert.equal(d.allowed, false);
  assert.equal(called, 0);
});

test("missing handler refuses in ask mode", async () => {
  const ctx = base({ handler: undefined });
  const d = await checkApproval(ctx, {
    command: "ls",
    cwd: "/",
    timeoutMs: 0,
    sandboxed: false,
  });
  assert.equal(d.allowed, false);
});

test("concurrent approvals use one prompt and trust-session covers the rest", async () => {
  let trusted = false;
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  let answer!: (decision: ApprovalDecision) => void;
  const ctx = base({
    isTrusted: () => trusted,
    trustSession: () => {
      trusted = true;
    },
    handler: () => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<ApprovalDecision>((resolve) => {
        answer = resolve;
      }).finally(() => {
        inFlight--;
      });
    },
  });
  const request = {
    command: "ls",
    cwd: "/",
    timeoutMs: 0,
    sandboxed: false,
  };

  const first = checkApproval(ctx, request);
  const second = checkApproval(ctx, request);
  await Promise.resolve();
  assert.equal(calls, 1, "parallel tool calls must not open two prompts");

  answer("trust-session");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(maxInFlight, 1);
  assert.equal(calls, 1);
  assert.equal(a.allowed, true);
  assert.equal(b.allowed, true);
  assert.equal(trusted, true);
});
