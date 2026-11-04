# Contributing to Atom-lite

Thanks for helping improve Atom-lite. This project deliberately keeps a small
core, so the best contributions are focused fixes, tests, documentation, and
provider adapters that fit the existing interfaces.

## Requirements

- Node.js >= 22.19
- npm (the repo tracks `package-lock.json`)

## Setup

```sh
git clone https://github.com/beast-ofcourse/atom-lite.git
cd atom-lite
npm ci
npm run dev        # run from source with tsx
```

## Before opening a pull request

Run the same checks as CI:

```sh
npm run typecheck
npm test
npm audit --omit=dev --audit-level=high
```

`npm run bench` is non-gating but useful when touching tools, startup, or TUI
rendering.

## Guidelines

- **Keep the core small.** New built-in tools need a strong justification
  against [ADR 0001](docs/adr/0001-four-built-in-tools-only.md). Prefer composing
  behavior through `bash` when it is reliable.
- **Add tests.** Behavior changes need coverage under `tests/`. Bug fixes should
  include a regression test where practical.
- **Record architecture decisions.** Structural changes belong in a new ADR under
  `docs/adr/`, following the existing format.
- **Match the surrounding code.** TypeScript strict mode, NodeNext ESM, named
  exports, and no new runtime dependencies without discussion.
- **Use Conventional Commits** (`feat:`, `fix:`, `perf:`, `docs:`, `test:`,
  `chore:`), matching the existing history.
- **Keep secrets out of the repo.** Provider credentials belong in
  `~/.config/atom-lite/credentials.json`, never in tracked files.

## Pull requests

Describe the problem, the approach, and how you verified it. Link the relevant
issue or spec when one exists. Small, reviewable pull requests land fastest.

## Security

Do not report vulnerabilities in public issues. Follow
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the MIT
License.
