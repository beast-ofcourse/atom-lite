# Four built-in tools only

Atom-lite exposes exactly four built-in tools — `read`, `write`, `edit`, and `bash` — and no others in v1. File discovery, search, tests, Git, builds, and other workflows happen through `bash`, not through additional tools.

This keeps the action surface small and general, and prevents the core from becoming a tool ecosystem. New tools require a strong justification against the "small core" principle.