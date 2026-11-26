---
name: atom-lite-extensions
description: Build, test, and debug Atom-lite extensions.
license: MIT
---

# Atom-lite Extensions

Atom-lite loads Pi-style extension modules in-process. A module exports one
factory that receives `pi`, an `ExtensionAPI`. Everything the extension
registers is owned by that extension's load generation.

## Sources of truth

Read these when a signature or status is unclear:

- [Compatibility matrix](https://github.com/beast-ofcourse/atom-lite/blob/master/src/extensions/compatibility-matrix.ts) — generated status for every `ExtensionAPI` method.
- [Types](https://github.com/beast-ofcourse/atom-lite/blob/master/src/extensions/types.ts) — `ExtensionAPI`, `ExtensionTool`, `ExtensionCommand`, `AtomEvent`, `ExecOptions`.
- [Runtime](https://github.com/beast-ofcourse/atom-lite/blob/master/src/extensions/api.ts) — implementation and scope gates.
- [User docs](https://github.com/beast-ofcourse/atom-lite/blob/master/docs/extensions.md) — discovery, trust, diagnostics, and reduced behavior.
- [Tests](https://github.com/beast-ofcourse/atom-lite/tree/master/tests/extensions) — runnable examples and fault-injection fixtures.
- In a live session: `/extensions` and `/extensions doctor --json`.

The matrix is authoritative. Regenerate it with `npm run matrix:generate` after
changing the API; `npm test` rejects a stale matrix.

## Workflow

### 1. Shape the module

Load an extension for one run with `atom-lite -e ./my-extension.js`
(`-e` / `--extension` is repeatable). Installed extensions come from Atom-lite
user/project directories and Pi locations, including `settings.json` and
`package.json` `pi.extensions` manifests.

A factory may be the `default` export, an `activate` export, or any function
export. Activation may be async. The host imports TypeScript through `jiti`
without a build step and aliases Pi specifiers:

```js
export default async function (pi) {
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Return a greeting for a name.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return { content: [{ type: "text", text: `Hello, ${params.name}!` }] };
    },
  });

  pi.registerCommand({
    name: "hello",
    description: "Say hello",
    async run(args, ctx) {
      pi.notify(`hello ${args}`, "info");
    },
  });
}
```

Use `@earendil-works/pi-tui` and `@sinclair/typebox` for Pi-style imports;
legacy `@mariozechner/*` specifiers also resolve. Project-local extensions load
only after project trust is granted, and non-interactive runs skip untrusted
ones with a stderr note.

Completion criterion: the module loads, `/extensions` lists it, and its tools
and commands appear in `/extensions doctor`.

### 2. Declare capability scopes

Declare scopes under `permissions` in the `atom` or `pi` field of the extension
manifest. If both fields exist, `pi` wins.

```jsonc title="package.json"
{
  "atom": {
    "extensions": ["./index.js"],
    "permissions": {
      "network": { "hosts": ["api.example.com", "*.example.org"] },
      "exec": { "commands": ["git"] },
      "providers": false,
      "ui": true,
      "session": { "read": true, "write": false },
    },
  },
}
```

Omitted means denied. Declaring `permissions: {}` creates a scoped extension
with zero rights. Omitting `permissions` keeps legacy behavior with all scopes
allowed. Denials throw `ExtensionCompatibilityError` naming the scope.

Completion criterion: the trust prompt lists the intended scopes and doctor
reports the expected `scopeMode` and `scopes`.

### 3. Use working APIs

The matrix groups methods into four statuses:

| Status        | Meaning                                                    |
| ------------- | ---------------------------------------------------------- |
| `supported`   | The host consumes the effect.                              |
| `reduced`     | Works with documented limits.                              |
| `no-op`       | Accepted for compatibility; no host code reads the value.  |
| `unsupported` | Tier 3 stub; throws `ExtensionCompatibilityError` on call. |

Build on `supported` and `reduced` methods. Treat `no-op` methods as
placeholder surface: they may mutate registries, but the host ignores them.
Guard Tier 3 calls with `pi.supports(name)` and branch on `pi.apiVersion`
(currently `"1"`). `supports()` reports method availability only; it does not
validate arguments.

Completion criterion: every API call in the module resolves to a `supported`
or `reduced` matrix entry, or is guarded behind `supports()`.

### 4. Persist, compose, and observe

Use `pi.store` for state that must survive restart and reload. Use
`pi.wrapTool` to intercept tool calls, `pi.provide`/`pi.consume` to share
services, and `pi.span`/`pi.metric` to record bounded diagnostics.

Completion criterion: state survives a restart, migration runs once, middleware
and services are removed on reload, and doctor shows the expected observability
counts without values.

### 5. Diagnose and test

Run one fixture without a provider, network, or user configuration:

```bash
atom-lite extension test ./my-extension.js
```

Export a named `test` function taking `ctx` to assert on the run. The CLI exits
non-zero on failed assertions or unclaimed extension errors.

```js
export default (pi) => {
  pi.registerTool({
    name: "echo",
    label: "Echo",
    description: "echoes text",
    execute: async (_id, args) => args.text,
  });
};

export async function test(ctx) {
  await ctx.runTurn("hello");
  ctx.assert.match(ctx.transcript[0].content, /hello/);
  ctx.assert.ok(ctx.events.includes("turn_end"));
  ctx.assert.equal(ctx.tools.length, 1);
}
```

Then inspect a live run with `/extensions doctor --json`.

Completion criterion: the harness passes and doctor shows expected
registrations, scopes, store metadata, and zero unexpected errors.

## Lua extensions

Atom-lite loads `.lua` files with the same host, API, trust model, and
generation boundary as JavaScript modules. Pass one with `-e`, install it as
`index.lua`, or name it in a manifest `extensions` array. Export a global
function named `activate` that receives `pi`; export a global function named
`test` that receives `ctx` to use the extension test harness.

```lua title="echo.lua"
activate = function(pi)
  pi.registerTool({
    name = "echo",
    label = "Echo",
    description = "Echo text",
    parameters = {
      type = "object",
      properties = { text = { type = "string" } },
    },
    execute = function(id, args)
      return args.text
    end,
  })
end

test = function(ctx)
  ctx.assert.equal(ctx.tools.length, 1)
end
```

Lua tables convert to JSON-like tool schemas, service payloads, and store
values. Lua functions stay callable as tool, command, event, middleware, and
migration handlers. Async `ExtensionAPI` methods such as `exec`, `fetch`,
dialogs, and `span` return resolved values inside Lua callbacks; do not call
`:await()` on them. JavaScript promises received from other host callbacks,
including a harness tool's `execute`, still use `:await()`.

Scopes, the durable store, services, observability, diagnostics, reload, and
unload follow the JavaScript rules in this skill. A Lua callback that exceeds
the configured handler timeout is contained as a timeout failure. `require`
cannot load host modules or npm packages because `package.path` and
`package.cpath` are empty; filesystem access is unrestricted in both languages.

## Loading and lifecycle

- Discovery order is CLI paths, project, Pi global, Pi settings, Atom-lite
  directories, then package manifests. Sources are sorted for stability.
- Activation order is discovery order, then a stable topological sort over
  literal `pi.provide("name", ...)` and `pi.consume("name", ...)` declarations.
  Providers activate before consumers. Dynamic names create no ordering edge.
- A failed activation contributes zero registrations. Reload builds a complete
  replacement set and swaps atomically; a failed reload leaves the live set
  untouched.
- Per extension, `extension_load` fires before `extension_activate`, after the
  factory and store activation succeed. `extension_error`, `extension_load`,
  and `extension_activate` broadcast once to the committed set.
- Unload archives every store, records `extension_unload`, and clears tools,
  services, middleware, handlers, and the jiti cache. Reload swaps sets and
  keeps live store files.
- Every extension callback is bounded by a timeout (5 s in the host, 2 s in
  the harness) and attributed to its extension in doctor. Stale-generation
  results are discarded.

## API map

**Identity and context:** `id`, `ui`, `store`, `apiVersion`, `supports`,
`getWorkspace()`, `getSession()`, `getSessionManager()`, `isProjectTrusted()`.

**Tools:** `registerTool`, `unregisterTool`, `wrapTool`, `setActiveTools`,
`getActiveTools`, `getAllTools`, `getToolsExpanded`, `setToolsExpanded`.

**Commands:** `registerCommand`, `unregisterCommand`.

**Events:** `on`, `off`.

**Session:** `appendEntry`, `getSessionEntries`.

**Dialogs:** `select`, `confirm`, `input`.

**Providers:** `registerProvider`, `unregisterProvider`, `registerModel`.

**Exec and network:** `exec`, `fetch`.

**Observability:** `span`, `metric`.

**Services:** `provide`, `consume`.

**Logging and notify:** `log`, `notify`.

**No-op compatibility surface:** `setStatus`, `registerWidget`,
`unregisterWidget`, `setWidget`, `registerToolRenderer`,
`registerMessageRenderer`, `registerEntryRenderer`,
`registerMarkdownTransformer`, `registerShortcut`, `registerFlag`, `getFlag`,
`addAutocompleteProvider`, `setFooter`, `setHeader`, `setTitle`,
`setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`,
`setHiddenThinkingLabel`.

**Tier 3 stubs:** `getSessionTree`, `forkSession`, `registerMcpServer`,
`registerOAuthProvider`, model factory, `enableRpcMode`, `registerCustomEditor`.

`pi.ui` also exposes `editor`, `onTerminalInput`, `custom`, `pasteToEditor`,
`setEditorText`, `getEditorText`, `getTheme`, and `setTheme`. `setTheme` returns
an unavailable result in this release.

## Tools, commands, and events

`registerTool` takes `name`, `label`, `description`, optional `parameters`
(JSON Schema), optional `annotations`, an `exposure` of `"direct"`,
`"model-only"`, or `"hidden"`, and an async `execute(toolCallId, params,
signal, onUpdate, ctx)`. `onUpdate` streams partial output. Names are
validated, collisions are renamed deterministically, and hidden tools stay out
of the model-visible set. Use `exposure: "direct"` or `"model-only"`;
`"codemode"` is a Tier 3 stub.

Commands are `/name` in the palette. A command declares `name`, `description`,
optional `argumentHint` and `category`, and `run(args, ctx)`. Handlers receive
an `ExtensionContext` with `workspace`, `trusted`, `hasUI`, `ui`, `log`, and
`sessionManager`.

Valid `AtomEvent` names: `extension_load`, `extension_activate`,
`extension_unload`, `extension_error`, `session_start`, `session_end`,
`session_shutdown`, `turn_start`, `turn_end`, `agent_before_settle`,
`agent_settled`, `context_build`, `before_provider_request`,
`after_provider_response`, `message_start`, `message_end`, `tool_call`,
`tool_result`, `tool_execution_start`, `tool_execution_end`,
`tool_execution_update`, `config_change`.

`pi.on(event, handler)` returns an unsubscribe function; `pi.off` removes one.
Handlers are awaited, bounded, and run behind a reload generation guard.

## Capability scopes in detail

| Scope       | Grants                                                    |
| ----------- | --------------------------------------------------------- |
| `network`   | `pi.fetch` to listed hosts, including every redirect hop. |
| `exec`      | `pi.exec` for exact commands or basenames.                |
| `providers` | `pi.registerProvider`.                                    |
| `ui`        | UI and dialog methods, including `pi.ui.*`.               |
| `session`   | Read or write session entry methods.                      |

Hosts match case-insensitively by exact name or `*.suffix`. Booleans must be
exactly `true`. `pi.fetch` strips `Authorization`, `Proxy-Authorization`, and
`Cookie` headers and returns a standard `Response`. `exec` never blocks the
event loop: it defaults to a 30 s timeout and a 10 MiB capture limit per stream,
and accepts `cwd`, `timeoutMs`, `env`, `signal`, `maxBuffer`, and `onOutput`.
Turn abort cancels the child. File access is not a scope; extensions run
in-process with host filesystem access, so `files.read` and `files.write` keys
are ignored.

`registerProvider` maps a reduced config set: `baseUrl`, `apiKey`, `headers`,
`authHeader`, and `models` apply; identity keys `name`, `id`, and `config` are
ignored; other keys warn and are dropped. `registerModel` is a no-op.
`appendEntry` and `getSessionEntries` persist custom entries in the session log
but no host view renders them. `getSessionManager()` is a read model, not a
fork or tree API.

## Durable store

`pi.store` writes `<agentDir>/extension-state/<id>.json` with shape
`{ "version": 1, "value": { ... } }`. The serialized file is capped at 1 MiB;
an oversized write throws and leaves state unchanged.

Set `version` and `migrate` before reading or writing. The host runs migration
once after activation, even if no store method was called. The hook must be
synchronous and return an object. A newer stored version, or an older version
with no hook, fails with `ExtensionCompatibilityError` at `store.migrate`.

```js
export default function (pi) {
  pi.store.version = 2;
  pi.store.migrate = (oldVersion, value) => ({
    ...value,
    count: (value.count ?? 0) + 1,
  });

  pi.store.set("count", (pi.store.get("count") ?? 0) + 1);
}
```

Methods: `get`, `set`, `delete`, and `archive`. The `archive` method moves the
file to `<id>.json.bak`, replacing an older backup. Unload archives each store;
reload keeps the live file. Doctor shows entry count and version only, never
values.

## Middleware, services, and observability

`pi.wrapTool(name, (call, next) => ...)` wraps a built-in or extension tool.
`call` carries the call id, name, and arguments; calling `next` proceeds inward.
First registered is outermost. A wrapper may replace the result, throw to
reject, or return nothing to produce an error result. Wrapping preserves tool
visibility, including `hidden`. Middleware is generation-scoped.

```js
export default function (pi) {
  pi.wrapTool("bash", async (call, next) => {
    const result = await next();
    return { ...result, content: redact(result.content) };
  });
}
```

`pi.provide(name, api, version)` publishes a semver service;
`pi.consume(name, range)` resolves one at activation. Ranges support `*`, `^`,
`~`, `>=`, and exact `x.y.z`. Missing, incompatible, duplicate, or cyclic
services throw `ExtensionCompatibilityError`. Services are generation-scoped.

```js
// provider.js
export default (pi) =>
  pi.provide("greeter", { greet: (name) => `hi ${name}` }, "1.2.0");

// consumer.js — activates after provider.js
export default (pi) => {
  const greeter = pi.consume("greeter", "^1.0.0");
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone",
    execute: async () => greeter.greet("Ada"),
  });
};
```

`pi.span(name, fn)` returns the wrapped result and rethrows errors. `pi.metric`
records a counter with optional attributes. Each extension keeps at most 1000
records per stream; reload resets them. Doctor exposes counts and last error
only, never values or attribute payloads.

## Compatibility tiers

- Tier 1: discovery, trust, module loading, tools, commands, events, store,
  dialogs, `exec`, `fetch`, logging, middleware, services.
- Tier 2: no-op compatibility surface listed above.
- Tier 3: seven stubs that throw `ExtensionCompatibilityError` naming method,
  tier, and replacement. `registerTool` also throws for `exposure: "codemode"`.

Guard a deferred call before using it:

```js
if (pi.supports("registerMcpServer")) {
  pi.registerMcpServer({ name: "fs" });
}
```

## Diagnostics and testing

`/extensions` lists discovered extensions and load status.
`/extensions doctor` prints status, counts, store metadata, observability
counts, and errors. `--json` adds `id`, `source`, `origin`, `entryPath`,
`status`, `error`, `stack`, `apis`, `scopeMode`, `scopes`, `lifecycleEvents`,
`errorCount`, `lastError`, and an `observability` summary. `apis` contains the
matrix entries for calls found in the entry file.

`atom-lite extension test <path>` loads the fixture through the normal loader
with a fake provider, fake TUI, and fake session. `ctx` exposes `pi`, `tools`,
`transcript`, `events`, `uiEvents`, `sessionEvents`, `session`, `errors`,
the `doctor`, `diagnostic`, `runTurn`, `dispatch`, and `setResponse` helpers,
dialog controls, and `assert` (`ok`, `equal`, `match`, `deepEqual`, `rejects`).
The default provider returns `echo:<prompt>`.

Use `ctx.diagnostic(/fragment/)` to claim a contained error. That call asserts
the error exists and marks it expected. Every other extension error fails the
run. The fault-injection fixtures under `tests/fixtures/extensions/` seed the
conformance suite.

## Trade-offs worth remembering

- Use Pi-style imports; the host aliases them to its own copies.
- Use `pi.store` for restart-safe state and `pi.appendEntry` for session
  entries. Neither needs module globals.
- Resolve project trust before relying on a project extension loading.
- Reload with `/reload` or restart after edits; jiti caching is disabled.
- Keep callbacks short. Handlers are awaited and timed out.
- Check the matrix before relying on a method; do not infer behavior from a
  method's presence on `pi`.
