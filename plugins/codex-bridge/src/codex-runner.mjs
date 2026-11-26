import { execFile, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STDERR_TAIL_MAX_CHARS,
  isTestMode,
  resolveGitBinary,
  resolvePowershellBinary,
  resolveTaskkillBinary,
} from './config.mjs';
import { composeCustomTargetReviewPrompt, composeExecPrompt } from './handoff.mjs';

/** Builds CLI argument vector for `codex exec` and `codex exec resume`. */
export function buildCodexExecArgs(spec, tmpOutputPath) {
  const sandboxMode = spec.mode === 'read-only' ? 'read-only' : 'workspace-write';
  const args = ['exec', '-C', spec.cwd, '-s', sandboxMode];

  if (spec.isResume) {
    args.push('resume');
  }
  if (spec.mode === 'worktree') {
    args.push('--worktree');
  }
  if (!spec.isResume && !spec.persist_session) {
    args.push('--ephemeral');
  }
  if (spec.skipGitRepoCheck) {
    args.push('--skip-git-repo-check');
  }
  if (spec.model) {
    args.push('-m', spec.model);
  }
  if (spec.reasoning_effort) {
    args.push('-c', `model_reasoning_effort="${spec.reasoning_effort}"`);
  }
  if (!spec.isResume) {
    args.push('--color', 'never');
  }
  args.push('--json', '-o', tmpOutputPath);
  if (spec.isResume) {
    args.push(spec.session_id);
  }
  args.push('-');
  return args;
}

/**
 * Builds CLI args + stdin prompt for `codex_review`.
 * When both a git target (--uncommitted/--base/--commit) and a custom prompt are
 * given, falls back to `codex exec -s read-only --ephemeral` because
 * codex-cli 0.164.0 forbids combining those flags with positional [PROMPT].
 */
export function buildCodexReviewInvocation(spec, tmpOutputPath) {
  const hasTargetFlag = Boolean(spec.uncommitted || spec.base || spec.commit);
  if (hasTargetFlag && spec.prompt) {
    const args = ['exec', '-C', spec.cwd, '-s', 'read-only', '--ephemeral'];
    if (spec.model) {
      args.push('-m', spec.model);
    }
    if (spec.reasoning_effort) {
      args.push('-c', `model_reasoning_effort="${spec.reasoning_effort}"`);
    }
    args.push('--color', 'never', '--json', '-o', tmpOutputPath, '-');
    return {
      args,
      stdinPrompt: composeCustomTargetReviewPrompt(spec),
      usedExecFallback: true,
    };
  }

  const args = ['exec', '-C', spec.cwd, '-s', 'read-only', 'review', '--ephemeral'];
  if (spec.uncommitted) {
    args.push('--uncommitted');
  } else if (spec.base) {
    args.push('--base', spec.base);
  } else if (spec.commit) {
    args.push('--commit', spec.commit);
  }
  if (spec.title) {
    args.push('--title', spec.title);
  }
  if (spec.model) {
    args.push('-m', spec.model);
  }
  if (spec.reasoning_effort) {
    args.push('-c', `model_reasoning_effort="${spec.reasoning_effort}"`);
  }
  args.push('--json', '-o', tmpOutputPath);
  if (spec.prompt) {
    args.push('-');
  }
  return {
    args,
    stdinPrompt: spec.prompt ? `${spec.prompt}\n` : null,
    usedExecFallback: false,
  };
}

/** Builds CLI args + stdin prompt for any validated exec or review spec. */
export function buildCodexInvocation(spec, tmpOutputPath) {
  if (spec.kind === 'review') {
    return buildCodexReviewInvocation(spec, tmpOutputPath);
  }
  return {
    args: buildCodexExecArgs(spec, tmpOutputPath),
    stdinPrompt: composeExecPrompt(spec),
    usedExecFallback: false,
  };
}

/** Parses a single `--json` JSONL line from Codex CLI stdout into state. */
export function parseJsonlLine(line, state) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return;
  }
  let evt;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    return;
  }

  state.events_count += 1;
  state.last_activity_at = new Date().toISOString();
  if (typeof evt.type === 'string') {
    state.last_event = evt.type;
  }

  const sid =
    evt.thread_id ||
    evt.session_id ||
    (evt.thread && typeof evt.thread.id === 'string' ? evt.thread.id : null);
  if (typeof sid === 'string' && sid.trim()) {
    state.session_id = sid.trim();
  }

  if (typeof evt.worktree_path === 'string' && evt.worktree_path.trim()) {
    state.worktree_path = evt.worktree_path.trim();
  }

  if (evt.usage && typeof evt.usage === 'object') {
    state.usage = evt.usage;
  }

  if (
    evt.type === 'item.completed' &&
    evt.item &&
    evt.item.type === 'agent_message' &&
    typeof evt.item.text === 'string'
  ) {
    state.last_agent_message = evt.item.text;
  } else if (typeof evt.last_agent_message === 'string') {
    state.last_agent_message = evt.last_agent_message;
  }
}

export function hasPolicyBlockMarker(text) {
  return typeof text === 'string' && /rejected:\s{0,16}blocked by policy/i.test(text);
}

function normalizeFsPathForCompare(p) {
  const resolved = path.resolve(p);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    canonical = resolved;
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** Resolves fallback worktree path only when the run succeeded and a sole new worktree appeared. */
export function resolveFallbackWorktreePath(beforeWorktrees, afterWorktrees, options = {}) {
  const { runSucceeded = true } = options;
  if (!Array.isArray(beforeWorktrees) || !Array.isArray(afterWorktrees)) {
    return { path: null, ambiguous: false, baselineFailed: true, candidates: [] };
  }
  const beforeSet = new Set(beforeWorktrees);
  const added = afterWorktrees.filter((p) => !beforeSet.has(p));
  if (!runSucceeded) {
    return {
      path: null,
      ambiguous: added.length > 0,
      baselineFailed: false,
      candidates: added,
    };
  }
  if (added.length === 1) {
    return { path: added[0], ambiguous: false, baselineFailed: false, candidates: added };
  }
  if (added.length > 1) {
    return { path: null, ambiguous: true, baselineFailed: false, candidates: added };
  }
  return { path: null, ambiguous: false, baselineFailed: false, candidates: [] };
}

/** Lists existing canonicalized git worktree paths for a repository (returns null on failure). */
export function listGitWorktrees(cwd, env = process.env) {
  const gitBin = resolveGitBinary(env);
  if (!gitBin) {
    return null;
  }
  try {
    const out = execFileSync(gitBin, ['worktree', 'list', '--porcelain'], {
      cwd,
      timeout: 3000,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const paths = [];
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        paths.push(normalizeFsPathForCompare(line.slice('worktree '.length).trim()));
      }
    }
    return paths;
  } catch {
    return null;
  }
}

/** Summarizes git status & diff stat inside an isolated worktree for review. */
export function summarizeWorktree(worktreePath, env = process.env) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return null;
  }
  const gitBin = resolveGitBinary(env);
  if (!gitBin) {
    return { path: worktreePath, status: '', diff_stat: '' };
  }
  const runGit = (args) => {
    try {
      return execFileSync(gitBin, args, {
        cwd: worktreePath,
        timeout: 3000,
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return '';
    }
  };
  return {
    path: worktreePath,
    status: runGit(['status', '--short']).slice(0, 1500),
    diff_stat: runGit(['diff', '--stat']).slice(0, 1500),
  };
}

/** Classifies whether a taskkill failure strictly indicates the target root PID no longer exists. */
export function isTaskkillRootNotFoundError(err, stdout, stderr, pid) {
  if (!err || err.killed || err.signal || typeof err.code === 'string') {
    return false;
  }
  if (String(stdout || '').trim() !== '') {
    return false;
  }
  if (typeof err.code === 'number') {
    return err.code === 128;
  }
  if (err.code !== undefined) {
    return false;
  }
  const escapedPid = String(pid).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const notFoundRe = new RegExp(
    `^\\s*ERROR:\\s+The\\s+process\\s+"?${escapedPid}"?\\s+not\\s+found\\.?\\s*$`,
    'i'
  );
  return notFoundRe.test(String(stderr || ''));
}

/** Queries live direct Windows descendant PIDs via trusted System32 powershell.exe. */
export function findWindowsDescendants(pid, options = {}) {
  const {
    env = process.env,
    timeoutMs = 2500,
    spawnedAtMs = null,
    execFileFn = execFile,
    powershellBin,
  } = options;

  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return Promise.resolve({ ok: true, pids: [] });
  }

  const psBin = powershellBin !== undefined ? powershellBin : resolvePowershellBinary(env);
  if (!psBin) {
    return Promise.resolve({
      ok: false,
      pids: [],
      error: 'System32 powershell.exe not found',
    });
  }

  const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${numericPid}" -Property ProcessId,CreationDate | ForEach-Object { "$($_.ProcessId),$(if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{0})" }`;
  return new Promise((resolve) => {
    execFileFn(
      psBin,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: Math.max(timeoutMs, 2500), encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const detail = `${stderr || ''} ${stdout || ''} ${err.message || ''}`.trim();
          resolve({
            ok: false,
            pids: [],
            error: detail || 'Failed to query Windows descendant processes',
          });
          return;
        }
        const pids = [];
        const seen = new Set();
        for (const rawLine of String(stdout || '').split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line) continue;
          const [pidPart, createdPart] = line.split(',');
          const childPid = Number(pidPart);
          if (!Number.isInteger(childPid) || childPid <= 0 || childPid === numericPid) {
            continue;
          }
          const creationMs = Number(createdPart);
          if (
            typeof spawnedAtMs === 'number' &&
            Number.isFinite(spawnedAtMs) &&
            Number.isFinite(creationMs) &&
            creationMs > 0 &&
            creationMs < spawnedAtMs - 2000
          ) {
            continue;
          }
          if (!seen.has(childPid)) {
            seen.add(childPid);
            pids.push(childPid);
          }
        }
        resolve({ ok: true, pids });
      }
    );
  });
}

function runTaskkillSingle(killer, targetPid, timeoutMs, execFileFn, isProcessGone) {
  return new Promise((resolve) => {
    execFileFn(
      killer,
      ['/T', '/F', '/PID', String(targetPid)],
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ ok: true, rootNotFound: false, method: 'taskkill' });
          return;
        }
        const detail = `${stderr || ''} ${stdout || ''} ${err.message || ''}`.trim();
        if (
          isTaskkillRootNotFoundError(err, stdout, stderr, targetPid) &&
          isProcessGone(targetPid)
        ) {
          resolve({ ok: true, rootNotFound: true, method: 'taskkill-already-exited' });
          return;
        }
        resolve({
          ok: false,
          rootNotFound: false,
          method: 'taskkill',
          timedOut: Boolean(err.killed || err.signal),
          error: detail || 'taskkill failed',
        });
      }
    );
  });
}

/** Terminates a child process and its descendant tree cleanly on Windows/POSIX. */
export async function killProcessTree(pid, options = {}) {
  const {
    timeoutMs = 5000,
    env = process.env,
    execFileFn = execFile,
    killFn = process.kill,
    platform = process.platform,
    taskkillBin,
    powershellBin,
    processGroup = platform !== 'win32',
    spawnedAtMs = null,
    rootAlreadyExited = false,
    findDescendantsFn,
  } = options;

  if (!pid) {
    return { ok: true, method: 'noop' };
  }

  const isProcessGone = (targetPid) => {
    try {
      killFn(targetPid, 0);
      return false;
    } catch (err) {
      return err?.code === 'ESRCH';
    }
  };

  if (platform === 'win32') {
    const killer = taskkillBin !== undefined ? taskkillBin : resolveTaskkillBinary(env);
    if (!killer) {
      return {
        ok: false,
        method: 'taskkill',
        timedOut: false,
        error: 'System32 taskkill.exe not found',
      };
    }

    const cleanupDescendants = async () => {
      let lookupRes;
      if (typeof findDescendantsFn === 'function') {
        const raw = await findDescendantsFn(pid, { spawnedAtMs, timeoutMs, env });
        lookupRes = Array.isArray(raw) ? { ok: true, pids: raw } : raw;
      } else if (execFileFn === execFile) {
        lookupRes = await findWindowsDescendants(pid, {
          env,
          timeoutMs: Math.max(timeoutMs, 2500),
          spawnedAtMs,
          powershellBin,
        });
      } else if (rootAlreadyExited) {
        return {
          ok: false,
          method: 'taskkill-descendants',
          timedOut: false,
          error: 'Unable to verify descendant processes after root exit',
        };
      } else {
        return { ok: true, method: 'taskkill-already-exited' };
      }

      if (!lookupRes || lookupRes.ok === false) {
        return {
          ok: false,
          method: 'taskkill-descendants',
          timedOut: false,
          error: lookupRes?.error || 'Failed to inspect descendant processes',
        };
      }

      const childPids = Array.isArray(lookupRes.pids) ? lookupRes.pids : [];
      if (childPids.length === 0) {
        return {
          ok: true,
          method: rootAlreadyExited ? 'already-exited' : 'taskkill-already-exited',
        };
      }

      const failures = [];
      let anyTimedOut = false;
      for (const childPid of childPids) {
        const childRes = await runTaskkillSingle(
          killer,
          childPid,
          timeoutMs,
          execFileFn,
          isProcessGone
        );
        if (!childRes.ok) {
          anyTimedOut = anyTimedOut || Boolean(childRes.timedOut);
          failures.push(`pid ${childPid}: ${childRes.error || 'taskkill failed'}`);
        }
      }
      if (failures.length > 0) {
        return {
          ok: false,
          method: 'taskkill-descendants',
          timedOut: anyTimedOut,
          error: failures.join('; '),
        };
      }
      return { ok: true, method: 'taskkill-descendants' };
    };

    if (rootAlreadyExited) {
      return cleanupDescendants();
    }

    const rootRes = await runTaskkillSingle(killer, pid, timeoutMs, execFileFn, isProcessGone);
    if (!rootRes.ok) {
      return {
        ok: false,
        method: rootRes.method,
        timedOut: rootRes.timedOut,
        error: rootRes.error,
      };
    }
    if (!rootRes.rootNotFound) {
      return { ok: true, method: 'taskkill' };
    }
    return cleanupDescendants();
  }

  return new Promise((resolve) => {
    const targetPid = processGroup ? -pid : pid;
    try {
      killFn(targetPid, 'SIGTERM');
    } catch (err) {
      if (err?.code === 'ESRCH') {
        resolve({ ok: true, method: 'already-exited' });
      } else {
        resolve({ ok: false, method: 'sigterm', error: err?.message || 'SIGTERM failed' });
      }
      return;
    }

    const escalationDelayMs = Math.min(500, Math.max(10, Math.floor(timeoutMs / 2)));
    setTimeout(() => {
      try {
        killFn(targetPid, 'SIGKILL');
        resolve({ ok: true, method: 'sigkill' });
      } catch (err) {
        if (err?.code === 'ESRCH') {
          resolve({ ok: true, method: 'sigkill' });
        } else {
          resolve({ ok: false, method: 'sigkill', error: err?.message || 'SIGKILL failed' });
        }
      }
    }, escalationDelayMs).unref();
  });
}

function appendStderrTail(current, chunk) {
  const combined = current + chunk;
  if (combined.length <= STDERR_TAIL_MAX_CHARS) {
    return combined;
  }
  return combined.slice(combined.length - STDERR_TAIL_MAX_CHARS);
}

/** Spawns a Codex CLI invocation, streams JSONL progress, and collects output via -o tmpfile. */
export function startCodexRun({
  binPath,
  prefixArgs = [],
  spec,
  onProgress,
  env = process.env,
  killProcessTreeFn = killProcessTree,
}) {
  const tmpOutputPath = path.join(os.tmpdir(), `codex-bridge-${crypto.randomUUID()}.txt`);
  const beforeWorktrees = spec.mode === 'worktree' ? listGitWorktrees(spec.cwd, env) : null;
  const { args, stdinPrompt, usedExecFallback } = buildCodexInvocation(spec, tmpOutputPath);

  const state = {
    events_count: 0,
    last_event: null,
    last_activity_at: new Date().toISOString(),
    session_id: spec.session_id || null,
    worktree_path: null,
    usage: null,
    last_agent_message: '',
  };

  let stderrTail = '';
  let policyBlocked = false;
  let policyScanTail = '';
  let stdoutLineBuf = '';
  let spawnError = null;

  const isPosix = process.platform !== 'win32';
  const spawnedAtMs = Date.now();
  const child = spawn(binPath, [...prefixArgs, ...args], {
    cwd: spec.cwd,
    shell: false,
    detached: isPosix,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  child.stdin.on('error', () => {
    // Ignore EPIPE if child exits before consuming stdin.
  });
  if (stdinPrompt) {
    child.stdin.write(stdinPrompt, 'utf8');
  }
  child.stdin.end();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutLineBuf += chunk;
    const lines = stdoutLineBuf.split(/\r?\n/);
    stdoutLineBuf = lines.pop() ?? '';
    for (const line of lines) {
      parseJsonlLine(line, state);
    }
    if (onProgress) {
      onProgress({ ...state });
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrTail = appendStderrTail(stderrTail, chunk);
    if (!policyBlocked) {
      const scanWindow = policyScanTail + chunk;
      if (hasPolicyBlockMarker(scanWindow)) {
        policyBlocked = true;
        policyScanTail = '';
      } else {
        policyScanTail = scanWindow.slice(-64);
      }
    }
  });

  let childExited = false;
  let pipesClosed = false;
  let lastCancelFailedResult = null;
  let inFlightCancelPromise = null;
  const donePromise = new Promise((resolve) => {
    let finalized = false;
    let exitGraceTimer = null;

    const finalize = (exitCode, signal) => {
      if (finalized) {
        return;
      }
      finalized = true;
      if (exitGraceTimer) {
        clearTimeout(exitGraceTimer);
        exitGraceTimer = null;
      }

      if (stdoutLineBuf.trim()) {
        parseJsonlLine(stdoutLineBuf, state);
        stdoutLineBuf = '';
      }

      let rawOutput = '';
      try {
        if (fs.existsSync(tmpOutputPath)) {
          rawOutput = fs.readFileSync(tmpOutputPath, 'utf8');
        }
      } catch {
        rawOutput = '';
      } finally {
        try {
          if (fs.existsSync(tmpOutputPath)) {
            fs.unlinkSync(tmpOutputPath);
          }
        } catch (unlinkErr) {
          if (
            unlinkErr?.code === 'EBUSY' ||
            unlinkErr?.code === 'EPERM' ||
            unlinkErr?.code === 'EACCES'
          ) {
            setTimeout(() => {
              try {
                if (fs.existsSync(tmpOutputPath)) {
                  fs.unlinkSync(tmpOutputPath);
                }
              } catch {
                // best effort cleanup
              }
            }, 150).unref();
          }
        }
      }

      if (!rawOutput.trim() && state.last_agent_message) {
        rawOutput = state.last_agent_message;
      }

      let worktreeInfo = null;
      let worktreeWarning = null;
      if (spec.mode === 'worktree') {
        let detectedPath = state.worktree_path;
        if (!detectedPath) {
          const runSucceeded = exitCode === 0 && !spawnError && !signal;
          const fallback = resolveFallbackWorktreePath(
            beforeWorktrees,
            listGitWorktrees(spec.cwd, env),
            { runSucceeded }
          );
          detectedPath = fallback.path;
          if (fallback.ambiguous) {
            worktreeWarning = runSucceeded
              ? `Multiple new git worktrees were created concurrently (${fallback.candidates.length}); unable to uniquely attribute a worktree path to this job. Inspect \`git worktree list\` to identify the right worktree.`
              : `Run did not succeed and ${fallback.candidates.length} new git worktree(s) appeared concurrently; unable to verify worktree ownership. Inspect \`git worktree list\` before modifying or cleaning up.`;
          } else if (fallback.baselineFailed) {
            worktreeWarning =
              'Unable to verify an isolated git worktree path because `git worktree list` failed; inspect `git worktree list` to locate any created worktree.';
          }
        }
        if (detectedPath) {
          worktreeInfo = summarizeWorktree(detectedPath, env);
        }
      }

      resolve({
        exitCode,
        signal,
        spawnError: spawnError ? spawnError.message : null,
        output: rawOutput,
        stderr: stderrTail.trim(),
        policyBlocked,
        session_id: state.session_id,
        usage: state.usage,
        worktree: worktreeInfo,
        worktreeWarning,
        usedExecFallback,
        progress: {
          events_count: state.events_count,
          last_event: state.last_event,
          last_activity_at: state.last_activity_at,
        },
      });
    };

    child.on('error', (err) => {
      childExited = true;
      pipesClosed = true;
      spawnError = err;
      finalize(null, null);
    });

    child.on('exit', (code, signal) => {
      childExited = true;
      if (finalized) {
        return;
      }
      exitGraceTimer = setTimeout(() => {
        if (!finalized) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finalize(code, signal);
        }
      }, 1000);
      exitGraceTimer.unref();
    });

    child.on('close', (code, signal) => {
      childExited = true;
      pipesClosed = true;
      finalize(code, signal);
    });
  });

  const performCancel = async () => {
    const killTimeoutMs = isTestMode(env) ? 300 : 4000;
    if (!childExited) {
      const res = await killProcessTreeFn(child.pid, {
        env,
        timeoutMs: killTimeoutMs,
        spawnedAtMs,
      });
      if (res?.ok === false) {
        lastCancelFailedResult = res;
      } else if (res?.ok) {
        lastCancelFailedResult = null;
      }
      return res;
    }

    if (lastCancelFailedResult) {
      if (isPosix) {
        const res = await killProcessTreeFn(child.pid, {
          env,
          timeoutMs: killTimeoutMs,
          spawnedAtMs,
        });
        if (res?.ok) {
          lastCancelFailedResult = null;
          return res;
        }
        if (res) {
          lastCancelFailedResult = res;
        }
        return lastCancelFailedResult;
      }

      const retryRes = await killProcessTreeFn(child.pid, {
        env,
        timeoutMs: killTimeoutMs,
        spawnedAtMs,
        rootAlreadyExited: true,
      });
      if (retryRes?.ok === false) {
        lastCancelFailedResult = retryRes;
        return lastCancelFailedResult;
      }
      if (retryRes?.ok && (pipesClosed || retryRes.method === 'taskkill-descendants')) {
        lastCancelFailedResult = null;
        return retryRes;
      }
      return lastCancelFailedResult;
    }

    if (pipesClosed) {
      return { ok: true, method: 'already-exited' };
    }

    const res = await killProcessTreeFn(child.pid, {
      env,
      timeoutMs: killTimeoutMs,
      spawnedAtMs,
      rootAlreadyExited: !isPosix,
    });
    if (res?.ok === false) {
      lastCancelFailedResult = res;
    }
    return res;
  };

  return {
    pid: child.pid,
    tmpOutputPath,
    hasExited: () => childExited,
    hasClosed: () => pipesClosed,
    getProgress: () => ({
      events_count: state.events_count,
      last_event: state.last_event,
      last_activity_at: state.last_activity_at,
      session_id: state.session_id,
    }),
    cancel: () => {
      if (inFlightCancelPromise) {
        return inFlightCancelPromise;
      }
      inFlightCancelPromise = performCancel().finally(() => {
        inFlightCancelPromise = null;
      });
      return inFlightCancelPromise;
    },
    donePromise,
  };
}
