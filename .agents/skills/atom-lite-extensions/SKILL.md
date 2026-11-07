---
name: atom-lite-extensions
description: "Build, load, and debug Atom-lite extensions (Pi-compatible). Use when creating an extension, registering tools/commands/providers, handling events, adding UI widgets, or troubleshooting extension loading. Covers the ExtensionAPI surface, trust, discovery, tiers, and examples."
license: MIT
---

# Atom-lite Extensions

Atom-lite hosts **unmodified Pi coding-agent extensions in-process**. An
extension is a TypeScript/JavaScript module that exports a default (or
`activate`) function receiving an `ExtensionAPI` (`pi`). It registers tools,
commands, providers, models, widgets, and event handlers into Atom-lite's own
runtime.

Reference docs:

- `docs/extensions.md` — discovery, trust, compatibility tiers, diagnostics.
- `docs/adr/0011-pi-extensions-in-process.md` — architecture.
- `src/extensions/types.ts` — full `ExtensionAPI` + registries.
- `src/extensions/api.ts` — runtime implementation.
- `tests/extensions/` — conformance fixtures.
- Run `/extensions` and `/extensions doctor` inside atom-lite for live diagnostics.

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
    async run(ctx, args) {
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
# or place under .agents/skills? no — extensions live in extension dirs, see Discovery
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
  // optional custom rendering (Tier 2):
  renderCall: (args, theme, context) => new Text(`call ${args}`),
  renderResult: (result, options, theme, context) =>
    new Text(result.content[0]?.text ?? ""),
});
pi.unregisterTool("my_tool");
pi.setActiveTools(["my_tool"]);
```

## Commands

```ts
pi.registerCommand({
  name: "mycmd",
  description: "Do something",
  argumentHint: "[arg]",
  async run(ctx, args, raw) {
    pi.appendEntry("mycmd_ran", { args });
    const ok = await pi.confirm("Title", "Proceed?");
    const name = await pi.input("Name", "placeholder");
    const choice = await pi.select("Pick", ["a", "b"]);
  },
});
pi.unregisterCommand("mycmd");
```

Commands become `/mycmd` in the palette and support autocomplete.

## Events

```ts
const off = pi.on("assistant_delta", async (event, ctx) => {
  /* ... */
});
pi.off("assistant_delta", handler);
```

Common events (AtomEvent): `extension_load`, `extension_activate`,
`extension_unload`, `extension_error`, `session_start`, `session_end`,
`turn_start`, `turn_end`, `tool_call`, `tool_result`, `message`,
`message_start`, `message_end`, `context_build`, `config_change`.
Tier 3 events (session tree, forks) fail loudly.

## UI

```ts
pi.ui.notify("hello", "info");          // info | warning | error
pi.setStatus("myext", "status text");   // undefined clears
pi.registerWidget("above", { id: "above", location: "aboveInput", render: (w) => ["line1"] });
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

Dialogs: `pi.select`, `pi.confirm`, `pi.input` (shown above).

## Session entries

```ts
pi.appendEntry("custom_type", { foo: 1 });
const entries = pi.getSessionEntries({ type: "custom_type" });
pi.getSessionManager(); // read model
pi.getSession(); // { id }
pi.getWorkspace();
```

## Providers & models

```ts
pi.registerProvider({
  name: "myprovider",
  // OpenAI-compatible mapping; OAuth/streamSimple are reduced-compat
});
pi.registerModel({ id: "mymodel", provider: "myprovider", ... });
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
  handler: async (ctx) => {},
});
pi.registerFlag("myflag", { type: "boolean", default: false });
const v = pi.getFlag("myflag");
pi.addAutocompleteProvider((tui, theme) => ({/* ... */}));
```

## Renderers (Tier 2)

```ts
pi.registerToolRenderer((toolName, next) => ({ renderCall, renderResult }));
pi.registerMessageRenderer("custom_type", (message, options, theme) => /* Component */);
pi.registerEntryRenderer("custom_type", (entry, theme) => /* Component */);
pi.registerMarkdownTransformer((markdown) => markdown);
```

## Compatibility tiers

- **Tier 1 (works today):** discovery, trust, TS loading, tools, commands, events,
  session entries/read model, status/notify/dialogs/widgets/overlays, exec,
  provider/model registration (OpenAI-compatible).
- **Tier 2 (staged):** renderers, markdown transformers, shortcuts, flags,
  autocomplete, custom footer/header/title, working indicator, thinking label.
- **Tier 3 (deferred, fail loudly):** session tree/forks, codemode, MCP server
  registration, OAuth providers, virtualModel, RPC mode, custom editors.

Reduced-compat features (OAuth, `streamSimple`, classifiers, image generation,
`refreshModels`) emit warnings rather than failing.

## Diagnostics

Inside atom-lite:

- `/extensions` — list discovered extensions + load status.
- `/extensions doctor` — per-extension tools/commands/errors.

## Tips

- Keep extensions dependency-free or bundle deps; host aliases cover Pi modules.
- Use `pi.appendEntry` for persisted state instead of module globals.
- Trust project extensions before they load (`pi.isProjectTrusted()`).
- Reload with `/reload` (or restart) after edits; module caching is disabled.
- Test against `tests/extensions/` conformance fixtures.

## Links

- Docs: `docs/extensions.md`
- ADR: `docs/adr/0011-pi-extensions-in-process.md`
- Types: `src/extensions/types.ts`
- Runtime: `src/extensions/`
- Pi extension API reference (installed): `~/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
  EOF
  echo "written"
