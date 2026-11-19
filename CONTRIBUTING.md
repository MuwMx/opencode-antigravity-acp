# Contributing to `opencode-antigravity-acp`

Thanks for your interest in contributing!

## Development Setup

1. Clone the repository and install dependencies with [Bun](https://bun.sh):

   ```bash
   git clone https://github.com/system1970/opencode-antigravity-acp.git
   cd opencode-antigravity-acp
   bun install
   ```

2. Run checks:

   ```bash
   bun run typecheck
   bun test
   bun run build
   ```

3. Test locally in OpenCode by placing or symlinking the repo into `~/.config/opencode/plugins/opencode-antigravity-acp`, then running:

   ```bash
   opencode service restart
   ```

   Remember to rebuild (`bun run build`) whenever editing `src/gui.tsx` so `dist/gui-experimental.cjs` stays up to date.

## Non-Negotiable Architecture & Safety Rules

Pull requests **must** preserve these core invariants:

- **Official ACP only:** Never extract OAuth tokens from Antigravity storage, spoof client headers, or call private Cloud Code HTTP endpoints directly.
- **Strict context allowlist:** Keep `tools.opencode.*` / `session_move` stripped before prompts or MCP tool descriptions reach `agy acp`.
- **Fail-fast on upstream errors:** Do not add automatic retry loops on `429` / quota / permission errors, and never emit retryable stream errors on plugin unload.
- **Zero overhead for non-ACP models:** Do not eagerly spawn `agy acp`, bind `McpRelayServer`, or attach global SSE event streams when other OpenCode providers are in use.
- **Keep `dist/gui-experimental.cjs` updated:** OpenCode loads the prebuilt CommonJS GUI bundle directly.

## Submitting Changes

1. Fork the repository and create a topic branch (`git checkout -b fix/my-change`).
2. Add or update unit tests in `test/` for your changes.
3. Ensure `bun run typecheck`, `bun test`, and `bun run build` all pass.
4. Open a pull request with a clear summary of what changed and how it was tested.
