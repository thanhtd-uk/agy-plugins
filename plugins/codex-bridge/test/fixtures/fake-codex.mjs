import fs from 'node:fs';

const argv = process.argv.slice(2);

function getFlagValue(flag) {
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  return null;
}

function logInvocation(stdinText = '') {
  const logFile = process.env.FAKE_CODEX_LOG_FILE;
  if (!logFile) return;
  const entry = {
    argv,
    cwd: process.cwd(),
    stdinBytes: Buffer.byteLength(stdinText, 'utf8'),
    stdinHead: stdinText.slice(0, 200),
  };
  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf8');
}

function readAllStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  if (argv[0] === 'archive') {
    logInvocation('');
    console.log(`Archived ${argv[1] || ''}`);
    return;
  }

  if (argv[0] === 'delete') {
    logInvocation('');
    if (!argv.includes('--force')) {
      console.error('delete requires --force');
      process.exit(2);
    }
    console.log(`Deleted ${argv[argv.length - 1] || ''}`);
    return;
  }

  if (argv[0] === '--version') {
    console.log('codex-cli 0.164.0-fake');
    return;
  }

  const readsStdin = argv.includes('-');
  const stdinText = readsStdin ? await readAllStdin() : '';
  logInvocation(stdinText);

  const outputPath = getFlagValue('-o') || getFlagValue('--output-last-message');
  const title = getFlagValue('--title') || '';
  const match = /\[SCENARIO:([a-z_]+)(?::(\d+))?\]/i.exec(`${stdinText}\n${title}`);
  const scenario = (match?.[1] || process.env.FAKE_CODEX_SCENARIO || 'fast_exec').toLowerCase();
  const delayMs = Number(match?.[2] || process.env.FAKE_CODEX_DELAY_MS || 450);

  const fixedUuid = '11111111-2222-4333-8444-555555555555';
  const resumeArg = argv.includes('resume') ? argv[argv.length - 2] : null;
  const sessionId = resumeArg && !resumeArg.startsWith('-') ? resumeArg : fixedUuid;

  console.log(JSON.stringify({ type: 'thread.started', thread_id: sessionId }));

  if (scenario === 'hang_exec') {
    setInterval(() => {
      console.log(JSON.stringify({ type: 'turn.heartbeat' }));
    }, 100);
    return;
  }

  if (scenario === 'slow_exec') {
    await new Promise((r) => setTimeout(r, delayMs));
  }

  if (scenario === 'error_exec') {
    console.error('Simulated Codex CLI failure: invalid config or model');
    process.exit(3);
  }

  if (scenario === 'policy_blocked') {
    process.stderr.write('ERROR codex_core::tools::router: CreateProcess rejected: blocked ');
    process.stderr.write('by policy\n');
    process.stderr.write('trailing noise '.repeat(400) + '\n');
  }

  let message = `OK from fake-codex (${scenario}) stdinBytes=${Buffer.byteLength(stdinText, 'utf8')}`;
  if (scenario === 'huge_output') {
    message = 'HEADER\n' + 'X'.repeat(22000) + '\nTAIL_MARKER';
  } else if (argv.includes('review')) {
    message = `Review complete. argv=${argv.join(' ')}`;
  }

  if (outputPath) {
    fs.writeFileSync(outputPath, message, 'utf8');
  }

  console.log(
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: message },
    })
  );
  console.log(
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 120, output_tokens: 45 },
    })
  );
}

void main();
