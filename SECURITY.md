# Security Policy

## Architecture Threat Model

`opencode-antigravity-acp` runs entirely locally on your machine:

- **Stdio child process:** Spawns Google's official `agy acp --stdio --process-per-session` binary as the current user.
- **Loopback MCP relay:** Binds an ephemeral TCP port strictly on `127.0.0.1` only while an ACP session is active, protected by a per-process 24-byte random `Authorization: Bearer <token>` header.
- **Prompt boundary sanitization:** Strips internal OpenCode control signatures (`tools.opencode.*`, `session_move`) before forwarding context or tool schemas.

## Reporting a Vulnerability

If you discover a security issue (such as token exposure, unintended network binding, or cross-session leakage), please avoid posting sensitive details in a public issue. Open a private security advisory on GitHub (`Security` -> `Advisories` -> `Report a vulnerability`) or contact the maintainer directly.
