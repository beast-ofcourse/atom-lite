// Contract: an extension command handler receives the same ExtensionContext
// as tools and hooks, so it can use pi.log/pi.exec/pi.ui.notify through the
// captured API and read real context state. Built-ins keep CommandContext.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommandRegistry } from "../../dist/cli/commands.js";
import {
  createExtensionAPI,
  createExtensionRegistries,
} from "../../dist/extensions/api.js";
import { PiSessionManager } from "../../dist/extensions/session-manager.js";

test("extension command handler receives ExtensionContext and can call pi.log, pi.exec, pi.ui.notify", async () => {
  const calls: any[] = [];
  const registries = createExtensionRegistries();
  const ui = {
    notify: (message: string, type?: string) =>
      calls.push(["notify", message, type]),
  } as any;
  const extensionContext = {
    workspace: process.cwd(),
    trusted: true,
    hasUI: false,
    ui,
    log: (message: string) => calls.push(["log", message]),
    sessionManager: new PiSessionManager({ id: "s-cmd" }),
  } as any;
  const api = createExtensionAPI(
    "probe",
    extensionContext,
    registries,
    "s-cmd",
  );
  api.ui = ui;

  api.registerCommand({
    name: "probe",
    description: "probe the handler context",
    async run(_args, ctx) {
      calls.push([
        "context",
        ctx?.workspace,
        typeof ctx?.log,
        !!ctx?.ui,
        ctx?.sessionManager?.getId?.(),
      ]);
      ctx.log("log-ok");
      api.log("api-log-ok");
      const result = await api.exec(process.execPath, [
        "-e",
        "process.stdout.write('exec-ok')",
      ]);
      calls.push(["exec", result.stdout]);
      api.ui.notify("notify-ok", "info");
    },
  });

  const registry = createCommandRegistry({
    extensionCommands: [...registries.commands.values()].map((command) => ({
      ...command,
      extensionContext,
    })),
  });
  const result = await registry.dispatch("/probe", {
    appendLine: () => {},
  } as any);

  assert.equal(result.handled, true);
  assert.equal(result.error, undefined);
  assert.deepEqual(calls[0], [
    "context",
    process.cwd(),
    "function",
    true,
    "s-cmd",
  ]);
  assert.ok(calls.some((call) => call[0] === "log" && call[1] === "log-ok"));
  assert.ok(calls.some((call) => call[0] === "exec" && call[1] === "exec-ok"));
  assert.ok(
    calls.some((call) => call[0] === "notify" && call[1] === "notify-ok"),
  );
});

test("built-in commands still receive CommandContext", async () => {
  const seen: any[] = [];
  const registry = createCommandRegistry();
  const command = registry.get("help");
  assert.ok(command);
  const ctx = { appendLine: (text: string) => seen.push(text) } as any;
  await command!.run(ctx, "", "/help");
  assert.ok(seen.length > 0);
});
