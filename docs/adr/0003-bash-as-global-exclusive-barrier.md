# `bash` is a global exclusive barrier, serial by default

Any `bash` call waits for active file operations, runs alone with a workspace-wide exclusive lock, and completes before conflicting operations continue. Arbitrary shell commands have unknown side effects, so their read/write behavior is never inferred from the command string.

This is a deliberate deviation from running independent commands concurrently. An advanced config may allow concurrent shells, but only when explicitly enabled and documented as potentially unsafe.
