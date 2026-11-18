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

- `docs/extensions.md` — discovery, trust, compatibility matrix, diagnostics.
- `src/extensions/types.ts` — `ExtensionAPI` types and registries.
- `src/extensions/api.ts` — runtime implementation.
- `src/extensions/compatibility-matrix.ts` — generated method status and consumers.
- `tests/extensions/` — extension tests.
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
`turn_start`, `turn_end`, `tool_call`, `tool_result`, `message`, `message_start`,
`message_end`, `context_build`, `config_change`. Tier 3 features are not
implemented.

## UI

```ts
pi.ui.notify("hello", "info");          // info | warning | error
pi.setStatus("myext", "status text");   // undefined clears (no-op)
pi.registerWidget("aboveInput", { id: "above", location: "aboveInput", render: (w) => ["line1"] });
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
pi.getSessionManager(); // no-op in the current matrix
pi.getSession(); // { id }
pi.getWorkspace();
```

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
pi.registerFlag("myflag", { type: "boolean", default: false });
const v = pi.getFlag("myflag");
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
  session entries, dialogs, `exec`, logging, provider registration.
- **Tier 2 (no-op):** renderers, markdown transformers, shortcuts,
  autocomplete, custom footer/header/title, working indicator, thinking label,
  status, widgets.
- **Tier 3 (not implemented):** session tree navigation, forks, codemode,
  MCP server registration, OAuth providers, RPC mode, custom editors. These
  methods are absent from `ExtensionAPI`.

Reduced-compat provider keys (`oauth`, `streamSimple`, `classifiers`, image
generation, `refreshModels`) emit warnings rather than failing.

## Diagnostics

Inside atom-lite:

- `/extensions` — list discovered extensions + load status.
- `/extensions doctor` — per-extension tools/commands/errors.
- `/extensions doctor --json` — id, source, status, error with stack, counts,
  and the matrix entry for every API the extension calls.

## Tips

- Keep extensions dependency-free or bundle deps; host aliases cover Pi modules.
- Use `pi.appendEntry` for persisted state instead of module globals.
- Trust project extensions before they load (`pi.isProjectTrusted()`).
- Reload with `/reload` (or restart) after edits; module caching is disabled.
- See `tests/extensions/` for runnable examples.

## Links

- Docs: `docs/extensions.md`
- Types: `src/extensions/types.ts`
- Runtime: `src/extensions/`
- Matrix: `src/extensions/compatibility-matrix.ts`
