import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getSessionLedgerPath, resolveCodexBinary } from './config.mjs';
import { SESSION_ID_RE, UUID_RE } from './validation.mjs';

function runCodexSubcommand(binInfo, args) {
  return new Promise((resolve, reject) => {
    execFile(
      binInfo.binPath,
      [...binInfo.prefixArgs, ...args],
      { windowsHide: true, timeout: 15000, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message || '').trim();
          reject(new Error(`codex ${args[0]} failed: ${detail}`));
          return;
        }
        resolve({ stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
      }
    );
  });
}

/**
 * Tracks bridge-created persistent Codex sessions so cleanup operations never
 * accidentally touch the user's personal interactive Codex sessions.
 */
export class SessionStore {
  constructor(ledgerPath = getSessionLedgerPath()) {
    this.ledgerPath = ledgerPath;
  }

  _readLedger({ throwOnError = false } = {}) {
    if (!fs.existsSync(this.ledgerPath)) {
      return { version: 1, sessions: Object.create(null) };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.sessions || typeof parsed.sessions !== 'object') {
        if (throwOnError) {
          throw new Error('Ledger file is malformed (missing "sessions" object).');
        }
        return { version: 1, sessions: Object.create(null) };
      }
      return { version: 1, sessions: Object.assign(Object.create(null), parsed.sessions) };
    } catch (err) {
      if (throwOnError) {
        throw err;
      }
      return { version: 1, sessions: Object.create(null) };
    }
  }

  _writeLedger(data) {
    const dir = path.dirname(this.ledgerPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.ledgerPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
      fs.renameSync(tmpPath, this.ledgerPath);
    } catch (err) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // best-effort temp cleanup
      }
      throw err;
    }
  }

  _hasTrackedEntry(sessions, sid) {
    return (
      Object.hasOwn(sessions, sid) &&
      Boolean(sessions[sid]) &&
      typeof sessions[sid] === 'object' &&
      !Array.isArray(sessions[sid])
    );
  }

  /** Records or updates a persistent bridge session in the ledger. */
  recordSession({ session_id, cwd, mode, summary, onlyIfTracked = false }) {
    if (!session_id) return null;
    const ledger = this._readLedger();
    const now = new Date().toISOString();
    const existing = this._hasTrackedEntry(ledger.sessions, session_id)
      ? ledger.sessions[session_id]
      : undefined;
    if (onlyIfTracked && !existing) {
      return null;
    }
    const entry = {
      session_id,
      cwd,
      mode,
      created_at: existing?.created_at ?? now,
      last_used_at: now,
      status: 'active',
      summary: (summary || existing?.summary || '').slice(0, 140),
    };
    ledger.sessions[session_id] = entry;
    this._writeLedger(ledger);
    return entry;
  }

  /** Lists bridge-tracked sessions sorted most-recently-used first. */
  listSessions() {
    const ledger = this._readLedger();
    return Object.values(ledger.sessions).sort((a, b) =>
      String(b.last_used_at).localeCompare(String(a.last_used_at))
    );
  }

  /** Archives a Codex session (bridge-tracked by default). */
  async archiveSession({ session_id, allow_untracked = false, env = process.env }) {
    if (typeof allow_untracked !== 'boolean') {
      throw new Error('"allow_untracked" must be a boolean.');
    }
    if (typeof session_id !== 'string' || !SESSION_ID_RE.test(session_id.trim())) {
      throw new Error('Invalid "session_id".');
    }
    const sid = session_id.trim();
    const initialLedger = this._readLedger();
    if (!allow_untracked && !this._hasTrackedEntry(initialLedger.sessions, sid)) {
      throw new Error(
        `Session "${sid}" is not in codex-bridge's tracked ledger. Pass allow_untracked=true to archive personal sessions.`
      );
    }

    const binInfo = resolveCodexBinary(env);
    await runCodexSubcommand(binInfo, ['archive', sid]);

    let latest;
    try {
      latest = this._readLedger({ throwOnError: true });
      if (this._hasTrackedEntry(latest.sessions, sid)) {
        latest.sessions[sid].status = 'archived';
        latest.sessions[sid].last_used_at = new Date().toISOString();
        this._writeLedger(latest);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Session "${sid}" was archived in Codex CLI, but failed to update codex-bridge ledger: ${msg}`
      );
    }
    return { status: 'archived', session_id: sid };
  }

  /** Permanently deletes a Codex session by UUID via `codex delete --force`. */
  async deleteSession({ session_id, allow_untracked = false, env = process.env }) {
    if (typeof allow_untracked !== 'boolean') {
      throw new Error('"allow_untracked" must be a boolean.');
    }
    if (typeof session_id !== 'string' || !UUID_RE.test(session_id.trim())) {
      throw new Error('"codex delete --force" requires a valid UUID session_id.');
    }
    const sid = session_id.trim();
    const initialLedger = this._readLedger();
    if (!allow_untracked && !this._hasTrackedEntry(initialLedger.sessions, sid)) {
      throw new Error(
        `Session "${sid}" is not in codex-bridge's tracked ledger. Pass allow_untracked=true to delete personal sessions.`
      );
    }

    const binInfo = resolveCodexBinary(env);
    await runCodexSubcommand(binInfo, ['delete', '--force', sid]);

    let latest;
    try {
      latest = this._readLedger({ throwOnError: true });
      if (this._hasTrackedEntry(latest.sessions, sid)) {
        delete latest.sessions[sid];
        this._writeLedger(latest);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Session "${sid}" was deleted in Codex CLI, but failed to update codex-bridge ledger: ${msg}`
      );
    }
    return { status: 'deleted', session_id: sid };
  }
}
