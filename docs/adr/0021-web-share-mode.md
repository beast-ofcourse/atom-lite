# 0021 — Web share mode

Date: 2026-11-16
Status: Accepted (implemented)
Supersedes: the cross-machine part of 0019
Related: 0019 (web surface)

## Context

ADR 0019 deliberately made the browser surface loopback-only. That boundary is still correct by default: the per-run token, Host/Origin checks, and localhost bind keep a local page from driving the agent. It also makes the web surface awkward to use from a phone. The current workaround requires an SSH client with port forwarding on the phone and copying a long token-bearing URL by hand.

The product needs a convenient path to the same surface from a phone without turning the web server into a LAN service, without accounts, and without weakening the default localhost posture.

## Decision

Add an explicit share mode to the serve command.

- The web server keeps binding `127.0.0.1`. There is no general `--host` flag and no inbound LAN exposure.
- Share mode opens an outbound encrypted tunnel from the host to a public HTTPS hostname. The default provider is `cloudflared`; a custom command can be supplied with a `{port}` placeholder.
- Tunnel commands are tokenized into an executable and arguments and spawned without a shell.
- The server accepts one extra hostname in its Host and Origin checks: the exact hostname published by the tunnel. All other hosts remain forbidden. The per-run token stays mandatory for HTTP and WebSocket requests.
- The command prints a local URL for diagnostics, the shared HTTPS URL with the token, and a terminal QR code. QR rendering is best effort.
- The tunnel process is owned by the serve command. Ctrl-C, SIGTERM, tunnel failure, and an early provider exit close the tunnel and the server together.
- The browser client, protocol, sessions, approvals, and token model are unchanged. The runtime still runs on the developer's machine.

## Consequences

- Phone access is one command and one QR scan. No client-side tunnel app or manual URL copying is needed.
- The published URL and QR code contain the run token. They must be treated as secrets and not pasted into public channels.
- Default `atom-lite --serve` remains loopback-only. Only an explicit share command widens the Host/Origin allowlist, and only for one hostname.
- A third-party tunnel provider sees connection metadata and the token in the URL. This is acceptable because the provider is chosen by the user and the alternative is a directly exposed server. Do not use an untrusted tunnel command.
- Custom commands are not shell scripts. Users needing shell features should wrap their own executable.
- CI coverage uses a fake tunnel command. No test depends on a public tunnel service.

## Alternatives considered

- **LAN bind with HTTPS.** Rejected for the first version: it expands the attack surface, needs certificate management, and still requires the phone to be on the same network.
- **Automatic provider detection.** Rejected for the first version: more moving parts and less predictable failure messages. An explicit override covers other providers.
- **SSH-only documentation.** Rejected as insufficiently convenient, though the SSH tunnel path remains valid for users who prefer it.
