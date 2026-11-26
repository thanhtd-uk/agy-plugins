import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildCodexExecArgs,
  buildCodexReviewInvocation,
  killProcessTree,
  parseJsonlLine,
  resolveFallbackWorktreePath,
} from '../src/codex-runner.mjs';
import { resolveCodexBinary, resolveGitBinary, resolveTaskkillBinary } from '../src/config.mjs';
import {
  composeCustomTargetReviewPrompt,
  composeExecPrompt,
  truncateOutput,
} from '../src/handoff.mjs';
import { JobManager, detectPolicyBlockWarning } from '../src/job-manager.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { validateCwd, validateExecInput, validateReviewInput } from '../src/validation.mjs';
import { cmdUninstall, copyRuntimeFiles, isBlockingFinding, validateInstallTarget } from '../scripts/install.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_CODEX_PATH = path.join(PLUGIN_ROOT, 'test', 'fixtures', 'fake-codex.mjs');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir, withCommit = false) {
  execFileSync('git', ['init'], { cwd: dir, windowsHide: true, stdio: 'ignore' });
  if (withCommit) {
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: dir,
      windowsHide: true,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test User'], {
      cwd: dir,
      windowsHide: true,
      stdio: 'ignore',
    });
    fs.writeFileSync(path.join(dir, 'README.md'), 'init\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: dir, windowsHide: true, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], {
      cwd: dir,
      windowsHide: true,
      stdio: 'ignore',
    });
  }
}

test('resolveCodexBinary respects CODEX_BRIDGE_BIN and prefix args', () => {
  const res = resolveCodexBinary({
    CODEX_BRIDGE_BIN: process.execPath,
    CODEX_BRIDGE_BIN_ARGS_PREFIX: JSON.stringify(['--version']),
  });
  assert.equal(res.binPath, path.resolve(process.execPath));
  assert.deepEqual(res.prefixArgs, ['--version']);
  assert.equal(res.source, 'env');

  assert.throws(
    () => resolveCodexBinary({ CODEX_BRIDGE_BIN: path.join(os.tmpdir(), 'definitely-missing-codex.exe') }),
    /missing file/i
  );
});

test('validateCwd rejects missing, relative, and file paths', () => {
  assert.throws(() => validateCwd(''), /Missing required "cwd"/);
  assert.throws(() => validateCwd('relative/path'), /absolute path/i);
  const tmpFile = path.join(os.tmpdir(), `codex-bridge-not-dir-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'x', 'utf8');
  try {
    assert.throws(() => validateCwd(tmpFile), /not a directory/i);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('validateExecInput enforces mode safety, worktree git HEAD, and flexible efforts', () => {
  const nonGitDir = makeTempDir('cb-nongit-');
  const unbornGitDir = makeTempDir('cb-unborn-');
  const committedGitDir = makeTempDir('cb-git-');
  try {
    initGitRepo(unbornGitDir, false);
    initGitRepo(committedGitDir, true);

    assert.throws(
      () => validateExecInput({ cwd: nonGitDir, prompt: 'test', mode: 'danger-full-access' }),
      /danger-full-access is disabled/i
    );
    assert.throws(
      () => validateExecInput({ cwd: nonGitDir, prompt: 'test', mode: 'worktree' }),
      /inside a Git repository/i
    );
    assert.throws(
      () => validateExecInput({ cwd: unbornGitDir, prompt: 'test', mode: 'worktree' }),
      /at least one Git commit/i
    );

    const wtSpec = validateExecInput({ cwd: committedGitDir, prompt: 'refactor', mode: 'worktree' });
    assert.equal(wtSpec.mode, 'worktree');
    assert.equal(wtSpec.skipGitRepoCheck, false);

    const nonGitSpec = validateExecInput({ cwd: nonGitDir, prompt: 'analyze' });
    assert.equal(nonGitSpec.mode, 'read-only');
    assert.equal(nonGitSpec.persist_session, false);
    assert.equal(nonGitSpec.skipGitRepoCheck, true);
    assert.equal(nonGitSpec.model, null);
    assert.equal(nonGitSpec.reasoning_effort, null);

    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      const spec = validateExecInput({
        cwd: nonGitDir,
        prompt: 'check',
        reasoning_effort: effort,
      });
      assert.equal(spec.reasoning_effort, effort);
    }

    const resumeSpec = validateExecInput({
      cwd: committedGitDir,
      prompt: 'continue',
      session_id: '11111111-2222-4333-8444-555555555555',
    });
    assert.equal(resumeSpec.isResume, true);
    assert.equal(resumeSpec.persist_session, true);
  } finally {
    fs.rmSync(nonGitDir, { recursive: true, force: true });
    fs.rmSync(unbornGitDir, { recursive: true, force: true });
    fs.rmSync(committedGitDir, { recursive: true, force: true });
  }
});

test('buildCodexExecArgs & buildCodexReviewInvocation produce valid clap flag order', () => {
  const gitDir = makeTempDir('cb-args-');
  try {
    initGitRepo(gitDir, true);

    const canonicalGitDir = fs.realpathSync.native(gitDir);
    const ephemeralSpec = validateExecInput({ cwd: gitDir, prompt: 'inspect' });
    const ephemeralArgs = buildCodexExecArgs(ephemeralSpec, 'C:\\tmp\\out.txt');
    assert.deepEqual(ephemeralArgs.slice(0, 6), ['exec', '-C', canonicalGitDir, '-s', 'read-only', '--ephemeral']);
    assert.equal(ephemeralArgs.at(-1), '-');
    assert.ok(!ephemeralArgs.includes('-m'));
    assert.ok(!ephemeralArgs.includes('-c'));

    const resumeSpec = validateExecInput({
      cwd: gitDir,
      prompt: 'next step',
      mode: 'worktree',
      session_id: '11111111-2222-4333-8444-555555555555',
      reasoning_effort: 'ultra',
    });
    const resumeArgs = buildCodexExecArgs(resumeSpec, 'C:\\tmp\\out.txt');
    assert.equal(resumeArgs[0], 'exec');
    assert.equal(resumeArgs[5], 'resume');
    assert.ok(resumeArgs.includes('--worktree'));
    assert.ok(!resumeArgs.includes('--ephemeral'));
    assert.ok(resumeArgs.includes('model_reasoning_effort="ultra"'));
    assert.equal(resumeArgs.at(-2), '11111111-2222-4333-8444-555555555555');
    assert.equal(resumeArgs.at(-1), '-');

    const pureReviewSpec = validateReviewInput({ cwd: gitDir });
    const pureReview = buildCodexReviewInvocation(pureReviewSpec, 'C:\\tmp\\rev.txt');
    assert.equal(pureReview.usedExecFallback, false);
    assert.deepEqual(pureReview.args.slice(0, 8), [
      'exec',
      '-C',
      canonicalGitDir,
      '-s',
      'read-only',
      'review',
      '--ephemeral',
      '--uncommitted',
    ]);
    assert.ok(!pureReview.args.includes('-'));

    const customTargetReviewSpec = validateReviewInput({
      cwd: gitDir,
      uncommitted: true,
      prompt: 'Focus on security',
    });
    const fallbackReview = buildCodexReviewInvocation(customTargetReviewSpec, 'C:\\tmp\\rev2.txt');
    assert.equal(fallbackReview.usedExecFallback, true);
    assert.ok(!fallbackReview.args.includes('review'));
    assert.match(fallbackReview.stdinPrompt, /Focus on security/);
  } finally {
    fs.rmSync(gitDir, { recursive: true, force: true });
  }
});

test('composeExecPrompt & truncateOutput obey budget', () => {
  const prompt = composeExecPrompt({
    prompt: 'Fix bug',
    focus_files: ['src/app.mjs:10-40'],
    context: 'Fails on null input',
    constraints: 'Run unit tests',
    mode: 'workspace-write',
    max_output_chars: 8500,
  });
  assert.match(prompt, /# Task\nFix bug/);
  assert.match(prompt, /src\/app\.mjs:10-40/);
  assert.match(prompt, /List modified files/);
  assert.match(prompt, /concise technical English/i);

  const longText = 'A'.repeat(15000);
  const res = truncateOutput(longText, 8500);
  assert.equal(res.truncated, true);
  assert.equal(res.originalChars, 15000);
  assert.ok(res.text.length <= 8500);
  assert.match(res.text, /truncated \d+ chars/);
});

test('parseJsonlLine extracts session_id, usage, and agent_message', () => {
  const state = {
    events_count: 0,
    last_event: null,
    last_activity_at: null,
    session_id: null,
    worktree_path: null,
    usage: null,
    last_agent_message: '',
  };
  parseJsonlLine('{"type":"thread.started","thread_id":"abc-123"}', state);
  parseJsonlLine(
    '{"type":"item.completed","item":{"type":"agent_message","text":"Done!"}}',
    state
  );
  parseJsonlLine('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}', state);
  assert.equal(state.session_id, 'abc-123');
  assert.equal(state.last_agent_message, 'Done!');
  assert.deepEqual(state.usage, { input_tokens: 10, output_tokens: 5 });
  assert.equal(state.events_count, 3);
});

test('SessionStore protects personal sessions unless allow_untracked=true', async () => {
  const tmpDir = makeTempDir('cb-store-');
  const ledgerPath = path.join(tmpDir, 'sessions.json');
  const logFile = path.join(tmpDir, 'codex.log');
  const fakeCodexPath = FAKE_CODEX_PATH;
  const env = {
    ...process.env,
    CODEX_BRIDGE_BIN: process.execPath,
    CODEX_BRIDGE_BIN_ARGS_PREFIX: JSON.stringify([fakeCodexPath]),
    FAKE_CODEX_LOG_FILE: logFile,
  };
  try {
    const store = new SessionStore(ledgerPath);
    const trackedId = '11111111-2222-4333-8444-555555555555';
    const personalId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    store.recordSession({ session_id: trackedId, cwd: tmpDir, mode: 'read-only', summary: 'hi' });
    assert.equal(store.listSessions().length, 1);

    await assert.rejects(
      () => store.deleteSession({ session_id: personalId, allow_untracked: false, env }),
      /not in codex-bridge's tracked ledger/
    );

    const archived = await store.archiveSession({ session_id: trackedId, env });
    assert.equal(archived.status, 'archived');

    const deleted = await store.deleteSession({ session_id: trackedId, env });
    assert.equal(deleted.status, 'deleted');
    assert.equal(store.listSessions().length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveGitBinary ignores relative/root-relative PATH entries and resolveTaskkillBinary fails closed', () => {
  const tmpDir = makeTempDir('cb-gitbin-');
  const exeName = process.platform === 'win32' ? 'git.exe' : 'git';
  const fakeGit = path.join(tmpDir, exeName);
  fs.writeFileSync(fakeGit, 'stub', 'utf8');
  try {
    const overridden = resolveGitBinary({ CODEX_BRIDGE_GIT_BIN: fakeGit });
    assert.equal(overridden, path.resolve(fakeGit));

    const fromPath = resolveGitBinary(
      { PATH: `.${path.delimiter}${tmpDir}` },
      { platform: process.platform }
    );
    assert.equal(fromPath, path.join(tmpDir, exeName));

    const rejectedWinPaths = resolveGitBinary(
      {
        PATH: `.${path.win32.delimiter}\\tools${path.win32.delimiter}C:relative`,
        ProgramFiles: 'relative\\pf',
        'ProgramFiles(x86)': '\\root-rel',
        LOCALAPPDATA: 'relative\\local',
      },
      {
        platform: 'win32',
        homedir: () => 'relative\\home',
        existsSync: (p) => /^(\\|C:relative|relative)/i.test(p),
        statSync: () => ({ isFile: () => true }),
      }
    );
    assert.equal(rejectedWinPaths, null);

    assert.throws(
      () => resolveGitBinary({ CODEX_BRIDGE_GIT_BIN: 'relative\\git.exe' }),
      /fully qualified path/i
    );

    const missingRootTaskkill = resolveTaskkillBinary(
      {},
      { platform: 'win32', existsSync: () => true, statSync: () => ({ isFile: () => true }) }
    );
    assert.equal(missingRootTaskkill, null);

    const missingTaskkill = resolveTaskkillBinary(
      { SystemRoot: 'C:\\Windows' },
      {
        platform: 'win32',
        existsSync: () => false,
        statSync: () => ({ isFile: () => false }),
      }
    );
    assert.equal(missingTaskkill, null);

    if (process.platform === 'win32') {
      const taskkillPath = resolveTaskkillBinary();
      assert.ok(path.isAbsolute(taskkillPath));
      assert.match(taskkillPath, /taskkill\.exe$/i);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('validateCwd canonicalizes both cwd and lockKey across junction/symlink', () => {
  const tmpDir = makeTempDir('cb-junction-');
  const realDir = path.join(tmpDir, 'real-repo');
  const linkDir = path.join(tmpDir, 'link-repo');
  fs.mkdirSync(realDir);
  fs.symlinkSync(realDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const realInfo = validateCwd(realDir);
    const linkInfo = validateCwd(linkDir);
    assert.equal(realInfo.lockKey, linkInfo.lockKey);
    assert.equal(realInfo.cwd, linkInfo.cwd);
    assert.equal(linkInfo.cwd, fs.realpathSync.native(realDir));
  } finally {
    fs.rmSync(linkDir, { recursive: true, force: true });
    fs.rmSync(realDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('killProcessTree fails closed without root-only SIGKILL fallback on Windows', async () => {
  let sigkillCalled = false;
  const denied = await killProcessTree(42424, {
    platform: 'win32',
    taskkillBin: 'C:\\Windows\\System32\\taskkill.exe',
    execFileFn: (_bin, _args, _opts, cb) => {
      const err = new Error('Access is denied.');
      err.killed = true;
      cb(err, '', 'ERROR: Access is denied.');
    },
    killFn: (_pid, sig) => {
      if (sig === 'SIGKILL') sigkillCalled = true;
      return true;
    },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.timedOut, true);
  assert.equal(sigkillCalled, false);
  assert.match(denied.error, /Access is denied/);

  const missingKiller = await killProcessTree(42426, {
    platform: 'win32',
    taskkillBin: null,
  });
  assert.equal(missingKiller.ok, false);
  assert.match(missingKiller.error, /taskkill\.exe not found/i);

  const liveRootNotFound = await killProcessTree(42427, {
    platform: 'win32',
    taskkillBin: 'C:\\Windows\\System32\\taskkill.exe',
    execFileFn: (_bin, _args, _opts, cb) => {
      cb(new Error('not found'), '', 'ERROR: Child process not found.');
    },
    killFn: () => true,
  });
  assert.equal(liveRootNotFound.ok, false);

  const alreadyExited = await killProcessTree(42425, {
    platform: 'win32',
    taskkillBin: 'C:\\Windows\\System32\\taskkill.exe',
    execFileFn: (_bin, _args, _opts, cb) => {
      cb(new Error('not found'), '', 'ERROR: The process "42425" not found.');
    },
    killFn: () => {
      const err = new Error('ESRCH');
      err.code = 'ESRCH';
      throw err;
    },
  });
  assert.equal(alreadyExited.ok, true);
  assert.equal(alreadyExited.method, 'taskkill-already-exited');
});

test('JobManager.cancelJob races cancel() against donePromise/graceMs and resets cancelReason on cancel_failed', async () => {
  const workDir = makeTempDir('cb-lock-cancel-');
  const fakeCodexPath = FAKE_CODEX_PATH;
  let releaseDone1;
  let releaseDone2;
  let releaseDone4;
  let callCount = 0;

  try {
    const manager = new JobManager({
      sessionStore: { recordSession: () => {} },
      env: {
        ...process.env,
        CODEX_BRIDGE_TEST_MODE: '1',
        CODEX_BRIDGE_BIN: process.execPath,
        CODEX_BRIDGE_BIN_ARGS_PREFIX: JSON.stringify([fakeCodexPath]),
      },
      cancelGraceMs: 50,
      startRun: () => {
        callCount += 1;
        if (callCount === 1) {
          const donePromise = new Promise((resolve) => {
            releaseDone1 = resolve;
          });
          return {
            pid: 999999,
            getProgress: () => ({ events_count: 1, last_event: 'turn.started' }),
            cancel: async () => ({ ok: false, method: 'taskkill', error: 'Access denied' }),
            donePromise,
          };
        }
        if (callCount === 2) {
          const donePromise = new Promise((resolve) => {
            releaseDone2 = resolve;
          });
          return {
            pid: 999998,
            getProgress: () => ({ events_count: 1, last_event: 'turn.started' }),
            // Resolves within graceMs after donePromise settles
            cancel: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 25)),
            donePromise,
          };
        }
        if (callCount === 3 || callCount >= 5) {
          return {
            pid: 1000000,
            getProgress: () => ({ events_count: 1, last_event: 'turn.completed' }),
            cancel: async () => ({ ok: true, method: 'noop' }),
            donePromise: Promise.resolve({
              exitCode: 0,
              signal: null,
              spawnError: null,
              output: 'third job ok',
              stderr: '',
              policyBlocked: false,
              session_id: null,
              usage: null,
              worktree: null,
              usedExecFallback: false,
            }),
          };
        }
        const donePromise4 = new Promise((resolve) => {
          releaseDone4 = resolve;
        });
        return {
          pid: 1000001,
          getProgress: () => ({ events_count: 1, last_event: 'turn.started' }),
          // Permanently hanging cancel() must fail closed with cancel_failed and keep lock held
          cancel: () => new Promise(() => {}),
          donePromise: donePromise4,
        };
      },
    });

    const spec1 = validateExecInput({
      cwd: workDir,
      mode: 'workspace-write',
      prompt: 'job 1',
      wait_sec: 0.05,
    });
    const started1 = await manager.startAndWait(spec1);
    assert.equal(started1.status, 'running');

    const cancelRes1 = await manager.cancelJob(started1.job_id);
    assert.equal(cancelRes1.status, 'cancel_failed');
    assert.match(cancelRes1.error, /Access denied/);

    // Lock must STILL be held because the OS process has not exited yet.
    const spec2 = validateExecInput({
      cwd: workDir,
      mode: 'workspace-write',
      prompt: 'job 2',
      wait_sec: 0.05,
    });
    await assert.rejects(() => manager.startAndWait(spec2), /already running/i);

    // Once job 1 exits naturally with code 0 after cancel_failed, it must report 'completed', not 'cancelled'.
    releaseDone1({
      exitCode: 0,
      signal: null,
      spawnError: null,
      output: 'natural finish',
      stderr: '',
      policyBlocked: false,
      session_id: null,
      usage: null,
      worktree: null,
      usedExecFallback: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(manager.getJobStatus(started1.job_id).status, 'completed');

    // Job 2: cancel() completes within graceMs after donePromise resolves before graceMs.
    const started2 = await manager.startAndWait(spec2);
    assert.equal(started2.status, 'running');
    setTimeout(() => {
      releaseDone2({
        exitCode: 1,
        signal: 'SIGTERM',
        spawnError: null,
        output: '',
        stderr: '',
        policyBlocked: false,
        session_id: null,
        usage: null,
        worktree: null,
        usedExecFallback: false,
      });
    }, 15);
    const t0 = Date.now();
    const cancelRes2 = await manager.cancelJob(started2.job_id);
    assert.equal(cancelRes2.status, 'cancelled');
    assert.ok(Date.now() - t0 < 200);

    const thirdRes = await manager.startAndWait(spec2);
    assert.equal(thirdRes.status, 'completed');
    assert.equal(thirdRes.output, 'third job ok');

    // Job 4: permanently hanging cancel() fails closed with cancel_failed and keeps write lock held.
    const spec4 = validateExecInput(
      { cwd: workDir, mode: 'workspace-write', prompt: 'job 4', wait_sec: 0.05 },
      { ...process.env, CODEX_BRIDGE_TEST_MODE: '1' }
    );
    const started4 = await manager.startAndWait(spec4);
    assert.equal(started4.status, 'running');
    const cancelRes4 = await manager.cancelJob(started4.job_id);
    assert.equal(cancelRes4.status, 'cancel_failed');
    await assert.rejects(() => manager.startAndWait(spec4), /already running/i);
    releaseDone4({
      exitCode: 1,
      signal: 'SIGTERM',
      spawnError: null,
      output: '',
      stderr: '',
      policyBlocked: false,
      session_id: null,
      usage: null,
      worktree: null,
      usedExecFallback: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(manager.getJobStatus(started4.job_id).status, 'failed');
    const recoveredRes = await manager.startAndWait(spec4);
    assert.equal(recoveredRes.status, 'completed');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('detectPolicyBlockWarning detects Windows blocked-by-policy stderr or streaming flag', () => {
  assert.match(
    detectPolicyBlockWarning('ERROR: CreateProcess rejected: blocked by policy'),
    /sandbox = "unelevated"/
  );
  assert.match(detectPolicyBlockWarning('truncated tail without marker', true), /sandbox = "unelevated"/);
  assert.equal(detectPolicyBlockWarning('all good', false), null);
});

test('validateInstallTarget & copyRuntimeFiles guard against unrelated directories and source overlap', () => {
  const srcRoot = PLUGIN_ROOT;
  const tmpDir = makeTempDir('cb-install-');
  try {
    const parentTarget = path.join(tmpDir, 'plugins');
    const siblingDir = path.join(parentTarget, 'agy-fast');
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(siblingDir, 'keep.txt'), 'safe', 'utf8');

    assert.throws(
      () => copyRuntimeFiles(srcRoot, parentTarget),
      /non-empty directory .* missing plugin\.json/i
    );
    assert.equal(fs.readFileSync(path.join(siblingDir, 'keep.txt'), 'utf8'), 'safe');

    const otherPluginDir = path.join(tmpDir, 'other-plugin');
    fs.mkdirSync(otherPluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(otherPluginDir, 'plugin.json'),
      JSON.stringify({ name: 'other-plugin' }),
      'utf8'
    );
    assert.throws(
      () => validateInstallTarget(srcRoot, otherPluginDir),
      /not "codex-bridge"/i
    );

    const secondCheckoutDir = path.join(tmpDir, 'second-checkout');
    fs.mkdirSync(path.join(secondCheckoutDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(secondCheckoutDir, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(secondCheckoutDir, 'plugin.json'),
      JSON.stringify({ name: 'codex-bridge' }),
      'utf8'
    );
    fs.writeFileSync(path.join(secondCheckoutDir, 'test', 'wip.mjs'), 'keep', 'utf8');
    assert.throws(
      () => copyRuntimeFiles(srcRoot, secondCheckoutDir),
      /source checkout/i
    );
    assert.throws(
      () => cmdUninstall(secondCheckoutDir),
      /source checkout/i
    );
    assert.equal(fs.readFileSync(path.join(secondCheckoutDir, 'test', 'wip.mjs'), 'utf8'), 'keep');

    assert.throws(() => validateInstallTarget(srcRoot, srcRoot), /overlaps source/i);
    assert.throws(
      () => validateInstallTarget(srcRoot, path.join(srcRoot, 'src')),
      /overlaps source/i
    );
    assert.throws(
      () => validateInstallTarget(srcRoot, path.join(srcRoot, '..backup')),
      /overlaps source/i
    );

    const freshTarget = path.join(tmpDir, 'fresh-codex-bridge');
    copyRuntimeFiles(srcRoot, freshTarget);
    assert.ok(fs.existsSync(path.join(freshTarget, 'plugin.json')));
    assert.ok(fs.existsSync(path.join(freshTarget, 'assets', 'logo.png')));
    assert.equal(isBlockingFinding({ severity: 'note', message: 'optional hint' }), false);
    assert.equal(isBlockingFinding({ severity: 'info', message: 'informational' }), false);
    assert.equal(isBlockingFinding({ severity: 'warning', message: 'warn' }), true);
    assert.equal(isBlockingFinding({ severity: 'error', message: 'err' }), true);
    assert.equal(isBlockingFinding('raw cli error'), true);

    // Symlinked/junction runtime directory in an existing install must be replaced without pruning target files
    const externalDir = path.join(tmpDir, 'external-dir');
    fs.mkdirSync(externalDir, { recursive: true });
    fs.writeFileSync(path.join(externalDir, 'precious.txt'), 'do-not-delete', 'utf8');
    const targetSrcDir = path.join(freshTarget, 'src');
    fs.rmSync(targetSrcDir, { recursive: true, force: true });
    fs.symlinkSync(externalDir, targetSrcDir, process.platform === 'win32' ? 'junction' : 'dir');

    copyRuntimeFiles(srcRoot, freshTarget);
    assert.equal(fs.lstatSync(targetSrcDir).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(externalDir, 'precious.txt'), 'utf8'), 'do-not-delete');
    assert.ok(fs.existsSync(path.join(freshTarget, 'src', 'mcp-server.mjs')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveCodexBinary ignores relative/root-relative PATH entries and returns fully qualified paths', () => {
  const winRejected = resolveCodexBinary(
    {
      PATH: `.${path.win32.delimiter}./bin${path.win32.delimiter}\\tools${path.win32.delimiter}C:relative${path.win32.delimiter}C:\\Trusted\\Codex`,
      LOCALAPPDATA: 'relative\\local',
    },
    {
      platform: 'win32',
      homedir: () => 'relative\\home',
      existsSync: (p) => p === 'C:\\Trusted\\Codex\\codex.exe' || /^(\.|\\|C:relative|relative)/i.test(p),
      statSync: () => ({ isFile: () => true }),
    }
  );
  assert.equal(winRejected.binPath, 'C:\\Trusted\\Codex\\codex.exe');
  assert.equal(winRejected.source, 'path');

  const winUncForward = resolveCodexBinary(
    { PATH: '//fileserver/share/codex-bin' },
    {
      platform: 'win32',
      homedir: () => 'relative\\home',
      existsSync: (p) => p === '\\\\fileserver\\share\\codex-bin\\codex.exe',
      statSync: () => ({ isFile: () => true }),
    }
  );
  assert.equal(winUncForward.binPath, '\\\\fileserver\\share\\codex-bin\\codex.exe');
  assert.equal(winUncForward.source, 'path');

  const posixResolved = resolveCodexBinary(
    { PATH: `.${path.posix.delimiter}./bin${path.posix.delimiter}/usr/local/bin` },
    {
      platform: 'linux',
      existsSync: (p) => p === '/usr/local/bin/codex' || p === 'codex' || p === 'bin/codex',
      statSync: () => ({ isFile: () => true }),
    }
  );
  assert.equal(posixResolved.binPath, '/usr/local/bin/codex');
  assert.equal(posixResolved.source, 'path');

  assert.throws(
    () =>
      resolveCodexBinary(
        { PATH: `.${path.posix.delimiter}relative/dir` },
        {
          platform: 'linux',
          existsSync: () => true,
          statSync: () => ({ isFile: () => true }),
        }
      ),
    /Codex CLI executable not found/i
  );
});

test('killProcessTree targets the POSIX process group and falls back to PID on ESRCH', async () => {
  const calls = [];
  const resGroup = await killProcessTree(5150, {
    platform: 'linux',
    timeoutMs: 20,
    killFn: (target, sig) => {
      calls.push([target, sig]);
    },
  });
  assert.equal(resGroup.ok, true);
  assert.equal(resGroup.method, 'sigkill');
  assert.deepEqual(calls, [
    [-5150, 'SIGTERM'],
    [-5150, 'SIGKILL'],
  ]);

  // If detached group is already gone (ESRCH on -pid), treat as already exited instead of falling back to positive PID
  const groupGoneCalls = [];
  const resGroupGone = await killProcessTree(6160, {
    platform: 'linux',
    timeoutMs: 20,
    killFn: (target, sig) => {
      groupGoneCalls.push([target, sig]);
      if (target < 0) {
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
    },
  });
  assert.equal(resGroupGone.ok, true);
  assert.equal(resGroupGone.method, 'already-exited');
  assert.deepEqual(groupGoneCalls, [[-6160, 'SIGTERM']]);

  // Non-group mode (processGroup: false) targets the PID directly
  const pidOnlyCalls = [];
  const resPidOnly = await killProcessTree(6161, {
    platform: 'linux',
    processGroup: false,
    timeoutMs: 20,
    killFn: (target, sig) => {
      pidOnlyCalls.push([target, sig]);
    },
  });
  assert.equal(resPidOnly.ok, true);
  assert.deepEqual(pidOnlyCalls, [
    [6161, 'SIGTERM'],
    [6161, 'SIGKILL'],
  ]);

  // If process group accepted SIGTERM and exited before SIGKILL, do NOT fall back to positive PID
  const noPidFallbackCalls = [];
  const resGroupGoneBeforeSigkill = await killProcessTree(7170, {
    platform: 'linux',
    timeoutMs: 20,
    killFn: (target, sig) => {
      noPidFallbackCalls.push([target, sig]);
      if (sig === 'SIGKILL' && target < 0) {
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
    },
  });
  assert.equal(resGroupGoneBeforeSigkill.ok, true);
  assert.deepEqual(noPidFallbackCalls, [
    [-7170, 'SIGTERM'],
    [-7170, 'SIGKILL'],
  ]);
});

test('resolveFallbackWorktreePath avoids attributing ambiguous or failed-baseline worktrees', () => {
  const single = resolveFallbackWorktreePath(['/repo'], ['/repo', '/wt-a']);
  assert.deepEqual(single, {
    path: '/wt-a',
    ambiguous: false,
    baselineFailed: false,
    candidates: ['/wt-a'],
  });

  const ambiguous = resolveFallbackWorktreePath(['/repo'], ['/repo', '/wt-a', '/wt-b']);
  assert.deepEqual(ambiguous, {
    path: null,
    ambiguous: true,
    baselineFailed: false,
    candidates: ['/wt-a', '/wt-b'],
  });

  const none = resolveFallbackWorktreePath(['/repo'], ['/repo']);
  assert.deepEqual(none, {
    path: null,
    ambiguous: false,
    baselineFailed: false,
    candidates: [],
  });

  const failedBaseline = resolveFallbackWorktreePath(null, ['/repo']);
  assert.deepEqual(failedBaseline, {
    path: null,
    ambiguous: false,
    baselineFailed: true,
    candidates: [],
  });

  const failedRun = resolveFallbackWorktreePath(['/repo'], ['/repo', '/wt-other'], {
    runSucceeded: false,
  });
  assert.deepEqual(failedRun, {
    path: null,
    ambiguous: true,
    baselineFailed: false,
    candidates: ['/wt-other'],
  });
});

test('composeCustomTargetReviewPrompt includes git diff --cached for uncommitted reviews', () => {
  const prompt = composeCustomTargetReviewPrompt({
    uncommitted: true,
    prompt: 'Check staged and unstaged edits',
  });
  assert.match(prompt, /git diff --cached/);
  assert.match(prompt, /git diff/);
  assert.match(prompt, /git status --short/);
});

test('SessionStore enforces boolean allow_untracked, onlyIfTracked, and post-await ledger consistency', async () => {
  const tmpDir = makeTempDir('cb-store-race-');
  const ledgerPath = path.join(tmpDir, 'sessions.json');
  const gateFile = path.join(tmpDir, 'archive-release.gate');
  const startedFile = path.join(tmpDir, 'archive-started.flag');
  const gatedCodexScript = path.join(tmpDir, 'gated-codex.mjs');
  fs.writeFileSync(
    gatedCodexScript,
    [
      "import fs from 'node:fs';",
      `const startedFile = ${JSON.stringify(startedFile)};`,
      `const gateFile = ${JSON.stringify(gateFile)};`,
      "fs.writeFileSync(startedFile, '1', 'utf8');",
      'const waitUntilReleased = () => {',
      '  if (fs.existsSync(gateFile)) process.exit(0);',
      '  setTimeout(waitUntilReleased, 10);',
      '};',
      'waitUntilReleased();',
    ].join('\n'),
    'utf8'
  );
  const env = {
    ...process.env,
    CODEX_BRIDGE_BIN: process.execPath,
    CODEX_BRIDGE_BIN_ARGS_PREFIX: JSON.stringify([gatedCodexScript]),
  };

  const waitForFile = async (filePath) => {
    for (let i = 0; i < 100; i += 1) {
      if (fs.existsSync(filePath)) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timed out waiting for ${filePath}`);
  };

  try {
    const store = new SessionStore(ledgerPath);
    const id1 = '11111111-2222-4333-8444-555555555555';
    const id2 = '22222222-2222-4333-8444-555555555555';
    const personalId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    // Object.prototype property names like "constructor" must not be mistaken for tracked session IDs
    assert.equal(
      store.recordSession({
        session_id: 'constructor',
        cwd: tmpDir,
        mode: 'read-only',
        summary: 'proto',
        onlyIfTracked: true,
      }),
      null
    );
    await assert.rejects(
      () => store.archiveSession({ session_id: 'constructor', env }),
      /not in codex-bridge's tracked ledger/i
    );

    // onlyIfTracked skips untracked personal session, updates tracked session
    assert.equal(
      store.recordSession({
        session_id: personalId,
        cwd: tmpDir,
        mode: 'read-only',
        summary: 'personal',
        onlyIfTracked: true,
      }),
      null
    );
    assert.equal(store.listSessions().length, 0);

    store.recordSession({ session_id: id1, cwd: tmpDir, mode: 'read-only', summary: 'one' });
    const updated = store.recordSession({
      session_id: id1,
      cwd: tmpDir,
      mode: 'read-only',
      summary: 'updated',
      onlyIfTracked: true,
    });
    assert.equal(updated.session_id, id1);

    await assert.rejects(
      () => store.deleteSession({ session_id: personalId, allow_untracked: 'false', env }),
      /must be a boolean/i
    );
    await assert.rejects(
      () => store.archiveSession({ session_id: personalId, allow_untracked: 'false', env }),
      /must be a boolean/i
    );

    // While archiveSession(id1) awaits CLI, another job records id2; id2 must NOT be overwritten.
    const archivePromise = store.archiveSession({ session_id: id1, env });
    await waitForFile(startedFile);
    store.recordSession({ session_id: id2, cwd: tmpDir, mode: 'read-only', summary: 'two' });
    fs.writeFileSync(gateFile, 'go', 'utf8');
    await archivePromise;

    const sessionsAfterArchive = store.listSessions();
    assert.equal(sessionsAfterArchive.length, 2);
    assert.equal(sessionsAfterArchive.find((s) => s.session_id === id1).status, 'archived');
    assert.equal(sessionsAfterArchive.find((s) => s.session_id === id2).status, 'active');

    // While archiveSession(id2) awaits CLI, deleteSession(id2) finishes first; archive must NOT resurrect id2.
    fs.rmSync(gateFile, { force: true });
    fs.rmSync(startedFile, { force: true });
    const archiveId2 = store.archiveSession({ session_id: id2, env });
    await waitForFile(startedFile);
    await store.deleteSession({
      session_id: id2,
      env: {
        ...env,
        CODEX_BRIDGE_BIN_ARGS_PREFIX: JSON.stringify([FAKE_CODEX_PATH]),
      },
    });
    fs.writeFileSync(gateFile, 'go', 'utf8');
    await archiveId2;

    assert.equal(
      store.listSessions().some((s) => s.session_id === id2),
      false
    );

    // Ledger entry mapped to null must not count as bridge-owned for destructive cleanup
    const nullSid = '55555555-2222-4333-8444-555555555555';
    fs.writeFileSync(
      ledgerPath,
      JSON.stringify({ version: 1, sessions: { [nullSid]: null } }, null, 2),
      'utf8'
    );
    await assert.rejects(
      () => store.deleteSession({ session_id: nullSid, env }),
      /not in codex-bridge's tracked ledger/i
    );

    // Corrupting the ledger mid-archive surfaces an explicit error instead of reporting false success
    const corruptId = '44444444-2222-4333-8444-555555555555';
    store.recordSession({ session_id: corruptId, cwd: tmpDir, mode: 'read-only', summary: 'corrupt' });
    fs.rmSync(gateFile, { force: true });
    fs.rmSync(startedFile, { force: true });
    const corruptArchive = store.archiveSession({ session_id: corruptId, env });
    await waitForFile(startedFile);
    fs.writeFileSync(ledgerPath, '{not-valid-json', 'utf8');
    fs.writeFileSync(gateFile, 'go', 'utf8');
    await assert.rejects(() => corruptArchive, /failed to update codex-bridge ledger/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('JobManager preserves personal session ownership on resume and returns output if ledger write fails', async () => {
  const workDir = makeTempDir('cb-jm-ledger-');
  const fakeCodexPath = FAKE_CODEX_PATH;
  const personalId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const ledgerPath = path.join(workDir, 'sessions.json');
  const realStore = new SessionStore(ledgerPath);

  try {
    const resumeManager = new JobManager({
      sessionStore: realStore,
      env: {
        ...process.env,
        CODEX_BRIDGE_TEST_MODE: '1',
        CODEX_BRIDGE_BIN: process.execPath,
        CODEX_BRIDGE_BIN_ARGS_PREFIX: JSON.stringify([fakeCodexPath]),
      },
      startRun: ({ spec }) => ({
        pid: 1,
        getProgress: () => ({ events_count: 1, last_event: 'turn.completed' }),
        cancel: async () => ({ ok: true }),
        donePromise: Promise.resolve({
          exitCode: 0,
          signal: null,
          spawnError: null,
          output: 'resumed personal output',
          stderr: '',
          policyBlocked: false,
          session_id: spec.session_id,
          usage: null,
          worktree: null,
          usedExecFallback: false,
        }),
      }),
    });

    const resumeSpec = validateExecInput({
      cwd: workDir,
      prompt: 'follow up',
      session_id: personalId,
    });
    const resumeResult = await resumeManager.startAndWait(resumeSpec);
    assert.equal(resumeResult.status, 'completed');
    assert.equal(resumeResult.session_id, personalId);
    assert.equal(realStore.listSessions().length, 0);

    const failingManager = new JobManager({
      sessionStore: {
        recordSession: () => {
          throw new Error('EACCES: ledger read-only');
        },
      },
      env: {
        ...process.env,
        CODEX_BRIDGE_TEST_MODE: '1',
        CODEX_BRIDGE_BIN: process.execPath,
        CODEX_BRIDGE_BIN_ARGS_PREFIX: JSON.stringify([fakeCodexPath]),
      },
      startRun: () => ({
        pid: 2,
        getProgress: () => ({ events_count: 1, last_event: 'turn.completed' }),
        cancel: async () => ({ ok: true }),
        donePromise: Promise.resolve({
          exitCode: 0,
          signal: null,
          spawnError: null,
          output: 'important codex answer',
          stderr: '',
          policyBlocked: false,
          session_id: '33333333-2222-4333-8444-555555555555',
          usage: null,
          worktree: null,
          usedExecFallback: false,
        }),
      }),
    });

    const newSpec = validateExecInput({
      cwd: workDir,
      prompt: 'save session',
      persist_session: true,
    });
    const res = await failingManager.startAndWait(newSpec);
    assert.equal(res.status, 'completed');
    assert.equal(res.output, 'important codex answer');
    assert.ok(Array.isArray(res.warnings));
    assert.match(res.warnings[0], /failed to update codex-bridge session ledger/i);
    assert.deepEqual(failingManager.getJobStatus(res.job_id), res);

    // shutdownAll awaits cancel() completion even when donePromise resolves immediately on SIGTERM
    let cancelFinished = false;
    let releaseDone;
    const shutdownManager = new JobManager({
      sessionStore: realStore,
      env: {
        ...process.env,
        CODEX_BRIDGE_TEST_MODE: '1',
        CODEX_BRIDGE_BIN: process.execPath,
        CODEX_BRIDGE_BIN_ARGS_PREFIX: JSON.stringify([fakeCodexPath]),
      },
      cancelGraceMs: 250,
      startRun: () => ({
        pid: 3,
        getProgress: () => ({ events_count: 1, last_event: 'turn.started' }),
        cancel: async () => {
          releaseDone({
            exitCode: null,
            signal: 'SIGTERM',
            spawnError: null,
            output: '',
            stderr: '',
            policyBlocked: false,
            session_id: null,
            usage: null,
            worktree: null,
            usedExecFallback: false,
          });
          await new Promise((r) => setTimeout(r, 40));
          cancelFinished = true;
          return { ok: true, method: 'sigkill' };
        },
        donePromise: new Promise((resolve) => {
          releaseDone = resolve;
        }),
      }),
    });

    const shutdownSpec = validateExecInput({ cwd: workDir, prompt: 'hang', wait_sec: 0.05 });
    const started = await shutdownManager.startAndWait(shutdownSpec);
    assert.equal(started.status, 'running');
    await shutdownManager.shutdownAll();
    assert.equal(cancelFinished, true);

    // Cancel keeps workspace-write lock held until cancel() finishes (even after donePromise settles)
    let lockCancelFinished = false;
    let releaseLockDone;
    const lockManager = new JobManager({
      sessionStore: realStore,
      env: {
        ...process.env,
        CODEX_BRIDGE_TEST_MODE: '1',
        CODEX_BRIDGE_BIN: process.execPath,
        CODEX_BRIDGE_BIN_ARGS_PREFIX: JSON.stringify([fakeCodexPath]),
      },
      cancelGraceMs: 250,
      startRun: ({ spec }) => {
        if (spec.prompt === 'first-writer') {
          return {
            pid: 4,
            getProgress: () => ({ events_count: 1, last_event: 'turn.started' }),
            cancel: async () => {
              releaseLockDone({
                exitCode: null,
                signal: 'SIGTERM',
                spawnError: null,
                output: '',
                stderr: '',
                policyBlocked: false,
                session_id: null,
                usage: null,
                worktree: null,
                usedExecFallback: false,
              });
              await new Promise((r) => setTimeout(r, 60));
              lockCancelFinished = true;
              return { ok: true, method: 'sigkill' };
            },
            donePromise: new Promise((resolve) => {
              releaseLockDone = resolve;
            }),
          };
        }
        return {
          pid: 5,
          getProgress: () => ({ events_count: 1, last_event: 'turn.completed' }),
          cancel: async () => ({ ok: true }),
          donePromise: Promise.resolve({
            exitCode: 0,
            signal: null,
            spawnError: null,
            output: 'second writer ok',
            stderr: '',
            policyBlocked: false,
            session_id: null,
            usage: null,
            worktree: null,
            usedExecFallback: false,
          }),
        };
      },
    });
    const writeSpec1 = validateExecInput({
      cwd: workDir,
      mode: 'workspace-write',
      prompt: 'first-writer',
      wait_sec: 0.05,
    });
    const writeSpec2 = validateExecInput({
      cwd: workDir,
      mode: 'workspace-write',
      prompt: 'second-writer',
      wait_sec: 0.05,
    });
    const startedLock = await lockManager.startAndWait(writeSpec1);
    const cancelPromise1 = lockManager.cancelJob(startedLock.job_id);
    const cancelPromise2 = lockManager.shutdownAll();
    await new Promise((r) => setTimeout(r, 15));
    await assert.rejects(() => lockManager.startAndWait(writeSpec2), /already running/i);
    const [earlyCancel] = await Promise.all([cancelPromise1, cancelPromise2]);
    assert.equal(earlyCancel.status, 'cancelled');
    assert.equal(lockCancelFinished, true);
    const secondWriter = await lockManager.startAndWait(writeSpec2);
    assert.equal(secondWriter.status, 'completed');

    // If parent exits during cancellation while tree termination fails (ok: false),
    // keep status cancel_failed, keep lock held, and never retry cancel against an exited parent PID.
    let cancelCalls = 0;
    const failTreeManager = new JobManager({
      sessionStore: realStore,
      env: {
        ...process.env,
        CODEX_BRIDGE_TEST_MODE: '1',
        CODEX_BRIDGE_BIN: process.execPath,
        CODEX_BRIDGE_BIN_ARGS_PREFIX: JSON.stringify([fakeCodexPath]),
      },
      cancelGraceMs: 100,
      startRun: ({ spec }) => {
        if (spec.prompt === 'fail-tree') {
          let releaseParent;
          return {
            pid: 7,
            getProgress: () => ({ events_count: 1, last_event: 'turn.started' }),
            cancel: async () => {
              cancelCalls += 1;
              // Fail tree termination BEFORE parent exits so activeCancelPromise already settled first
              setTimeout(() => {
                releaseParent({
                  exitCode: null,
                  signal: 'SIGTERM',
                  spawnError: null,
                  output: '',
                  stderr: '',
                  policyBlocked: false,
                  session_id: null,
                  usage: null,
                  worktree: null,
                  usedExecFallback: false,
                });
              }, 15);
              return { ok: false, error: 'SIGKILL EPERM on group' };
            },
            donePromise: new Promise((resolve) => {
              releaseParent = resolve;
            }),
          };
        }
        return {
          pid: 8,
          getProgress: () => ({ events_count: 1, last_event: 'turn.completed' }),
          cancel: async () => ({ ok: true }),
          donePromise: Promise.resolve({
            exitCode: 0,
            signal: null,
            spawnError: null,
            output: 'unlocked ok',
            stderr: '',
            policyBlocked: false,
            session_id: null,
            usage: null,
            worktree: null,
            usedExecFallback: false,
          }),
        };
      },
    });
    const failTreeSpec = validateExecInput(
      { cwd: workDir, mode: 'workspace-write', prompt: 'fail-tree', wait_sec: 0.05 },
      { ...process.env, CODEX_BRIDGE_TEST_MODE: '1' }
    );
    const afterUnlockSpec = validateExecInput(
      { cwd: workDir, mode: 'workspace-write', prompt: 'after-unlock', wait_sec: 0.05 },
      { ...process.env, CODEX_BRIDGE_TEST_MODE: '1' }
    );
    const startedFailTree = await failTreeManager.startAndWait(failTreeSpec);
    const failedCancel = await failTreeManager.cancelJob(startedFailTree.job_id);
    assert.equal(failedCancel.status, 'cancel_failed');
    assert.match(failedCancel.error, /process-tree termination failed/i);

    const repeatedCancel = await failTreeManager.cancelJob(startedFailTree.job_id);
    assert.equal(repeatedCancel.status, 'cancel_failed');
    assert.equal(cancelCalls, 1);

    // Once parent exited, workspace lock is released so subsequent jobs are not permanently deadlocked
    const afterUnlockRes = await failTreeManager.startAndWait(afterUnlockSpec);
    assert.equal(afterUnlockRes.status, 'completed');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('JobManager max_runtime_sec retries failed timeout cancel and preserves timed_out status on late zero exit', async () => {
  const workDir = makeTempDir('cb-timeout-retry-');
  const fakeCodexPath = FAKE_CODEX_PATH;
  const recordedSessions = [];
  let runIndex = 0;
  let retryCancelCalls = 0;
  let persistentCancelCalls = 0;
  let releasePersistent;

  try {
    const manager = new JobManager({
      sessionStore: {
        recordSession: (entry) => recordedSessions.push(entry),
      },
      env: {
        ...process.env,
        CODEX_BRIDGE_TEST_MODE: '1',
        CODEX_BRIDGE_BIN: process.execPath,
        CODEX_BRIDGE_BIN_ARGS_PREFIX: JSON.stringify([fakeCodexPath]),
      },
      cancelGraceMs: 25,
      startRun: () => {
        runIndex += 1;
        if (runIndex === 1) {
          // Job 1: first timeout cancel fails, second retry kills the process cleanly.
          let release1;
          return {
            pid: 200001,
            getProgress: () => ({ events_count: 1, last_event: 'turn.started' }),
            cancel: async () => {
              retryCancelCalls += 1;
              if (retryCancelCalls === 1) {
                return { ok: false, error: 'transient taskkill failure' };
              }
              setTimeout(() => {
                release1({
                  exitCode: 1,
                  signal: 'SIGTERM',
                  spawnError: null,
                  output: '',
                  stderr: '',
                  policyBlocked: false,
                  session_id: 'sess-retry',
                  usage: null,
                  worktree: null,
                  usedExecFallback: false,
                });
              }, 5);
              return { ok: true, method: 'taskkill' };
            },
            donePromise: new Promise((resolve) => {
              release1 = resolve;
            }),
          };
        }
        // Job 2: all timeout cancel attempts fail; process later exits with code 0.
        return {
          pid: 200002,
          getProgress: () => ({ events_count: 1, last_event: 'turn.started' }),
          cancel: async () => {
            persistentCancelCalls += 1;
            return { ok: false, error: 'Access denied' };
          },
          donePromise: new Promise((resolve) => {
            releasePersistent = resolve;
          }),
        };
      },
    });

    const spec1 = {
      ...validateExecInput(
        { cwd: workDir, mode: 'workspace-write', prompt: 'timeout-retry', wait_sec: 0.05, persist_session: true },
        { ...process.env, CODEX_BRIDGE_TEST_MODE: '1' }
      ),
      max_runtime_sec: 0.02,
    };
    const res1 = await manager.startAndWait(spec1);
    const final1 = res1.status === 'running' ? await manager.waitJob(res1.job_id, 1) : res1;
    assert.equal(final1.status, 'timed_out');
    assert.equal(retryCancelCalls, 2);

    const spec2 = {
      ...validateExecInput(
        { cwd: workDir, mode: 'workspace-write', prompt: 'timeout-late-exit', wait_sec: 0.05, persist_session: true },
        { ...process.env, CODEX_BRIDGE_TEST_MODE: '1' }
      ),
      max_runtime_sec: 0.02,
    };
    const started2 = await manager.startAndWait(spec2);
    assert.equal(started2.status, 'running');

    // Wait long enough for all 3 bounded timeout cancel attempts to complete.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(persistentCancelCalls, 3);
    assert.equal(manager.getJobStatus(started2.job_id).status, 'running');

    // Write lock remains held while the OS process has not exited.
    await assert.rejects(() => manager.startAndWait(spec2), /already running/i);

    // Late natural exit with code 0 must still be reported as 'timed_out', never 'completed'.
    releasePersistent({
      exitCode: 0,
      signal: null,
      spawnError: null,
      output: 'late zero exit',
      stderr: '',
      policyBlocked: false,
      session_id: 'sess-late',
      usage: null,
      worktree: null,
      usedExecFallback: false,
    });
    const final2 = await manager.waitJob(started2.job_id, 1);
    assert.equal(final2.status, 'timed_out');
    assert.equal(recordedSessions.length, 0);

    // Job 3: child has already exited while pipes are still draining; timeout must not retry PID kill.
    let exitedJobCancelCalls = 0;
    let exitedFlag = false;
    let releaseExited;
    const exitedManager = new JobManager({
      sessionStore: { recordSession: () => {} },
      env: {
        ...process.env,
        CODEX_BRIDGE_TEST_MODE: '1',
        CODEX_BRIDGE_BIN: process.execPath,
        CODEX_BRIDGE_BIN_ARGS_PREFIX: JSON.stringify([fakeCodexPath]),
      },
      cancelGraceMs: 25,
      startRun: () => ({
        pid: 200003,
        hasExited: () => exitedFlag,
        getProgress: () => ({ events_count: 1, last_event: 'turn.started' }),
        cancel: async () => {
          exitedJobCancelCalls += 1;
          exitedFlag = true;
          return { ok: false, error: 'transient failure while exiting' };
        },
        donePromise: new Promise((resolve) => {
          releaseExited = resolve;
        }),
      }),
    });
    const spec3 = {
      ...validateExecInput(
        { cwd: workDir, mode: 'workspace-write', prompt: 'timeout-exited-child', wait_sec: 0.05 },
        { ...process.env, CODEX_BRIDGE_TEST_MODE: '1' }
      ),
      max_runtime_sec: 0.02,
    };
    const started3 = await exitedManager.startAndWait(spec3);
    assert.equal(started3.status, 'running');
    await new Promise((r) => setTimeout(r, 140));
    assert.equal(exitedJobCancelCalls, 1);
    releaseExited({
      exitCode: 0,
      signal: null,
      spawnError: null,
      output: '',
      stderr: '',
      policyBlocked: false,
      session_id: null,
      usage: null,
      worktree: null,
      usedExecFallback: false,
    });
    assert.equal((await exitedManager.waitJob(started3.job_id, 1)).status, 'timed_out');

    // Job 4: shutdownAll() clears queued timeout retries and prevents post-shutdown cancel calls.
    let shutdownCancelCalls = 0;
    let releaseShutdown;
    const shutdownRetryManager = new JobManager({
      sessionStore: { recordSession: () => {} },
      env: {
        ...process.env,
        CODEX_BRIDGE_TEST_MODE: '1',
        CODEX_BRIDGE_BIN: process.execPath,
        CODEX_BRIDGE_BIN_ARGS_PREFIX: JSON.stringify([fakeCodexPath]),
      },
      cancelGraceMs: 40,
      startRun: () => ({
        pid: 200004,
        hasExited: () => false,
        getProgress: () => ({ events_count: 1, last_event: 'turn.started' }),
        cancel: async () => {
          shutdownCancelCalls += 1;
          return { ok: false, error: 'Access denied' };
        },
        donePromise: new Promise((resolve) => {
          releaseShutdown = resolve;
        }),
      }),
    });
    const spec4 = {
      ...validateExecInput(
        { cwd: workDir, mode: 'read-only', prompt: 'timeout-shutdown', wait_sec: 0.05 },
        { ...process.env, CODEX_BRIDGE_TEST_MODE: '1' }
      ),
      max_runtime_sec: 0.02,
    };
    await shutdownRetryManager.startAndWait(spec4);
    await new Promise((r) => setTimeout(r, 70));
    await shutdownRetryManager.shutdownAll();
    const callsAfterShutdown = shutdownCancelCalls;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(shutdownCancelCalls, callsAfterShutdown);
    releaseShutdown({
      exitCode: 0,
      signal: null,
      spawnError: null,
      output: '',
      stderr: '',
      policyBlocked: false,
      session_id: null,
      usage: null,
      worktree: null,
      usedExecFallback: false,
    });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
