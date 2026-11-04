import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  ApprovalPrompt,
  type ApprovalDecision,
} from "../../dist/cli/approval-prompt.js";

const request = {
  command: "rm -rf build && npm run build",
  cwd: "~/project",
  timeoutMs: 30_000,
  sandboxed: false,
};

function makePrompt(): {
  prompt: ApprovalPrompt;
  decisions: ApprovalDecision[];
} {
  const decisions: ApprovalDecision[] = [];
  const prompt = new ApprovalPrompt(request, (decision) =>
    decisions.push(decision),
  );
  return { prompt, decisions };
}

test("approval prompt renders a clear boxed choice list", () => {
  const { prompt } = makePrompt();
  const rows = prompt.render(64);
  const rendered = rows.join("\n");
  assert.match(rendered, /approval required/);
  assert.match(rendered, /rm -rf build/);
  assert.match(rendered, /\[y\] Approve/);
  assert.match(rendered, /\[n\] Deny/);
  assert.match(rendered, /\[t\] Trust session/);
  for (const row of rows) {
    assert.ok(visibleWidth(row) <= 64, `width ${visibleWidth(row)}`);
  }
});

test("approval prompt accepts y, n, and t shortcuts", () => {
  const approve = makePrompt();
  approve.prompt.handleInput("y");
  assert.deepEqual(approve.decisions, ["approve"]);

  const deny = makePrompt();
  deny.prompt.handleInput("n");
  assert.deepEqual(deny.decisions, ["deny"]);

  const trust = makePrompt();
  trust.prompt.handleInput("t");
  assert.deepEqual(trust.decisions, ["trust-session"]);
});

test("approval prompt defaults Enter to deny and resolves only once", () => {
  const { prompt, decisions } = makePrompt();
  prompt.handleInput("\r");
  assert.deepEqual(decisions, ["deny"]);
  prompt.handleInput("y");
  assert.deepEqual(decisions, ["deny"]);
});

test("approval prompt denies on Escape", () => {
  const { prompt, decisions } = makePrompt();
  prompt.handleInput("\x1b");
  assert.deepEqual(decisions, ["deny"]);
});
