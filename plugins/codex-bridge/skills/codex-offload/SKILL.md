---
name: codex-offload
description: >-
  Conserve Gemini quota by offloading most execution (implementation,
  refactoring, test authoring, and code reviews) to Codex CLI via codex-bridge
  with flexible tier/model selection (fast, deep, or user-specified model) in a
  Win-Win peer workflow. Activate when the user invokes /codex-offload or says
  Gemini quota is low.
---

# Codex Offload (`/codex-offload`)

Shift heavy execution tokens from Antigravity's Gemini model to local **Codex CLI**, keeping Gemini lean as Lead Navigator & Verifier while selecting the right Codex tier (`fast`, `deep`, or an explicit model/effort override) for each task.

## Role Split (Win-Win Peer Workflow)

1. **Gemini (Lead Navigator & Verifier)**:
   - Align on the goal with the user in concise steps and identify the minimal `focus_files` (`path[:start-end]`).
   - Do **not** draft full implementation patches or micromanage line-by-line instructions in the prompt.
   - Run local test suites, builds, and `git diff --stat` outside Codex's Windows sandbox (nested `spawn` inside Codex sandbox can hit `EPERM`).
   - Surface honest disagreements: if Codex challenges an assumption or proposes a cleaner design, either adopt it cleanly or present both trade-offs briefly to the user.

2. **Codex Peer — Flexible Tier & Model Routing**:
   - **User override first**: If the user specifies a tier or model (e.g., `/codex-offload deep ...`, `/codex-offload astra ...`, or a custom `model` / `reasoning_effort`), honor it directly.
   - **Routine work (`profile: "fast"`, default `gpt-6.2-sol`, `high`)**: Use for standard multi-file implementation, test authoring, mechanical refactors, and first-pass code reviews to maximize speed and conserve Codex quota.
   - **Complex / high-risk work (`profile: "deep"`, `gpt-6.2-astra`, `high`–`xhigh`)**: Pick `deep` **upfront** (without waiting for `fast` to fail) for major architectural changes, subtle concurrency/multi-file bugs, or security-critical/core edits.

## Execution Rules in Offload Mode

- **Write mode choice**:
  - Use `mode: "workspace-write"` for routine, well-scoped edits/tests in a clean or tracked Git repo so Gemini can verify directly with `git diff` + tests (saves extra diff-reading & merge turns).
  - Use `mode: "worktree"` for large, speculative, or high-risk refactors where isolated review before merging is safer.
- **Sessions & Quota fallback**:
  - Keep one-off tasks `--ephemeral` (`persist_session: false`); enable `persist_session: true` only for multi-turn iterations (cleaning up finished sessions via `codex_session`).
  - If Codex fails with `quota_limited: true`, inform the user briefly and finish the task solo in Antigravity without retrying.
- **Review discipline**: Run `codex_review` (`fast` for routine diffs, `deep` for risky/complex diffs) for at most 1–2 rounds — fix P0/P1, report P2/P3 without endless polishing loops.
