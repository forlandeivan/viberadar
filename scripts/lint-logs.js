#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const glob = require('glob');

const ROOT = process.cwd();
const PATTERNS = process.env.LOG_LINT_PATTERNS
  ? process.env.LOG_LINT_PATTERNS.split(',').map((v) => v.trim()).filter(Boolean)
  : ['src/**/*.ts'];
const EXCLUDE = ['**/dist/**', '**/node_modules/**'];

const requiredWarnErrorFields = [
  'timestamp',
  'service',
  'env',
  'level',
  'trace_id',
  'span_id',
  'request_id',
  'event_name',
  'outcome',
  'error_code'
];

const forbiddenPatterns = [
  /\bpassword\b/i,
  /\bpasswd\b/i,
  /\bsecret\b/i,
  /\btoken\b/i,
  /\bapi[_-]?key\b/i,
  /\bauthorization\b/i,
  /\bcookie\b/i,
  /\bset-cookie\b/i,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /\b(?!\d{4}-\d{2}-\d{2}\b)\+?[0-9][0-9()\-\s]{8,}\b/
];

const files = [...new Set(
  PATTERNS.flatMap((pattern) =>
    glob.sync(pattern, {
      cwd: ROOT,
      nodir: true,
      ignore: EXCLUDE
    })
  )
)];

const issues = [];

function addIssue(file, message) {
  issues.push(`${file}: ${message}`);
}

function extractTopLevelObjectLiteral(argsRaw) {
  const trimmed = argsRaw.trim();
  if (!trimmed.startsWith('{')) return null;

  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(0, i + 1);
      }
    }
  }

  return null;
}

for (const file of files) {
  const fullPath = path.join(ROOT, file);
  const content = fs.readFileSync(fullPath, 'utf8');

  const unstructuredRegex = /logger\.(debug|info|warn|error)\(\s*(["'`])/gim;
  if (unstructuredRegex.test(content)) {
    addIssue(file, 'Found unstructured log call with plain string payload.');
  }

  const warnErrorCallRegex = /logger\.(warn|error)\s*\(([^)]*)\)/gim;
  let match;
  while ((match = warnErrorCallRegex.exec(content)) !== null) {
    const level = match[1].toUpperCase();
    const rawArgs = match[2];
    const payload = extractTopLevelObjectLiteral(rawArgs);

    if (!payload) {
      addIssue(file, `${level} log must use object payload.`);
      continue;
    }

    for (const field of requiredWarnErrorFields) {
      const fieldRegex = new RegExp(`\\b${field}\\b\\s*:`, 'm');
      if (!fieldRegex.test(payload)) {
        addIssue(file, `${level} payload is missing required field: ${field}`);
      }
    }

    const hasUserId = /\buser_id\b\s*:/.test(payload);
    const hasUserHash = /\buser_hash\b\s*:/.test(payload);
    if (!hasUserId && !hasUserHash) {
      addIssue(file, `${level} payload must include user_id or user_hash.`);
    }
  }

  const loggerCallRegex = /logger\.(debug|info|warn|error)\s*\(([\s\S]*?)\)/gim;
  while ((match = loggerCallRegex.exec(content)) !== null) {
    const payload = match[2];
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(payload)) {
        addIssue(file, `Forbidden PII/secret pattern in log payload: ${pattern}`);
      }
    }
  }
}

if (issues.length > 0) {
  console.error('Logging lint failed:');
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log(`Logging lint passed (${files.length} files checked).`);
