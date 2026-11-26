---
name: codex-deep
description: >-
  Run a read-only peer architectural critique, second-opinion debate, or
  hard-bug diagnosis with GPT-6.2 Astra (profile "deep") via codex-bridge
  before editing files. Activate when the user invokes /codex-deep or asks
  for a deep Astra consultation.
---

# Codex Deep (`/codex-deep`)

Consult **GPT-6.2 Astra** (`profile: "deep"`, `reasoning_effort: "high"`, or `"xhigh"` for stubborn concurrency/edge-case bugs) as an independent senior peer **before** making edits.

## Workflow

1. **Strictly read-only first**:
   - Call `codex_exec` with `mode: "read-only"`, `profile: "deep"`, and `reasoning_effort: "high"` (or `"xhigh"` for especially hard bugs). Do **not** modify any files until the user reviews the options and decides.
2. **Peer debate handoff**:
   - Pass minimal `focus_files` (`path[:start-end]`), constraints, and Gemini's preliminary hypothesis or design framing in concise English.
   - Explicitly ask Astra to challenge weak assumptions, expose hidden edge cases/risks, and propose cleaner alternatives.
   - If the run exceeds 145s, long-poll cleanly via `codex_job({ action: "wait", job_id })`.
3. **Surface both perspectives to the user**:
   - Synthesize agreements, blind spots Astra caught, and — whenever Gemini and Astra disagree on a material trade-off — present a concise 2-column comparison so the user makes the final call.
4. **Quota fallback**:
   - If Astra fails with `quota_limited: true`, inform the user briefly and complete the deep analysis solo in Antigravity without retrying Codex.
