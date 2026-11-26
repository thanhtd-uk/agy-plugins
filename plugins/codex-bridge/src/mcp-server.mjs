import { JobManager } from './job-manager.mjs';
import { SessionStore } from './session-store.mjs';
import { validateExecInput, validateReviewInput } from './validation.mjs';

const SERVER_INFO = {
  name: 'codex-bridge',
  version: '0.2.1',
};

export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const TOOLS = [
  {
    name: 'codex_exec',
    description:
      'Run Codex CLI (codex exec / resume) in an explicit workspace cwd. Defaults to ephemeral + read-only; returns job_id at ~145s if still running.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['cwd', 'prompt'],
      properties: {
        cwd: { type: 'string', description: 'Required absolute workspace directory path.' },
        prompt: { type: 'string', description: 'Task goal or follow-up prompt.' },
        mode: {
          type: 'string',
          enum: ['read-only', 'worktree', 'workspace-write'],
          default: 'read-only',
          description: 'Sandbox policy. Prefer worktree for isolated Git edits; workspace-write for direct edits.',
        },
        focus_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional relative file paths (path[:start-end]) for Codex to read directly.',
        },
        context: { type: 'string', description: 'Concise background or findings from Orchestrator.' },
        constraints: { type: 'string', description: 'Hard requirements or verification commands.' },
        deliverable: { type: 'string', description: 'Expected output format.' },
        persist_session: {
          type: 'boolean',
          default: false,
          description: 'Keep Codex conversation on disk and return session_id for later resume.',
        },
        session_id: {
          type: 'string',
          description: 'Resume an existing persisted Codex session_id.',
        },
        profile: {
          type: 'string',
          enum: ['fast', 'deep'],
          description: 'Model tier: "fast" (GPT-6.2 Sol, default) or "deep" (GPT-6.2 Astra). Decoupled from config.toml.',
        },
        model: { type: 'string', description: 'Optional raw model slug override (supersedes profile).' },
        reasoning_effort: {
          type: 'string',
          description: 'Optional effort slug (low, medium, high, xhigh, max, ultra; defaults to high for fast/deep).',
        },
        wait_sec: { type: 'number', default: 145, description: 'Sync wait budget before returning background job_id (max 150s).' },
        max_runtime_sec: { type: 'number', default: 900, description: 'Hard job timeout in seconds (max 1800s).' },
        max_output_chars: { type: 'number', default: 8500, description: 'Output character cap (500..8500).' },
      },
    },
  },
  {
    name: 'codex_review',
    description:
      'Run ephemeral read-only Codex code review (codex exec review) on a Git repository.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['cwd'],
      properties: {
        cwd: { type: 'string', description: 'Required absolute Git repository directory path.' },
        uncommitted: { type: 'boolean', description: 'Review staged, unstaged, and untracked changes.' },
        base: { type: 'string', description: 'Review changes against this base branch.' },
        commit: { type: 'string', description: 'Review a specific commit SHA.' },
        title: { type: 'string', description: 'Optional title for the review summary.' },
        prompt: { type: 'string', description: 'Optional custom review instructions.' },
        profile: {
          type: 'string',
          enum: ['fast', 'deep'],
          description: 'Model tier: "fast" (GPT-6.2 Sol, default) or "deep" (GPT-6.2 Astra). Decoupled from config.toml.',
        },
        model: { type: 'string', description: 'Optional raw model slug override (supersedes profile).' },
        reasoning_effort: { type: 'string', description: 'Optional effort slug (low..ultra; defaults to high for fast/deep).' },
        wait_sec: { type: 'number', default: 145, description: 'Sync wait budget (max 150s).' },
        max_runtime_sec: { type: 'number', default: 900, description: 'Hard timeout (max 1800s).' },
        max_output_chars: { type: 'number', default: 8500, description: 'Output character cap (500..8500).' },
      },
    },
  },
  {
    name: 'codex_job',
    description:
      'Manage background Codex jobs returned after the 145s sync window (wait long-poll, status, cancel, list).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['wait', 'status', 'cancel', 'list'] },
        job_id: { type: 'string', description: 'Required for wait, status, and cancel.' },
        wait_sec: { type: 'number', default: 140, description: 'Long-poll duration for action=wait (max 150s).' },
      },
    },
  },
  {
    name: 'codex_session',
    description:
      'List, archive, or delete persisted Codex sessions tracked by codex-bridge.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'archive', 'delete'] },
        session_id: { type: 'string', description: 'Required for archive and delete (UUID required for delete).' },
        allow_untracked: {
          type: 'boolean',
          default: false,
          description: 'Allow archiving/deleting a session not created by codex-bridge.',
        },
      },
    },
  },
];

function toolSuccess(payload) {
  const isFailure =
    payload &&
    typeof payload === 'object' &&
    (payload.status === 'failed' ||
      payload.status === 'timed_out' ||
      payload.status === 'cancel_failed');
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isFailure ? { isError: true } : {}),
  };
}

function toolError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

/** Creates a stateful MCP request router bound to a JobManager & SessionStore. */
export function createBridgeHandler(env = process.env) {
  const sessionStore = new SessionStore();
  const jobManager = new JobManager({ sessionStore, env });
  let initialized = false;
  let negotiatedProtocolVersion = LATEST_PROTOCOL_VERSION;

  async function handleToolCall(name, args) {
    try {
      if (name === 'codex_exec') {
        const sid = typeof args?.session_id === 'string' ? args.session_id.trim() : '';
        const resumedSession = sid ? sessionStore.getSession(sid) : null;
        const spec = validateExecInput(args, env, { resumedSession });
        return toolSuccess(await jobManager.startAndWait(spec));
      }
      if (name === 'codex_review') {
        const spec = validateReviewInput(args, env);
        return toolSuccess(await jobManager.startAndWait(spec));
      }
      if (name === 'codex_job') {
        const action = args?.action;
        if (action === 'list') {
          return toolSuccess({ jobs: jobManager.listJobs() });
        }
        const jobId = typeof args?.job_id === 'string' ? args.job_id.trim() : '';
        if (!jobId) {
          throw new Error(`"job_id" is required for codex_job action="${action}".`);
        }
        if (action === 'wait') {
          return toolSuccess(await jobManager.waitJob(jobId, args?.wait_sec));
        }
        if (action === 'status') {
          return toolSuccess(jobManager.getJobStatus(jobId));
        }
        if (action === 'cancel') {
          return toolSuccess(await jobManager.cancelJob(jobId));
        }
        throw new Error(`Unsupported codex_job action: "${action}".`);
      }
      if (name === 'codex_session') {
        const action = args?.action;
        if (action === 'list') {
          return toolSuccess({ sessions: sessionStore.listSessions() });
        }
        const session_id = typeof args?.session_id === 'string' ? args.session_id.trim() : '';
        if (!session_id) {
          throw new Error(`"session_id" is required for codex_session action="${action}".`);
        }
        if (args?.allow_untracked !== undefined && typeof args.allow_untracked !== 'boolean') {
          throw new Error('"allow_untracked" must be a boolean.');
        }
        const allow_untracked = args?.allow_untracked === true;
        if (action === 'archive') {
          return toolSuccess(await sessionStore.archiveSession({ session_id, allow_untracked, env }));
        }
        if (action === 'delete') {
          return toolSuccess(await sessionStore.deleteSession({ session_id, allow_untracked, env }));
        }
        throw new Error(`Unsupported codex_session action: "${action}".`);
      }
      throw new Error(`Unknown tool: ${name}`);
    } catch (err) {
      return toolError(err);
    }
  }

  async function handleRpcMessage(msg, { inBatch = false } = {}) {
    if (
      !msg ||
      typeof msg !== 'object' ||
      Array.isArray(msg) ||
      msg.jsonrpc !== '2.0' ||
      typeof msg.method !== 'string' ||
      !msg.method
    ) {
      return {
        jsonrpc: '2.0',
        id:
          msg && typeof msg === 'object' && Object.prototype.hasOwnProperty.call(msg, 'id')
            ? msg.id
            : null,
        error: { code: -32600, message: 'Invalid Request' },
      };
    }

    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
    if (!hasId) {
      return null;
    }

    try {
      if (msg.method === 'initialize') {
        if (inBatch) {
          return {
            jsonrpc: '2.0',
            id: msg.id,
            error: {
              code: -32600,
              message: 'Invalid Request: initialize cannot be sent inside a JSON-RPC batch',
            },
          };
        }
        if (initialized) {
          return {
            jsonrpc: '2.0',
            id: msg.id,
            error: {
              code: -32600,
              message: 'Invalid Request: server is already initialized',
            },
          };
        }
        if (typeof msg.params?.protocolVersion !== 'string' || !msg.params.protocolVersion.trim()) {
          return {
            jsonrpc: '2.0',
            id: msg.id,
            error: {
              code: -32602,
              message: 'Invalid params: "protocolVersion" must be a non-empty string',
            },
          };
        }
        const requestedVersion = msg.params.protocolVersion.trim();
        initialized = true;
        negotiatedProtocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
          ? requestedVersion
          : LATEST_PROTOCOL_VERSION;
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: negotiatedProtocolVersion,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        };
      }
      if (msg.method === 'ping') {
        return { jsonrpc: '2.0', id: msg.id, result: {} };
      }
      if (msg.method === 'tools/list') {
        return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
      }
      if (msg.method === 'tools/call') {
        const toolName = msg.params?.name;
        const toolArgs = msg.params?.arguments ?? {};
        const result = await handleToolCall(toolName, toolArgs);
        return { jsonrpc: '2.0', id: msg.id, result };
      }
      return {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  return {
    handleRpcMessage,
    getProtocolVersion: () => negotiatedProtocolVersion,
    shutdown: () => jobManager.shutdownAll(),
  };
}

/** Runs the Stdio transport supporting both NDJSON and Content-Length framing. */
export function startStdioServer(env = process.env) {
  const bridge = createBridgeHandler(env);
  let buffer = Buffer.alloc(0);
  let framing = 'ndjson';
  let shuttingDown = false;

  const sendResponse = (payload) => {
    const json = JSON.stringify(payload);
    if (framing === 'content-length') {
      const byteLen = Buffer.byteLength(json, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`, 'utf8');
    } else {
      process.stdout.write(`${json}\n`, 'utf8');
    }
  };

  const dispatchLine = (rawText) => {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      sendResponse({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }
    if (Array.isArray(msg)) {
      if (bridge.getProtocolVersion() !== '2025-03-26') {
        sendResponse({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32600,
            message: `Invalid Request: JSON-RPC batching is not supported in MCP ${bridge.getProtocolVersion()}`,
          },
        });
        return;
      }
      if (msg.length === 0) {
        sendResponse({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid Request' },
        });
        return;
      }
      void Promise.all(
        msg.map((item) => bridge.handleRpcMessage(item, { inBatch: true }))
      ).then((results) => {
        const responses = results.filter(Boolean);
        if (responses.length > 0) {
          sendResponse(responses);
        }
      });
      return;
    }
    void bridge.handleRpcMessage(msg).then((res) => {
      if (res) {
        sendResponse(res);
      }
    });
  };

  const processBuffer = () => {
    while (buffer.length > 0) {
      const asAscii = buffer.subarray(0, Math.min(buffer.length, 64)).toString('ascii');
      if (/^Content-Length:/i.test(asAscii)) {
        framing = 'content-length';
        const sepIdx = buffer.indexOf('\r\n\r\n');
        const lfSepIdx = sepIdx === -1 ? buffer.indexOf('\n\n') : -1;
        const headerEnd = sepIdx !== -1 ? sepIdx : lfSepIdx;
        const sepLen = sepIdx !== -1 ? 4 : 2;
        if (headerEnd === -1) return;

        const headerStr = buffer.subarray(0, headerEnd).toString('ascii');
        const match = /Content-Length:\s*(\d+)/i.exec(headerStr);
        if (!match) {
          buffer = buffer.subarray(headerEnd + sepLen);
          continue;
        }
        const contentLen = Number(match[1]);
        const msgStart = headerEnd + sepLen;
        if (buffer.length < msgStart + contentLen) return;

        const body = buffer.subarray(msgStart, msgStart + contentLen).toString('utf8');
        buffer = buffer.subarray(msgStart + contentLen);
        dispatchLine(body);
        continue;
      }

      const nlIdx = buffer.indexOf('\n');
      if (nlIdx === -1) return;
      const line = buffer.subarray(0, nlIdx).toString('utf8');
      buffer = buffer.subarray(nlIdx + 1);
      dispatchLine(line);
    }
  };

  const gracefulExit = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await bridge.shutdown();
    process.exit(0);
  };

  process.stdin.on('data', (chunk) => {
    const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    buffer = Buffer.concat([buffer, chunkBuf]);
    processBuffer();
  });

  process.stdin.on('end', () => {
    void gracefulExit();
  });
  process.on('SIGINT', () => {
    void gracefulExit();
  });
  process.on('SIGTERM', () => {
    void gracefulExit();
  });

  return bridge;
}

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const isEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  }
})();

if (isEntrypoint) {
  startStdioServer();
}
