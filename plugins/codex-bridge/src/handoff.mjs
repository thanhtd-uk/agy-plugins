import { DEFAULT_MAX_OUTPUT_CHARS } from './config.mjs';

/**
 * Formats a compact, token-efficient handoff prompt passed to Codex via stdin.
 */
export function composeExecPrompt({
  prompt,
  focus_files = [],
  context = null,
  constraints = null,
  deliverable = null,
  mode = 'read-only',
  max_output_chars = DEFAULT_MAX_OUTPUT_CHARS,
}) {
  const sections = [`# Task\n${prompt}`];

  if (focus_files.length > 0) {
    const fileLines = focus_files.map((entry) => `- ${entry}`).join('\n');
    sections.push(
      `# Focus Files\nRead directly from disk in cwd as needed; avoid quoting full unchanged files.\n${fileLines}`
    );
  }

  if (context) {
    sections.push(`# Context\n${context}`);
  }

  if (constraints) {
    sections.push(`# Constraints\n${constraints}`);
  }

  if (deliverable) {
    sections.push(`# Deliverable\n${deliverable}`);
  }

  const budgetNotes = [
    'Work as a peer engineer: if you spot flawed assumptions, hidden risks, or a simpler/cleaner path, flag them concisely alongside or before your solution.',
    'Respond in concise technical English unless the task requires another language.',
    `Keep your final response concise and under ~${max_output_chars} characters.`,
  ];
  if (mode === 'worktree' || mode === 'workspace-write') {
    budgetNotes.push(
      'List modified files, verification commands/results, and any key trade-offs or edge cases clearly.'
    );
  }
  sections.push(`# Output Budget\n${budgetNotes.join(' ')}`);

  return sections.join('\n\n') + '\n';
}

/**
 * Builds a read-only exec prompt when codex_review receives both a git target
 * flag (--uncommitted/--base/--commit) and custom review instructions, because
 * codex-cli 0.164.0 rejects combining those target flags with [PROMPT].
 */
export function composeCustomTargetReviewPrompt({
  uncommitted,
  base,
  commit,
  title,
  prompt,
  max_output_chars = DEFAULT_MAX_OUTPUT_CHARS,
}) {
  let targetInstruction =
    'Inspect all uncommitted changes: run `git status --short`, `git diff` (unstaged changes), and `git diff --cached` (staged changes), plus inspect any untracked files.';
  if (base) {
    targetInstruction = `Inspect changes against base branch \`${base}\` via \`git diff ${base}...HEAD\`.`;
  } else if (commit) {
    targetInstruction = `Inspect commit \`${commit}\` via \`git show ${commit}\`.`;
  }

  const sections = [
    `# Code Review Task\n${targetInstruction}`,
    `# Review Instructions\n${prompt}`,
  ];

  if (title) {
    sections.push(`# Review Title\n${title}`);
  }

  sections.push(
    `# Output Budget\nReview as an independent senior peer: challenge risky assumptions, report findings by severity with exact file paths/line numbers, and propose concise fixes or cleaner alternatives. Respond in concise technical English unless asked otherwise, under ~${max_output_chars} characters.`
  );

  return sections.join('\n\n') + '\n';
}

/**
 * Truncates text cleanly so final MCP tool output stays within maxChars.
 */
export function truncateOutput(text, maxChars = DEFAULT_MAX_OUTPUT_CHARS) {
  const normalized = (text ?? '').replace(/\r\n/g, '\n').trimEnd();
  if (normalized.length <= maxChars) {
    return { text: normalized, truncated: false, originalChars: normalized.length };
  }

  const markerReserve = 96;
  const usable = Math.max(maxChars - markerReserve, 120);
  const headLen = Math.floor(usable * 0.75);
  const tailLen = Math.max(usable - headLen, 0);
  const omitted = normalized.length - headLen - tailLen;
  const notice = `\n\n...[truncated ${omitted} chars to stay within ${maxChars} char budget]...\n\n`;

  const combined =
    tailLen > 0
      ? normalized.slice(0, headLen) + notice + normalized.slice(normalized.length - tailLen)
      : normalized.slice(0, headLen) + notice.trimEnd();

  return {
    text: combined.slice(0, maxChars),
    truncated: true,
    originalChars: normalized.length,
  };
}
