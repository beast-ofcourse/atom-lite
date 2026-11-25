import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const jsonMode = argv.includes("--json");
const compareIndex = argv.indexOf("--compare");
const comparePath = compareIndex >= 0 ? argv[compareIndex + 1] : undefined;
const selected = argv.filter(
  (arg, index) =>
    !arg.startsWith("--") &&
    !(compareIndex >= 0 && index === compareIndex + 1),
);

const root = mkdtempSync(join(tmpdir(), "atom-interactive-bench-"));
process.env.HOME = root;
process.env.XDG_CONFIG_HOME = join(root, ".config");

const { AgentRuntime } = await import("../dist/agent/loop.js");
const { InMemorySession } = await import("../dist/sessions/store.js");
const { FakeProvider } = await import("../dist/providers/fake.js");

function put(workspace, relative, content) {
  const target = join(workspace, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

const plainWorkspace = join(root, "plain");
const skillsWorkspace = join(root, "skills");
for (let i = 0; i < 12; i++) {
  put(plainWorkspace, `src/file-${i}.ts`, `export const value${i} = ${i};\n`);
}
for (let i = 0; i < 132; i++) {
  put(
    skillsWorkspace,
    `.agents/skills/skill-${String(i).padStart(3, "0")}/SKILL.md`,
    `---\nname: skill-${i}\ndescription: Fixture skill number ${i} for latency benchmarking\n---\n`,
  );
}
put(skillsWorkspace, "src/main.ts", "export const main = 1;\n");

const delay = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

function fakeTool(name, content, delayMs = 0) {
  return {
    definition: { name, description: name, parameters: {} },
    execute: async (call) => {
      await delay(delayMs);
      return { toolCallId: call.id, name, content };
    },
  };
}

const summaryResponse = {
  text: [
    "## Objective",
    "Preserve the task.",
    "## Requirements",
    "None.",
    "## Decisions",
    "None.",
    "## Work State",
    "In progress.",
    "## Next Move",
    "Continue.",
    "## Relevant Files",
    "None.",
    "## Important Context",
    "None.",
  ].join("\n"),
  usage: { input: 120, output: 40, total: 160 },
};

function validateRequest(request) {
  assert.ok(Array.isArray(request.messages), "request messages must be an array");
  assert.ok(request.messages.length > 0, "request must carry at least one message");
  assert.ok(typeof request.model === "string" && request.model.length > 0, "request must name a model");
  for (const message of request.messages) {
    assert.ok(
      ["system", "user", "assistant", "tool"].includes(message.role),
      `unexpected message role: ${message.role}`,
    );
  }
}

function respond(request) {
  validateRequest(request);
  const isSummary = request.messages.some(
    (message) =>
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.includes("## Objective"),
  );
  return isSummary ? summaryResponse : undefined;
}

const usage = (input, output, cacheRead = 0) => ({
  input,
  output,
  total: input + output + cacheRead,
  cacheRead,
});

function longHistory(session, count = 24) {
  const block = "context ".repeat(150);
  for (let i = 0; i < count; i++) {
    session.appendMessage({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `${block} ${i}` }],
    });
  }
}

const scenarios = [
  {
    name: "cold",
    repetitions: 8,
    make: () => ({
      workspace: plainWorkspace,
      prompt: "what is two plus two",
      responses: [{ text: "four", usage: usage(1200, 8) }],
    }),
  },
  {
    name: "long-history",
    repetitions: 8,
    make: () => ({
      workspace: plainWorkspace,
      prompt: "summarise the state",
      prepare: longHistory,
      responses: [{ text: "done", usage: usage(9000, 12, 6000) }],
    }),
  },
  {
    name: "parallel-reads",
    repetitions: 5,
    make: () => {
      const calls = Array.from({ length: 10 }, (_, i) => ({
        id: `read-${i}`,
        name: "read",
        arguments: { path: `src/file-${i}.ts` },
      }));
      return {
        workspace: plainWorkspace,
        prompt: "read ten files",
        tools: [
          {
            definition: { name: "read", description: "read", parameters: {} },
            execute: async (call) => {
              const slow = call.arguments?.path === "src/file-9.ts";
              await delay(slow ? 140 : 1);
              return { toolCallId: call.id, name: call.name, content: "x".repeat(3000) };
            },
          },
        ],
        responses: [
          { toolCalls: calls, usage: usage(1400, 30) },
          { text: "early", usage: usage(6000, 10, 4000) },
          { text: "done", usage: usage(9000, 10, 7000) },
        ],
      };
    },
  },
  {
    name: "unchanged-reread",
    repetitions: 5,
    make: () => ({
      workspace: plainWorkspace,
      prompt: "read the same file twice",
      tools: [fakeTool("read", "y".repeat(4000))],
      responses: [
        {
          toolCalls: [{ id: "r1", name: "read", arguments: { path: "src/file-0.ts" } }],
          usage: usage(1300, 20),
        },
        {
          toolCalls: [{ id: "r2", name: "read", arguments: { path: "src/file-0.ts" } }],
          usage: usage(6000, 20, 4000),
        },
        { text: "done", usage: usage(10000, 10, 8000) },
      ],
    }),
  },
  {
    name: "fast-response-slow-batch",
    repetitions: 5,
    make: () => ({
      workspace: plainWorkspace,
      prompt: "run two tools",
      tools: [fakeTool("fast", "fast", 10), fakeTool("slow", "slow", 140)],
      responses: [
        {
          toolCalls: [
            { id: "f1", name: "fast", arguments: {} },
            { id: "s1", name: "slow", arguments: {} },
          ],
          usage: usage(1300, 20),
        },
        { text: "early", usage: usage(6000, 10, 4000) },
        { text: "done", usage: usage(7000, 10, 5000) },
      ],
    }),
  },
  {
    name: "over-threshold-compaction",
    repetitions: 5,
    make: () => ({
      workspace: plainWorkspace,
      prompt: "continue",
      prepare: (session) => longHistory(session, 40),
      options: {
        contextWindow: 10000,
        keepTokens: 500,
        buffer: "10%",
        compactionStrategy: "summary",
      },
      responses: [{ text: "done", usage: usage(4000, 10, 2000) }],
    }),
  },
  {
    name: "many-skills-repo-map",
    repetitions: 5,
    make: () => ({
      workspace: skillsWorkspace,
      prompt: "which skills exist",
      options: {
        repoMap: { enabled: true, maxTokens: 1200, maxFiles: 400 },
      },
      responses: [{ text: "listed", usage: usage(16000, 12, 12000) }],
    }),
  },
];

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
}

function median(values) {
  return percentile(values, 0.5);
}

async function runScenario(scenario) {
  const samples = [];
  for (let i = 0; i < scenario.repetitions; i++) {
    const fixture = scenario.make();
    const provider = new FakeProvider(fixture.responses, {
      stream: true,
      strict: true,
      respond,
      chunkSize: 32,
      firstTokenDelayMs: 5,
      chunkDelayMs: 1,
    });
    const runtime = new AgentRuntime({
      provider,
      workspace: fixture.workspace,
      tools: fixture.tools ?? [],
      ...fixture.options,
    });
    const timings = [];
    runtime.setEventSink((event) => {
      if (event.type === "turn_timing") timings.push(event.timing);
    });
    const session = new InMemorySession(`bench-${i}`, fixture.workspace);
    fixture.prepare?.(session);

    const startedAt = performance.now();
    await runtime.runAgentTurn(fixture.prompt, session, new AbortController().signal);
    const wallMs = performance.now() - startedAt;

    assert.equal(timings.length, 1, "a turn must emit exactly one timing record");
    assert.equal(provider.remaining, 0, "scripted responses left unconsumed");
    const timing = timings[0];
    assert.ok(timing.requestId, "timing must carry a request id");
    samples.push({ wallMs, timing, calls: provider.calls });
  }

  const field = (name) => median(samples.map((s) => s.timing[name] ?? 0));
  return {
    scenario: scenario.name,
    repetitions: scenario.repetitions,
    wallP50Ms: Number(percentile(samples.map((s) => s.wallMs), 0.5).toFixed(2)),
    wallP95Ms: Number(percentile(samples.map((s) => s.wallMs), 0.95).toFixed(2)),
    firstTokenP50Ms: Number(field("firstTokenMs").toFixed(2)),
    modelCalls: field("modelCalls"),
    requestCount: median(samples.map((s) => s.calls)),
    preflightMs: Number(field("preflightMs").toFixed(2)),
    contextBuildMs: Number(field("contextBuildMs").toFixed(2)),
    serializeMs: Number(field("serializeMs").toFixed(2)),
    firstToolStartMs: Number(field("firstToolStartMs").toFixed(2)),
    toolBatchMs: Number(field("toolBatchMs").toFixed(2)),
    postTurnMs: Number(field("postTurnMs").toFixed(2)),
    fixedPromptTokens: field("fixedPromptTokens"),
    historyTokens: field("historyTokens"),
    toolResultTokens: field("toolResultTokens"),
    inputTokens: field("inputTokens"),
    cachedInputTokens: field("cachedInputTokens"),
    outputTokens: field("outputTokens"),
  };
}

function printTable(results) {
  const columns = [
    ["scenario", (r) => r.scenario],
    ["wall p50", (r) => `${r.wallP50Ms}ms`],
    ["wall p95", (r) => `${r.wallP95Ms}ms`],
    ["1st tok", (r) => `${r.firstTokenP50Ms}ms`],
    ["context", (r) => `${r.contextBuildMs}ms`],
    ["serialize", (r) => `${r.serializeMs}ms`],
    ["tool", (r) => `${r.toolBatchMs}ms`],
    ["calls", (r) => String(r.modelCalls)],
    ["reqs", (r) => String(r.requestCount)],
    ["fixed", (r) => String(r.fixedPromptTokens)],
    ["history", (r) => String(r.historyTokens)],
    ["tool out", (r) => String(r.toolResultTokens)],
    ["input", (r) => String(r.inputTokens)],
    ["cached", (r) => String(r.cachedInputTokens)],
  ];
  const widths = columns.map(([name, get]) =>
    Math.max(name.length, ...results.map((r) => get(r).length)),
  );
  console.log(columns.map(([name], i) => name.padEnd(widths[i])).join("  "));
  for (const result of results) {
    console.log(columns.map(([, get], i) => get(result).padEnd(widths[i])).join("  "));
  }
}

function printComparison(results, baseline) {
  const byName = new Map(baseline.scenarios.map((s) => [s.scenario, s]));
  const metrics = ["wallP50Ms", "firstTokenP50Ms", "modelCalls", "inputTokens"];
  console.log(`comparison with ${comparePath}`);
  for (const result of results) {
    const before = byName.get(result.scenario);
    if (!before) {
      console.log(`${result.scenario}: no baseline`);
      continue;
    }
    const parts = metrics.map((metric) => {
      const delta = ((result[metric] - before[metric]) / (before[metric] || 1)) * 100;
      return `${metric} ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
    });
    console.log(`${result.scenario}: ${parts.join("  ")}`);
  }
}

try {
  const chosen = selected.length > 0 ? scenarios.filter((s) => selected.includes(s.name)) : scenarios;
  assert.ok(chosen.length > 0, `no scenarios matched: ${selected.join(", ")}`);
  const known = new Set(scenarios.map((s) => s.name));
  for (const name of selected) assert.ok(known.has(name), `unknown scenario: ${name}`);

  const results = [];
  for (const scenario of chosen) {
    results.push(await runScenario(scenario));
  }

  if (jsonMode) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), scenarios: results }, null, 2));
  } else {
    printTable(results);
    if (comparePath) {
      const { readFileSync } = await import("node:fs");
      printComparison(results, JSON.parse(readFileSync(comparePath, "utf8")));
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
