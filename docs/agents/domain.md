# Domain Docs

How contributors should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`docs/adr/`**: read ADRs that touch the area you're about to work in.
- **`docs/configuration.md`**: config fields and defaults, when the work touches configuration.

If any of these files don't exist, proceed silently.

## File structure

Single-context repo:

```
/
├── docs/
│   ├── adr/
│   └── configuration.md
└── src/
```

## Use the project's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term the code, README, and ADRs use. Don't invent synonyms for concepts the project already names.

If the concept you need isn't established yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it as a documentation gap).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding.
