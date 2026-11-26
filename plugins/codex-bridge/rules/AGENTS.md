# Codex Bridge (`codex_exec`, `codex_review`, `codex_job`, `codex_session`)

Partner with local Codex CLI for second opinions, hard bugs, isolated edits, and reviews.

- **Call proactively (bounded)**: Call `codex_exec` (`read-only`) before major architecture choices or after 1–2 failed fixes, and `codex_review` (`uncommitted: true`) after large/risky edits. Skip trivial tasks. Cap review loops at 1–2 rounds (fix P0/P1; report P2/P3, do not loop).
- **Lean English handoff**: Pass absolute `cwd`, `focus_files` (`path[:start-end]`), and brief `context`/`constraints` in concise English (except non-English copy) so Codex reads disk directly; reply in the user's language.
- **Safe `mode` & Windows tests**: Default `read-only`. Prefer `worktree` in Git repos with commits (review diff before merging); use `workspace-write` for fast edits or non-git/unborn repos. Run test suites yourself outside Codex's Windows sandbox (nested `spawn` hits `EPERM`).
- **Sessions**: Default ephemeral. Enable `persist_session: true` for multi-turn loops; to resume a worktree, pass `cwd: <worktree.path>` + `workspace-write` (not `worktree`), then clean up via `codex_session`.
- **Effort**: Omit `model`/`reasoning_effort` to inherit `~/.codex/config.toml` defaults, or pick `low`/`medium` (quick/small), `high` (normal), `xhigh`/`max`/`ultra` (hard).
- **Jobs (>145s)**: If `status: "running"`, long-poll via `codex_job({ action: "wait", job_id })` instead of tight `status` loops.
