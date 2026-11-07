# Security policy

## Supported versions

Security fixes are provided for the latest published release line.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's security advisory flow:

<https://github.com/beast-ofcourse/atom-lite/security/advisories/new>

Do not open a public issue, discussion, or pull request for an undisclosed
vulnerability.

Include as much of the following as you can:

- affected version (`atom-lite --version`) and platform
- a description of the impact and the attacker's capabilities
- reproduction steps or a minimal proof of concept
- relevant configuration, provider, and approval mode
- any suggested fix or mitigation

## What to expect

- We aim to acknowledge reports within three business days.
- We will confirm the issue, agree on a disclosure timeline, and credit reporters
  who want attribution.
- Please give us a reasonable window to ship a fix before public disclosure.

## Scope

Reports are especially relevant when they affect:

- workspace path boundaries or symlink escapes
- approval-mode enforcement or shell-command approval bypasses
- credential storage, redaction, or accidental secret logging
- prompt-injection paths that lead to unauthorized tool execution
- session files or configuration parsing

Issues in third-party providers or model endpoints should be reported to those
projects; we will still help coordinate when Atom-lite is affected.
