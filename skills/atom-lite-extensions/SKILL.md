---
name: atom-lite-extensions
description: "Build, load, and debug Atom-lite extensions (Pi-compatible). Use when creating an extension, registering tools/commands/providers, handling events, adding UI widgets, or troubleshooting extension loading. Covers the ExtensionAPI surface, trust, discovery, tiers, and examples."
license: MIT
---

# Atom-lite Extensions

Atom-lite hosts Pi coding-agent extensions in-process. An extension is a
TypeScript/JavaScript module that exports a default (or `activate`) function
receiving an `ExtensionAPI` (`pi`). It registers tools, commands, providers,
models, widgets, and event handlers into Atom-lite's own runtime.

Reference docs:

- [docs/extensions.md](https://github.com/beast-ofcourse/atom-lite/blob/master/docs/extensions.md) — discovery, trust, compatibility matrix, diagnostics.
- [src/extensions/types.ts](https://github.com/beast-ofcourse/atom-lite/blob/master/src/extensions/types.ts) — `ExtensionAPI` types and registries.
- [src/extensions/api.ts](https://github.com/beast-ofcourse/atom-lite/blob/master/src/extensions/api.ts) — runtime implementation.
- [src/extensions/store.ts](https://github.com/beast-ofcourse/atom-lite/blob/master/src/extensions/store.ts) — durable store implementation.
- [src/extensions/compatibility-matrix.ts](https://github.com/beast-ofcourse/atom-lite/blob/master/src/extensions/compatibility-matrix.ts) — generated method status and consumers.
- [tests/extensions/](https://github.com/beast-ofcourse/atom-lite/tree/master/tests/extensions) — extension tests.
- Run `/extensions` and `/extensions doctor --json` inside atom-lite for live diagnostics.

## Minimal extension

```ts
// my-ext.ts
export default function (pi: any) {
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

  pi.on("tool_call", async (event) => {
    // observe every tool call
    pi.log(`tool_call: ${event?.name}`);
  });
}
```

Load it:

```bash
atom-lite -e ./my-ext.ts
```

## Discovery

Extensions are discovered from:

- CLI paths: `-e` / `--extension PATH`.
- Atom-lite user/project extension directories.
- Pi discovery locations and `settings.json` / `package.json` `pi.extensions` manifests.

Project-local extensions are **skipped until the project is trusted**. Interactive
sessions prompt for approval; non-interactive runs skip untrusted ones. Trust
decisions are stored in user config. Check trust with `pi.isProjectTrusted()`.

## Module shape

Both forms are accepted (migration-friendly):

```ts
export default function (pi) {
  /* ... */
}
export async function activate(pi) {
  /* ... */
}
```

Pi host modules are aliased to Atom-lite's own copies, so use Pi-style imports:

```ts
import { Type } from "@sinclair/typebox"; // or "typebox"
import { Text } from "@earendil-works/pi-tui"; // or "pi-tui"
```

Legacy `@mariozechner/*` specifiers also resolve. TypeScript loads without a
build step (via `jiti`).

## Tools

```ts
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What the LLM sees.",
  parameters: {/* JSON Schema / TypeBox */},
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // stream partial output:
    onUpdate?.({ content: [{ type: "text", text: "partial..." }] });
    return {
      content: [{ type: "text", text: "final result" }],
      details: { foo: 1 },
    };
  },
});
pi.unregisterTool("my_tool");
pi.setActiveTools(["my_tool"]);
```

Check the compatibility matrix before relying on a tool method.

## Commands

```ts
pi.registerCommand({
  name: "mycmd",
  description: "Do something",
  argumentHint: "[arg]",
  async run(args, ctx) {
    pi.appendEntry("mycmd_ran", { args });
    const ok = await pi.confirm("Title", "Proceed?");
    const name = await pi.input("Name", "placeholder");
    const choice = await pi.select("Pick", ["a", "b"]);
  },
});
pi.unregisterCommand("mycmd");
```

Commands become `/mycmd` in the palette and support autocomplete. The handler
signature is `run(args, ctx)`.

## Events

```ts
const off = pi.on("tool_call", async (event, ctx) => {
  /* ... */
});
pi.off("tool_call", handler);
```

Valid events (`AtomEvent`): `extension_load`, `extension_activate`,
`extension_unload`, `extension_error`, `session_start`, `session_end`,
`session_shutdown`, `turn_start`, `turn_end`, `agent_before_settle`,
`agent_settled`, `context_build`, `before_provider_request`,
`after_provider_response`, `message_start`, `message_end`, `tool_call`,
`tool_result`, `tool_execution_start`, `tool_execution_end`,
`tool_execution_update`, `config_change`. Tier 3 APIs are failing stubs; check
`pi.supports(name)` before calling one. `supports()` checks the method, not its
arguments.

## UI

```ts
pi.ui.notify("hello", "info");          // info | warning | error
pi.setStatus("myext", "status text");   // undefined clears (no-op)
pi.registerWidget("aboveInput", { id: "my-widget", location: "aboveInput", render: (width) => ["line1"] });
pi.setWidget("key", ["line"], { placement: "aboveEditor" });
pi.setFooter((tui, theme, data) => /* component */);
pi.setHeader((tui, theme) => /* component */);
pi.setTitle("my title");
pi.setWorkingMessage("thinking...");
pi.setWorkingVisible(true);
pi.setWorkingIndicator({ frames: ["⠋","⠙"], intervalMs: 80 });
pi.setHiddenThinkingLabel("reasoning");
pi.getToolsExpanded(); pi.setToolsExpanded(true);
```

`registerWidget`, `setWidget`, `setFooter`, `setHeader`, `setTitle`,
`setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`,
`setHiddenThinkingLabel`, and `setStatus` are `no-op` in the current matrix.

Dialogs: `pi.select`, `pi.confirm`, `pi.input` (shown above).

## Session entries

```ts
pi.appendEntry("custom_type", { foo: 1 });
const entries = pi.getSessionEntries({ type: "custom_type" });
pi.getSessionManager(); // read model over the live session
pi.getSession(); // { id: real session id }
pi.getWorkspace();
```

## Durable store

`pi.store` persists JSON state across restarts and reloads. State lives at
`<agentDir>/extension-state/<id>.json` with shape
`{ "version": 1, "value": { ... } }`. The serialized file is capped at 1 MiB
per extension; exceeding it throws `ExtensionCompatibilityError`.

Set `version` and `migrate` before the first `get`/`set`/`delete`. The host
calls the `pi.store.migrate` hook once at activation when the stored version
is older. A newer stored version throws `ExtensionCompatibilityError` on
`store.migrate`.

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

`pi.store.delete(key)` removes one entry. Uninstall/unregister archives the
file as `<id>.json.bak` (a later archive replaces the old one): call
`pi.store.archive()` or the loader's `archiveStore` method. Doctor reports entry
count and version only, never values.

## Providers & models

```ts
pi.registerProvider({
  name: "myprovider",
  // OpenAI-compatible mapping; OAuth/streamSimple are reduced-compat
});
pi.registerModel({ id: "mymodel", provider: "myprovider" }); // no-op
pi.unregisterProvider("myprovider");
```

## Exec & logging

```ts
const res = await pi.exec("git", ["status"], { cwd: pi.getWorkspace() });
pi.log("debug message");
```

## Shortcuts, flags, autocomplete

```ts
pi.registerShortcut("ctrl+shift+x", {
  description: "do thing",
  handler: async (ctx) => {}, // no-op in the current matrix
});
pi.registerFlag("myflag", { type: "boolean", default: false }); // no-op in the current matrix
const v = pi.getFlag("myflag"); // no-op in the current matrix
pi.addAutocompleteProvider((tui, theme) => ({/* ... */})); // no-op
```

## Renderers (no-op)

```ts
pi.registerToolRenderer((toolName, next) => ({ renderCall, renderResult }));
pi.registerMessageRenderer("custom_type", (message, options, theme) => /* Component */);
pi.registerEntryRenderer("custom_type", (entry, theme) => /* Component */);
pi.registerMarkdownTransformer((markdown) => markdown);
```

## Compatibility tiers

- **Tier 1 (works today):** discovery, trust, module loading, tools, commands, events,
  session entries, durable store, dialogs, `exec`, logging, provider registration.
- **Tier 2 (no-op):** renderers, markdown transformers, shortcuts, flags,
  autocomplete, custom footer/header/title, working indicator, thinking label,
  status, widgets.
- **Tier 3 (failing stubs):** session tree navigation, forks, codemode tool
  exposure, MCP server registration, OAuth providers, RPC mode, custom editors,
  and model factories. Each throws `ExtensionCompatibilityError` naming the
  method, tier, and a replacement. Check `pi.supports(name)` first;
  `pi.apiVersion` identifies the API surface. `supports()` checks method
  availability only: `registerTool` reports `true` but still throws for
  `exposure: "codemode"`.

Provider config keys outside the mapped set (`baseUrl`, `apiKey`, `headers`,
`authHeader`, `models`) and identity keys (`name`, `id`, `config`) emit a
reduced-compatibility warning naming the key and are not applied.

## Diagnostics

Inside atom-lite:

- `/extensions` — list discovered extensions + load status.
- `/extensions doctor` — per-extension tools/commands/store count and version/errors.
- `/extensions doctor --json` — id, source, status, error with stack, counts,
  store entry count and version (never values), and the matrix entry for every
  API the extension calls.

## Tips

- Keep extensions dependency-free or bundle deps; host aliases cover Pi modules.
- Use `pi.store` for extension state that must survive restart; use
  `pi.appendEntry` for session entries. Neither needs module globals.
- Trust project extensions before they load (`pi.isProjectTrusted()`).
- Reload with `/reload` (or restart) after edits; module caching is disabled.
- See [tests/extensions/](https://github.com/beast-ofcourse/atom-lite/tree/master/tests/extensions) for runnable examples.

## Links

- Docs: [docs/extensions.md](https://github.com/beast-ofcourse/atom-lite/blob/master/docs/extensions.md)
- Types: [src/extensions/types.ts](https://github.com/beast-ofcourse/atom-lite/blob/master/src/extensions/types.ts)
- Runtime: [src/extensions/](https://github.com/beast-ofcourse/atom-lite/tree/master/src/extensions)
- Matrix: [src/extensions/compatibility-matrix.ts](https://github.com/beast-ofcourse/atom-lite/blob/master/src/extensions/compatibility-matrix.ts)
