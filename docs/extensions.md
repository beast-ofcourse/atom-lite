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
session entries, dialogs, `exec`, logging, and the durable store. The `no-op`
methods above are accepted for compatibility but have no effect in this release.

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
`<id>.json.bak`. A later archive replaces the previous backup. Call
`pi.store.archive()` from the extension, or the loader's `archiveStore` method
when the host removes an extension.

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

- `exec(command, args?, options?)` → `Promise<ExecResult>`
- `log(message)`

**UI context (`pi.ui`)** — also exposes: `editor`, `onTerminalInput`, `custom`, `pasteToEditor`, `setEditorText`, `getEditorText`, `getTheme`, `setTheme`.

## Diagnostics

`/extensions` lists discovered extensions and load status. `/extensions doctor`
prints per-extension load status, tool/command counts, store entry count and
version, and errors. `/extensions doctor --json` prints an array with, per
extension, `id`, `source`, `status`, `error`, `stack`, `toolCount`,
`commandCount`, `eventCount`, `apis` — the matrix entries for API calls found in
that extension's entry file — `store` (`entryCount` and `version`, never
values), and `lifecycleEvents`, the lifecycle records from that extension.

The JSON list contains only methods that exist in `ExtensionAPI`. Called Tier 3
methods carry their `unsupported` matrix entry; containment errors include the
method, tier, and alternative when one exists.

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
