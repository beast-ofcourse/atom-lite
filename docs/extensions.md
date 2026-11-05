# Extensions

Atom-lite hosts unmodified Pi coding-agent extensions in-process. See
[ADR-0011](./adr/0011-pi-extensions-in-process.md) for the architectural
decision.

## Supported Pi version

Atom-lite targets the Pi extension API shipped with
`@earendil-works/pi-coding-agent` 1.4.x. The pinned release is recorded in
`package.json` and the alias map in `src/extensions/loader.ts`. To upgrade:

1. Bump the Pi dependency and alias targets.
2. Run `npm run typecheck && npm test`.
3. Run the extension conformance fixtures under `tests/extensions/`.
4. Update the compatibility matrix below.

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

## Compatibility tiers

### Tier 1 — works today

- Discovery and trust
- TypeScript loading without a build step
- Tools, slash commands, and event handlers
- Session entries and session read model
- Status, notifications, dialogs, widgets, and overlays
- `exec` and session inspection
- Provider and model registration (OpenAI-compatible mapping)

### Tier 2 — compatible surface, staged

- Tool, message, and entry renderers
- Markdown transformers
- Keyboard shortcuts and flags
- Autocomplete providers
- Custom footer/header/title
- Working indicator and thinking label

### Tier 3 — deliberately deferred

- Session tree navigation and forks
- Codemode tool exposure
- MCP server registration
- OAuth providers
- `virtualModel`
- RPC mode
- Custom editor components

Tier 3 APIs fail loudly at registration with a clear compatibility error rather
than silently no-oping.

## Reduced compatibility

Some Pi features are accepted but reduced:

- OAuth, `streamSimple`, classifiers, image generation, and `refreshModels`
  are reported as reduced-compatibility warnings.
- Provider registration maps onto Atom-lite's OpenAI-compatible provider
  factory.

## Diagnostics

Use `/extensions` to list discovered extensions and `/extensions doctor` for
per-extension load status, tool/command counts, and errors.

## Migration notes

- Pi extensions using `export default function (pi)` or
  `export async function activate(pi)` work unchanged.
- Pi host module aliases (`pi-tui`, `pi-agent-core`, `pi-ai`, `typebox`,
  `@sinclair/typebox`, and legacy `@mariozechner/*`) resolve to Atom-lite's
  own copies.
- Extensions that depend on Tier 3 APIs fail loudly at registration.
