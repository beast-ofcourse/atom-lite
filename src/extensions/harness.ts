/**
 * `atom-lite extension test <path>`: load one fixture through the normal
 * extension loader with a fake provider, fake TUI and fake session, then run
 * its `test(ctx)` export. No real provider, network, or user config is read.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ExtensionLoader,
  type ExtensionDiagnostic,
  type ExtensionLifecycleEvent,
} from "./loader.js";
import { createDefaultExtensionUI, DialogBoundary } from "./ui.js";
import type { ExtensionUICallbacks } from "./ui.js";
import type { ExtensionAPI } from "./api.js";
import type { AtomEvent, ExtensionTool } from "./types.js";
import type { ExtensionSessionLike } from "./session-manager.js";

export interface ExtensionAssert {
  ok(value: unknown, message?: string): void;
  equal(actual: unknown, expected: unknown, message?: string): void;
  match(actual: string, pattern: RegExp | string, message?: string): void;
  deepEqual(actual: unknown, expected: unknown, message?: string): void;
  rejects(
    fn: () => Promise<unknown>,
    pattern?: RegExp | string,
    message?: string,
  ): Promise<void>;
}

export interface TranscriptEntry {
  role: "user" | "assistant" | "tool";
  content: string;
}

export interface FakeExtensionSession extends ExtensionSessionLike {
  id: string;
  workspace: string;
  events: Array<Record<string, unknown>>;
}

export interface HarnessTool extends ExtensionTool {
  execute: (...args: any[]) => Promise<unknown>;
}

export interface FakeProviderRequest {
  prompt: string;
  transcript: TranscriptEntry[];
  events: string[];
}

/** The seam that answers a fixture turn; no real provider or network is used. */
export interface FakeProvider {
  complete(request: FakeProviderRequest): string | Promise<string>;
}

export interface RunExtensionTestOptions {
  provider?: FakeProvider;
}

export interface ExtensionTestContext {
  id: string;
  assert: ExtensionAssert;
  /** The API instance the fixture's factory received. */
  pi?: ExtensionAPI;
  tools: HarnessTool[];
  transcript: TranscriptEntry[];
  events: string[];
  uiEvents: Array<Record<string, unknown>>;
  sessionEvents: Array<Record<string, unknown>>;
  session: FakeExtensionSession;
  errors: Array<Record<string, unknown>>;
  doctor(): ExtensionDiagnostic[];
  /** Assert a contained `extension_error` exists, so it does not fail the run. */
  diagnostic(pattern: string | RegExp): void;
  runTurn(prompt: string): Promise<{
    text: string;
    events: string[];
    transcript: TranscriptEntry[];
  }>;
  dispatch(event: AtomEvent, payload?: unknown): Promise<unknown[]>;
  setResponse(text: string): void;
  holdDialogs(hold?: boolean): void;
  cancelDialogs(reason?: string): void;
  cancelDialogsAfterOpen(reason?: string): void;
}

export interface ExtensionTestResult {
  passed: boolean;
  assertions: number;
  failures: string[];
  errors: string[];
  output: string[];
  diagnostics: ExtensionDiagnostic[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function label(pattern: RegExp | string): string {
  return String(pattern);
}

function createAssert(
  failures: string[],
  count: { value: number },
): ExtensionAssert {
  const fail = (message: string): never => {
    failures.push(message);
    throw new Error(message);
  };
  return {
    ok(value, message = "expected a truthy value") {
      count.value++;
      if (!value) fail(message);
    },
    equal(actual, expected, message) {
      count.value++;
      if (!Object.is(actual, expected)) {
        fail(message ?? `expected ${String(expected)}, got ${String(actual)}`);
      }
    },
    match(actual, pattern, message) {
      count.value++;
      const matcher =
        typeof pattern === "string" ? new RegExp(pattern) : pattern;
      if (!matcher.test(actual)) {
        fail(
          message ??
            `expected ${JSON.stringify(actual)} to match ${label(pattern)}`,
        );
      }
    },
    deepEqual(actual, expected, message) {
      count.value++;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        fail(
          message ??
            `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
      }
    },
    async rejects(fn, pattern, message) {
      count.value++;
      try {
        await fn();
      } catch (error) {
        const text = messageOf(error);
        if (pattern) {
          const matcher =
            typeof pattern === "string" ? new RegExp(pattern) : pattern;
          if (!matcher.test(text)) {
            fail(
              message ??
                `expected rejection matching ${label(pattern)}, got ${text}`,
            );
          }
        }
        return;
      }
      fail(message ?? "expected the call to reject");
    },
  };
}

/**
 * Load and run one fixture. The result is returned rather than thrown so the
 * CLI can print every failure and set a non-zero exit code.
 */
export async function runExtensionTest(
  fixturePath: string | undefined,
  options: RunExtensionTestOptions = {},
): Promise<ExtensionTestResult> {
  const result: ExtensionTestResult = {
    passed: false,
    assertions: 0,
    failures: [],
    errors: [],
    output: [],
    diagnostics: [],
  };
  if (!fixturePath) {
    result.errors.push("extension test requires a fixture path");
    result.output.push(`FAIL: ${result.errors[0]}`);
    return result;
  }

  const absolute = resolve(fixturePath);
  const temp = mkdtempSync(join(tmpdir(), "atom-lite-extension-test-"));
  try {
    const transcript: TranscriptEntry[] = [];
    const events: string[] = [];
    const uiEvents: Array<Record<string, unknown>> = [];
    const sessionEvents: Array<Record<string, unknown>> = [];
    const failures: string[] = [];
    const count = { value: 0 };
    const fail = (message: string): never => {
      failures.push(message);
      throw new Error(message);
    };
    const dialogs = new DialogBoundary();
    let holdDialogs = false;
    let autoCancel: string | undefined;
    let fakeResponse: string | undefined;

    const session: FakeExtensionSession = {
      id: "test-session",
      workspace: temp,
      events: sessionEvents,
      appendDurableEvent: (event) => {
        sessionEvents.push({ ...event });
      },
      appendEvent: (event) => {
        sessionEvents.push({ ...event });
      },
    };

    const uiCallbacks: ExtensionUICallbacks = {
      notify: (message, type) => {
        uiEvents.push({ method: "notify", message, type });
      },
      select: (title, options) => {
        uiEvents.push({ method: "select", title, options });
        if (!holdDialogs) return Promise.resolve(options[0]);
        const pending = dialogs.run<string>("select", ({ resolve: settle }) => {
          void settle;
        });
        if (autoCancel) {
          const reason = autoCancel;
          queueMicrotask(() => dialogs.cancelAll(reason));
        }
        return pending;
      },
      confirm: (title, message) => {
        uiEvents.push({ method: "confirm", title, message });
        return Promise.resolve(true);
      },
      input: (title, placeholder) => {
        uiEvents.push({ method: "input", title, placeholder });
        return Promise.resolve(placeholder ?? "test-input");
      },
      editor: (title, prefill) => {
        uiEvents.push({ method: "editor", title, prefill });
        return Promise.resolve(prefill ?? "");
      },
      getToolsExpanded: () => false,
      getEditorText: () => "",
    };

    const loader = new ExtensionLoader({
      cliPaths: [absolute],
      cwd: temp,
      userDir: join(temp, "user"),
      agentDir: join(temp, "agent"),
      hasUI: true,
      uiFactory: (registries, ctx) =>
        createDefaultExtensionUI(registries, ctx, uiCallbacks),
      session,
      handlerTimeoutMs: 2_000,
    });
    await loader.loadAll();
    result.diagnostics = loader.diagnostics();

    // Include failed activations: fault-injection fixtures assert on their
    // own error state, so their `test` export must still run.
    const loaded = loader.list()[0];
    const rawErrors = () =>
      loader
        .lifecycleEvents()
        .filter((event) => event.type === "extension_error");
    const observedErrors = new Set<ExtensionLifecycleEvent>();
    const harnessErrors = () =>
      rawErrors().map((event) => ({
        extensionId: event.extensionId,
        method: event.method,
        error: event.error,
      }));

    const tools: HarnessTool[] = loaded
      ? [...loaded.registries.tools.values()].map((tool: ExtensionTool) => ({
          ...tool,
          execute: async (...args: any[]) => {
            const value = await loader.runBounded(
              { extensionId: loaded.id, method: `tool:${tool.name}` },
              () => (tool as any).execute(...args),
              { rethrow: true },
            );
            transcript.push({
              role: "tool",
              content:
                typeof value === "string" ? value : JSON.stringify(value ?? ""),
            });
            return value;
          },
        }))
      : [];

    const dispatch = (event: AtomEvent, payload?: unknown) => {
      events.push(event);
      return loader.dispatchEvent(event, payload);
    };
    const provider: FakeProvider =
      options.provider ??
      ({
        complete: ({ prompt }) => fakeResponse ?? `echo:${prompt}`,
      } satisfies FakeProvider);
    const runTurn = async (prompt: string) => {
      transcript.push({ role: "user", content: prompt });
      await dispatch("turn_start", { prompt });
      await dispatch("before_provider_request", { prompt });
      await dispatch("after_provider_response", { prompt });
      const text = await provider.complete({
        prompt,
        transcript: [...transcript],
        events: [...events],
      });
      transcript.push({ role: "assistant", content: text });
      await dispatch("turn_end", { text });
      return { text, events: [...events], transcript: [...transcript] };
    };

    const context: ExtensionTestContext = {
      id: loaded?.id ?? "fixture",
      pi: loaded?.api,
      tools,
      transcript,
      events,
      uiEvents,
      sessionEvents,
      session,
      errors: harnessErrors(),
      doctor: () => loader.diagnostics(),
      diagnostic: (pattern) => {
        const matcher =
          typeof pattern === "string" ? new RegExp(pattern) : pattern;
        const matches = rawErrors().filter((event) =>
          matcher.test(event.error ?? ""),
        );
        count.value++;
        if (matches.length === 0) {
          fail(
            `expected a contained extension error matching ${label(pattern)}`,
          );
        }
        for (const event of matches) observedErrors.add(event);
      },
      runTurn,
      dispatch,
      setResponse: (text) => {
        fakeResponse = text;
      },
      holdDialogs: (hold = true) => {
        holdDialogs = hold;
      },
      cancelDialogs: (reason = "overlay closed") => dialogs.cancelAll(reason),
      cancelDialogsAfterOpen: (reason = "overlay closed") => {
        autoCancel = reason;
      },
      assert: createAssert(failures, count),
    };
    // Errors accumulate during the fixture's run; expose them live.
    Object.defineProperty(context, "errors", {
      configurable: true,
      enumerable: true,
      get: harnessErrors,
    });

    const moduleExports = loaded?.moduleExports ?? {};
    const defaultExport = moduleExports.default;
    const testExport =
      moduleExports.test ??
      (defaultExport && typeof defaultExport === "object"
        ? (defaultExport as Record<string, unknown>).test
        : undefined);
    if (typeof testExport !== "function") {
      result.errors.push("fixture must export test(ctx)");
    } else {
      try {
        await (testExport as (ctx: ExtensionTestContext) => unknown)(context);
      } catch (error) {
        // Failed assertions already carry their message; other throws are
        // fixture errors and fail the run like extension errors do.
        if (failures.length === 0 || !failures.includes(messageOf(error))) {
          result.errors.push(`test(ctx) threw: ${messageOf(error)}`);
        }
      }
    }

    result.assertions = count.value;
    result.failures = [...failures];
    for (const event of rawErrors()) {
      if (observedErrors.has(event)) continue;
      const text = event.error ?? "extension_error";
      // Only errors a fixture explicitly claims through ctx.diagnostic() are
      // expected; every other extension error fails the run.
      if (!result.errors.includes(text)) result.errors.push(text);
    }
  } catch (error) {
    result.errors.push(messageOf(error));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  result.passed = result.failures.length === 0 && result.errors.length === 0;
  result.output = [
    `extension test: ${absolute}`,
    ...result.failures.map((failure) => `FAIL: ${failure}`),
    ...result.errors.map((error) => `ERROR: ${error}`),
    result.passed
      ? `PASS: fixture passed (${result.assertions} assertions)`
      : `FAILED: ${result.failures.length} assertion(s), ${result.errors.length} error(s)`,
  ];
  return result;
}
