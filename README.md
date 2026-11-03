# Atom-lite

A minimal-harness, model-agnostic coding agent. One agent loop, four tools (`read`, `write`, `edit`, `bash`), a deterministic scheduler, durable sessions, and explicit safety boundaries.

## Install

```sh
npm install -g atom-lite
```

Or run without installing:

```sh
npx atom-lite "fix the failing test"
```

Requires Node.js >= 20.

## Quick start

```sh
atom-lite                 # interactive session in current directory
atom-lite "task"          # run one task, then exit
atom-lite --provider NAME  # select a provider profile
atom-lite --continue      # resume most recent session
atom-lite --help
```

## Configuration

User config: `~/.config/atom-lite/config.json`
Project config: `.atom-lite/config.json` (non-secrets only)

See `project-overview.md` for the full configuration shape. Secrets must be provided via environment variables (e.g. `ATOM_LITE_*`), never in project config.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT