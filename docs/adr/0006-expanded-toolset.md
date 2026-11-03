# Expanded built-in toolset (webfetch, websearch)

ADR-0001 originally limited Atom-lite to four built-in tools. The product now also ships `webfetch` and `websearch` as built-in tools, because network access (fetching docs, searching the web) is a core capability for a coding agent and cannot be reliably composed through `bash` alone (HTML→markdown conversion, anonymous search, output caps).

The original four remain the core; `webfetch`/`websearch` are additive. They are always on by default but respect the same validation, output-cap, and cancellation rules as the other tools. `grep`/`glob` are deferred (use `bash` with `rg`/`find` for now).