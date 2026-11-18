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

| Status        | Methods | Meaning                                   |
| ------------- | ------- | ----------------------------------------- |
| `supported`   | 18      | Effect is consumed by the host.           |
| `reduced`     | 7       | Works with limits; see Reduced behavior.  |
| `no-op`       | 21      | Call is accepted; nothing consumes it.    |
| `unsupported` | 7       | Failing stub; see Tier 3.                 |

**`supported`:** `registerTool`, `unregisterTool`, `setActiveTools`,
`getActiveTools`, `getAllTools`, `registerCommand`, `unregisterCommand`, `on`,
`off`, `getToolsExpanded`, `setToolsExpanded`, `select`, `confirm`, `input`,
`getWorkspace`, `getSession`, `isProjectTrusted`, `unregisterProvider`.

**`reduced`:** `appendEntry`, `getSessionEntries`, `notify`, `registerProvider`,
`exec`, `log`, `supports`.

**`no-op`:** `setStatus`, `registerWidget`, `unregisterWidget`,
`registerToolRenderer`, `registerMessageRenderer`, `registerEntryRenderer`,
`registerMarkdownTransformer`, `registerShortcut`, `registerFlag`, `getFlag`,
`addAutocompleteProvider`, `setWidget`, `setFooter`, `setHeader`, `setTitle`,
`setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`,
`setHiddenThinkingLabel`, `getSessionManager`, `registerModel`.

Tier 1 covers discovery, trust, module loading, tools, commands, events,
session entries, dialogs, `exec`, and logging. The `no-op` methods above are
accepted for compatibility but have no effect in this release.

## Reduced behavior

`registerProvider` maps an OpenAI-compatible config into Atom-lite's provider
list. Config keys `oauth`, `streamSimple`, `classifiers`, `refreshModels`, and
`images` emit a reduced-compatibility warning and are not applied.

`appendEntry` and `getSessionEntries` keep entries in the extension's own
registry; no host view reads them. `notify`, `exec`, and `log` run, but their
output is not surfaced in the host UI. `supports(method)` returns `true` for
every method that will not throw a compatibility error, including `no-op`
methods.

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

```ts
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
- `getSessionManager()` → any (currently no-op)
- `isProjectTrusted()` → boolean
- `apiVersion` → string version of this API surface
- `supports(method)` → boolean; `false` for Tier 3 stubs

**Tools**

- `registerTool(tool)`, `unregisterTool(name)`
- `setActiveTools(names)`, `getActiveTools()`, `getAllTools()`
- `getToolsExpanded()`, `setToolsExpanded(expanded)`

**Commands**

- `registerCommand(command)`, `unregisterCommand(name)`

**Events** (`AtomEvent` values: `extension_load`, `extension_activate`, `extension_unload`, `extension_error`, `session_start`, `session_end`, `turn_start`, `turn_end`, `tool_call`, `tool_result`, `message`, `message_start`, `message_end`, `context_build`, `config_change`)

- `on(event, handler)` → unsubscribe fn
- `off(event, handler)`

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

**UI context (`pi.ui`)** — also exposes: `editor`, `onTerminalInput`, `custom`, `pasteToEditor`, `setEditorText`, `getEditorText`, `getTheme`, `setTheme`.

## Diagnostics

`/extensions` lists discovered extensions and load status. `/extensions doctor`
prints per-extension load status, tool/command counts, and errors.
`/extensions doctor --json` prints an array with, per extension, `id`, `source`,
`status`, `error`, `stack`, `toolCount`, `commandCount`, `eventCount`, `apis`
— the matrix entries for API calls found in that extension's entry file — and
`lifecycleEvents`, the lifecycle records from that extension.

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
