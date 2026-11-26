import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ALLOWED_PROFILES,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_RUNTIME_SEC,
  DEFAULT_WAIT_SEC,
  HARD_MAX_RUNTIME_SEC,
  MAX_MAX_OUTPUT_CHARS,
  MAX_WAIT_SEC,
  MIN_MAX_OUTPUT_CHARS,
  getProfileConfig,
  isTestMode,
  resolveGitBinary,
} from './config.mjs';

export { ALLOWED_PROFILES };
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SESSION_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
export const EFFORT_RE = /^[a-z0-9_-]{1,24}$/i;
export const MODEL_RE = /^[a-zA-Z0-9._:/-]{1,100}$/;
export const ALLOWED_MODES = new Set(['read-only', 'worktree', 'workspace-write']);

/** Validates that cwd is an existing absolute directory path. */
export function validateCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw new Error('Missing required "cwd": pass an explicit absolute directory path.');
  }
  const trimmed = cwd.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`"cwd" must be an absolute path, got: ${trimmed}`);
  }
  const resolved = path.resolve(trimmed);
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new Error(`"cwd" does not exist on disk: ${resolved}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`"cwd" is not a directory: ${resolved}`);
  }
  let canonical;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch (err) {
    throw new Error(
      `Failed to resolve canonical path for "cwd" (${resolved}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const lockKey = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  return { cwd: canonical, lockKey };
}

function runGitReadOnly(cwd, args, env = process.env) {
  const gitBin = resolveGitBinary(env);
  if (!gitBin) {
    throw new Error('Git executable not found.');
  }
  return execFileSync(gitBin, args, {
    cwd,
    timeout: 3000,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Inspects whether cwd belongs to a Git working tree and has an existing HEAD commit. */
export function inspectGitRepo(cwd, env = process.env) {
  try {
    const inside = runGitReadOnly(cwd, ['rev-parse', '--is-inside-work-tree'], env);
    if (inside !== 'true') {
      return { isGitRepo: false, hasHeadCommit: false, repoRoot: null };
    }
    let repoRoot = null;
    try {
      repoRoot = runGitReadOnly(cwd, ['rev-parse', '--show-toplevel'], env);
    } catch {
      repoRoot = null;
    }
    let hasHeadCommit = false;
    try {
      runGitReadOnly(cwd, ['rev-parse', '--verify', 'HEAD'], env);
      hasHeadCommit = true;
    } catch {
      hasHeadCommit = false;
    }
    return { isGitRepo: true, hasHeadCommit, repoRoot };
  } catch {
    return { isGitRepo: false, hasHeadCommit: false, repoRoot: null };
  }
}

function clampNumber(value, { name, defaultVal, min, max, integer = false }) {
  if (value === undefined || value === null) {
    return defaultVal;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`"${name}" must be a finite number.`);
  }
  const bounded = Math.min(Math.max(num, min), max);
  return integer ? Math.round(bounded) : bounded;
}

function validateOptionalString(value, name, maxLen = 32000) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`"${name}" must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > maxLen) {
    throw new Error(`"${name}" exceeds maximum length of ${maxLen} characters.`);
  }
  return trimmed;
}

function assertModelSlug(value, label) {
  if (typeof value !== 'string' || !MODEL_RE.test(value)) {
    throw new Error(`Invalid ${label} slug.`);
  }
  return value;
}

function assertEffortSlug(value, label) {
  if (typeof value !== 'string' || !EFFORT_RE.test(value)) {
    throw new Error(`Invalid ${label} slug.`);
  }
  return value;
}

function validateModelAndEffort(raw, env, { isResume = false, resumedSession = null } = {}) {
  let explicitProfile = null;
  if (raw.profile !== undefined && raw.profile !== null && String(raw.profile).trim() !== '') {
    if (typeof raw.profile !== 'string') {
      throw new Error('Invalid "profile": must be a string ("fast" or "deep").');
    }
    const normalized = raw.profile.trim().toLowerCase();
    if (!ALLOWED_PROFILES.has(normalized)) {
      throw new Error(`Invalid "profile": "${raw.profile}". Allowed values are "fast" or "deep".`);
    }
    explicitProfile = normalized;
  }

  let explicitModel = null;
  if (raw.model !== undefined && raw.model !== null && String(raw.model).trim() !== '') {
    if (typeof raw.model !== 'string' || !MODEL_RE.test(raw.model.trim())) {
      throw new Error('Invalid "model" slug.');
    }
    explicitModel = raw.model.trim();
  }

  let explicitEffort = null;
  if (
    raw.reasoning_effort !== undefined &&
    raw.reasoning_effort !== null &&
    String(raw.reasoning_effort).trim() !== ''
  ) {
    if (typeof raw.reasoning_effort !== 'string' || !EFFORT_RE.test(raw.reasoning_effort.trim())) {
      throw new Error('Invalid "reasoning_effort" slug.');
    }
    explicitEffort = raw.reasoning_effort.trim();
  }

  const cfg = getProfileConfig(env);

  if (explicitModel) {
    const resolvedEffort =
      explicitEffort ??
      (explicitProfile
        ? assertEffortSlug(cfg[explicitProfile].reasoning_effort, `"${explicitProfile}" effort`)
        : null);
    return {
      profile: 'custom',
      model: explicitModel,
      reasoning_effort: resolvedEffort,
    };
  }

  if (explicitProfile) {
    const target = cfg[explicitProfile];
    return {
      profile: explicitProfile,
      model: assertModelSlug(target.model, `"${explicitProfile}" model`),
      reasoning_effort:
        explicitEffort ?? assertEffortSlug(target.reasoning_effort, `"${explicitProfile}" effort`),
    };
  }

  if (isResume) {
    const savedEffort =
      resumedSession?.reasoning_effort && EFFORT_RE.test(resumedSession.reasoning_effort)
        ? resumedSession.reasoning_effort
        : null;
    if (resumedSession?.model && MODEL_RE.test(resumedSession.model)) {
      const savedProfile = ALLOWED_PROFILES.has(resumedSession.profile)
        ? resumedSession.profile
        : 'custom';
      return {
        profile: savedProfile,
        model: resumedSession.model,
        reasoning_effort: explicitEffort ?? savedEffort,
      };
    }
    return {
      profile: 'inherited',
      model: null,
      reasoning_effort: explicitEffort ?? savedEffort,
    };
  }

  if (cfg.legacyModel) {
    return {
      profile: 'custom',
      model: assertModelSlug(cfg.legacyModel, 'CODEX_BRIDGE_MODEL'),
      reasoning_effort: explicitEffort ?? null,
    };
  }

  const defaultTarget = cfg[cfg.defaultProfile];
  return {
    profile: cfg.defaultProfile,
    model: assertModelSlug(defaultTarget.model, `"${cfg.defaultProfile}" model`),
    reasoning_effort:
      explicitEffort ??
      assertEffortSlug(defaultTarget.reasoning_effort, `"${cfg.defaultProfile}" effort`),
  };
}

function validateTimingAndBudget(raw, env) {
  const testMode = isTestMode(env);
  const wait_sec = clampNumber(raw.wait_sec, {
    name: 'wait_sec',
    defaultVal: DEFAULT_WAIT_SEC,
    min: testMode ? 0.05 : 1,
    max: MAX_WAIT_SEC,
  });
  const max_runtime_sec = clampNumber(raw.max_runtime_sec, {
    name: 'max_runtime_sec',
    defaultVal: DEFAULT_MAX_RUNTIME_SEC,
    min: testMode ? 0.2 : 30,
    max: HARD_MAX_RUNTIME_SEC,
  });
  const max_output_chars = clampNumber(raw.max_output_chars, {
    name: 'max_output_chars',
    defaultVal: DEFAULT_MAX_OUTPUT_CHARS,
    min: MIN_MAX_OUTPUT_CHARS,
    max: MAX_MAX_OUTPUT_CHARS,
    integer: true,
  });
  return { wait_sec, max_runtime_sec, max_output_chars };
}

/** Validates and normalizes arguments for `codex_exec`. */
export function validateExecInput(raw, env = process.env, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Tool arguments must be a JSON object.');
  }

  const { cwd, lockKey } = validateCwd(raw.cwd);
  const git = inspectGitRepo(cwd, env);

  if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) {
    throw new Error('Missing required non-empty "prompt".');
  }
  const prompt = raw.prompt.trim();

  const mode = raw.mode === undefined || raw.mode === null ? 'read-only' : String(raw.mode).trim();
  if (!ALLOWED_MODES.has(mode)) {
    throw new Error(
      `Invalid "mode": "${mode}". Allowed values are read-only, worktree, workspace-write (danger-full-access is disabled).`
    );
  }

  if (mode === 'worktree') {
    if (!git.isGitRepo) {
      throw new Error(
        `mode="worktree" requires "${cwd}" to be inside a Git repository. Use mode="read-only" or mode="workspace-write" instead.`
      );
    }
    if (!git.hasHeadCommit) {
      throw new Error(
        `mode="worktree" requires at least one Git commit (HEAD does not exist yet in "${cwd}"). Create an initial commit or use mode="workspace-write".`
      );
    }
  }

  let focus_files = [];
  if (raw.focus_files !== undefined && raw.focus_files !== null) {
    if (!Array.isArray(raw.focus_files)) {
      throw new Error('"focus_files" must be an array of file path strings.');
    }
    if (raw.focus_files.length > 50) {
      throw new Error('"focus_files" supports at most 50 entries.');
    }
    focus_files = raw.focus_files.map((item, idx) => {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error(`"focus_files[${idx}]" must be a non-empty string.`);
      }
      return item.trim();
    });
  }

  const context = validateOptionalString(raw.context, 'context');
  const constraints = validateOptionalString(raw.constraints, 'constraints');
  const deliverable = validateOptionalString(raw.deliverable, 'deliverable');

  let session_id = null;
  if (raw.session_id !== undefined && raw.session_id !== null && String(raw.session_id).trim() !== '') {
    const sid = String(raw.session_id).trim();
    if (sid.startsWith('-') || !SESSION_ID_RE.test(sid)) {
      throw new Error('Invalid "session_id": must be an alphanumeric/UUID/slug identifier.');
    }
    session_id = sid;
  }

  if (raw.persist_session !== undefined && typeof raw.persist_session !== 'boolean') {
    throw new Error('"persist_session" must be a boolean.');
  }
  const isResume = Boolean(session_id);
  const persist_session = isResume ? true : Boolean(raw.persist_session ?? false);

  const { profile, model, reasoning_effort } = validateModelAndEffort(raw, env, {
    isResume,
    resumedSession: options.resumedSession ?? null,
  });
  const { wait_sec, max_runtime_sec, max_output_chars } = validateTimingAndBudget(raw, env);

  return {
    kind: 'exec',
    cwd,
    lockKey,
    git,
    skipGitRepoCheck: !git.isGitRepo,
    prompt,
    mode,
    focus_files,
    context,
    constraints,
    deliverable,
    session_id,
    isResume,
    persist_session,
    profile,
    model,
    reasoning_effort,
    wait_sec,
    max_runtime_sec,
    max_output_chars,
  };
}

/** Validates and normalizes arguments for `codex_review`. */
export function validateReviewInput(raw, env = process.env) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Tool arguments must be a JSON object.');
  }

  const { cwd, lockKey } = validateCwd(raw.cwd);
  const git = inspectGitRepo(cwd, env);
  if (!git.isGitRepo) {
    throw new Error(`"codex_review" requires a Git repository, but "${cwd}" is not inside one.`);
  }

  if (raw.uncommitted !== undefined && typeof raw.uncommitted !== 'boolean') {
    throw new Error('"uncommitted" must be a boolean.');
  }

  let uncommitted = raw.uncommitted === true;
  const base = validateOptionalString(raw.base, 'base', 256);
  const commit = validateOptionalString(raw.commit, 'commit', 256);
  const title = validateOptionalString(raw.title, 'title', 256);
  const prompt = validateOptionalString(raw.prompt, 'prompt', 32000);

  if (base?.startsWith('-')) {
    throw new Error('"base" branch name cannot start with "-".');
  }
  if (commit?.startsWith('-')) {
    throw new Error('"commit" SHA cannot start with "-".');
  }

  const targetCount = [uncommitted, Boolean(base), Boolean(commit)].filter(Boolean).length;
  if (targetCount > 1) {
    throw new Error('Specify at most one review target: "uncommitted", "base", or "commit".');
  }
  if (targetCount === 0 && !prompt) {
    uncommitted = true;
  }

  const { profile, model, reasoning_effort } = validateModelAndEffort(raw, env);
  const { wait_sec, max_runtime_sec, max_output_chars } = validateTimingAndBudget(raw, env);

  return {
    kind: 'review',
    cwd,
    lockKey,
    git,
    mode: 'read-only',
    uncommitted,
    base,
    commit,
    title,
    prompt,
    profile,
    model,
    reasoning_effort,
    wait_sec,
    max_runtime_sec,
    max_output_chars,
  };
}
