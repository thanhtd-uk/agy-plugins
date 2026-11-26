import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_WAIT_SEC = 145;
export const MAX_WAIT_SEC = 150;
export const DEFAULT_JOB_WAIT_SEC = 140;
export const DEFAULT_MAX_RUNTIME_SEC = 900;
export const HARD_MAX_RUNTIME_SEC = 1800;
export const DEFAULT_MAX_OUTPUT_CHARS = 8500;
export const MIN_MAX_OUTPUT_CHARS = 500;
export const MAX_MAX_OUTPUT_CHARS = 8500;
export const STDERR_TAIL_MAX_CHARS = 4096;
export const DEFAULT_MAX_CONCURRENT_JOBS = 3;

/** Returns true when fast test-scale timeouts are enabled via env. */
export function isTestMode(env = process.env) {
  return env.CODEX_BRIDGE_TEST_MODE === '1' || env.CODEX_BRIDGE_ALLOW_SHORT_TIMEOUTS === '1';
}

/** Returns maximum allowed concurrent Codex background/active jobs. */
export function getMaxConcurrentJobs(env = process.env) {
  const raw = Number(env.CODEX_BRIDGE_MAX_JOBS);
  if (Number.isFinite(raw) && raw >= 1) {
    return Math.min(Math.floor(raw), 10);
  }
  return DEFAULT_MAX_CONCURRENT_JOBS;
}

/** Returns default model override from env or null to inherit ~/.codex/config.toml. */
export function getDefaultModel(env = process.env) {
  const val = env.CODEX_BRIDGE_MODEL?.trim();
  return val ? val : null;
}

/** Returns the file path for the bridge-owned session ledger. */
export function getSessionLedgerPath(env = process.env) {
  const override = env.CODEX_BRIDGE_SESSION_STORE?.trim();
  if (override) {
    return path.resolve(override);
  }
  const baseDir =
    env.LOCALAPPDATA ||
    (process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local')
      : path.join(os.homedir(), '.local', 'share'));
  return path.join(baseDir, 'codex-bridge', 'sessions.json');
}

function isExecutableFile(filePath, existsSyncFn, statSyncFn) {
  try {
    return existsSyncFn(filePath) && statSyncFn(filePath).isFile();
  } catch {
    return false;
  }
}

function parseArgsPrefix(raw) {
  if (!raw || !raw.trim()) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid CODEX_BRIDGE_BIN_ARGS_PREFIX JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('CODEX_BRIDGE_BIN_ARGS_PREFIX must be a JSON array of strings');
  }
  return parsed;
}

/**
 * Resolves the local Codex CLI binary path in priority order:
 * 1. CODEX_BRIDGE_BIN (+ optional CODEX_BRIDGE_BIN_ARGS_PREFIX)
 * 2. %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe (Windows)
 * 3. codex.exe / codex on PATH
 */
export function resolveCodexBinary(env = process.env, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const existsSyncFn = deps.existsSync ?? fs.existsSync;
  const statSyncFn = deps.statSync ?? fs.statSync;
  const homedirFn = deps.homedir ?? os.homedir;
  const pathMod = platform === 'win32' ? path.win32 : path.posix;

  const envBin = env.CODEX_BRIDGE_BIN?.trim();
  if (envBin) {
    const resolved = pathMod.resolve(envBin);
    if (!isExecutableFile(resolved, existsSyncFn, statSyncFn)) {
      throw new Error(`CODEX_BRIDGE_BIN points to a missing file: ${resolved}`);
    }
    return {
      binPath: resolved,
      prefixArgs: parseArgsPrefix(env.CODEX_BRIDGE_BIN_ARGS_PREFIX),
      source: 'env',
    };
  }

  if (platform === 'win32') {
    const home = homedirFn();
    const localAppData = isFullyQualifiedPath(env.LOCALAPPDATA, 'win32')
      ? env.LOCALAPPDATA
      : isFullyQualifiedPath(home, 'win32')
        ? pathMod.join(home, 'AppData', 'Local')
        : null;
    if (localAppData) {
      const defaultWinBin = pathMod.resolve(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
      if (isFullyQualifiedPath(defaultWinBin, 'win32') && isExecutableFile(defaultWinBin, existsSyncFn, statSyncFn)) {
        return { binPath: defaultWinBin, prefixArgs: [], source: 'localappdata' };
      }
    }
  }

  const pathEnv = env.PATH || env.Path || '';
  const exeName = platform === 'win32' ? 'codex.exe' : 'codex';
  for (const rawDir of pathEnv.split(pathMod.delimiter)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !isFullyQualifiedPath(dir, platform)) continue;
    const candidate = pathMod.resolve(dir, exeName);
    if (isFullyQualifiedPath(candidate, platform) && isExecutableFile(candidate, existsSyncFn, statSyncFn)) {
      return { binPath: candidate, prefixArgs: [], source: 'path' };
    }
  }

  throw new Error(
    'Codex CLI executable not found. Install Codex CLI or set CODEX_BRIDGE_BIN to the codex.exe path.'
  );
}

function isFullyQualifiedPath(filePath, platform = process.platform) {
  if (typeof filePath !== 'string' || !filePath) {
    return false;
  }
  if (platform === 'win32') {
    return /^(?:[A-Za-z]:[\\/]|(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+)/.test(filePath);
  }
  return path.isAbsolute(filePath);
}

/**
 * Resolves the Git CLI executable from an explicit override, fully qualified PATH entries,
 * or standard trusted installation paths (never relative or root-relative CWD entries).
 */
export function resolveGitBinary(env = process.env, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const existsSyncFn = deps.existsSync ?? fs.existsSync;
  const statSyncFn = deps.statSync ?? fs.statSync;
  const homedirFn = deps.homedir ?? os.homedir;
  const pathMod = platform === 'win32' ? path.win32 : path.posix;

  const envBin = env.CODEX_BRIDGE_GIT_BIN?.trim();
  if (envBin) {
    if (!isFullyQualifiedPath(envBin, platform)) {
      throw new Error(`CODEX_BRIDGE_GIT_BIN must be a fully qualified path, got: ${envBin}`);
    }
    const resolved = pathMod.resolve(envBin);
    if (!isExecutableFile(resolved, existsSyncFn, statSyncFn)) {
      throw new Error(`CODEX_BRIDGE_GIT_BIN points to a missing file: ${resolved}`);
    }
    return resolved;
  }

  const pathEnv = env.PATH || env.Path || '';
  const exeName = platform === 'win32' ? 'git.exe' : 'git';
  for (const rawDir of pathEnv.split(pathMod.delimiter)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !isFullyQualifiedPath(dir, platform)) continue;
    const candidate = pathMod.resolve(dir, exeName);
    if (isFullyQualifiedPath(candidate, platform) && isExecutableFile(candidate, existsSyncFn, statSyncFn)) {
      return candidate;
    }
  }

  let fallbacks;
  if (platform === 'win32') {
    const pf = isFullyQualifiedPath(env.ProgramFiles, 'win32')
      ? env.ProgramFiles
      : 'C:\\Program Files';
    const pfx86 = isFullyQualifiedPath(env['ProgramFiles(x86)'], 'win32')
      ? env['ProgramFiles(x86)']
      : 'C:\\Program Files (x86)';
    const home = homedirFn();
    const localAppData = isFullyQualifiedPath(env.LOCALAPPDATA, 'win32')
      ? env.LOCALAPPDATA
      : isFullyQualifiedPath(home, 'win32')
        ? pathMod.join(home, 'AppData', 'Local')
        : null;

    fallbacks = [
      pathMod.resolve(pf, 'Git', 'cmd', 'git.exe'),
      pathMod.resolve(pfx86, 'Git', 'cmd', 'git.exe'),
      ...(localAppData ? [pathMod.resolve(localAppData, 'Programs', 'Git', 'cmd', 'git.exe')] : []),
    ];
  } else {
    fallbacks = ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'];
  }

  for (const candidate of fallbacks) {
    if (isFullyQualifiedPath(candidate, platform) && isExecutableFile(candidate, existsSyncFn, statSyncFn)) {
      return candidate;
    }
  }

  return null;
}

function getEnvCaseInsensitive(env, name) {
  if (!env || typeof env !== 'object') {
    return null;
  }
  if (env[name] !== undefined && env[name] !== null) {
    return env[name];
  }
  const target = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === target && env[key] !== undefined && env[key] !== null) {
      return env[key];
    }
  }
  return null;
}

function resolveWindowsSystem32Binary(relativeParts, env = process.env, deps = {}) {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') {
    return null;
  }
  const existsSyncFn = deps.existsSync ?? fs.existsSync;
  const statSyncFn = deps.statSync ?? fs.statSync;
  const roots = [];
  const seen = new Set();
  for (const rawRoot of [
    getEnvCaseInsensitive(env, 'SystemRoot'),
    getEnvCaseInsensitive(env, 'WINDIR'),
  ]) {
    if (!isFullyQualifiedPath(rawRoot, 'win32')) {
      continue;
    }
    const normalized = path.win32.resolve(rawRoot);
    const dedupKey = normalized.toLowerCase();
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey);
      roots.push(normalized);
    }
  }
  for (const root of roots) {
    const candidate = path.win32.resolve(root, 'System32', ...relativeParts);
    if (isExecutableFile(candidate, existsSyncFn, statSyncFn)) {
      return candidate;
    }
  }
  return null;
}

/** Resolves the absolute path to Windows System32 taskkill.exe (or null if missing/POSIX). */
export function resolveTaskkillBinary(env = process.env, deps = {}) {
  return resolveWindowsSystem32Binary(['taskkill.exe'], env, deps);
}

/** Resolves the absolute path to Windows System32 powershell.exe (or null if missing/POSIX). */
export function resolvePowershellBinary(env = process.env, deps = {}) {
  return resolveWindowsSystem32Binary(
    ['WindowsPowerShell', 'v1.0', 'powershell.exe'],
    env,
    deps
  );
}
