---
name: codex-offload
description: >-
  Conserve Gemini quota by offloading routine implementation, refactoring, test
  authoring, and standard code reviews to GPT-6.2 Sol via codex-bridge
  (profile "fast") in a Win-Win peer workflow. Activate when the user invokes
  /codex-offload or says Gemini quota is low.
---

# Codex Offload (`/codex-offload`)

Shift heavy execution tokens from Antigravity's Gemini model to local **GPT-6.2 Sol** (`profile: "fast"`, `reasoning_effort: "high"`), while keeping Gemini lean as Lead Navigator & Verifier and escalating to **GPT-6.2 Astra** (`profile: "deep"`) only when genuinely needed.

## Role Split (Win-Win Peer Workflow)

1. **Gemini (Lead Navigator & Verifier)**:
   - Align on the goal with the user in concise steps and identify the minimal `focus_files` (`path[:start-end]`).
   - Do **not** draft full implementation patches or micromanage line-by-line instructions in the prompt.
   - Run local test suites, builds, and `git diff --stat` outside Codex's Windows sandbox (nested `spawn` inside Codex sandbox can hit `EPERM`).
   - Surface honest disagreements: if Sol challenges an assumption or proposes a cleaner design, either adopt it cleanly or present both trade-offs briefly to the user.

2. **Codex Sol (`profile: "fast"`, default `gpt-6.2-sol`, `high` effort)**:
   - Owns routine multi-file implementation, test writing, mechanical refactors, and first-pass code reviews.
   - Give it the **goal, context, constraints, and verification expectations**, and invite pushback on risks or simpler alternatives.

3. **Codex Astra (`profile: "deep"`, `gpt-6.2-astra`, `high`–`xhigh`) — Escalate Only When Needed**:
   - Escalate when a task involves tricky concurrency, subtle multi-file bugs after 1–2 failed attempts, major architectural trade-offs, or high-risk security changes.

## Execution Rules in Offload Mode

- **Write mode choice**:
  - Use `mode: "workspace-write"` for routine, well-scoped edits/tests in a clean or tracked Git repo so Gemini can verify directly with `git diff` + tests (saves extra diff-reading & merge turns).
  - Use `mode: "worktree"` for large, speculative, or high-risk refactors where isolated review before merging is safer.
- **Sessions**: Keep one-off tasks `--ephemeral` (`persist_session: false`). Enable `persist_session: true` only when iterating across multiple turns on the same module, and remember to clean up finished bridge sessions via `codex_session`.
- **Review discipline**: Run `codex_review` (`profile: "fast"` for routine changes, `profile: "deep"` for risky changes) for at most 1–2 rounds — fix P0/P1, report P2/P3 without endless polishing loops.
