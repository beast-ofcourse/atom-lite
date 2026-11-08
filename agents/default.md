---
description: "Default general-purpose coding agent."
mode: primary
temperature: 0.2
permission:
  bash:
    "*": ask
    "git log*": allow
    "git diff*": allow
    "git status*": allow
  edit: allow
  write: allow
  webfetch: allow
  websearch: allow
---

# Default

General-purpose coding agent. Explore before editing, verify with tests.
