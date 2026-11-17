# Domain docs

How agents should read this repository's documentation before exploring code.

## Before exploring

- **`docs/config.md`** — config fields, defaults, and scope when the work touches configuration.
- **`docs/README.md`** — the public documentation map and page ownership.
- **`docs/adr/`** — private architecture decision records. They exist only in maintainer checkouts and are ignored by git. If the directory is absent, skip it silently.

Architecture rationale that needs to be visible to users belongs in the relevant public page, not only in an ADR.

## File structure

Single-context repo:

```text
/
├── docs/                 # published documentation
│   ├── README.md         # documentation index
│   ├── agents/           # agent workflow conventions (internal)
│   ├── adr/              # private, gitignored
│   └── <topic>.md        # one public topic per page
└── src/
```

## Vocabulary

Use the terms the code, README, and public docs already use when naming a concept in an issue, refactor proposal, hypothesis, or test. Do not invent synonyms.

If a concept has no established name, treat that as a signal: reconsider the name, or record a documentation gap.

## Conflicts

If a change contradicts a private ADR, or a public page disagrees with code, surface the conflict explicitly. Do not silently override either one.
