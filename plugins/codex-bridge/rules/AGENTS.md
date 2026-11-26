# Codex Bridge (`codex_exec`, `codex_review`, `codex_job`, `codex_session`)

Pair with Codex CLI as peer engineers (win-win):
- **Gemini (Navigator)**: holds intent, picks `focus_files`, runs tests outside Windows sandbox.
- **Codex (Senior Peer)**: owns scoped work/review, challenges weak assumptions, flags cleaner paths/edge cases.
- **Goal-first handoff**: pass `cwd`, `focus_files`, goal, constraints in lean English; no micromanagement. Adopt valid pushback or show both trade-offs to user.

## Profiles (decoupled from `~/.codex/config.toml`; default `high` effort)
- **`profile: "fast"` (default, GPT-6.2 Sol)**: quick second opinions, routine reviews/edits/tests, fast offload.
- **`profile: "deep"` (GPT-6.2 Astra; `xhigh`/`ultra` for hardest bugs)**: major architecture, `/codex-deep`, after 1-2 failed fixes, high-risk work.

## Modes, Slash Skills & Fallback
- **Skills**: `/codex-offload` (offload work to Codex: `fast` routine, `deep` complex/requested; `workspace-write` routine / `worktree` risky), `/codex-deep` (read-only Astra debate), `/codex-off` (solo AGY, no `codex_*`).
- **Quota fallback**: if `quota_limited: true`, tell user briefly and continue solo in AGY without retrying.
- **Safety & sessions**: default `read-only`; `worktree` needs HEAD commit (resume via `worktree.path` + `workspace-write`). Cap reviews at 1-2 rounds; default ephemeral; `persist_session: true` only for loops; wait >145s via `codex_job`.
