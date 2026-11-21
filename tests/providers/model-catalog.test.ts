import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapUpstreamModel,
  setRemoteOverlay,
  clearRemoteOverlay,
  catalogLookup,
  resolveModelCapabilities,
} from "../../dist/providers/model-catalog.js";

test("map upstream metadata to catalog entry", () => {
  const entry = mapUpstreamModel("acme", {
    id: "acme-large",
    context_length: 128000,
    max_tokens: 4096,
    supports_reasoning: true,
  });
  assert.equal(entry.id, "acme-large");
  assert.equal(entry.contextWindow, 128000);
  assert.equal(entry.maxTokens, 4096);
  assert.equal(entry.reasoning, true);
  assert.ok(entry.thinkingLevelMap);
});

test("remote overlay wins over seed", () => {
  clearRemoteOverlay();
  setRemoteOverlay({ openai: [{ id: "gpt-4o", contextWindow: 999999, reasoning: false }] });
  const entry = catalogLookup("openai", "gpt-4o");
  assert.equal(entry?.contextWindow, 999999);
  clearRemoteOverlay();
  assert.equal(catalogLookup("openai", "gpt-4o")?.contextWindow, 128000);
});

test("user override wins over overlay and seed", () => {
  clearRemoteOverlay();
  setRemoteOverlay({ openai: [{ id: "gpt-4o", contextWindow: 999999, reasoning: false }] });
  const resolved = resolveModelCapabilities("openai", "gpt-4o", {
    override: { contextWindow: 123 },
  });
  assert.equal(resolved.contextWindow, 123);
  clearRemoteOverlay();
});