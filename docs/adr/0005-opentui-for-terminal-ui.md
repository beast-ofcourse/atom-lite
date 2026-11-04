# OpenTUI for the terminal UI

**Status:** Superseded by [ADR 0007](./0007-pi-tui-replaces-opentui.md).

Atom-lite uses OpenTUI (rather than readline + a hand-rolled renderer, or Ink/React-based TUIs) for its interactive terminal interface, including streaming output, tool status, and approval prompts.

Chosen over Ink to avoid pulling React into a non-React CLI; chosen over a pure readline approach because live streaming tool status and approval UX benefit from a real TUI framework. OpenTUI's dependency footprint and rendering model are the accepted trade-off.
