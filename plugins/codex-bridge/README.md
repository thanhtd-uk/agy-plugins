# Codex Bridge (`codex-bridge`)

Zero-dependency Local Stdio MCP Server (Node.js >= 20, pure ESM) connecting **Antigravity Orchestrator** with your local **Codex CLI** (`codex exec` / `codex exec resume` / `codex exec review`).

## Features

- **Ephemeral by default**: Runs with `--ephemeral` so one-off orchestrator queries do not pollute your personal `~/.codex` session history. Enable `persist_session: true` only when multi-turn `resume` is useful, and clean up via `codex_session`.
- **Safe isolation modes**: Defaults to `read-only`. Supports `worktree` (`--worktree`, isolated Git worktree for diff inspection before merging) and `workspace-write` (direct workspace edits, with per-`cwd` write locking). `danger-full-access` is disabled.
- **Beats Antigravity's 180s MCP timeout**: Waits synchronously up to `145s` (`wait_sec <= 150s`), then seamlessly transitions long runs into a background `job_id` managed via `codex_job` (`wait` long-poll up to `140s`, `status`, `cancel`, `list`).
- **Windows-safe process handling**: Passes prompts over `stdin` (`-`) to avoid the 8191-char command-line limit, spawns `codex.exe` with `shell: false`, reads clean output from `-o <tmpfile>` capped at `<= 8.5 KB`, and terminates process trees with `taskkill /T /F`.
- **Inherits `~/.codex/config.toml`**: Inherits your configured Codex CLI model and `model_reasoning_effort` from `~/.codex/config.toml` unless overridden per call or via `CODEX_BRIDGE_MODEL`.

## Prerequisites

- **Node.js** `>= 20.0.0`
- **Codex CLI** (`codex.exe` on Windows / `codex` on POSIX) installed and signed in (`codex login`)
- **Windows sandbox setting**: In `~/.codex/config.toml`, configure:
  ```toml
  [windows]
  sandbox = "unelevated"
  ```
  Verify with `codex doctor`. Without this setting on Windows, `read-only` shell commands inside Codex CLI can fail with `rejected: blocked by policy`.

## Quick Start on a New Machine

```powershell
git clone https://github.com/thanhtd-uk/agy-plugins.git
cd agy-plugins
npm --prefix plugins/codex-bridge run install:plugin
npm --prefix plugins/codex-bridge run doctor
```

Then reload or start a new Antigravity conversation so the plugin's MCP server and rules are loaded.

## Installation & Diagnostics Commands

Run from `plugins/codex-bridge/`:

```powershell
# Install runtime files to ~/.gemini/config/plugins/codex-bridge and run strict validation
node scripts/install.mjs install

# Check Node, Codex CLI, auth, rules size, and strict plugin validation
node scripts/install.mjs doctor

# Remove installed plugin from ~/.gemini/config/plugins/codex-bridge
node scripts/install.mjs uninstall
```

## MCP Tools (`eager: true`)

| Tool | Purpose | Key Parameters |
| :--- | :--- | :--- |
| `codex_exec` | Run `codex exec` or `codex exec resume` | `cwd` (required abs path), `prompt`, `mode` (`read-only`\|`worktree`\|`workspace-write`), `focus_files`, `context`, `constraints`, `persist_session`, `session_id`, `model`, `reasoning_effort`, `wait_sec`, `max_runtime_sec`, `max_output_chars` |
| `codex_review` | Run ephemeral `read-only` review | `cwd` (required Git repo), `uncommitted` / `base` / `commit`, `title`, `prompt`, `model`, `reasoning_effort`, `wait_sec` |
| `codex_job` | Manage background jobs (>145s) | `action` (`wait`\|`status`\|`cancel`\|`list`), `job_id`, `wait_sec` |
| `codex_session` | Manage bridge-tracked sessions | `action` (`list`\|`archive`\|`delete`), `session_id`, `allow_untracked` |

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CODEX_BRIDGE_BIN` | Auto-detected | Explicit path to `codex.exe` (falls back to `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`, then `PATH`). |
| `CODEX_BRIDGE_GIT_BIN` | Auto-detected | Optional fully qualified path to `git.exe` / `git`. |
| `CODEX_BRIDGE_MODEL` | Inherited from `~/.codex/config.toml` | Default model slug override when tool `model` is omitted. |
| `CODEX_BRIDGE_MAX_JOBS` | `3` | Maximum concurrent Codex jobs (`1..10`). |
| `CODEX_BRIDGE_SESSION_STORE` | `%LOCALAPPDATA%\codex-bridge\sessions.json` | Path to the bridge-owned session ledger. |

## Troubleshooting

- **`rejected: blocked by policy` on Windows**: Add `[windows]` + `sandbox = "unelevated"` to `~/.codex/config.toml` and verify with `codex doctor`.
- **`mode="worktree"` fails on a new repo**: Git requires at least one commit (`HEAD`) before creating worktrees. Make an initial commit or use `mode="workspace-write"`.
- **`Codex CLI executable not found`**: Run `node scripts/install.mjs doctor` or set `CODEX_BRIDGE_BIN` in `mcp_config.json`.
- **Tests**: `npm --prefix plugins/codex-bridge test`
