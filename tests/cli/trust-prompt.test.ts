import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectTrustPrompt } from "../../dist/cli/trust-prompt.js";

const entries = [
  {
    id: "alpha",
    entryPath: "/work/.pi/extensions/alpha.ts",
    version: "1.0.0",
    capabilities: ["tools", "commands"],
  },
];

test("renders the project path, entry files, and capabilities", () => {
  const prompt = new ProjectTrustPrompt(entries, "/work", () => {});
  const output = prompt.render(80).join("\n");
  assert.match(output, /project extensions need approval/);
  assert.match(output, /\/work/);
  assert.match(output, /alpha/);
  assert.match(output, /alpha\.ts/);
  assert.match(output, /tools, commands/);
  assert.match(output, /Approve/);
  assert.match(output, /Deny/);
});

test("y approves and n denies", () => {
  const decisions: string[] = [];
  const approve = new ProjectTrustPrompt(entries, "/work", (decision) =>
    decisions.push(decision),
  );
  approve.handleInput("y");
  const deny = new ProjectTrustPrompt(entries, "/work", (decision) =>
    decisions.push(decision),
  );
  deny.handleInput("n");
  assert.deepEqual(decisions, ["approve", "deny"]);
});

test("escape defaults to deny and a decision settles once", () => {
  const decisions: string[] = [];
  const prompt = new ProjectTrustPrompt(entries, "/work", (decision) =>
    decisions.push(decision),
  );
  prompt.handleInput("\x1b");
  prompt.handleInput("y");
  assert.deepEqual(decisions, ["deny"]);
});
