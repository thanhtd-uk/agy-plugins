import crypto from 'node:crypto';
import {
  DEFAULT_JOB_WAIT_SEC,
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
  constructor({ sessionStore, env = process.env, startRun = startCodexRun, cancelGraceMs = null }) {
    this.sessionStore = sessionStore;
    this.env = env;
    this.startRun = startRun;
    this.cancelGraceMs = cancelGraceMs;
    this.jobs = new Map();
    this.writeLocks = new Map();
    this.shuttingDown = false;
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

    if (spec.mode === 'workspace-write') {
      this.writeLocks.set(spec.lockKey, job_id);
    }

    const job = {
      job_id,
      spec,
      status: 'running',
      startedAtMs,
      finishedAtMs: null,
      cancelReason: null,
      timedOut: false,
      activeCancelToken: null,
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

    const maxTimeoutCancelAttempts = 3;
    const scheduleTimeoutCancel = (attempt = 1) => {
      if (job.status !== 'running' || this.shuttingDown) {
        return;
      }
      job.timedOut = true;
      if (job.run.hasExited?.()) {
        return;
      }
      void this.cancelJob(job_id, 'max_runtime_exceeded')
        .then((res) => {
          if (
            job.status === 'running' &&
            !this.shuttingDown &&
            !job.run.hasExited?.() &&
            res?.status === 'cancel_failed' &&
            attempt < maxTimeoutCancelAttempts
          ) {
            const retryDelayMs = this.cancelGraceMs ?? (isTestMode(this.env) ? 50 : 5000);
            job.ttlTimer = setTimeout(() => {
              scheduleTimeoutCancel(attempt + 1);
            }, retryDelayMs);
            job.ttlTimer.unref();
          }
        })
        .catch(() => {});
    };

    job.ttlTimer = setTimeout(() => {
      scheduleTimeoutCancel(1);
    }, spec.max_runtime_sec * 1000);
    job.ttlTimer.unref();

    job.donePromise = job.run.donePromise.then(async (res) => {
      if (job.ttlTimer) {
        clearTimeout(job.ttlTimer);
        job.ttlTimer = null;
      }
      let cancelRes = job.lastCancelResult ?? null;
      if (job.activeCancelPromise) {
        cancelRes = await job.activeCancelPromise;
      }
      const treeTerminationFailed = Boolean(
        job.cancelReason && cancelRes && cancelRes.ok === false
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
        ...(treeTerminationFailed
          ? {
              pid: job.run.pid ?? null,
              error: `Codex exited during cancellation, but process-tree termination failed (${cancelRes?.error || 'unknown error'}). Verify no descendant processes remain.`,
            }
          : res.spawnError
            ? { error: res.spawnError }
            : {}),
        ...(includeStderr ? { stderr: res.stderr } : {}),
      };

      return job.finalPayload;
    });

    const race = await Promise.race([
      job.donePromise.then(() => 'done'),
      sleepRace(spec.wait_sec * 1000),
    ]);

    if (race === 'done') {
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

    const race = await Promise.race([
      job.donePromise.then(() => 'done'),
      sleepRace(clampedWait * 1000),
    ]);
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
      job.lastCancelError = null;
      job.lastCancelResult = null;
      const cancelPromise = raceReferencedTimeout(
        Promise.resolve()
          .then(() => job.run.cancel())
          .then((res) => {
            const normalized = res ?? null;
            job.lastCancelResult = normalized;
            if (normalized && normalized.ok === false && normalized.error) {
              job.lastCancelError = normalized.error;
            }
            return normalized;
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            job.lastCancelError = msg;
            const failed = { ok: false, error: msg };
            job.lastCancelResult = failed;
            return failed;
          }),
        graceMs
      )
        .then((res) => {
          if (res === 'timeout') {
            job.lastCancelError = job.lastCancelError || 'cancellation timed out';
            const timedOut = { ok: false, error: job.lastCancelError };
            job.lastCancelResult = timedOut;
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
    if (job.activeCancelToken === cancelToken) {
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
    this.shuttingDown = true;
    const graceMs = this.cancelGraceMs ?? (isTestMode(this.env) ? 500 : 5000);
    const active = Array.from(this.jobs.values()).filter((j) => j.status === 'running');
    for (const j of active) {
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
