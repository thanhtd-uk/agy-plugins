import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(PLUGIN_ROOT, 'src', 'mcp-server.mjs');
const FAKE_CODEX_PATH = path.join(PLUGIN_ROOT, 'test', 'fixtures', 'fake-codex.mjs');

class McpClient {
  constructor(env) {
    this.child = spawn(process.execPath, [SERVER_PATH], {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.stderr = '';

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buf += chunk;
      const lines = this.buf.split(/\r?\n/);
      this.buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const msg = JSON.parse(trimmed);
        if (Array.isArray(msg) || (msg.id === null && this.pending.has('__batch__'))) {
          const resolver = this.pending.get('__batch__');
          if (resolver) {
            this.pending.delete('__batch__');
            resolver(msg);
          }
          continue;
        }
        const resolver = this.pending.get(msg.id);
        if (resolver) {
          this.pending.delete(msg.id);
          resolver(msg);
        }
      }
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout for ${method} (stderr=${this.stderr})`));
      }, 15000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(payload, 'utf8');
    });
  }

  requestBatch(items) {
    const payload = JSON.stringify(items) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete('__batch__');
        reject(new Error(`Batch RPC timeout (stderr=${this.stderr})`));
      }, 15000);
      this.pending.set('__batch__', (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(payload, 'utf8');
    });
  }

  async callTool(name, args) {
    const res = await this.request('tools/call', { name, arguments: args });
    assert.ok(!res.error, `Unexpected JSON-RPC error: ${JSON.stringify(res.error)}`);
    const text = res.result?.content?.[0]?.text ?? '{}';
    return {
      isError: Boolean(res.result?.isError),
      data: JSON.parse(text),
    };
  }

  async close() {
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 3000);
      this.child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function makeWorktreeDir(prefix, withGit = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (withGit) {
    execFileSync('git', ['init'], { cwd: dir, windowsHide: true, stdio: 'ignore' });
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
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);\n', 'utf8');
    execFileSync('git', ['add', 'app.js'], { cwd: dir, windowsHide: true, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], {
      cwd: dir,
      windowsHide: true,
      stdio: 'ignore',
    });
  }
  return dir;
}

test('MCP integration: Content-Length frames count UTF-8 bytes over stdio', () => {
  const requests = [
    {
      id: 'khởi tạo 🚀',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        clientInfo: { name: 'Tiếng Việt 🌏', version: '1.0' },
      },
    },
    { id: 'kiểm tra 🏓', method: 'ping', params: { message: 'Xin chào 👋' } },
  ];
  const frames = requests.map((request) => {
    const json = JSON.stringify({ jsonrpc: '2.0', ...request });
    const length = Buffer.byteLength(json, 'utf8');
    assert.ok(length > json.length);
    return `Content-Length: ${length}\r\n\r\n${json}`;
  });
  let output = execFileSync(process.execPath, [SERVER_PATH], {
    cwd: PLUGIN_ROOT,
    input: frames.join(''),
    timeout: 15000,
    windowsHide: true,
  });

  const responses = requests.map(({ id }) => {
    const headerEnd = output.indexOf('\r\n\r\n');
    assert.ok(headerEnd >= 0, 'Missing response header terminator');
    const header = output.subarray(0, headerEnd).toString('ascii');
    assert.match(header, /^Content-Length: \d+$/i);
    const length = Number(header.split(':')[1]);
    const body = output.toString('utf8', headerEnd + 4, headerEnd + 4 + length);
    const byteLen = Buffer.byteLength(body, 'utf8');
    assert.equal(length, byteLen, 'Content-Length must match the response JSON byte length');
    assert.ok(byteLen > body.length, 'Expected multi-byte UTF-8 in the response JSON');
    const response = JSON.parse(body);
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, id);
    output = output.subarray(headerEnd + 4 + length);
    return response;
  });
  assert.equal(output.length, 0, 'Unexpected bytes after the ping response');
  assert.equal(responses[0].result.protocolVersion, '2025-03-26');
  assert.deepEqual(responses[1].result, {});
});

test('MCP integration: full lifecycle over stdio', async () => {
  const sandboxDir = makeWorktreeDir('cb-int-work-', true);
  const stateDir = makeWorktreeDir('cb-int-state-', false);
  const logFile = path.join(stateDir, 'fake-codex.jsonl');
  const ledgerFile = path.join(stateDir, 'sessions.json');

  const tmpFilesBefore = new Set(
    fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('codex-bridge-'))
  );

  // Separate connection checks unsupported protocol negotiation, duplicate initialize rejection, and 2025-11-25 batch gating
  try {
    const latestClient = new McpClient({
      CODEX_BRIDGE_TEST_MODE: '1',
      CODEX_BRIDGE_BIN: process.execPath,
      CODEX_BRIDGE_BIN_ARGS_PREFIX: JSON.stringify([FAKE_CODEX_PATH]),
      CODEX_BRIDGE_SESSION_STORE: ledgerFile,
      CODEX_BRIDGE_MAX_JOBS: '3',
    });
    try {
      const badInit = await latestClient.request('initialize', { protocolVersion: 12345 });
      assert.equal(badInit.error.code, -32602);

      const initUnsupported = await latestClient.request('initialize', {
        protocolVersion: '2099-01-01',
      });
      assert.equal(initUnsupported.result.protocolVersion, '2025-11-25');

      const duplicateInit = await latestClient.request('initialize', {
        protocolVersion: '2025-03-26',
      });
      assert.equal(duplicateInit.error.code, -32600);
      assert.match(duplicateInit.error.message, /already initialized/i);

      const rejectedBatch = await latestClient.requestBatch([
        { jsonrpc: '2.0', id: 900, method: 'ping', params: {} },
      ]);
      assert.equal(rejectedBatch.error.code, -32600);
      assert.match(rejectedBatch.error.message, /batching is not supported/i);
    } finally {
      await latestClient.close();
    }
  } catch (err) {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    throw err;
  }

  const client = new McpClient({
    CODEX_BRIDGE_TEST_MODE: '1',
    CODEX_BRIDGE_BIN: process.execPath,
    CODEX_BRIDGE_BIN_ARGS_PREFIX: JSON.stringify([FAKE_CODEX_PATH]),
    CODEX_BRIDGE_SESSION_STORE: ledgerFile,
    CODEX_BRIDGE_MAX_JOBS: '3',
    FAKE_CODEX_LOG_FILE: logFile,
  });

  try {
    // 1. initialize (2025-03-26) + tools/list + batch dispatch
    const init = await client.request('initialize', { protocolVersion: '2025-03-26' });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal(init.result.serverInfo.name, 'codex-bridge');
    const listRes = await client.request('tools/list');
    assert.deepEqual(
      listRes.result.tools.map((t) => t.name),
      ['codex_exec', 'codex_review', 'codex_job', 'codex_session']
    );

    const batchRes = await client.requestBatch([
      { jsonrpc: '2.0', id: 901, method: 'ping', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0' },
      { method: 'initialize' },
      { jsonrpc: '2.0', id: 902, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { jsonrpc: '2.0', id: 903, method: 'tools/list', params: {} },
    ]);
    assert.equal(Array.isArray(batchRes), true);
    assert.equal(batchRes.length, 5);
    assert.equal(batchRes[0].id, 901);
    assert.equal(batchRes[1].id, null);
    assert.equal(batchRes[1].error.code, -32600);
    assert.equal(batchRes[2].id, null);
    assert.equal(batchRes[2].error.code, -32600);
    assert.equal(batchRes[3].id, 902);
    assert.equal(batchRes[3].error.code, -32600);
    assert.match(batchRes[3].error.message, /initialize cannot be sent inside a json-rpc batch/i);
    assert.equal(batchRes[4].id, 903);

    // 2. Sync codex_exec with > 12KB stdin prompt (exceeds Windows 8191-char CLI limit)
    const bigPrompt = `[SCENARIO:fast_exec] ` + 'Z'.repeat(12500);
    const fast = await client.callTool('codex_exec', {
      cwd: sandboxDir,
      prompt: bigPrompt,
      focus_files: ['app.js:1-1'],
    });
    assert.equal(fast.isError, false);
    assert.equal(fast.data.status, 'completed');
    assert.equal(fast.data.session_id, undefined);
    assert.match(fast.data.output, /stdinBytes=/);
    const logs1 = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.ok(logs1[0].stdinBytes > 12500);
    assert.ok(logs1[0].argv.includes('--ephemeral'));

    // 3. Invalid cwd returns isError
    const badCwd = await client.callTool('codex_exec', {
      cwd: 'relative/dir',
      prompt: 'fail',
    });
    assert.equal(badCwd.isError, true);
    assert.match(badCwd.data.error, /absolute path/i);

    // 4. Slow job exceeds wait_sec -> background job_id -> codex_job wait
    const slowStart = await client.callTool('codex_exec', {
      cwd: sandboxDir,
      prompt: '[SCENARIO:slow_exec:400] analyze slow task',
      wait_sec: 0.1,
    });
    assert.equal(slowStart.isError, false);
    assert.equal(slowStart.data.status, 'running');
    assert.ok(slowStart.data.job_id);

    const slowDone = await client.callTool('codex_job', {
      action: 'wait',
      job_id: slowStart.data.job_id,
      wait_sec: 5,
    });
    assert.equal(slowDone.isError, false);
    assert.equal(slowDone.data.status, 'completed');

    // 5. Hanging job -> cancel kills tree & concurrency/write-lock enforcement
    const writeJob1 = await client.callTool('codex_exec', {
      cwd: sandboxDir,
      mode: 'workspace-write',
      prompt: '[SCENARIO:hang_exec] edit 1',
      wait_sec: 0.1,
    });
    assert.equal(writeJob1.data.status, 'running');

    const writeConflict = await client.callTool('codex_exec', {
      cwd: sandboxDir,
      mode: 'workspace-write',
      prompt: '[SCENARIO:fast_exec] edit 2',
      wait_sec: 1,
    });
    assert.equal(writeConflict.isError, true);
    assert.match(writeConflict.data.error, /workspace-write job .* already running/i);

    const cancelled = await client.callTool('codex_job', {
      action: 'cancel',
      job_id: writeJob1.data.job_id,
    });
    assert.equal(cancelled.data.status, 'cancelled');

    // 5b. Junction/symlink targeting the same directory must share the workspace-write lock
    const junctionParent = makeWorktreeDir('cb-int-junc-', false);
    const junctionDir = path.join(junctionParent, 'repo-link');
    fs.symlinkSync(sandboxDir, junctionDir, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const realWrite = await client.callTool('codex_exec', {
        cwd: sandboxDir,
        mode: 'workspace-write',
        prompt: '[SCENARIO:hang_exec] lock real',
        wait_sec: 0.1,
      });
      assert.equal(realWrite.data.status, 'running');

      const junctionConflict = await client.callTool('codex_exec', {
        cwd: junctionDir,
        mode: 'workspace-write',
        prompt: '[SCENARIO:fast_exec] bypass via junction',
        wait_sec: 0.2,
      });
      assert.equal(junctionConflict.isError, true);
      assert.match(junctionConflict.data.error, /workspace-write job .* already running/i);

      const cancelledReal = await client.callTool('codex_job', {
        action: 'cancel',
        job_id: realWrite.data.job_id,
      });
      assert.equal(cancelledReal.data.status, 'cancelled');
    } finally {
      fs.rmSync(junctionDir, { recursive: true, force: true });
      fs.rmSync(junctionParent, { recursive: true, force: true });
    }

    // 6. Huge output truncation <= 8500 chars
    const huge = await client.callTool('codex_exec', {
      cwd: sandboxDir,
      prompt: '[SCENARIO:huge_output] produce big text',
      max_output_chars: 1500,
    });
    assert.equal(huge.data.status, 'completed');
    assert.equal(huge.data.truncated, true);
    assert.ok(huge.data.output.length <= 1500);

    // 7. Persistent session lifecycle -> resume -> list -> delete
    const persisted = await client.callTool('codex_exec', {
      cwd: sandboxDir,
      prompt: '[SCENARIO:fast_exec] start session',
      persist_session: true,
    });
    assert.equal(persisted.data.status, 'completed');
    assert.ok(persisted.data.session_id);

    const resumed = await client.callTool('codex_exec', {
      cwd: sandboxDir,
      prompt: '[SCENARIO:fast_exec] continue session',
      session_id: persisted.data.session_id,
    });
    assert.equal(resumed.data.status, 'completed');
    assert.equal(resumed.data.session_id, persisted.data.session_id);

    const listed = await client.callTool('codex_session', { action: 'list' });
    assert.equal(listed.data.sessions.length, 1);

    const untrackDelete = await client.callTool('codex_session', {
      action: 'delete',
      session_id: '99999999-9999-4999-8999-999999999999',
    });
    assert.equal(untrackDelete.isError, true);

    // 7b. String "false" for allow_untracked must be rejected; resuming a personal session must not claim ownership
    const stringBoolDelete = await client.callTool('codex_session', {
      action: 'delete',
      session_id: '99999999-9999-4999-8999-999999999999',
      allow_untracked: 'false',
    });
    assert.equal(stringBoolDelete.isError, true);
    assert.match(stringBoolDelete.data.error, /must be a boolean/i);

    const personalId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const resumedPersonal = await client.callTool('codex_exec', {
      cwd: sandboxDir,
      prompt: '[SCENARIO:fast_exec] follow up on personal session',
      session_id: personalId,
    });
    assert.equal(resumedPersonal.isError, false);
    assert.equal(resumedPersonal.data.session_id, personalId);

    const listedAfterPersonal = await client.callTool('codex_session', { action: 'list' });
    assert.equal(
      listedAfterPersonal.data.sessions.some((s) => s.session_id === personalId),
      false
    );

    const deleteResumedPersonal = await client.callTool('codex_session', {
      action: 'delete',
      session_id: personalId,
    });
    assert.equal(deleteResumedPersonal.isError, true);
    assert.match(deleteResumedPersonal.data.error, /not in codex-bridge's tracked ledger/i);

    const deleted = await client.callTool('codex_session', {
      action: 'delete',
      session_id: persisted.data.session_id,
    });
    assert.equal(deleted.isError, false);
    assert.equal(deleted.data.status, 'deleted');

    // 8. codex_review pure --uncommitted & target+prompt fallback
    const rev1 = await client.callTool('codex_review', {
      cwd: sandboxDir,
      uncommitted: true,
    });
    assert.equal(rev1.isError, false);
    assert.equal(rev1.data.status, 'completed');
    assert.equal(rev1.data.used_exec_fallback, undefined);

    const rev2 = await client.callTool('codex_review', {
      cwd: sandboxDir,
      uncommitted: true,
      prompt: '[SCENARIO:fast_exec] check edge cases',
    });
    assert.equal(rev2.isError, false);
    assert.equal(rev2.data.used_exec_fallback, true);

    // 8b. Windows sandbox policy-block stderr surfaces warning even across chunk splits & >4KB tail
    const blocked = await client.callTool('codex_exec', {
      cwd: sandboxDir,
      prompt: '[SCENARIO:policy_blocked] inspect files',
    });
    assert.equal(blocked.isError, false);
    assert.equal(blocked.data.status, 'completed');
    assert.ok(Array.isArray(blocked.data.warnings));
    assert.match(blocked.data.warnings[0], /blocked by policy/i);
    assert.ok(typeof blocked.data.stderr === 'string' && blocked.data.stderr.length > 0);

    // 8c. max_runtime_sec enforcement terminates hanging child and releases workspace-write lock
    const timedOutExec = await client.callTool('codex_exec', {
      cwd: sandboxDir,
      mode: 'workspace-write',
      prompt: '[SCENARIO:hang_exec] exceed max runtime',
      max_runtime_sec: 0.25,
      wait_sec: 5,
    });
    assert.equal(timedOutExec.isError, true);
    assert.equal(timedOutExec.data.status, 'timed_out');
    assert.match(timedOutExec.data.error, /max_runtime_sec/i);

    const afterTimeoutWrite = await client.callTool('codex_exec', {
      cwd: sandboxDir,
      mode: 'workspace-write',
      prompt: '[SCENARIO:fast_exec] lock released after timeout',
      wait_sec: 2,
    });
    assert.equal(afterTimeoutWrite.isError, false);
    assert.equal(afterTimeoutWrite.data.status, 'completed');

    // 9. Verify no leaked temp output files
    const tmpFilesAfter = fs
      .readdirSync(os.tmpdir())
      .filter((f) => f.startsWith('codex-bridge-') && !tmpFilesBefore.has(f));
    assert.deepEqual(tmpFilesAfter, []);
  } finally {
    await client.close();
    fs.rmSync(sandboxDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
