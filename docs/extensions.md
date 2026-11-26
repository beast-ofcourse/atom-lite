# Extensions

Atom-lite hosts Pi coding-agent extensions in-process. Load one for a single run, or install it in a user or project directory.

```bash
atom-lite -e ./my-extension
/extensions doctor --json
```

Project-local extensions load only after the project is trusted. See [Safety](./safety.md).

## Compatibility source

Atom-lite does not pin a Pi release. It loads extension modules through `jiti`
and aliases Pi host specifiers to installed packages or bundled shims. The
`ExtensionAPI` surface is defined in `src/extensions/api.ts`.

The generated matrix in `src/extensions/compatibility-matrix.ts` is the source
of truth for what each method does. Regenerate it after changing the interface
or a consumer:

```bash
npm run matrix:generate
```

`npm test` fails if the matrix is stale or a `supported` entry has no consumer.

## Discovery

Extensions are discovered from:

- CLI paths passed with `-e` / `--extension`.
- Atom-lite's own user and project directories.
- Pi's discovery locations and `settings.json` / `package.json` `pi.extensions`
  manifests.

Project-local extensions require trust before loading.

## Trust

Project extensions are skipped until the project is trusted. Interactive
sessions prompt for approval; non-interactive runs skip untrusted project
extensions. Trust decisions are stored in user config.

The prompt lists the exact scopes an extension declares. Declare them under
`permissions` in the `atom` (or `pi`) manifest field:

```jsonc title="package.json"
{
  "atom": {
    "extensions": ["./index.js"],
    "permissions": {
      "network": { "hosts": ["api.example.com"] },
      "exec": { "commands": ["git"] },
      "providers": false,
      "ui": true,
      "session": { "read": true, "write": false },
    },
  },
}
```

Every scope is opt-in: omitting a scope denies it. An extension with no
`permissions` object runs in `legacy-unscoped` mode with every scope allowed,
so existing extensions keep working. `/extensions doctor` labels each extension
`scoped` or `legacy-unscoped` and lists its declared scopes.

> **Note:** File access is not a scope. Extensions run in-process with the
> host's filesystem access, so no manifest can grant or deny it. Do not declare
> `files.read` or `files.write`; the host ignores those keys.

Denied calls throw `ExtensionCompatibilityError` naming the scope: `exec`
checks its command allowlist, `fetch` checks its host allowlist,
`registerProvider` requires `providers`, UI methods (including `pi.ui.*`)
require `ui`, and session entry methods require the matching `session` read or
write right. `exec` matches the declared command by exact string or basename.

## Compatibility matrix

Each `ExtensionAPI` method has one status. A `supported` method has a host
reader outside `api.ts`; the matrix records its location as `{ file, line }`.
`reduced` methods work with limits. `no-op` methods accept calls but no host
code reads the value. `unsupported` methods are reserved for features with no
implementation.

| Status        | Methods | Meaning                                  |
| ------------- | ------- | ---------------------------------------- |
| `supported`   | 23      | Effect is consumed by the host.          |
| `reduced`     | 9       | Works with limits; see Reduced behavior. |
| `no-op`       | 20      | Call is accepted; nothing consumes it.   |
| `unsupported` | 7       | Failing stub; see Tier 3.                |

**`supported`:** `registerTool`, `unregisterTool`, `setActiveTools`,
`getActiveTools`, `getAllTools`, `registerCommand`, `unregisterCommand`, `on`,
`off`, `getToolsExpanded`, `setToolsExpanded`, `select`, `confirm`, `input`,
`getWorkspace`, `getSession`, `isProjectTrusted`, `unregisterProvider`,
`wrapTool`, `provide`, `consume`, `span`, `metric`.

**`reduced`:** `appendEntry`, `getSessionEntries`, `getSessionManager`, `notify`,
`registerProvider`, `exec`, `fetch`, `log`, `supports`.

**`no-op`:** `setStatus`, `registerWidget`, `unregisterWidget`,
`registerToolRenderer`, `registerMessageRenderer`, `registerEntryRenderer`,
`registerMarkdownTransformer`, `registerShortcut`, `registerFlag`, `getFlag`,
`addAutocompleteProvider`, `setWidget`, `setFooter`, `setHeader`, `setTitle`,
`setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`,
`setHiddenThinkingLabel`, `registerModel`.

Tier 1 covers discovery, trust, module loading, tools, commands, events,
session entries, the durable store, dialogs, `exec`, logging, tool middleware,
and inter-extension services. The `no-op` methods above are accepted for
compatibility but have no effect in this release.

## Shipped examples

`examples/extensions/subagent/` is the Pi-compatible subagent extension. It
registers one `subagent` tool and runs each task in a separate `atom-lite`
process with `--mode json`, so the child gets an isolated context window. See
the [example README](../examples/extensions/subagent/README.md) for install
steps and agent definitions.

Load it for one run:

```bash
atom-lite -e ./examples/extensions/subagent/index.ts
```

Define agents as markdown files with frontmatter under `~/.pi/agent/agents`:

```md title="~/.pi/agent/agents/scout.md"
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls
model: anthropic/claude-haiku-4-5
---

You are a scout. Return compressed findings for the next agent.
```

The tool supports single `{ agent, task }`, parallel `{ tasks: [...] }`, and
chain `{ chain: [...] }` modes. Chain steps substitute `{previous}` with the
prior step's output. Omit `model` to reuse the parent process's `--model`,
`--provider`, and `--thinking` flags, or the configured defaults. Project-local
agents under `.atom-lite/agents` or `.pi/agents` require `agentScope: "both"` and
interactive confirmation unless the project is trusted.

The extension calls `node:child_process.spawn` directly instead of `pi.exec`, so
no `exec` scope is declared. Install it only from a source you trust.

## Tool middleware and services

Two extensions can cooperate on one tool or one typed service without module
globals. Both are scoped to the load generation: unload and reload remove them
with the extension set that registered them.

### Tool middleware

`pi.wrapTool(name, handler)` intercepts a built-in or extension tool. A wrapper
gets `(call, next)`: `call` carries the tool call id, name, and arguments, and
calling `next` proceeds inward to the next wrapper and then the tool's
`execute`.
Wrappers run in registration order — the first wrapper registered is outermost
and runs first. Each may replace the result, reject the call by throwing, or
abort (return no result), which becomes an error result for the model. Wrappers
are bounded by the same generation, timeout, and error attribution as event
handlers.

```js
export default function (pi) {
  pi.wrapTool("bash", async (call, next) => {
    const result = await next();
    return { ...result, content: redact(result.content) };
  });
}
```

Wrapping never changes model visibility: a wrapper on a tool with
`exposure: "hidden"` stays out of the model-visible set. The underlying tool
keeps its definition, annotations, and exposure.

### Services

`pi.provide(name, api, version)` publishes a versioned service.
`pi.consume(name, versionRange)` resolves one at activation. Extensions load in
topological order by provide/consume edges, so a provider activates before its
consumers. Semver ranges support `*`, `^`, `~`, `>=`, and exact `x.y.z`.

```js
// provider.js
export default function (pi) {
  pi.provide("greeter", { greet: (name) => `hi ${name}` }, "1.2.0");
}

// consumer.js — loads after the provider even if discovered first
export default function (pi) {
  const greeter = pi.consume("greeter", "^1.0.0");
  pi.registerTool({ name: "greet", label: "Greet", description: "Greet", execute: async () => greeter.greet("Ada") });
}
```

A missing service, an incompatible version, a duplicate provide name, or a
dependency cycle raises `ExtensionCompatibilityError` naming the method, tier,
and reason. The activation failure is attributed to the consuming extension in
doctor output.

## Reduced behavior

`registerProvider` maps an OpenAI-compatible config into Atom-lite's provider
list. The host applies `baseUrl`, `apiKey`, `headers`, `authHeader`, and
`models`; identity keys (`name`, `id`, `config`) are ignored. Every other config
key emits a reduced-compatibility warning naming that key and is not applied.

`appendEntry` and `getSessionEntries` persist custom entries in the session
event log and read them back after resume; no host view renders them.
`getSessionManager()` returns a real read model over the live session. `notify`
and `log` run, but their output is not surfaced in the host UI.

`exec` spawns a child process without blocking the event loop. It defaults to a
30 s timeout and a 10 MiB capture limit per stream; a timeout, an abort signal,
or an exceeded buffer kills the child and reports its signal in the result.
Options are `cwd`, `timeoutMs`, `env` (overrides `process.env`), `signal`,
`maxBuffer`, and an `onOutput` callback receiving `(stream, text)` for live output. The host also
forwards output through the `tool_output` event. `fetch(url, init?)` is a
host proxy limited to `network.hosts`; it strips `Authorization`,
`Proxy-Authorization`, and `Cookie` headers, checks every redirect against the
same allowlist, and returns a standard `Response`.

`supports(method)` returns `false` only for Tier 3 stubs; implemented and
`no-op` methods return `true`. It does not validate arguments: registering a
tool with `exposure: "codemode"` still throws even though
`supports("registerTool")` is `true`.

## Tier 3

Tier 3 APIs are present on `pi` as failing stubs: session tree navigation and
forks, codemode tool exposure, MCP server registration, OAuth providers, RPC
mode, custom editor components, and model factories. Calling one throws
`ExtensionCompatibilityError`, which names the method, the tier, and a
replacement when one exists. No raw `TypeError` is produced for a missing
method. The matrix lists each stub as `unsupported`, and doctor includes the
matrix entry for any Tier 3 call found in the extension file.

`registerTool` rejects a tool with `exposure: "codemode"` with the same typed
error. Use `"direct"` or `"model-only"` instead.

Check `pi.supports(name)` before calling a deferred API, and read
`pi.apiVersion` to branch on the API surface:

```text
if (pi.supports("registerMcpServer")) {
  pi.registerMcpServer({ name: "fs" });
}
```

## Durable store

`pi.store` keeps JSON state across restarts and reloads without module globals.
State lives in one file per extension at
`<agentDir>/extension-state/<id>.json`, where `agentDir` is Atom-lite's agent
directory. It is separate from the session log (which is deleted with a
session) and from user config (which holds settings, not extension state).

The file shape is `{ "version": 1, "value": { ... } }`, where each key in
`value` is a `pi.store` entry. The serialized file is capped at 1 MiB per
extension. `set`, `delete`, and a migration result that exceed the cap throw
`ExtensionCompatibilityError` and leave the store unchanged.

Set `version` and `migrate` at the top of `activate` before calling `get`,
`set`, or `delete`:

```ts
export default function (pi) {
  pi.store.version = 2;
  pi.store.migrate = (oldVersion, value) => ({
    ...value,
    n: (value.n ?? 0) + 1,
  });

  const n = pi.store.get("n");
  pi.store.set("n", (n ?? 0) + 1);
}
```

At activation the host reads the file once. When the stored version is older,
it calls the `pi.store.migrate` hook once and writes the result at the
registered version. A newer stored version throws
`ExtensionCompatibilityError` on `store.migrate` instead of dropping keys; the
extension is reported as failed in doctor. An older version with no `migrate`
hook fails the same way.

Uninstalling or unregistering an extension archives its file as
`<id>.json.bak`. A later archive replaces the previous backup. The host archives
every loaded store when it unloads the extension set; an extension can also call
`pi.store.archive()` itself. Reloads swap extension sets and keep the live store
file.

`/extensions doctor` prints only the entry count and schema version for each
store. Values never appear in doctor output.

## ExtensionAPI reference

The `pi` object passed to an extension is an `ExtensionAPI`. The matrix above
marks which methods have an effect.

**Identity / context**

- `id` — extension id
- `ui` — `ExtensionUIContext` (see UI below)
- `getWorkspace()` → string
- `getSession()` → `{ id }`
- `getSessionManager()` → a Pi session read model over the live session; entries persist across resume
- `isProjectTrusted()` → boolean
- `apiVersion` → string version of this API surface
- `supports(method)` → boolean; `false` only for Tier 3 stubs; see Reduced behavior

**Tools**

- `registerTool(tool)`, `unregisterTool(name)`
- `wrapTool(name, handler)` — compose a wrapper around a built-in or extension tool in registration order
- `setActiveTools(names)`, `getActiveTools()`, `getAllTools()`
- `getToolsExpanded()`, `setToolsExpanded(expanded)`

**Services**

- `provide(name, api, version)`, `consume(name, versionRange)` — publish and resolve versioned services in dependency order

**Commands**

- `registerCommand(command)`, `unregisterCommand(name)`

**Events** (`AtomEvent` values):

- Lifecycle: `extension_load`, `extension_activate`, `extension_unload`, `extension_error`, `session_start`, `session_end`, `session_shutdown`
- Turn: `turn_start`, `turn_end`, `agent_before_settle`, `agent_settled`, `context_build`
- Provider: `before_provider_request`, `after_provider_response`
- Message: `message_start`, `message_end`
- Tools: `tool_call`, `tool_result`, `tool_execution_start`, `tool_execution_end`, `tool_execution_update`
- Settings: `config_change`

- `on(event, handler)` → unsubscribe fn
- `off(event, handler)`

Every dispatch is awaited. A handler settles before the turn advances. For
each extension, `extension_load` fires before `extension_activate`.
`extension_error`, `extension_load`, and `extension_activate` reach sibling
extensions once, after the new extension set is committed.

**Session entries**

- `appendEntry(type, data)`
- `getSessionEntries(filter?)`

**Durable store**

- `pi.store.get(key)` → the stored JSON value, or `undefined`
- `pi.store.set(key, value)` — write a JSON-serializable value
- `pi.store.delete(key)` → boolean
- `pi.store.version` — integer schema version this extension understands; default `1`
- `pi.store.migrate` — optional synchronous hook `(oldVersion, value)`, called once at activation
- `pi.store.archive()` — move the store file to `<id>.json.bak`

See [Durable store](#durable-store) for the file location, size cap, and failure
behavior.

**Status / notify**

- `setStatus(part, value)` (no-op)
- `notify(message, level?)` — level: `"info" | "warning" | "error"`

**Widgets**

- `registerWidget(location, widget)` — location: `"aboveInput" | "belowInput" | "footer"` (no-op)
- `unregisterWidget(id)` (no-op)
- `setWidget(key, content, options?)` — placement: `"aboveEditor" | "belowEditor"` (no-op)

**Renderers / transformers** (no-op)

- `registerToolRenderer(resolver)`, `registerMessageRenderer(customType, renderer)`, `registerEntryRenderer(customType, renderer)`, `registerMarkdownTransformer(transformer)`

**Shortcuts / flags / autocomplete**

- `registerShortcut(shortcut, options)` (no-op), `registerFlag(name, options)` (no-op), `getFlag(name)` (no-op), `addAutocompleteProvider(factory)` (no-op)

**UI chrome** (no-op)

- `setFooter(factory?)`, `setHeader(factory?)`, `setTitle(title)`
- `setWorkingMessage(message?)`, `setWorkingVisible(visible)`, `setWorkingIndicator(options?)`, `setHiddenThinkingLabel(label?)`

**Dialogs**

- `select(title, options)` → `Promise<string | undefined>`
- `confirm(title, message)` → `Promise<boolean>`
- `input(title, placeholder?)` → `Promise<string | undefined>`

**Providers / models**

- `registerProvider(provider)` (reduced), `unregisterProvider(name)`, `registerModel(model)` (no-op)

**Exec / logging**

- `exec(command, args?, options?)` → `Promise<ExecResult>` (cancellable; scope-gated)
- `fetch(url, init?)` → `Promise<Response>` (host-allowlisted proxy)
- `log(message)`

**Observability**

- `span(name, fn)` → `Promise<unknown>`; records the wrapped call's duration and
  `ok`/`error` outcome, then returns its result or re-throws its error.
- `metric(name, value, attrs?)`; records a counter. Attributes stay in memory.

Records are bounded at 1000 per extension and reset on reload. Doctor exposes
counts and the last error only — metric values, attribute payloads, and recorded
span results never appear in diagnostics.

**UI context (`pi.ui`)** — also exposes: `editor`, `onTerminalInput`, `custom`, `pasteToEditor`, `setEditorText`, `getEditorText`, `getTheme`, `setTheme`.

## Diagnostics

`/extensions` lists discovered extensions and load status. `/extensions doctor`
prints per-extension load status, tool/command counts, store entry count and
version, observability counts, and errors. `/extensions doctor --json` prints
an array with, per extension, `id`, `source`, `status`, `error`, `stack`,
`toolCount`, `commandCount`, `eventCount`, `apis` — the matrix entries for API
calls found in that extension's entry file — `store` (`entryCount` and
`version`, never values), `scopeMode` / `scopes` (sandbox classification and
declared scope list), and `lifecycleEvents`, the lifecycle records from that
extension. It also reports `errorCount` and `lastError` for contained failures,
plus `observability` with `spanCount`, `metricCount`, `errorCount`, and
`lastError` for span failures.

The JSON list contains only methods that exist in `ExtensionAPI`. Called Tier 3
methods carry their `unsupported` matrix entry; containment errors include the
method, tier, and alternative when one exists.

## Testing an extension

Run one fixture without a provider, network, or user configuration:

```bash
atom-lite extension test ./extensions/my-extension.js
```

The fixture loads through the normal extension loader with a fake provider,
fake TUI, and fake session. Export a `test` function taking `ctx` to assert on the run:

```js title="my-extension.js"
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

`ctx` provides `assert` (`ok`, `equal`, `match`, `deepEqual`, `rejects`),
`runTurn`, `tools`, `transcript`, `events`, `uiEvents`, `sessionEvents`,
`doctor`, `diagnostic`, `dispatch`, `setResponse`, and `pi` (the API instance
the factory received). `runTurn` asks a fake provider for the assistant text;
the CLI's default echoes `echo:<prompt>`. Programmatic callers pass their own:

```ts
runExtensionTest("./my-extension.js", {
  provider: {
    complete: ({ prompt }) => `mock:${prompt}`,
  },
});
```

Commands exit zero when every assertion passes and no unclaimed extension error
occurs; any failure or unexpected error prints the cause and exits non-zero.

The fault-injection files under `tests/fixtures/extensions/` are the seed of the
conformance suite. A fixture proving that a specific error is contained claims
it with `ctx.diagnostic(/message fragment/)`. That call is an assertion: it
fails when no matching `extension_error` exists, and marks the matched error as
expected. Every other extension error fails the run.

## Migration notes

- Pi extensions using `export default function (pi)` or
  `export async function activate(pi)` work unchanged.
- Pi host module aliases (`pi-tui`, `pi-agent-core`, `pi-ai`, `typebox`,
  `@sinclair/typebox`, and legacy `@mariozechner/*`) resolve to Atom-lite's
  own copies.
- Check the matrix before relying on a method; `no-op` methods are accepted but
  have no effect.

## Lua extensions

Atom-lite also loads `.lua` entrypoints through the in-process extension host. A Lua extension exports an `activate` factory receiving `pi` and may export `test` receiving `ctx` for the extension test harness. Lua tables convert to tool parameter schemas and session data; Lua functions remain callable as tool `execute` handlers, event handlers, and middleware. Asynchronous `ExtensionAPI` methods (`exec`, `fetch`, dialogs, `span`) return promises that Lua code awaits with `:await()` inside extension callbacks.

Discovery, trust, capability scopes, the durable store, services, tool middleware, observability, diagnostics, and reload semantics are identical to JavaScript extensions. Lua module loading is restricted to the extension's own directory.

## Next

- [Commands](./commands.md)
- [Safety](./safety.md)
- [Troubleshooting](./troubleshooting.md)
