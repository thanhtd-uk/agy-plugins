---
name: codex-off
description: >-
  Run solo in Antigravity without calling Codex CLI tools (codex_exec,
  codex_review, codex_job, codex_session) for the remainder of the current
  conversation. Activate when the user invokes /codex-off, asks to disable
  Codex for this chat, or wants to proceed solo when Codex quota is exhausted.
---

# Codex Off (`/codex-off`)

Disable all `codex-bridge` tool calls for the **current conversation only** so Antigravity works 100% solo without waiting on or consuming Codex CLI quota.

## Rules

1. **No Codex calls in this session**:
   - Do **not** invoke `codex_exec`, `codex_review`, `codex_job`, or `codex_session` for the rest of this conversation unless the user explicitly asks to re-enable Codex (or invokes `/codex-offload` or `/codex-deep`).
2. **Handle everything natively in Antigravity**:
   - Perform planning, codebase exploration, implementation, local test/build verification, and `git diff` self-review directly with Antigravity's built-in tools and subagents.
3. **Session-scoped only**:
   - Do not modify `~/.gemini/config` or disable the plugin globally; new conversations automatically start back in normal peer mode.
