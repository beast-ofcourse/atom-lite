// Contract tests for ticket 10 (Tier 3 fails loudly).
//
// Seams under test:
//   - createExtensionAPI(): a Tier 3 method throws a typed
//     ExtensionCompatibilityError naming method, tier, and alternative; a
//     codemode tool is rejected with the same typed error; `supports()` and
//     `apiVersion` let an author branch without try/catch.
//   - ExtensionLoader.loadAll()/lifecycleEvents()/doctorJson(): an uncaught
//     Tier 3 call is contained as an attributable `extension_error`, and doctor
//     labels the called API `unsupported` with no raw TypeError.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createExtensionAPI,
  createExtensionRegistries,
} from "../../dist/extensions/api.js";
import { ExtensionLoader } from "../../dist/extensions/loader.js";
import {
  compatibilityMatrix,
  type CompatibilityMatrixEntry,
} from "../../dist/extensions/compatibility-matrix.js";
import { collectExtensionTools } from "../../dist/extensions/tool-adapter.js";

const TIER3_METHODS = [
  "getSessionTree",
  "forkSession",
  "registerMcpServer",
  "registerOAuthProvider",
  "virtualModel",
  "enableRpcMode",
  "registerCustomEditor",
];

function api() {
  const registries = createExtensionRegistries();
  const ctx = {
    workspace: "/tmp",
    trusted: true,
    hasUI: false,
    ui: null as any,
    log() {},
  };
  return { registries, api: createExtensionAPI("ext", ctx, registries, "s1") };
}

test("a Tier 3 method throws a typed compatibility error at the call site", () => {
  const { api: pi } = api();
  const fn = (pi as any).registerMcpServer;
  assert.equal(typeof fn, "function", "the stub is present on the API");

  let caught: any;
  try {
    fn({ name: "fs", command: "npx" });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, "calling a Tier 3 stub throws");
  assert.equal(caught.name, "ExtensionCompatibilityError");
  assert.equal(caught.method, "registerMcpServer");
  assert.equal(caught.tier, 3);
  assert.match(caught.alternative ?? "", /mcpServers/);
  assert.match(caught.message, /registerMcpServer/);
  assert.match(caught.message, /tier 3/);
  assert.doesNotMatch(caught.message, /is not a function/);
});

test("an uncaught Tier 3 call is contained and doctor lists it unsupported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-lite-tier3-"));
  try {
    writeFileSync(
      join(dir, "mcp.js"),
      "export default (api) => { api.registerMcpServer({ name: 'fs' }); };\n",
    );
    const loader = new ExtensionLoader({
      userDir: dir,
      agentDir: join(dir, "agent"),
    });
    await loader.loadAll();

    const errors = loader
      .lifecycleEvents()
      .filter((event) => event.type === "extension_error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].extensionId, "mcp");
    assert.equal(errors[0].method, "registerMcpServer");
    assert.equal(errors[0].tier, 3);
    assert.match(errors[0].error ?? "", /registerMcpServer/);
    assert.match(errors[0].error ?? "", /tier 3/);
    assert.doesNotMatch(errors[0].error ?? "", /is not a function/);

    const [diagnostic] = JSON.parse(loader.doctorJson());
    const entry = diagnostic.apis.find(
      (item: any) => item.method === "registerMcpServer",
    );
    assert.ok(entry, "doctor lists the called Tier 3 API");
    assert.equal(entry.status, "unsupported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every Tier 3 stub throws a typed error and supports() reports false", () => {
  const { api: pi } = api();

  for (const method of TIER3_METHODS) {
    const fn = (pi as any)[method];
    assert.equal(typeof fn, "function", `${method} is present on the API`);
    let caught: any;
    try {
      fn({}, "x");
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, `${method} throws`);
    assert.equal(caught.name, "ExtensionCompatibilityError", method);
    assert.equal(caught.method, method);
    assert.equal(caught.tier, 3, method);
    assert.ok(caught.alternative, `${method} names an alternative`);
    assert.match(caught.message, new RegExp(method));
    assert.match(caught.message, /tier 3/);
    assert.doesNotMatch(caught.message, /is not a function/);
    assert.equal((pi as any).supports(method), false, method);
  }

  assert.equal(typeof (pi as any).apiVersion, "string");
  assert.ok((pi as any).apiVersion.length > 0);
  assert.equal((pi as any).supports("registerTool"), true);
});

test("codemode exposure is rejected at registration with a compatibility error", async () => {
  const { registries, api: pi } = api();
  const tool = {
    name: "codemode-tool",
    label: "c",
    description: "d",
    exposure: "codemode",
    execute: async () => 1,
  };
  assert.throws(
    () => pi.registerTool(tool as any),
    (error: any) =>
      error.name === "ExtensionCompatibilityError" &&
      error.method === "registerTool" &&
      error.tier === 3 &&
      /codemode/.test(error.message) &&
      /tier 3/.test(error.message),
  );
  assert.equal(registries.tools.has("codemode-tool"), false);

  const dir = mkdtempSync(join(tmpdir(), "atom-lite-tier3-"));
  try {
    writeFileSync(
      join(dir, "codemode.js"),
      [
        "export default (api) => {",
        "  api.registerTool({ name: 'ok', label: 'o', description: 'd', exposure: 'direct', execute: async () => 1 });",
        "  api.registerTool({ name: 'bad', label: 'b', description: 'd', exposure: 'codemode', execute: async () => 1 });",
        "};",
        "",
      ].join("\n"),
    );
    const loader = new ExtensionLoader({
      userDir: dir,
      agentDir: join(dir, "agent"),
    });
    await loader.loadAll();

    assert.deepEqual(
      collectExtensionTools(loader).map((item) => item.definition.name),
      [],
      "an activation that throws contributes no tools (transactional activation)",
    );
    const errors = loader
      .lifecycleEvents()
      .filter((event) => event.type === "extension_error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].extensionId, "codemode");
    assert.equal(errors[0].method, "registerTool");
    assert.equal(errors[0].tier, 3);
    assert.match(errors[0].error ?? "", /codemode/);
    assert.doesNotMatch(errors[0].error ?? "", /is not a function/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the matrix labels every Tier 3 stub unsupported", () => {
  for (const method of TIER3_METHODS) {
    const entry = compatibilityMatrix.find((row) => row.method === method);
    assert.ok(entry, `${method} is in the generated matrix`);
    assert.equal(entry!.status, "unsupported", method);
  }
});

test("doctor lists every Tier 3 call in an extension as unsupported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-lite-tier3-"));
  try {
    writeFileSync(
      join(dir, "alltier3.js"),
      [
        "export default (api) => {",
        ...TIER3_METHODS.map((method) => `  api.${method}({});`),
        "};",
        "",
      ].join("\n"),
    );
    const loader = new ExtensionLoader({
      userDir: dir,
      agentDir: join(dir, "agent"),
    });
    await loader.loadAll();

    const [diagnostic] = JSON.parse(loader.doctorJson());
    const apis = new Map<string, CompatibilityMatrixEntry>(
      diagnostic.apis.map((entry: CompatibilityMatrixEntry) => [
        entry.method,
        entry,
      ]),
    );
    for (const method of TIER3_METHODS) {
      assert.equal(apis.get(method)?.status, "unsupported", method);
    }
    assert.doesNotMatch(loader.doctorJson(), /is not a function/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Tier 3 call from a lifecycle handler is contained and attributed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-lite-tier3-"));
  try {
    writeFileSync(
      join(dir, "handler.js"),
      [
        "export default (api) => {",
        '  api.on("session_end", () => api.virtualModel({ id: "x" }));',
        "};",
        "",
      ].join("\n"),
    );
    const loader = new ExtensionLoader({
      userDir: dir,
      agentDir: join(dir, "agent"),
    });
    await loader.loadAll();
    await loader.notifySessionEnd();

    const errors = loader
      .lifecycleEvents()
      .filter((event) => event.type === "extension_error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].extensionId, "handler");
    assert.match(errors[0].method ?? "", /on:session_end/);
    assert.match(errors[0].error ?? "", /virtualModel/);
    assert.match(errors[0].error ?? "", /tier 3/);
    assert.doesNotMatch(errors[0].error ?? "", /is not a function/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
