// Contract tests for ticket 09 (provider and mode gates).
//
// Seams under test:
//   - createExtensionAPI().registerProvider(): the reduced-compatibility
//     warning must name every unsupported feature declared in the config.
//   - createExtensionAPI().unregisterProvider(): a provider's models must
//     leave the selectable set as soon as the provider is removed.
//
// Each test pins a way an extension config could be silently ignored or leave
// stale selection state behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExtensionAPI,
  createExtensionRegistries,
} from "../../dist/extensions/api.js";
import { ExtensionLoader } from "../../dist/extensions/loader.js";
import { availableProviderNames } from "../../dist/providers/catalog.js";
import type { ExtensionContext } from "../../dist/extensions/types.js";

function makeApi(): ReturnType<typeof createExtensionAPI> {
  const ctx: ExtensionContext = {
    workspace: "/tmp",
    trusted: true,
    hasUI: false,
    ui: {} as any,
    log: () => {},
  };
  return createExtensionAPI(
    "bridge-ext",
    ctx,
    createExtensionRegistries(),
    "current",
  );
}

test("registerProvider warns for every declared unsupported provider feature", () => {
  const api = makeApi();
  const original = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    api.registerProvider({
      name: "bridge",
      config: {
        baseUrl: "https://example.invalid/v1",
        oauth: { clientId: "x" },
        streamSimple: true,
        classifiers: true,
        refreshModels: true,
        images: true,
        rpc: true,
      },
    });
  } finally {
    console.error = original;
  }
  const warning = errors.join("\n");
  for (const feature of [
    "oauth",
    "streamSimple",
    "classifiers",
    "refreshModels",
    "images",
    "rpc",
  ]) {
    assert.match(warning, new RegExp(feature), `no warning for ${feature}`);
  }
});

test("unregistered model cannot be selected", () => {
  const registries = createExtensionRegistries();
  const ctx: ExtensionContext = {
    workspace: "/tmp",
    trusted: true,
    hasUI: false,
    ui: {} as any,
    log: () => {},
  };
  const api = createExtensionAPI("bridge-ext", ctx, registries, "current");
  api.registerProvider({ name: "bridge", config: {} });
  api.registerProvider({ name: "other", config: {} });
  api.registerModel({ provider: "bridge", id: "stale-model" });
  api.registerModel({ provider: "other", id: "kept-model" });

  api.unregisterProvider("bridge");

  assert.deepEqual(
    registries.models.map((model) => model.id),
    ["kept-model"],
  );
});

test("unregisterProvider removes the provider from host model selection", async () => {
  // Ticket 09: filtering registries.models alone is not enough. The host
  // selection path reads config.providers and modelCache, so both must lose
  // the provider in the same call. availableProviderNames() is the function
  // the host's model picker uses.
  const dir = mkdtempSync(join(tmpdir(), "atom-lite-provider-gate-"));
  try {
    writeFileSync(
      join(dir, "bridge.js"),
      [
        "export default (api) => {",
        "  api.registerProvider({ name: 'bridge', config: { baseUrl: 'https://example.invalid/v1', models: [{ id: 'm1' }] } });",
        "  api.unregisterProvider('bridge');",
        "};",
        "",
      ].join("\n"),
    );
    const config = {
      providers: {
        bridge: { type: "openai-compatible", model: "m1" },
        keep: { type: "openai-compatible", model: "k1" },
      },
    } as any;
    const modelCache = new Map<string, { models: string[]; at: number }>([
      ["bridge", { models: ["m1"], at: Date.now() }],
    ]);
    const removed: string[] = [];
    const loader = new ExtensionLoader({
      userDir: dir,
      agentDir: join(dir, "agent"),
      onProviderUnregistered: (name) => {
        removed.push(name);
        delete config.providers[name];
        modelCache.delete(name);
      },
    });
    await loader.loadAll();

    assert.deepEqual(removed, ["bridge"]);
    assert.equal(modelCache.has("bridge"), false);
    assert.deepEqual(availableProviderNames(config).sort(), ["keep"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
