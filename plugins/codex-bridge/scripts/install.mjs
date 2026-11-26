import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSessionLedgerPath, resolveCodexBinary } from '../src/config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const DEFAULT_TARGET = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'codex-bridge');

const RUNTIME_ITEMS = ['plugin.json', 'mcp_config.json', 'package.json', 'README.md', 'rules', 'src'];

function parseArgs(argv) {
  const cmd = argv[0] || 'doctor';
  let target = DEFAULT_TARGET;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--target' && argv[i + 1]) {
      target = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return { cmd, target };
}

function runAgyValidate(dirPath) {
  try {
    const out = execFileSync('agy', ['plugin', 'validate', '--strict', dirPath, '--json'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out);
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    return { ok: findings.length === 0, findings, skipped: false };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: true, findings: [], skipped: true, reason: 'agy CLI not found on PATH' };
    }
    const raw = (err.stdout || err.stderr || err.message || '').trim();
    return { ok: false, findings: [raw], skipped: false };
  }
}

function removeLinkIfPresent(targetPath) {
  let st;
  try {
    st = fs.lstatSync(targetPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
  if (st.isSymbolicLink()) {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  }
  return false;
}

function syncDir(srcDir, dstDir) {
  removeLinkIfPresent(dstDir);
  if (fs.existsSync(dstDir) && !fs.lstatSync(dstDir).isDirectory()) {
    fs.rmSync(dstDir, { recursive: true, force: true });
  }
  fs.mkdirSync(dstDir, { recursive: true });
  const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true });
  const srcNames = new Set(srcEntries.map((entry) => entry.name));

  for (const existing of fs.readdirSync(dstDir, { withFileTypes: true })) {
    const existingPath = path.join(dstDir, existing.name);
    if (!srcNames.has(existing.name) || existing.isSymbolicLink()) {
      fs.rmSync(existingPath, { recursive: true, force: true });
    }
  }

  for (const entry of srcEntries) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      syncDir(srcPath, dstPath);
    } else {
      removeLinkIfPresent(dstPath);
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function canonicalizePathForCompare(targetPath) {
  let current = path.resolve(targetPath);
  const trailing = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    trailing.unshift(path.basename(current));
    current = parent;
  }
  let canonicalBase = current;
  try {
    canonicalBase = fs.realpathSync.native(current);
  } catch {
    canonicalBase = path.resolve(current);
  }
  const full = trailing.length > 0 ? path.join(canonicalBase, ...trailing) : canonicalBase;
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function isSameOrSubpath(parent, child) {
  const rel = path.relative(parent, child);
  return (
    rel === '' ||
    (rel !== '..' &&
      !rel.startsWith(`..${path.sep}`) &&
      !rel.startsWith('../') &&
      !path.isAbsolute(rel))
  );
}

function pathsOverlap(pathA, pathB) {
  const normA = canonicalizePathForCompare(pathA);
  const normB = canonicalizePathForCompare(pathB);
  return isSameOrSubpath(normA, normB) || isSameOrSubpath(normB, normA);
}

function assertNotSourceCheckout(targetDir, action) {
  let entries;
  try {
    entries = fs.readdirSync(targetDir);
  } catch {
    return;
  }
  const sourceMarkers = entries.filter((name) =>
    ['scripts', 'test', '.git', '.github'].includes(name)
  );
  if (sourceMarkers.length > 0) {
    throw new Error(
      `Refusing to ${action} "${targetDir}": directory appears to be a source checkout (contains ${sourceMarkers.join(', ')}) rather than an installed plugin.`
    );
  }
}

/** Validates that dstRoot is safe to install into without pruning unrelated files or source files. */
export function validateInstallTarget(srcRoot, dstRoot) {
  if (pathsOverlap(srcRoot, dstRoot)) {
    throw new Error(
      `Refusing to install: target "${dstRoot}" overlaps source plugin directory "${srcRoot}".`
    );
  }
  if (!fs.existsSync(dstRoot)) {
    return;
  }
  if (!fs.statSync(dstRoot).isDirectory()) {
    throw new Error(`Refusing to install: target "${dstRoot}" exists and is not a directory.`);
  }
  const entries = fs.readdirSync(dstRoot);
  if (entries.length === 0) {
    return;
  }
  const manifestPath = path.join(dstRoot, 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Refusing to install into non-empty directory "${dstRoot}": missing plugin.json for an existing codex-bridge installation.`
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Refusing to install into "${dstRoot}": failed to parse plugin.json (${err instanceof Error ? err.message : String(err)}).`
    );
  }
  if (manifest?.name !== 'codex-bridge') {
    throw new Error(
      `Refusing to install into "${dstRoot}": plugin.json name is "${manifest?.name}", not "codex-bridge".`
    );
  }
  assertNotSourceCheckout(dstRoot, 'install into');
}

export function copyRuntimeFiles(srcRoot, dstRoot) {
  validateInstallTarget(srcRoot, dstRoot);
  fs.mkdirSync(dstRoot, { recursive: true });
  const allowed = new Set(RUNTIME_ITEMS);
  for (const existing of fs.readdirSync(dstRoot, { withFileTypes: true })) {
    if (!allowed.has(existing.name)) {
      fs.rmSync(path.join(dstRoot, existing.name), { recursive: true, force: true });
    }
  }

  for (const item of RUNTIME_ITEMS) {
    const src = path.join(srcRoot, item);
    const dst = path.join(dstRoot, item);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing runtime artifact in source plugin: ${src}`);
    }
    if (fs.statSync(src).isDirectory()) {
      syncDir(src, dst);
    } else {
      removeLinkIfPresent(dst);
      fs.copyFileSync(src, dst);
    }
  }
}

function cmdInstall(target) {
  const preCheck = runAgyValidate(PLUGIN_ROOT);
  if (!preCheck.ok) {
    console.error('Source validation failed:', preCheck.findings);
    process.exitCode = 1;
    return;
  }

  copyRuntimeFiles(PLUGIN_ROOT, target);
  const postCheck = runAgyValidate(target);
  if (!postCheck.ok) {
    console.error('Installed plugin validation failed:', postCheck.findings);
    process.exitCode = 1;
    return;
  }

  console.log(`Installed codex-bridge to: ${target}`);
  console.log(
    postCheck.skipped
      ? `Validation skipped (${postCheck.reason}).`
      : 'agy plugin validate --strict: PASS (0 errors, 0 warnings).'
  );
}

function cmdDoctor(target) {
  let healthy = true;
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  console.log(`Node.js: v${process.versions.node} (${nodeMajor >= 20 ? 'OK' : 'FAIL >=20 required'})`);
  if (nodeMajor < 20) healthy = false;

  try {
    const bin = resolveCodexBinary();
    const ver = execFileSync(bin.binPath, [...bin.prefixArgs, '--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    }).trim();
    console.log(`Codex CLI: ${ver} (${bin.binPath}) [source=${bin.source}]`);
  } catch (err) {
    console.error(`Codex CLI: FAIL (${err.message})`);
    healthy = false;
  }

  const codexHome = path.join(os.homedir(), '.codex');
  const hasConfig = fs.existsSync(path.join(codexHome, 'config.toml'));
  const hasAuth = fs.existsSync(path.join(codexHome, 'auth.json'));
  console.log(`Codex config.toml: ${hasConfig ? 'present' : 'missing (using Codex defaults)'}`);
  console.log(`Codex auth.json: ${hasAuth ? 'present' : 'MISSING (run codex login)'}`);
  if (!hasAuth) healthy = false;

  const rulesBytes = fs.statSync(path.join(PLUGIN_ROOT, 'rules', 'AGENTS.md')).size;
  console.log(`Source rules/AGENTS.md: ${rulesBytes} bytes (${rulesBytes < 1536 ? 'OK <1.5KB' : 'TOO LARGE'})`);
  if (rulesBytes >= 1536) healthy = false;

  const srcVal = runAgyValidate(PLUGIN_ROOT);
  console.log(
    `Source strict validate: ${srcVal.skipped ? 'SKIPPED' : srcVal.ok ? 'PASS' : 'FAIL'}`
  );
  if (!srcVal.ok) healthy = false;

  const installed = fs.existsSync(path.join(target, 'plugin.json'));
  console.log(`Installed target (${target}): ${installed ? 'present' : 'not installed'}`);
  if (installed) {
    const dstVal = runAgyValidate(target);
    console.log(
      `Installed strict validate: ${dstVal.skipped ? 'SKIPPED' : dstVal.ok ? 'PASS' : 'FAIL'}`
    );
    if (!dstVal.ok) healthy = false;
  }

  console.log(`Session ledger path: ${getSessionLedgerPath()}`);
  if (!healthy) {
    process.exitCode = 1;
  }
}

export function cmdUninstall(target) {
  if (pathsOverlap(PLUGIN_ROOT, target)) {
    throw new Error(
      `Refusing to uninstall: target "${target}" overlaps source plugin directory "${PLUGIN_ROOT}".`
    );
  }
  const manifestPath = path.join(target, 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    console.log(`Nothing to uninstall at: ${target}`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest?.name !== 'codex-bridge') {
    throw new Error(`Refusing to remove ${target}: plugin.json name is "${manifest?.name}", not "codex-bridge".`);
  }
  assertNotSourceCheckout(target, 'uninstall');
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`Uninstalled codex-bridge from: ${target}`);
}

const isEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  }
})();

if (isEntrypoint) {
  const { cmd, target } = parseArgs(process.argv.slice(2));
  if (cmd === 'install') {
    cmdInstall(target);
  } else if (cmd === 'doctor') {
    cmdDoctor(target);
  } else if (cmd === 'uninstall') {
    cmdUninstall(target);
  } else {
    console.error(`Unknown command "${cmd}". Use: install | doctor | uninstall`);
    process.exitCode = 1;
  }
}
