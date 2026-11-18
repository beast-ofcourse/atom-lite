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

## Compatibility matrix

Each `ExtensionAPI` method has one status. A `supported` method has a host
reader outside `api.ts`; the matrix records its location as `{ file, line }`.
`reduced` methods work with limits. `no-op` methods accept calls but no host
code reads the value. `unsupported` methods are reserved for features with no
implementation.

| Status        | Methods | Meaning                                  |
| ------------- | ------- | ---------------------------------------- |
| `supported`   | 18      | Effect is consumed by the host.          |
| `reduced`     | 8       | Works with limits; see Reduced behavior. |
| `no-op`       | 20      | Call is accepted; nothing consumes it.   |
| `unsupported` | 7       | Failing stub; see Tier 3.                |

**`supported`:** `registerTool`, `unregisterTool`, `setActiveTools`,
`getActiveTools`, `getAllTools`, `registerCommand`, `unregisterCommand`, `on`,
`off`, `getToolsExpanded`, `setToolsExpanded`, `select`, `confirm`, `input`,
`getWorkspace`, `getSession`, `isProjectTrusted`, `unregisterProvider`.

**`reduced`:** `appendEntry`, `getSessionEntries`, `getSessionManager`, `notify`,
`registerProvider`, `exec`, `log`, `supports`.

**`no-op`:** `setStatus`, `registerWidget`, `unregisterWidget`,
`registerToolRenderer`, `registerMessageRenderer`, `registerEntryRenderer`,
`registerMarkdownTransformer`, `registerShortcut`, `registerFlag`, `getFlag`,
`addAutocompleteProvider`, `setWidget`, `setFooter`, `setHeader`, `setTitle`,
`setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`,
`setHiddenThinkingLabel`, `registerModel`.

Tier 1 covers discovery, trust, module loading, tools, commands, events,
session entries, dialogs, `exec`, and logging. The `no-op` methods above are
accepted for compatibility but have no effect in this release.

## Reduced behavior

`registerProvider` maps an OpenAI-compatible config into Atom-lite's provider
list. The host applies `baseUrl`, `apiKey`, `headers`, `authHeader`, and
`models`; identity keys (`name`, `id`, `config`) are ignored. Every other config
key emits a reduced-compatibility warning naming that key and is not applied.

`appendEntry` and `getSessionEntries` persist custom entries in the session
event log and read them back after resume; no host view renders them.
`getSessionManager()` returns a real read model over the live session. `notify`,
`exec`, and `log` run, but their output is not surfaced in the host UI.
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
- `setActiveTools(names)`, `getActiveTools()`, `getAllTools()`
- `getToolsExpanded()`, `setToolsExpanded(expanded)`

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

- `exec(command, args?, options?)` → `Promise<ExecResult>`
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
prints per-extension load status, tool/command counts, and errors.
`/extensions doctor --json` prints an array with, per extension, `id`, `source`,
`status`, `error`, `stack`, `toolCount`, `commandCount`, `eventCount`, `apis`
— the matrix entries for API calls found in that extension's entry file — and
`lifecycleEvents`, the lifecycle records from that extension. It also reports
`errorCount` and `lastError` for contained failures, plus `observability` with
`spanCount`, `metricCount`, `errorCount`, and `lastError` for span failures.

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
`doctor`, `dispatch`, `setResponse`, and `pi` (the API instance
the factory received). Commands exit zero when every assertion passes and no
extension error occurs; any failure or unexpected error prints the cause and
exits non-zero.

The fault-injection files under `tests/fixtures/extensions/` are the seed of the
conformance suite. A fixture that proves a specific error is contained exports
`expectErrors = ["message fragment"]` so that error does not fail the run.

## Migration notes

- Pi extensions using `export default function (pi)` or
  `export async function activate(pi)` work unchanged.
- Pi host module aliases (`pi-tui`, `pi-agent-core`, `pi-ai`, `typebox`,
  `@sinclair/typebox`, and legacy `@mariozechner/*`) resolve to Atom-lite's
  own copies.
- Check the matrix before relying on a method; `no-op` methods are accepted but
  have no effect.

## Next

- [Commands](./commands.md)
- [Safety](./safety.md)
- [Troubleshooting](./troubleshooting.md)
