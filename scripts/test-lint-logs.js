#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function runLint(cwd) {
  const scriptPath = path.resolve(__dirname, 'lint-logs.js');
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      LOG_LINT_PATTERNS: 'src/**/*.ts'
    }
  });
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-logs-test-'));

try {
  const passDir = path.join(tmpRoot, 'pass');
  fs.mkdirSync(path.join(passDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(passDir, 'src', 'ok.ts'),
    `logger.warn({
      timestamp: '2026-03-08T12:30:45.123Z',
      service: 'svc',
      env: 'prod',
      level: 'WARN',
      trace_id: 't',
      span_id: 's',
      request_id: 'r',
      user_hash: 'u',
      event_name: 'auth.session.failed',
      outcome: 'failure',
      error_code: 'UNAUTHORIZED'
    });\n`
  );

  const passResult = runLint(passDir);
  assert.strictEqual(passResult.status, 0, passResult.stdout + passResult.stderr);

  const failDir = path.join(tmpRoot, 'fail');
  fs.mkdirSync(path.join(failDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(failDir, 'src', 'bad.ts'),
    `logger.error({ event_name: 'auth.session.failed' });\nconsole.error('token leaked');\n`
  );

  const failResult = runLint(failDir);
  assert.notStrictEqual(failResult.status, 0, failResult.stdout + failResult.stderr);
  assert.match(failResult.stderr, /missing required field|Forbidden PII\/secret pattern|unstructured/i);

  console.log('lint-logs tests passed');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
