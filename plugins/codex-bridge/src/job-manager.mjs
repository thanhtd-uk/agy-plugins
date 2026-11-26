import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_JOB_WAIT_SEC,
  DEFAULT_MAX_RUNTIME_SEC,
  MAX_WAIT_SEC,
  getMaxConcurrentJobs,
  isTestMode,
  resolveCodexBinary,
} from './config.mjs';
import { hasPolicyBlockMarker, startCodexRun } from './codex-runner.mjs';
import { truncateOutput } from './handoff.mjs';

const FINISHED_JOB_TTL_MS = 60 * 60 * 1000;
const MAX_FINISHED_JOBS = 30;

function sleepRace(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref();
  });
}

function raceReferencedTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** Detects Windows Codex CLI sandbox/execution policy rejections hidden in stderr. */
export function detectPolicyBlockWarning(stderr, policyBlocked = false) {
  if (Boolean(policyBlocked) || hasPolicyBlockMarker(stderr)) {
    return 'Codex CLI rejected shell commands due to sandbox/execution policy ("rejected: blocked by policy"). On Windows, configure [windows] sandbox = "unelevated" (or "elevated") in ~/.codex/config.toml and verify with `codex doctor`.';
  }
  return null;
}

/**
 * Coordinates synchronous-with-background-fallback Codex jobs, concurrency limits,
 * per-cwd workspace-write locks, and clean process-tree cancellation.
 */
export class JobManager {
  constructor({
    sessionStore,
    env = process.env,
    startRun = startCodexRun,
    cancelGraceMs = null,
    maxTimeoutCancelAttempts = 3,
  }) {
    this.sessionStore = sessionStore;
    this.env = env;
    this.startRun = startRun;
    this.cancelGraceMs = cancelGraceMs;
    this.maxTimeoutCancelAttempts = maxTimeoutCancelAttempts;
    this.jobs = new Map();
    this.writeLocks = new Map();
  }

  _countRunning() {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'running') count += 1;
    }
    return count;
  }

  _pruneFinishedJobs() {
    const now = Date.now();
    const finished = [];
    for (const [id, job] of this.jobs.entries()) {
      if (job.status === 'running') continue;
      if (now - job.finishedAtMs > FINISHED_JOB_TTL_MS) {
        this.jobs.delete(id);
      } else {
        finished.push(job);
      }
    }
    if (finished.length > MAX_FINISHED_JOBS) {
      finished.sort((a, b) => a.finishedAtMs - b.finishedAtMs);
      for (const old of finished.slice(0, finished.length - MAX_FINISHED_JOBS)) {
        this.jobs.delete(old.job_id);
      }
    }
  }

  _buildRunningPayload(job) {
    const elapsed_sec = Number(((Date.now() - job.startedAtMs) / 1000).toFixed(1));
    if (job.timedOut) {
      return {
        status: 'running',
        timed_out: true,
        job_id: job.job_id,
        pid: job.run.pid ?? null,
        kind: job.spec.kind,
        mode: job.spec.mode,
        cwd: job.spec.cwd,
        elapsed_sec,
        max_runtime_sec: job.spec.max_runtime_sec,
        timeout_cancel_attempts: job.timeoutCancelAttempts,
        ...(job.timeoutCancelExhausted ? { timeout_cancel_exhausted: true } : {}),
        ...(job.lastCancelError ? { cancel_error: job.lastCancelError } : {}),
        progress: job.run.getProgress(),
        hint: `Codex job exceeded max_runtime_sec (${job.spec.max_runtime_sec}s), but process termination has not completed yet. Call codex_job({ action: "cancel", job_id }) to retry or inspect OS pid=${job.run.pid ?? 'unknown'}.`,
      };
    }
    return {
      status: 'running',
      job_id: job.job_id,
      kind: job.spec.kind,
      mode: job.spec.mode,
      cwd: job.spec.cwd,
      elapsed_sec,
      progress: job.run.getProgress(),
      hint: 'Call codex_job({ action: "wait", job_id }) to long-poll up to 140s for completion, or action: "cancel" to abort.',
    };
  }

  _buildFinalPayload(job) {
    return job.finalPayload;
  }

  /** Starts a Codex run and waits up to `spec.wait_sec` before returning a running jobId. */
  async startAndWait(spec) {
    this._pruneFinishedJobs();

    const maxJobs = getMaxConcurrentJobs(this.env);
    if (this._countRunning() >= maxJobs) {
      throw new Error(
        `Maximum concurrent Codex jobs (${maxJobs}) reached. Wait for or cancel an active job via codex_job.`
      );
    }

    if (spec.mode === 'workspace-write' && this.writeLocks.has(spec.lockKey)) {
      const blockingJobId = this.writeLocks.get(spec.lockKey);
      throw new Error(
        `Another workspace-write job (${blockingJobId}) is already running in "${spec.cwd}". Wait for it or use mode="worktree" / mode="read-only".`
      );
    }

    const binInfo = resolveCodexBinary(this.env);
    const job_id = `job_${crypto.randomBytes(6).toString('hex')}`;
    const startedAtMs = Date.now();
    const startedMonoMs = performance.now();
    const maxRuntimeSec =
      Number.isFinite(spec.max_runtime_sec) && spec.max_runtime_sec > 0
        ? spec.max_runtime_sec
        : DEFAULT_MAX_RUNTIME_SEC;
    const deadlineMonoMs = startedMonoMs + maxRuntimeSec * 1000;

    if (spec.mode === 'workspace-write') {
      this.writeLocks.set(spec.lockKey, job_id);
    }

    let resolveTimeoutExhausted;
    const timeoutExhaustedPromise = new Promise((resolve) => {
      resolveTimeoutExhausted = resolve;
    });

    const job = {
      job_id,
      spec,
      status: 'running',
      startedAtMs,
      deadlineMonoMs,
      finishedAtMs: null,
      cancelReason: null,
      timedOut: false,
      exiting: false,
      shutdownRequested: false,
      treeTerminationFailed: false,
      treeTerminationError: null,
      timeoutCancelAttempts: 0,
      timeoutCancelExhausted: false,
      timeoutExhaustedPromise,
      resolveTimeoutExhausted,
      cancelOpSeq: 0,
      activeCancelToken: null,
      activeCancelPromise: null,
      lastCancelResult: null,
      lastCancelError: null,
      ttlTimer: null,
      run: null,
      finalPayload: null,
      donePromise: null,
    };

    try {
      job.run = this.startRun({
        binPath: binInfo.binPath,
        prefixArgs: binInfo.prefixArgs,
        spec,
        env: this.env,
      });
    } catch (err) {
      if (spec.mode === 'workspace-write') {
        this.writeLocks.delete(spec.lockKey);
      }
      throw err;
    }

    this.jobs.set(job_id, job);

    const runTimeoutCancel = async (attempt = 1) => {
      job.ttlTimer = null;
      if (job.status !== 'running' || job.exiting || job.shutdownRequested) {
        return;
      }
      job.timedOut = true;
      if (job.run.hasExited?.() && job.run.hasClosed?.() !== false) {
        return;
      }
      job.timeoutCancelAttempts = attempt;
      let res;
      try {
        res = await this.cancelJob(job_id, 'max_runtime_exceeded');
      } catch (err) {
        res = {
          status: 'cancel_failed',
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (job.status !== 'running' || job.exiting || job.shutdownRequested) {
        return;
      }
      if (job.run.hasExited?.() && job.run.hasClosed?.() !== false) {
        return;
      }
      if (res?.status === 'cancel_failed') {
        if (attempt < this.maxTimeoutCancelAttempts) {
          const retryDelayMs = this.cancelGraceMs ?? (isTestMode(this.env) ? 50 : 5000);
          job.ttlTimer = setTimeout(() => {
            void runTimeoutCancel(attempt + 1);
          }, retryDelayMs);
          job.ttlTimer.unref();
        } else {
          job.timeoutCancelExhausted = true;
          job.resolveTimeoutExhausted('timeout_exhausted');
        }
      }
    };

    const initialDelayMs = Math.max(0, Math.ceil(job.deadlineMonoMs - performance.now()));
    job.ttlTimer = setTimeout(() => {
      void runTimeoutCancel(1);
    }, initialDelayMs);
    job.ttlTimer.unref();

    job.donePromise = job.run.donePromise.then(async (res) => {
      const exitedMonoMs = performance.now();
      job.exiting = true;
      if (job.ttlTimer) {
        clearTimeout(job.ttlTimer);
        job.ttlTimer = null;
      }
      if (exitedMonoMs >= job.deadlineMonoMs) {
        job.timedOut = true;
      }

      let cancelRes = job.lastCancelResult ?? null;
      if (job.activeCancelPromise) {
        cancelRes = await job.activeCancelPromise;
      }
      if (job.ttlTimer) {
        clearTimeout(job.ttlTimer);
        job.ttlTimer = null;
      }
      if (job.lastCancelResult && (!cancelRes || cancelRes.ok !== false)) {
        cancelRes = job.lastCancelResult;
      }

      const treeTerminationFailed = Boolean(
        job.treeTerminationFailed ||
          (job.cancelReason && cancelRes && cancelRes.ok === false)
      );
      if (spec.mode === 'workspace-write' && this.writeLocks.get(spec.lockKey) === job_id) {
        this.writeLocks.delete(spec.lockKey);
      }

      job.finishedAtMs = Date.now();
      const elapsed_sec = Number(((job.finishedAtMs - job.startedAtMs) / 1000).toFixed(1));
      const { text: output, truncated, originalChars } = truncateOutput(
        res.output,
        spec.max_output_chars
      );

      let finalStatus = 'completed';
      if (treeTerminationFailed) {
        finalStatus = 'cancel_failed';
        job.cancelReason = null;
        job.activeCancelToken = null;
      } else if (job.timedOut || job.cancelReason === 'max_runtime_exceeded') {
        finalStatus = 'timed_out';
      } else if (job.cancelReason) {
        finalStatus = 'cancelled';
      } else if (res.spawnError || res.exitCode !== 0) {
        finalStatus = 'failed';
      }

      job.status = finalStatus;
      job.resolveTimeoutExhausted('done');

      const warnings = [];
      const returnedSessionId =
        spec.kind === 'exec' && spec.persist_session ? res.session_id : null;
      if (returnedSessionId && finalStatus === 'completed') {
        try {
          this.sessionStore.recordSession({
            session_id: returnedSessionId,
            cwd: spec.cwd,
            mode: spec.mode,
            summary: spec.prompt,
            onlyIfTracked: Boolean(spec.isResume),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(
            `Codex completed, but failed to update codex-bridge session ledger: ${msg}. Session "${returnedSessionId}" may not be tracked in codex_session.`
          );
        }
      }

      const policyWarning =
        finalStatus === 'completed' ? detectPolicyBlockWarning(res.stderr, res.policyBlocked) : null;
      if (policyWarning) {
        warnings.push(policyWarning);
      }
      if (res.worktreeWarning) {
        warnings.push(res.worktreeWarning);
      }
      const includeStderr = (finalStatus === 'failed' || Boolean(policyWarning)) && Boolean(res.stderr);

      const failureDetail = job.treeTerminationError || cancelRes?.error || 'unknown error';
      let errorPayload = {};
      if (treeTerminationFailed) {
        errorPayload = {
          pid: job.run.pid ?? null,
          ...(job.timedOut ? { timed_out: true } : {}),
          error: job.timedOut
            ? `Codex exceeded max_runtime_sec (${maxRuntimeSec}s) and exited during cancellation, but process-tree termination failed (${failureDetail}). Verify no descendant processes remain.`
            : `Codex exited during cancellation, but process-tree termination failed (${failureDetail}). Verify no descendant processes remain.`,
        };
      } else if (res.spawnError) {
        errorPayload = { error: res.spawnError };
      } else if (finalStatus === 'timed_out') {
        errorPayload = {
          error: `Codex job exceeded max_runtime_sec (${maxRuntimeSec}s).${job.lastCancelError ? ` Last termination error: ${job.lastCancelError}` : ''}`,
        };
      }

      job.finalPayload = {
        status: finalStatus,
        job_id,
        kind: spec.kind,
        mode: spec.mode,
        cwd: spec.cwd,
        elapsed_sec,
        exit_code: res.exitCode,
        ...(returnedSessionId ? { session_id: returnedSessionId } : {}),
        ...(res.worktree ? { worktree: res.worktree } : {}),
        ...(res.usage ? { usage: res.usage } : {}),
        ...(res.usedExecFallback ? { used_exec_fallback: true } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        output,
        truncated,
        ...(truncated ? { original_output_chars: originalChars } : {}),
        ...errorPayload,
        ...(includeStderr ? { stderr: res.stderr } : {}),
      };

      return job.finalPayload;
    });

    const race = await Promise.race([
      job.donePromise.then(() => 'done'),
      job.timeoutExhaustedPromise,
      sleepRace(spec.wait_sec * 1000),
    ]);

    if (race === 'done' || job.status !== 'running') {
      return this._buildFinalPayload(job);
    }
    return this._buildRunningPayload(job);
  }

  /** Long-polls a running job up to waitSec seconds or returns immediately if finished. */
  async waitJob(jobId, waitSec) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown job_id: ${jobId}`);
    }
    if (job.status !== 'running') {
      return this._buildFinalPayload(job);
    }

    const minWait = isTestMode(this.env) ? 0.05 : 1;
    const rawWait = waitSec === undefined || waitSec === null ? DEFAULT_JOB_WAIT_SEC : Number(waitSec);
    if (!Number.isFinite(rawWait)) {
      throw new Error('"wait_sec" must be a finite number.');
    }
    const clampedWait = Math.min(Math.max(rawWait, minWait), MAX_WAIT_SEC);

    const racers = [job.donePromise.then(() => 'done'), sleepRace(clampedWait * 1000)];
    if (!job.timeoutCancelExhausted) {
      racers.push(job.timeoutExhaustedPromise);
    }
    const race = await Promise.race(racers);
    if (race === 'done' || job.status !== 'running') {
      return this._buildFinalPayload(job);
    }
    return this._buildRunningPayload(job);
  }

  /** Returns immediate job status or final output if finished. */
  getJobStatus(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown job_id: ${jobId}`);
    }
    if (job.status !== 'running') {
      return this._buildFinalPayload(job);
    }
    return this._buildRunningPayload(job);
  }

  /** Cancels a running job and kills its entire process tree within a bounded grace window. */
  async cancelJob(jobId, reason = 'cancelled') {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown job_id: ${jobId}`);
    }
    if (job.status !== 'running') {
      return this._buildFinalPayload(job);
    }
    const cancelToken = Symbol('cancel');
    job.activeCancelToken = cancelToken;
    job.cancelReason = reason;
    const graceMs = this.cancelGraceMs ?? (isTestMode(this.env) ? 500 : 5000);
    if (!job.activeCancelPromise) {
      const opSeq = ++job.cancelOpSeq;
      job.lastCancelError = null;
      job.lastCancelResult = null;
      const rawCancelPromise = Promise.resolve()
        .then(() => job.run.cancel())
        .then((res) => {
          const normalized = res ?? null;
          if (job.cancelOpSeq === opSeq) {
            job.lastCancelResult = normalized;
            if (normalized && normalized.ok === false) {
              if (normalized.error) {
                job.lastCancelError = normalized.error;
              }
              if (job.run.hasExited?.() && job.run.hasClosed?.() === false) {
                job.treeTerminationFailed = true;
                job.treeTerminationError =
                  normalized.error || job.lastCancelError || 'unknown error';
              }
            } else if (normalized && normalized.ok === true) {
              job.treeTerminationFailed = false;
              job.treeTerminationError = null;
            }
          }
          return normalized;
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          const failed = { ok: false, error: msg };
          if (job.cancelOpSeq === opSeq) {
            job.lastCancelError = msg;
            job.lastCancelResult = failed;
            if (job.run.hasExited?.() && job.run.hasClosed?.() === false) {
              job.treeTerminationFailed = true;
              job.treeTerminationError = msg;
            }
          }
          return failed;
        });

      const cancelPromise = raceReferencedTimeout(rawCancelPromise, graceMs)
        .then((res) => {
          if (res === 'timeout') {
            const errMsg =
              (job.cancelOpSeq === opSeq ? job.lastCancelError : null) || 'cancellation timed out';
            const timedOut = { ok: false, error: errMsg };
            if (job.cancelOpSeq === opSeq) {
              job.lastCancelError = errMsg;
              job.lastCancelResult = timedOut;
            }
            return timedOut;
          }
          return res;
        })
        .finally(() => {
          if (job.activeCancelPromise === cancelPromise) {
            job.activeCancelPromise = null;
          }
        });
      job.activeCancelPromise = cancelPromise;
    }

    const race =
      reason === 'server_shutdown'
        ? await raceReferencedTimeout(job.donePromise.then(() => 'done'), graceMs)
        : await Promise.race([job.donePromise.then(() => 'done'), sleepRace(graceMs)]);
    if (race === 'done' || job.status !== 'running') {
      return this._buildFinalPayload(job);
    }
    if (
      job.lastCancelResult?.ok === false &&
      job.run.hasExited?.() &&
      job.run.hasClosed?.() === false
    ) {
      job.treeTerminationFailed = true;
      job.treeTerminationError =
        job.lastCancelResult.error || job.lastCancelError || 'unknown error';
    } else if (job.activeCancelToken === cancelToken) {
      job.cancelReason = null;
      job.activeCancelToken = null;
    }
    return {
      status: 'cancel_failed',
      job_id: job.job_id,
      pid: job.run.pid ?? null,
      kind: job.spec.kind,
      mode: job.spec.mode,
      cwd: job.spec.cwd,
      error: `Failed to terminate Codex process (pid=${job.run.pid ?? 'unknown'}): ${job.lastCancelError || 'cancellation timed out or process did not exit within grace period'}. Concurrency slot and write lock remain held until the process exits.`,
    };
  }

  /** Lists active and recently finished jobs. */
  listJobs() {
    this._pruneFinishedJobs();
    return Array.from(this.jobs.values()).map((job) => ({
      job_id: job.job_id,
      status: job.status,
      ...(job.timedOut && job.status === 'running' ? { timed_out: true } : {}),
      kind: job.spec.kind,
      mode: job.spec.mode,
      cwd: job.spec.cwd,
      elapsed_sec: Number(
        (((job.finishedAtMs ?? Date.now()) - job.startedAtMs) / 1000).toFixed(1)
      ),
    }));
  }

  /** Cancels all active jobs and drains pending cancellations during server shutdown. */
  async shutdownAll() {
    const graceMs = this.cancelGraceMs ?? (isTestMode(this.env) ? 500 : 5000);
    const active = Array.from(this.jobs.values()).filter((j) => j.status === 'running');
    for (const j of active) {
      j.shutdownRequested = true;
      if (j.ttlTimer) {
        clearTimeout(j.ttlTimer);
        j.ttlTimer = null;
      }
    }
    await Promise.allSettled(active.map((j) => this.cancelJob(j.job_id, 'server_shutdown')));
    const pendingCancels = Array.from(this.jobs.values())
      .map((j) => j.activeCancelPromise)
      .filter(Boolean);
    if (pendingCancels.length > 0) {
      await raceReferencedTimeout(Promise.allSettled(pendingCancels), graceMs);
    }
  }
}
