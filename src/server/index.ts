import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as readline from 'readline';
import chokidar from 'chokidar';
import { ScanResult, ModuleInfo, FeatureResult, scanProject, ObservabilityCatalogItem, MissingCriticalLogItem, FailurePoint } from '../scanner';

interface ServerOptions {
  data: ScanResult;
  port: number;
  projectRoot: string;
}

export interface ServerHandle {
  server: http.Server;
}

const DASHBOARD_HTML = fs.readFileSync(
  path.join(__dirname, '../ui/dashboard.html'),
  'utf-8'
);

// ─── Agent CLI commands ───────────────────────────────────────────────────────

const WIN = process.platform === 'win32';
type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
interface RuntimeEnvSettings {
  codexSandboxMode: CodexSandboxMode;
  approvalPolicy: 'never';
  agentQueueMax: number;
  agentCooldownMinMs: number;
  agentCooldownMaxMs: number;
  autoFixFailedTests: boolean;
  autoFixMaxRetries: number;
  autoStage: boolean;
  envFilePath: string | null;
}

const DEFAULT_RUNTIME_ENV_CONTENT = [
  '# VibeRadar runtime defaults for agent execution.',
  '# You can override any value with OS env vars.',
  '',
  '# Agent queue hard limit (1..100)',
  'VIBERADAR_AGENT_QUEUE_MAX=5',
  '',
  '# Random cooldown between queued tasks, in milliseconds',
  'VIBERADAR_AGENT_COOLDOWN_MIN_MS=20000',
  'VIBERADAR_AGENT_COOLDOWN_MAX_MS=60000',
  '',
  '# Auto-fix tests when generated/updated tests fail',
  'VIBERADAR_AUTO_FIX_FAILED_TESTS=true',
  'VIBERADAR_AUTO_FIX_MAX_RETRIES=1',
  '',
  '# Codex sandbox mode: read-only | workspace-write | danger-full-access',
  'VIBERADAR_CODEX_SANDBOX=workspace-write',
  '',
  '# Auto-stage agent changes after each run (git add, no commit)',
  '# Staged = agent changes (green in VSCode), unstaged = your own changes (red)',
  'VIBERADAR_AUTO_STAGE=true',
  '',
].join('\n');

function parseEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return env;
  const raw = fs.readFileSync(filePath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadRuntimeEnv(projectRoot: string): RuntimeEnvSettings {
  const envPath = path.join(projectRoot, '.viberadar.env');
  if (!fs.existsSync(envPath)) {
    try {
      fs.writeFileSync(envPath, DEFAULT_RUNTIME_ENV_CONTENT, 'utf-8');
    } catch {}
  }
  const fileEnv = parseEnvFile(envPath);

  function readEnv(name: string): string {
    const fromProcess = (process.env[name] || '').trim();
    if (fromProcess) return fromProcess;
    return (fileEnv[name] || '').trim();
  }

  function readEnvInt(name: string, fallback: number, min: number, max: number): number {
    const raw = readEnv(name);
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    const n = Math.round(parsed);
    return Math.min(max, Math.max(min, n));
  }

  function readEnvBool(name: string, fallback: boolean): boolean {
    const raw = readEnv(name).toLowerCase();
    if (!raw) return fallback;
    if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
    return fallback;
  }

  const sandboxRaw = readEnv('VIBERADAR_CODEX_SANDBOX');
  const codexSandboxMode: CodexSandboxMode =
    sandboxRaw === 'read-only' || sandboxRaw === 'workspace-write' || sandboxRaw === 'danger-full-access'
      ? sandboxRaw
      : 'workspace-write';

  const agentCooldownMinMs = readEnvInt('VIBERADAR_AGENT_COOLDOWN_MIN_MS', 20000, 0, 600000);
  const agentCooldownMaxMs = readEnvInt('VIBERADAR_AGENT_COOLDOWN_MAX_MS', 60000, agentCooldownMinMs, 600000);

  return {
    codexSandboxMode,
    approvalPolicy: 'never',
    agentQueueMax: readEnvInt('VIBERADAR_AGENT_QUEUE_MAX', 5, 1, 100),
    agentCooldownMinMs,
    agentCooldownMaxMs,
    autoFixFailedTests: readEnvBool('VIBERADAR_AUTO_FIX_FAILED_TESTS', true),
    autoFixMaxRetries: readEnvInt('VIBERADAR_AUTO_FIX_MAX_RETRIES', 1, 0, 5),
    autoStage: readEnvBool('VIBERADAR_AUTO_STAGE', true),
    envFilePath: fs.existsSync(envPath) ? envPath : null,
  };
}

function randomInt(min: number, max: number): number {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function detectQueueBlockSignal(line: string): 403 | 429 | null {
  const s = line.toLowerCase();
  const is403 = (
    (s.includes('403') && (s.includes('forbidden') || s.includes('unexpected status') || s.includes('status'))) ||
    s.includes('unable to load site') ||
    s.includes('ray id:')
  );
  if (is403) return 403;
  const is429 = (
    s.includes('429') ||
    s.includes('too many requests') ||
    s.includes('rate limit') ||
    s.includes('rate-limit')
  );
  if (is429) return 429;
  return null;
}

/**
 * Returns set of files that have uncommitted changes (modified + untracked).
 * Used to diff before/after agent run so we stage only agent-made changes.
 */
function getGitDirtyFiles(cwd: string): Set<string> {
  const result = new Set<string>();
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    // Modified/deleted tracked files
    const modified = execSync('git diff --name-only HEAD', { cwd, encoding: 'utf-8' }).trim();
    // New untracked files
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd, encoding: 'utf-8' }).trim();
    for (const f of [...modified.split('\n'), ...untracked.split('\n')]) {
      if (f.trim()) result.add(f.trim());
    }
  } catch { /* not a git repo or git not available */ }
  return result;
}

/**
 * Stages files that are in `after` but not in `before` (agent-made changes).
 * Skips .viberadar/ internals. Returns count of staged files.
 */
function stageAgentChanges(cwd: string, before: Set<string>, after: Set<string>): number {
  const toStage = [...after].filter(f =>
    !before.has(f) && !f.startsWith('.viberadar/')
  );
  if (toStage.length === 0) return 0;
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    const escaped = toStage.map(f => `"${f.replace(/"/g, '\\"')}"`).join(' ');
    execSync(`git add -- ${escaped}`, { cwd });
    return toStage.length;
  } catch { return 0; }
}

/**
 * Build shell command that pipes task file into the agent CLI.
 * --output-format stream-json gives real-time events (tool calls, writes, etc.)
 * File piping avoids TUI mode in Claude Code v2+.
 */
/**
 * Codex with danger-full-access rewrites ~/.codex/config.toml and can set
 * model_reasoning_effort = "xhigh" which is not a valid value and causes
 * Codex to exit with code 1 before doing any work. Patch it to "high" every
 * time before launching Codex.
 */
function patchCodexConfig(): void {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  try {
    if (!fs.existsSync(configPath)) return;
    const original = fs.readFileSync(configPath, 'utf8');
    const patched = original.replace(
      /model_reasoning_effort\s*=\s*"xhigh"/g,
      'model_reasoning_effort = "high"'
    );
    if (patched !== original) {
      fs.writeFileSync(configPath, patched, 'utf8');
      process.stdout.write('   🔧 Patched ~/.codex/config.toml: xhigh → high\n');
    }
  } catch {
    // non-fatal: if we can't patch, Codex will error on its own
  }
}

function buildAgentShellCmd(agent: string, taskFile: string, codexSandboxMode: CodexSandboxMode, model?: string): string {
  const escaped = taskFile.replace(/\\/g, '\\\\');
  const modelFlag = (agent === 'claude' && model) ? ` --model ${model}` : '';
  if (WIN) {
    if (agent === 'claude') return `type "${escaped}" | claude.cmd --print --verbose --output-format stream-json${modelFlag}`;
    if (agent === 'codex') {
      return `codex.cmd -a never exec --color never --sandbox ${codexSandboxMode} < "${escaped}"`;
    }
  } else {
    if (agent === 'claude') return `claude --print --verbose --output-format stream-json${modelFlag} < "${escaped}"`;
    if (agent === 'codex') {
      return `codex -a never exec --color never --sandbox ${codexSandboxMode} < "${escaped}"`;
    }
  }
  return `claude --print --verbose --output-format stream-json${modelFlag} < "${escaped}"`;
}

function buildAgentSpawnEnv(agent: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (agent === 'codex') {
    // Prevent nested Codex launches from inheriting Desktop thread context
    // that can inject incompatible settings (e.g. model_reasoning_effort).
    delete env.CODEX_THREAD_ID;
    delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    delete env.CODEX_SHELL;
  }
  return env;
}

/** Parse a Claude Code stream-json event into a human-readable line, or null to skip */
function parseClaudeEvent(raw: string): string | null {
  let event: any;
  try { event = JSON.parse(raw); } catch { return raw.trim() || null; }

  switch (event.type) {
    case 'assistant': {
      const blocks: any[] = event.message?.content ?? [];
      const parts: string[] = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text?.trim()) {
          // Show first non-empty line of assistant reasoning
          const line = b.text.trim().split('\n').find((l: string) => l.trim());
          if (line) parts.push(line.length > 120 ? line.slice(0, 120) + '…' : line);
        }
        if (b.type === 'tool_use') parts.push(fmtTool(b.name, b.input));
      }
      return parts.join('\n') || null;
    }
    case 'tool_use':
      return fmtTool(event.name, event.input);
    case 'result':
      if (event.subtype === 'success' && event.result) {
        // Return full result text (multiline), caller splits it
        return '§RESULT§' + event.result.trim();
      }
      if (event.subtype === 'error_during_execution') return '❌ ' + (event.error ?? 'error');
      return null;
    case 'system':
    case 'tool_result':
      return null; // skip noise
    default:
      return null;
  }
}

function fmtTool(name: string, input: any = {}): string {
  const fp = input.file_path || input.path || input.notebook_path || '';
  switch (name) {
    case 'Write':        return `✏️  Пишу: ${fp}`;
    case 'Edit':         return `✏️  Правлю: ${fp}`;
    case 'Read':         return `📖 Читаю: ${fp}`;
    case 'Bash':         return `⚡ $ ${(input.command ?? '').slice(0, 100)}`;
    case 'Glob':         return `🔍 Glob: ${input.pattern ?? ''}`;
    case 'Grep':         return `🔍 Grep: ${input.pattern ?? ''}`;
    case 'NotebookEdit': return `✏️  Notebook: ${fp}`;
    default:             return `🔧 ${name}${fp ? ': ' + fp : ''}`;
  }
}

// ─── Test runner after agent ──────────────────────────────────────────────────

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;

interface TestFileError {
  testName: string;
  message: string;
}

interface TestFileDetail {
  passed: number;
  failed: number;
  errors: TestFileError[];
}

interface TestRunResult extends Record<string, unknown> {
  passed: number;
  failed: number;
  files: string[];
  fileDetails: Record<string, TestFileDetail>; // absolute path → detail
  runError?: string;
}

interface AgentQueueItem {
  runId: string;
  task: string;
  featureKey?: string;
  filePath?: string;
  selectedFilePaths?: string[];
  title: string;
  agent: string;
  savedErrors?: TestFileError[];
  savedFailedFiles?: Array<{ filePath: string; errors: TestFileError[] }>;
  savedTestType?: string;
  autoFixAttempt?: number;
  autoFixSourceTask?: string;
  meta?: Record<string, any>;
}

type RunPhase = 'queued' | 'starting' | 'running' | 'validating' | 'completed' | 'failed' | 'canceled';
type FileOutcomeStatus = 'covered' | 'not-covered' | 'blocked' | 'infra';

interface FileOutcome {
  sourcePath: string;
  status: FileOutcomeStatus;
  reason?: string;
  testFile?: string;
}

interface ValidationStats {
  total: number;
  covered: number;
  notCovered: number;
  blocked: number;
  infra: number;
}

interface RunRecord {
  runId: string;
  task: string;
  title: string;
  agent: string;
  featureKey?: string;
  filePath?: string;
  selectedFilePaths?: string[];
  targetSourcePaths?: string[];
  phase: RunPhase;
  queuePosition: number | null;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  fileOutcomes?: FileOutcome[];
  validationStats?: ValidationStats;
}

// ─── E2E Plan types ───────────────────────────────────────────────────────────

interface E2eTestCase {
  id: string;
  name: string;
  description: string;
  steps: string[];
  expectedResults: string[];
  status: 'pending' | 'approved' | 'rejected' | 'written' | 'passed' | 'failed';
  testFilePath?: string;
  lastError?: string;
  screenshotPaths?: string[];
}

interface E2ePlan {
  featureKey: string;
  featureLabel: string;
  generatedAt: string;
  updatedAt: string;
  baseUrl?: string;
  testCases: E2eTestCase[];
}

type ParsedE2eTestCase = Omit<E2eTestCase, 'status' | 'testFilePath' | 'lastError' | 'screenshotPaths'>;

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function extractBalancedJsonObjects(text: string): string[] {
  const result: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (start === -1) {
      if (ch === '{') {
        start = i;
        depth = 1;
        inString = false;
        escapeNext = false;
      }
      continue;
    }

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        result.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return result;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function normalizeE2eCaseId(value: string, index: number): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || `e2e-case-${index + 1}`;
}

function sanitizeParsedE2eTestCases(value: unknown): ParsedE2eTestCase[] {
  if (!Array.isArray(value)) return [];
  const usedIds = new Set<string>();
  const result: ParsedE2eTestCase[] = [];

  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;

    const name = toNonEmptyString(item.name) ?? `E2E кейс ${i + 1}`;
    const description = toNonEmptyString(item.description) ?? name;
    const steps = toStringArray(item.steps);
    const expectedResults = toStringArray(item.expectedResults);
    if (steps.length === 0 || expectedResults.length === 0) continue;

    let idBase = normalizeE2eCaseId(toNonEmptyString(item.id) ?? `e2e-case-${i + 1}`, i);
    let id = idBase;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${idBase}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);

    result.push({
      id,
      name,
      description,
      steps,
      expectedResults,
    });
  }

  return result;
}

function parseE2ePlanFromAgentOutput(rawOutput: string): { baseUrl?: string; testCases: ParsedE2eTestCase[] } {
  const cleaned = stripAnsi(rawOutput).replace(/\u0000/g, '').trim();
  if (!cleaned) {
    throw new Error('пустой ответ агента');
  }

  const candidates: string[] = [];
  const fencedRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fencedMatch: RegExpExecArray | null = null;
  while ((fencedMatch = fencedRe.exec(cleaned)) !== null) {
    const block = fencedMatch[1]?.trim();
    if (block) candidates.push(block);
  }
  candidates.push(...extractBalancedJsonObjects(cleaned));
  candidates.push(cleaned);

  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i];
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;
    const testCases = sanitizeParsedE2eTestCases(obj.testCases);
    if (testCases.length === 0) continue;
    const baseUrl = toNonEmptyString(obj.baseUrl) ?? undefined;
    return { baseUrl, testCases };
  }

  const hasTestCasesKey = cleaned.toLowerCase().includes('"testcases"');
  if (hasTestCasesKey) {
    throw new Error('ответ похож на JSON-план, но он обрезан или повреждён');
  }
  throw new Error('в ответе агента не найден валидный JSON с testCases');
}

function runTestFiles(files: string[], projectRoot: string): Promise<TestRunResult> {
  return new Promise((resolve) => {
    // Write JSON to a temp file — avoids stdout encoding/regex issues on Windows
    const tmpDir  = path.join(projectRoot, '.viberadar');
    const tmpFile = path.join(tmpDir, '_test-results.json');
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
    try { fs.unlinkSync(tmpFile); } catch {}

    const proc = spawn(
      'npx', ['vitest', 'run', '--reporter=json', `--outputFile=${tmpFile}`, ...files],
      { cwd: projectRoot, shell: true, stdio: 'pipe' }
    );
    let stdout = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.on('close', () => {
      try {
        // Prefer the output file (reliable); fall back to stdout
        let jsonStr: string;
        if (fs.existsSync(tmpFile)) {
          jsonStr = fs.readFileSync(tmpFile, 'utf-8').trim();
          process.stdout.write(`   ✅ vitest outputFile: ${tmpFile} (${jsonStr.length} bytes)\n`);
        } else {
          process.stdout.write(`   ⚠️  vitest outputFile not found, falling back to stdout (${stdout.length} bytes)\n`);
          const match = stdout.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
          jsonStr = match ? match[0] : stdout.trim();
        }

        const json = JSON.parse(jsonStr);
        process.stdout.write(`   🔍 vitest JSON: passed=${json.numPassedTests} failed=${json.numFailedTests} testResults=${(json.testResults ?? []).length}\n`);

        // Extract per-file failure details
        const fileDetails: Record<string, TestFileDetail> = {};
        for (const tr of (json.testResults ?? [])) {
          const fp: string = tr.testFilePath ?? '';
          if (!fp) continue;
          const assertions: any[] = tr.assertionResults ?? tr.testResults ?? [];
          const errors: TestFileError[] = [];
          for (const ar of assertions) {
            if (ar.status === 'failed') {
              errors.push({
                testName: ar.fullName ?? ar.title ?? 'unknown',
                message: (ar.failureMessages?.[0] ?? ar.errors?.[0]?.message ?? '').split('\n')[0].slice(0, 300),
              });
            }
          }
          fileDetails[fp] = {
            passed: assertions.filter((a: any) => a.status === 'passed').length,
            failed: errors.length,
            errors,
          };
        }

        const failedFiles = Object.entries(fileDetails).filter(([, d]) => d.failed > 0);
        process.stdout.write(`   🔍 fileDetails: ${Object.keys(fileDetails).length} files, ${failedFiles.length} with failures\n`);
        if (failedFiles.length > 0) {
          for (const [fp, d] of failedFiles) {
            process.stdout.write(`      ❌ ${fp} → ${d.failed} failed\n`);
          }
        }

        resolve({
          passed: json.numPassedTests ?? 0,
          failed: json.numFailedTests ?? 0,
          files,
          fileDetails,
        });
      } catch (err: any) {
        process.stdout.write(`   ❌ runTestFiles parse error: ${err.message}\n`);
        resolve({ passed: 0, failed: files.length, files, fileDetails: {}, runError: err.message });
      }
    });
    proc.on('error', (err: any) => resolve({ passed: 0, failed: files.length, files, fileDetails: {}, runError: err.message }));
  });
}

// ─── E2E plan storage ─────────────────────────────────────────────────────────

function e2ePlanDir(projectRoot: string): string {
  return path.join(projectRoot, '.viberadar', 'e2e-plans');
}

function e2ePlanPath(projectRoot: string, featureKey: string): string {
  return path.join(e2ePlanDir(projectRoot), `${featureKey}.json`);
}

function loadE2ePlan(projectRoot: string, featureKey: string): E2ePlan | null {
  try {
    const p = e2ePlanPath(projectRoot, featureKey);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { return null; }
}

function saveE2ePlan(projectRoot: string, plan: E2ePlan): void {
  const dir = e2ePlanDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  plan.updatedAt = new Date().toISOString();
  fs.writeFileSync(e2ePlanPath(projectRoot, plan.featureKey), JSON.stringify(plan, null, 2), 'utf-8');
}

function e2eScreenshotDir(projectRoot: string, featureKey: string): string {
  return path.join(projectRoot, '.viberadar', 'e2e-screenshots', featureKey);
}

function collectScreenshots(projectRoot: string, featureKey: string, testCaseId: string): string[] {
  const dir = path.join(e2eScreenshotDir(projectRoot, featureKey), testCaseId);
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .sort()
      .map(f => `${featureKey}/${testCaseId}/${f}`);
  } catch { return []; }
}

function hasPlaywright(projectRoot: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return !!deps['@playwright/test'] || !!deps['playwright'];
  } catch { return false; }
}

// ─── Playwright runner ────────────────────────────────────────────────────────

function runPlaywrightTests(files: string[], projectRoot: string): Promise<{ passed: number; failed: number; results: Record<string, 'passed' | 'failed'>; errors: Record<string, string> }> {
  return new Promise((resolve) => {
    const proc = spawn(
      'npx', ['playwright', 'test', '--reporter=json', ...files],
      { cwd: projectRoot, shell: true, stdio: 'pipe' }
    );
    let stdout = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.on('close', () => {
      try {
        const match = stdout.match(/\{[\s\S]*"suites"[\s\S]*\}/);
        const json = JSON.parse(match ? match[0] : stdout);
        const results: Record<string, 'passed' | 'failed'> = {};
        const errors: Record<string, string> = {};
        let passed = 0, failed = 0;
        const walkSuites = (suites: any[]) => {
          for (const suite of suites ?? []) {
            for (const spec of suite.specs ?? []) {
              const ok = spec.tests?.every((t: any) => t.results?.every((r: any) => r.status === 'passed'));
              const title = spec.title ?? suite.title ?? 'unknown';
              if (ok) { results[title] = 'passed'; passed++; }
              else {
                results[title] = 'failed'; failed++;
                const errMsg = spec.tests?.[0]?.results?.[0]?.error?.message ?? 'Test failed';
                errors[title] = errMsg.split('\n')[0].slice(0, 300);
              }
            }
            if (suite.suites) walkSuites(suite.suites);
          }
        };
        walkSuites(json.suites ?? []);
        resolve({ passed, failed, results, errors });
      } catch {
        resolve({ passed: 0, failed: 0, results: {}, errors: {} });
      }
    });
    proc.on('error', () => resolve({ passed: 0, failed: 0, results: {}, errors: {} }));
  });
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildWriteTestsPrompt(
  feat: FeatureResult,
  modules: ModuleInfo[],
  testRunner: string,
): string {
  const untestedMods = modules
    .filter(m => m.featureKeys.includes(feat.key) && m.type !== 'test' && !m.hasTests && !m.isInfra);

  const untestedPaths = untestedMods.map(m => '- ' + m.relativePath.replace(/\\/g, '/'));

  const existing = modules
    .filter(m => m.featureKeys.includes(feat.key) && m.type === 'test')
    .map(m => '- ' + m.relativePath.replace(/\\/g, '/'));

  const hasNoTestInfra = modules.filter(m => m.type === 'test').length === 0;

  // Split by suggested type and give explicit guidance
  const unitFiles = untestedMods.filter(m => (m.suggestedTestType ?? 'unit') === 'unit');
  const integrationFiles = untestedMods.filter(m => m.suggestedTestType === 'integration');
  const typeSummary = [
    unitFiles.length > 0
      ? `Unit-тесты (${unitFiles.length} файлов): мокай все зависимости через vi.mock(), никаких обращений к реальной БД`
      : '',
    integrationFiles.length > 0
      ? `Integration-тесты (${integrationFiles.length} файлов): используй реальную БД через test-helpers или pg-mem`
      : '',
  ].filter(Boolean).join('\n');

  return [
    `Напиши тесты для фичи "${feat.label}".`,
    ``,
    `Файлов без тестов (${untestedMods.length}):`,
    ...untestedPaths,
    ``,
    typeSummary ? `Рекомендации по типам тестов:\n${typeSummary}` : '',
    ``,
    existing.length > 0
      ? `Существующие тест-файлы (для справки по паттернам):\n${existing.join('\n')}`
      : '',
    ``,
    hasNoTestInfra
      ? `⚠️ В проекте пока нет ни одного теста. Если нужна тестовая инфраструктура (test-helpers.ts, vitest.config.ts) — создай её сначала.`
      : '',
    ``,
    `Требования:`,
    `- Используй ${testRunner}`,
    `- Следуй паттернам существующих тестов в проекте`,
    `- Для каждого файла создай соответствующий тест-файл`,
    `- Не изменяй существующие тесты`,
  ].filter(Boolean).join('\n');
}

function buildWriteTestsForFilePrompt(
  filePath: string,
  feat: FeatureResult,
  modules: ModuleInfo[],
  testRunner: string,
): string {
  const normalPath = filePath.replace(/\\/g, '/');

  // Find module info to get suggestedTestType (match by relativePath or absolute path)
  const sourceModule = modules.find(m =>
    m.relativePath.replace(/\\/g, '/') === normalPath || m.path === filePath
  );
  const suggestedTestType = sourceModule?.suggestedTestType ?? 'unit';

  const existing = modules
    .filter(m => m.featureKeys.includes(feat.key) && m.type === 'test')
    .map(m => '- ' + m.relativePath.replace(/\\/g, '/'));

  const hasNoTestInfra = modules.filter(m => m.type === 'test').length === 0;

  const testTypeBlock = suggestedTestType === 'integration'
    ? [
        `Тип теста: INTEGRATION`,
        `Файл обращается к БД, репозиториям или внешним сервисам.`,
        `→ Используй test-helpers или pg-mem для работы с реальной БД.`,
        `→ Не мокай репозитории — проверяй реальное поведение.`,
      ].join('\n')
    : [
        `Тип теста: UNIT`,
        `→ Замокай все внешние зависимости через \`vi.mock()\`.`,
        `→ Не используй реальную БД или внешние сервисы.`,
        `→ Тест должен работать быстро без внешних зависимостей.`,
      ].join('\n');

  return [
    `Напиши тест для файла \`${normalPath}\`.`,
    `Фича: "${feat.label}"`,
    ``,
    testTypeBlock,
    ``,
    existing.length > 0
      ? `Существующие тест-файлы фичи (следуй этим паттернам):\n${existing.join('\n')}`
      : 'Существующих тестов в этой фиче пока нет — следуй общим паттернам проекта.',
    ``,
    hasNoTestInfra
      ? `⚠️ В проекте пока нет ни одного теста. Если нужна тестовая инфраструктура (test-helpers.ts, vitest.config.ts) — создай её сначала.`
      : '',
    ``,
    `Требования:`,
    `- Используй ${testRunner}`,
    `- Создай один тест-файл для \`${normalPath}\``,
    `- Покрой: happy path, edge cases, обработку ошибок`,
    `- Следуй паттернам существующих тестов в проекте`,
    `- Не изменяй существующие тесты`,
  ].filter(Boolean).join('\n');
}

function buildWriteTestsForSelectedPrompt(
  filePaths: string[],
  feat: FeatureResult,
  modules: ModuleInfo[],
  testRunner: string,
): string {
  const normalized = filePaths.map(p => p.replace(/\\/g, '/')).filter(Boolean);
  const selectedModules = normalized
    .map(p => modules.find(m => m.relativePath.replace(/\\/g, '/') === p))
    .filter((m): m is ModuleInfo => !!m && m.type !== 'test');

  const selectedLines = selectedModules.map((m) => {
    const suggested = m.suggestedTestType === 'integration' ? 'integration' : 'unit';
    const staleMark = m.testStale ? ' (тест устарел)' : '';
    return `- ${m.relativePath.replace(/\\/g, '/')} — ${suggested}${staleMark}`;
  });

  return [
    `Напиши/обнови тесты только для выбранных файлов фичи "${feat.label}".`,
    '',
    `Выбрано файлов (${selectedModules.length}):`,
    ...selectedLines,
    '',
    `Критерии высокого стандарта (обязательно):`,
    `- Работай только с выбранными файлами из списка`,
    `- Для КАЖДОГО выбранного файла сделай явный результат: created | updated | already-covered | blocked`,
    `- Если теста нет — создай`,
    `- Если тест устарел или слабый — обнови/дополни`,
    `- Для unit файлов мокай внешние зависимости`,
    `- Для integration файлов используй test-helpers или pg-mem`,
    `- Используй ${testRunner}`,
    `- Следуй текущим паттернам тестов в проекте`,
    `- Не завершай задачу без отчета по каждому выбранному файлу`,
    '',
    `Формат финального ответа (строго):`,
    `1) "Матрица покрытия (X/${selectedModules.length})"`,
    `   Для каждого выбранного файла отдельная строка:`,
    `   - source: <path> | status: <created|updated|already-covered|blocked> | testFile: <path или -> | note: <что сделано/почему blocked>`,
    `2) "Проверка"`,
    `   - какие одноразовые команды запускал`,
    `   - итог (сколько тестов passed/failed)`,
    `3) "Осталось без тестов"`,
    `   - перечисли файлы из выбранного списка, которые все еще без тестов (если есть), иначе напиши "нет"`,
    `4) "Conventional Commit title"`,
    `   - одна строка в формате Conventional Commits`,
  ].join('\n');
}

function buildRefreshTestsForSelectedPrompt(
  filePaths: string[],
  feat: FeatureResult,
  modules: ModuleInfo[],
  testRunner: string,
): string {
  const normalized = filePaths.map(p => p.replace(/\\/g, '/')).filter(Boolean);
  const selectedModules = normalized
    .map(p => modules.find(m => m.relativePath.replace(/\\/g, '/') === p))
    .filter((m): m is ModuleInfo => !!m && m.type !== 'test');

  const selectedLines = selectedModules.map((m) => {
    const suggested = m.suggestedTestType === 'integration' ? 'integration' : 'unit';
    const linkedTest = m.testFile ? m.testFile.replace(/\\/g, '/') : 'теста нет';
    return `- ${m.relativePath.replace(/\\/g, '/')} — ${suggested}, текущий тест: ${linkedTest}`;
  });

  return [
    `Актуализируй тесты для выбранных файлов фичи "${feat.label}".`,
    '',
    `Выбрано файлов (${selectedModules.length}):`,
    ...selectedLines,
    '',
    `Критерии высокого стандарта (обязательно):`,
    `- Для КАЖДОГО выбранного файла дай итог: updated | already-covered | blocked`,
    `- Не пропускай файлы молча: если не изменил, объясни почему`,
    '',
    `Для каждого выбранного файла:`,
    `1) Проверь актуальность и качество тестов.`,
    `2) Дополни недостающие сценарии (happy path, edge cases, ошибки).`,
    `3) Если тест отсутствует — создай новый.`,
    `4) Не меняй source-код без крайней необходимости; фокус на тестах.`,
    `5) Используй ${testRunner} и паттерны проекта.`,
    '',
    `Формат финального ответа (строго):`,
    `1) "Матрица покрытия (X/${selectedModules.length})"`,
    `   - source: <path> | status: <updated|already-covered|blocked> | testFile: <path или -> | note: <кратко>`,
    `2) "Проверка"`,
    `   - одноразовые команды + результат`,
    `3) "Осталось без тестов"`,
    `   - список из выбранных, если такие остались`,
    `4) "Conventional Commit title"`,
  ].join('\n');
}

function buildFixTestsPrompt(filePath: string, errors: TestFileError[]): string {
  const normalPath = filePath.replace(/\\/g, '/');
  return [
    `Исправь падающие тесты в файле \`${normalPath}\`.`,
    ``,
    `Упавшие тесты (${errors.length}):`,
    ...errors.map(e => `• "${e.testName}"\n  ${e.message}`),
    ``,
    `Требования:`,
    `- Исправь только падающие тесты, не трогай проходящие`,
    `- Не удаляй тесты — исправь логику или моки`,
    `- Если тест проверяет несуществующее поведение — адаптируй под реальное поведение кода`,
    `- Если ошибка в исходном коде, а не в тесте — исправь код`,
    `- После исправления запусти ТОЛЬКО этот файл: npm run test -- ${normalPath}`,
    `- НЕ запускай npm run test без аргументов — зависнет на integration-тестах с БД`,
  ].join('\n');
}

function buildFixAllTestsPrompt(failedFiles: Array<{ filePath: string; errors: TestFileError[] }>, testType: string): string {
  const totalErrors = failedFiles.reduce((sum, f) => sum + f.errors.length, 0);
  const fileBlocks = failedFiles.map(f => {
    const normalPath = f.filePath.replace(/\\/g, '/');
    return [
      `### \`${normalPath}\` (${f.errors.length} упало):`,
      ...f.errors.map(e => `• "${e.testName}"\n  ${e.message}`),
    ].join('\n');
  });
  return [
    `Исправь все падающие ${testType} тесты (${totalErrors} тестов в ${failedFiles.length} файлах).`,
    ``,
    ...fileBlocks,
    ``,
    `Требования:`,
    `- Исправь только падающие тесты, не трогай проходящие`,
    `- Не удаляй тесты — исправь логику или моки`,
    `- Если тест проверяет несуществующее поведение — адаптируй под реальное поведение кода`,
    `- Если ошибка в исходном коде, а не в тесте — исправь код`,
    `- После исправления каждого файла запускай ТОЛЬКО его тест: npm run test -- <путь/к/тесту.test.ts>`,
    `- НЕ запускай npm run test без аргументов — зависнет на integration-тестах с БД`,
  ].join('\n');
}

function buildMapUnmappedPrompt(modules: ModuleInfo[], features: FeatureResult[]): string {
  const unmapped = modules
    .filter(m => m.type !== 'test' && !m.isInfra && (!m.featureKeys || m.featureKeys.length === 0))
    .map(m => '- ' + m.relativePath.replace(/\\/g, '/'));

  const featureList = features.map(f => `  • ${f.key} — ${f.label}`).join('\n');

  return [
    `В проекте ${unmapped.length} файлов без привязки к фичам.`,
    ``,
    `Для каждого файла реши:`,
    `1. Относится к существующей фиче → добавь путь в "include" этой фичи в viberadar.config.json`,
    `2. Это инфраструктура (конфиги, типы, middleware, bootstrap) → добавь glob в массив "ignore"`,
    `3. Явно новая бизнес-фича → создай новую запись в "features"`,
    `4. Непонятно → пропусти`,
    ``,
    `Существующие фичи:`,
    featureList,
    ``,
    `Файлы:`,
    ...unmapped,
  ].join('\n');
}

// ─── Orphan test helpers & prompt builders ─────────────────────────────────────

const CLASSIFY_BATCH_SIZE = 30;
const LINK_BATCH_SIZE = 30;

function getOrphanTests(modules: ModuleInfo[]) {
  const testModules = modules.filter(m => m.type === 'test');
  const linkedTestPaths = new Set(
    modules.filter(m => m.type !== 'test' && m.testFile)
      .map(m => m.testFile!.replace(/\\/g, '/'))
  );
  return {
    noFeature: testModules.filter(m => m.featureKeys.length === 0),
    noSource: testModules.filter(m => !linkedTestPaths.has(m.relativePath.replace(/\\/g, '/'))),
  };
}

function buildClassifyOrphanTestsPrompt(modules: ModuleInfo[], features: FeatureResult[], projectRoot: string, batch: number): string | null {
  const orphans = getOrphanTests(modules).noFeature;
  const start = batch * CLASSIFY_BATCH_SIZE;
  const slice = orphans.slice(start, start + CLASSIFY_BATCH_SIZE);
  if (slice.length === 0) return null;

  const totalBatches = Math.ceil(orphans.length / CLASSIFY_BATCH_SIZE);

  // Read config to show current include patterns
  let configFeatures: Record<string, { label: string; include: string[] }> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(projectRoot, 'viberadar.config.json'), 'utf-8'));
    if (raw.features) {
      for (const [k, v] of Object.entries(raw.features) as [string, any][]) {
        configFeatures[k] = { label: v.label || k, include: v.include || [] };
      }
    }
  } catch {}

  // Build source map for tests that have linked sources
  const testSourceMap = new Map<string, string[]>();
  for (const m of modules) {
    if (m.type !== 'test' && m.testFile) {
      const key = m.testFile.replace(/\\/g, '/');
      if (!testSourceMap.has(key)) testSourceMap.set(key, []);
      testSourceMap.get(key)!.push(m.relativePath.replace(/\\/g, '/'));
    }
  }

  const featureList = Object.entries(configFeatures).map(([k, v]) =>
    `  • ${k} — ${v.label}\n    include: ${JSON.stringify(v.include)}`
  ).join('\n');

  const testList = slice.map(m => {
    const rel = m.relativePath.replace(/\\/g, '/');
    const sources = testSourceMap.get(rel);
    return sources
      ? `- ${rel}  (исходник: ${sources.join(', ')})`
      : `- ${rel}`;
  }).join('\n');

  return [
    `В проекте ${orphans.length} тестов без привязки к фичам (пакет ${batch + 1}/${totalBatches}).`,
    ``,
    `Для каждого теста:`,
    `1. Прочитай файл теста и определи, какой модуль/фичу он тестирует`,
    `2. Относится к существующей фиче → добавь glob-паттерн в "include" этой фичи в viberadar.config.json`,
    `3. Это инфраструктура (setup, helpers, fixtures, mocks, shared utils) → добавь glob в массив "ignore"`,
    `4. Непонятно → пропусти`,
    ``,
    `Существующие фичи:`,
    featureList,
    ``,
    `Тесты без фичи:`,
    testList,
    ``,
    `Важно:`,
    `- НЕ создавай новые фичи. Используй только существующие.`,
    `- Добавляй конкретные glob-паттерны (напр. "tests/*storage*", "e2e/billing*"), а НЕ широкие вроде "tests/**"`,
    `- Для каждого теста: прочитай файл, определи какой модуль он тестирует, найди фичу этого модуля`,
    `- НЕ запускай тесты и НЕ меняй код тестов — только viberadar.config.json`,
  ].join('\n');
}

function buildLinkOrphanTestsPrompt(modules: ModuleInfo[], batch: number): string | null {
  const orphans = getOrphanTests(modules).noSource;
  const start = batch * LINK_BATCH_SIZE;
  const slice = orphans.slice(start, start + LINK_BATCH_SIZE);
  if (slice.length === 0) return null;

  const totalBatches = Math.ceil(orphans.length / LINK_BATCH_SIZE);

  const testList = slice.map(m => `- ${m.relativePath.replace(/\\/g, '/')}`).join('\n');

  return [
    `В проекте ${orphans.length} тестов без привязки к исходному файлу (пакет ${batch + 1}/${totalBatches}).`,
    ``,
    `Сканер связывает тесты с исходниками тремя способами:`,
    `1. По имени файла (auth.test.ts → auth.ts, tests/auth.test.ts → src/auth.ts)`,
    `2. По import-анализу (если тест импортирует исходник)`,
    `3. По fuzzy-matching (workspace-storage → WorkspaceStorage)`,
    ``,
    `Для каждого теста ниже:`,
    `1. Прочитай файл теста и определи, какой исходный модуль он тестирует`,
    `2. Если тест НЕ импортирует этот модуль напрямую — добавь import в начало файла:`,
    `   import '<относительный_путь_к_исходнику>' // viberadar:source-link`,
    `   (Это может быть type-only import если нужно: import type {...} from '...')`,
    `3. Если тест автономный (fixture, helper, тестирует только внутреннюю логику) → пропусти`,
    ``,
    `Тесты без исходника:`,
    testList,
    ``,
    `Важно:`,
    `- Добавляй ТОЛЬКО import для связи со сканером — НЕ меняй логику тестов`,
    `- НЕ запускай тесты`,
    `- Если не можешь найти исходник — пропусти тест`,
  ].join('\n');
}

// ─── Observability prompt builders ────────────────────────────────────────────

const LOGGING_STANDARD_INLINE = [
  `## Стандарт логирования (инлайн)`,
  `Обязательные поля для каждого структурированного лога:`,
  `- timestamp (ISO-8601) — обычно ставится логгером автоматически`,
  `- service — имя сервиса (billing-api, auth и т.д.)`,
  `- env — среда (local|dev|stage|prod):`,
  `    ⚠️ КРИТИЧНО: способ получения зависит от окружения файла:`,
  `    • Серверный файл (server/, Node.js, .ts без JSX): process.env.NODE_ENV ?? "local"`,
  `    • Клиентский файл (client/, Vite, .tsx, React-компонент): import.meta.env.MODE ?? "local"`,
  `    • НЕЛЬЗЯ использовать process.env в клиентском коде — Vite его не поддерживает, это сломает сборку`,
  `- level — DEBUG|INFO|WARN|ERROR`,
  `- trace_id — ID распределённого трейса`,
  `- request_id — сквозной request-id`,
  `- user_id или user_hash — идентификатор пользователя`,
  `- event_name — доменное имя события, формат: <domain>.<entity>.<action> (lower_snake_case через точку)`,
  `- outcome — success|failure|partial`,
  `- error_code — код ошибки (для WARN/ERROR обязателен)`,
  ``,
  `Допустимые error_code: VALIDATION_ERROR, UNAUTHORIZED, FORBIDDEN, RESOURCE_NOT_FOUND, CONFLICT, RATE_LIMITED, DEPENDENCY_TIMEOUT, DEPENDENCY_UNAVAILABLE, DB_TIMEOUT, DB_CONSTRAINT_VIOLATION, INTERNAL_ERROR`,
  ``,
  `Правила лог-уровней:`,
  `- DEBUG — только локальная диагностика, в prod выключен`,
  `- INFO — значимые бизнес-события и lifecycle операции`,
  `- WARN — деградация, ретраи, graceful fallback`,
  `- ERROR — фактический сбой операции`,
].join('\n');

const SUPPRESS_GUARD = `
⛔ СТРОГО ЗАПРЕЩЕНО (нарушение = потеря наблюдаемости в prod):
- Трогать logger.warn / logger.error / logger.fatal — это сигналы деградации и сбоев, не шум
- Понижать WARN → INFO, WARN → DEBUG, ERROR → WARN — это критическая потеря
- Удалять или переименовывать ERROR/FATAL логи

✅ Работать ТОЛЬКО с:
- logger.info / logger.debug / logger.trace которые неструктурированы или lifecycle-мусор
- Конкретные сообщения указаны в задаче ниже
`.trim();

function buildObsSuppressPatternPrompt(pattern: string, recommendation: string, catalog: ObservabilityCatalogItem[]): string {
  // Only include modules whose noisyMessages actually contain this pattern.
  // Use prefix matching to handle 80/90-char truncation differences.
  const relatedModules = catalog
    .filter(c => (c.noisyMessages || []).some(m => m && (m === pattern || m.startsWith(pattern) || pattern.startsWith(m))))
    .map(c => {
      const snippets = (c.noisyMessages || []).slice(0, 3).map(m => `    • "${m}"`).join('\n');
      return `- ${c.modulePath} (format: ${c.format})\n${snippets}`;
    })
    .slice(0, 15);

  return [
    `Убери шумные лог-вызовы уровня INFO/DEBUG/TRACE.`,
    ``,
    SUPPRESS_GUARD,
    ``,
    `Конкретный паттерн для поиска: "${pattern}"`,
    ``,
    relatedModules.length > 0
      ? `Модули где встречается шум (с примерами сообщений):\n${relatedModules.join('\n')}`
      : '',
    ``,
    `Что сделать с каждым найденным вызовом logger.info/debug/trace, порождающим этот паттерн:`,
    `- УДАЛИ полностью, если это lifecycle-мусор: "started", "done", "ok", "loaded", "ready", "ping"`,
    `- СТРУКТУРИРУЙ в logger.debug({ service, event_name, outcome, ...данные }), если несёт диагностическую ценность`,
    `- НЕ ТРОГАЙ, если это logger.warn / logger.error / logger.fatal — даже если сообщение похоже на шум`,
    ``,
    `⛔ НЕ ЗАПУСКАЙ npm test / vitest / playwright — это лог-правка, не изменение логики. Единственная нужная проверка: \`npm run check\` (tsc).`,
    ``,
    `\n${LOGGING_STANDARD_INLINE}`,
  ].filter(Boolean).join('\n');
}

function buildObsAddCriticalLogsPrompt(modulePath: string, catalog: ObservabilityCatalogItem[]): string {
  const moduleItem = catalog.find(c => c.modulePath === modulePath);
  const missingFields = moduleItem?.missingFields || [];

  return [
    `Добавь критичные логи (warn/error) в модуль \`${modulePath}\`.`,
    ``,
    `Сейчас в модуле нет warn/error событий. При сбоях мы не увидим ошибку в логах.`,
    ``,
    moduleItem
      ? `Текущее состояние модуля:\n- Формат: ${moduleItem.format}\n- Уровень: ${moduleItem.level}\n- Пропущенные поля: ${missingFields.length > 0 ? missingFields.join(', ') : 'нет'}`
      : '',
    ``,
    `Что сделать:`,
    `- Найди в модуле точки, где может произойти ошибка (catch-блоки, проверки null/undefined, HTTP-ответы с ошибкой, DB-ошибки)`,
    `- Добавь logger.warn или logger.error с обязательными полями по стандарту`,
    `- Каждый лог должен включать: event_name, outcome, error_code (для error)`,
    `- Именование event_name: <domain>.<entity>.<action> (lower_snake_case через точку)`,
    `- Используй error_code из допустимых кодов в стандарте ниже`,
    ``,
    `\n${LOGGING_STANDARD_INLINE}`,
  ].filter(Boolean).join('\n');
}

const FP_TYPE_LABELS: Record<string, string> = {
  'empty-catch':             'Пустой catch-блок — проглатывает ошибку',
  'catch-no-log':            'catch без логирования ошибки',
  'promise-catch-no-log':    '.catch() без логирования',
  'http-no-error-handling':  'HTTP-вызов без обработки ошибок',
  'db-no-error-handling':    'DB-операция без обработки ошибок',
  'throw-no-log':            'throw без предшествующего logger.error',
  'error-check-no-log':      'Проверка ошибки (if err) без логирования',
};

function buildObsAddCriticalLogsPromptV2(item: MissingCriticalLogItem, catalog: ObservabilityCatalogItem[]): string {
  const catalogEntry = catalog.find(c => c.modulePath === item.modulePath);

  const fpDescriptions = item.failurePoints.map(fp =>
    `- Строка ~${fp.lineApprox}: ${FP_TYPE_LABELS[fp.type] || fp.type}\n  \`${fp.snippet}\``
  ).join('\n');

  return [
    `Добавь критичные логи (warn/error) в модуль \`${item.modulePath}\`.`,
    ``,
    `Роль модуля: ${item.roleHint} (приоритет: ${item.riskTier})`,
    item.hasAnyWarnError
      ? `В модуле есть некоторые warn/error, но обнаружены незакрытые точки отказа.`
      : `В модуле НЕТ ни одного warn/error. При сбоях мы не увидим ошибку в логах.`,
    ``,
    catalogEntry
      ? `Текущее состояние:\n- Формат: ${catalogEntry.format}\n- Уровень: ${catalogEntry.level}\n- Пропущенные поля: ${(catalogEntry.missingFields || []).join(', ') || 'нет'}`
      : '',
    ``,
    `Обнаруженные точки отказа без логирования (${item.failurePoints.length}):`,
    fpDescriptions,
    ``,
    `Что сделать с каждой точкой:`,
    `- Пустые catch-блоки: добавь logger.error с контекстом, event_name, error_code, outcome:failure`,
    `- catch без лога: добавь logger.error/warn рядом с обработкой ошибки`,
    `- .catch() без лога: добавь logger.error в обработчик промиса`,
    `- HTTP/DB без обработки: оберни в try/catch с logger.error`,
    `- throw без лога: добавь logger.error ДО throw`,
    `- if(err) без лога: добавь logger.warn/error в ветку ошибки`,
    ``,
    `Каждый лог: event_name, outcome, error_code (для error).`,
    `event_name: <domain>.<entity>.<action> (lower_snake_case через точку)`,
    ``,
    `\n${LOGGING_STANDARD_INLINE}`,
  ].filter(Boolean).join('\n');
}

function guessTestFile(modulePath: string): string | null {
  // server/llm-client.ts → tests/llm-client.test.ts
  const basename = modulePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.(ts|tsx|js|jsx)$/, '') ?? '';
  if (!basename) return null;
  return `tests/${basename}.test.ts`;
}

function buildObsBatchAddCriticalLogsPrompt(items: MissingCriticalLogItem[], catalog: ObservabilityCatalogItem[]): string {
  const moduleBlocks = items.map(item => {
    const fpSummary = item.failurePoints.map(fp =>
      `  - строка ~${fp.lineApprox}: ${FP_TYPE_LABELS[fp.type] || fp.type} — \`${fp.snippet}\``
    ).join('\n');
    return `### \`${item.modulePath}\` (${item.roleHint}, ${item.riskTier})\n${fpSummary || '  - Нет warn/error, проверь весь модуль на точки отказа'}`;
  }).join('\n\n');

  const testCommands = items
    .map(item => guessTestFile(item.modulePath))
    .filter((f): f is string => f !== null)
    .filter((f, i, arr) => arr.indexOf(f) === i) // dedupe
    .map(f => `  npm run test -- ${f}`)
    .join('\n');

  return [
    `Добавь критичные логи в ${items.length} модулей.`,
    ``,
    `Для каждого модуля: найди точки отказа (указаны ниже) и добавь logger.warn/error с обязательными полями.`,
    ``,
    moduleBlocks,
    ``,
    `Требования к каждому логу:`,
    `- event_name: <domain>.<entity>.<action> (lower_snake_case через точку)`,
    `- outcome: failure|partial`,
    `- error_code из словаря (VALIDATION_ERROR, DEPENDENCY_TIMEOUT, INTERNAL_ERROR и т.д.)`,
    `- Пустые catch: добавь logger.error, не оставляй пустыми`,
    `- HTTP/DB без обработки: оберни в try/catch с logger.error`,
    `- В payload-объекте логгера используй ТОЛЬКО переменные из текущего скоупа (не угадывай имена полей из типов)`,
    ``,
    `⚠️ ВАЖНО — React / Vite файлы (.tsx):`,
    `- НЕ добавляй export утилитарных функций в файлы React-компонентов — React Fast Refresh сделает full reload`,
    `- Если нужна утилита — создай отдельный файл *Utils.ts рядом и импортируй оттуда`,
    ``,
    `⚠️ ВАЖНО — проверка после изменений:`,
    `- ШАГ 1: npm run check -- --pretty false (TypeScript, обязательно — ловит ошибки в payload)`,
    `- ШАГ 2: запустить ТОЛЬКО тест-файл изменённого модуля — НЕ весь suite`,
    `- Команды для тестов (по одной за раз):`,
    testCommands || `  npm run test -- tests/<basename>.test.ts`,
    `- Запуск \`npm run test\` без аргументов ЗАПРЕЩЁН — зависнет на integration-тестах с БД`,
    `- Если тест-файл не найден — пропусти ШАГ 2`,
    ``,
    `\n${LOGGING_STANDARD_INLINE}`,
  ].filter(Boolean).join('\n');
}

function buildObsEnrichFieldPrompt(fieldName: string, catalog: ObservabilityCatalogItem[]): string {
  const affectedModules = catalog
    .filter(c => c.missingFields.includes(fieldName))
    .map(c => `- ${c.modulePath} (format: ${c.format}, missing: ${c.missingFields.join(', ')})`)
    .slice(0, 30);

  const fieldHints: Record<string, string> = {
    service: 'Имя сервиса. Берётся из конфига или env-переменной, не хардкодится.',
    env: 'Среда (local|dev|stage|prod). ⚠️ КРИТИЧНО — способ зависит от файла: серверный код (server/, Node.js) → process.env.NODE_ENV ?? "local"; клиентский код (client/, Vite, .tsx, React) → import.meta.env.MODE ?? "local". НЕЛЬЗЯ использовать process.env в Vite/React — сломает сборку.',
    trace_id: 'ID распределённого трейса. Передаётся через middleware из заголовка или генерируется.',
    request_id: 'Сквозной ID запроса. Берётся из заголовка X-Request-Id или генерируется middleware.',
    event_name: 'Доменное событие. Формат: <domain>.<entity>.<action> (lower_snake_case через точку).',
    outcome: 'Результат операции: success|failure|partial.',
    error_code: 'Код ошибки из допустимых кодов (см. стандарт ниже). Обязателен для WARN/ERROR.',
    user_id: 'ID пользователя (user_id для внутренних, user_hash для внешних). Берётся из контекста auth.',
  };

  return [
    `Добавь обязательное поле \`${fieldName}\` во все лог-вызовы, где оно отсутствует.`,
    ``,
    fieldHints[fieldName] ? `Описание поля: ${fieldHints[fieldName]}` : '',
    ``,
    affectedModules.length > 0
      ? `Модули с пропущенным полем "${fieldName}" (${affectedModules.length}):\n${affectedModules.join('\n')}`
      : '',
    ``,
    `Что сделать:`,
    `- Открой каждый модуль из списка`,
    `- Найди все вызовы логгера (logger.info, logger.warn, logger.error и т.д.)`,
    `- Добавь поле "${fieldName}" в каждый вызов, где оно отсутствует`,
    `- Значение поля должно быть взято из контекста (request, config, env) — не хардкодь`,
    `- В .tsx файлах НЕ добавляй utility-exports — React Fast Refresh сделает full reload всего модуля`,
    ``,
    `После всех правок запусти: npm run check -- --pretty false`,
    ``,
    `\n${LOGGING_STANDARD_INLINE}`,
  ].filter(Boolean).join('\n');
}

function buildObsBatchRecommendationPrompt(recommendationType: string, catalog: ObservabilityCatalogItem[]): string {
  const isSuppressTask = recommendationType === 'suppress';
  const affected = catalog
    .filter(c => c.recommendation === recommendationType)
    .map(c => {
      const base = `- ${c.modulePath} (format: ${c.format}, level: ${c.level}, missing: ${c.missingFields.join(', ') || 'none'})`;
      if (isSuppressTask && c.noisyMessages && c.noisyMessages.length > 0) {
        const snippets = c.noisyMessages.slice(0, 3).map(m => `    • "${m}"`).join('\n');
        return `${base}\n${snippets}`;
      }
      return base;
    })
    .slice(0, 30);

  const actionMap: Record<string, string> = {
    'suppress': 'Удали или структурируй шумные INFO/DEBUG/TRACE логи (WARN/ERROR не трогать!)',
    'downgrade level': 'Понизь уровень только INFO-логов без ценности → debug. WARN/ERROR не трогать.',
    'enrich fields': 'Добавь недостающие обязательные поля в лог-вызовы каждого модуля',
    'add event': 'Добавь warn/error события в модули, где их нет',
  };

  return [
    `Batch-исправление: ${recommendationType} для ${affected.length} модулей.`,
    ``,
    isSuppressTask ? SUPPRESS_GUARD : '',
    ``,
    `Действие: ${actionMap[recommendationType] || recommendationType}`,
    ``,
    `Модули (с примерами шумных сообщений):\n${affected.join('\n')}`,
    ``,
    `Требования:`,
    `- Обработай каждый модуль из списка`,
    `- Для event_name используй формат <domain>.<entity>.<action>`,
    `- Для error_code используй допустимые коды из стандарта ниже`,
    ``,
    `\n${LOGGING_STANDARD_INLINE}`,
  ].filter(Boolean).join('\n');
}

function buildObsFixModulePrompt(modulePath: string, catalogItem: ObservabilityCatalogItem): string {
  const isSuppressRec = catalogItem.recommendation === 'suppress';
  const noisySnippets = (catalogItem.noisyMessages || []).slice(0, 6);

  const recActions: Record<string, string> = {
    'suppress': 'Удали или структурируй шумные INFO/DEBUG/TRACE логи (WARN/ERROR не трогать!)',
    'downgrade level': 'Понизь уровень только INFO-логов без ценности → debug. WARN/ERROR не трогать.',
    'enrich fields': 'Добавь недостающие обязательные поля',
    'add event': 'Добавь warn/error события для обработки ошибок',
  };

  return [
    `Исправь логирование в модуле \`${modulePath}\`.`,
    ``,
    `Текущее состояние:`,
    `- Формат: ${catalogItem.format}`,
    `- Уровень: ${catalogItem.level}`,
    `- Пропущенные поля: ${catalogItem.missingFields.length > 0 ? catalogItem.missingFields.join(', ') : 'нет'}`,
    `- Рекомендация: ${catalogItem.recommendation}`,
    ``,
    isSuppressRec ? SUPPRESS_GUARD : '',
    ``,
    `Что сделать:`,
    `- ${recActions[catalogItem.recommendation] || catalogItem.recommendation}`,
    isSuppressRec && noisySnippets.length > 0
      ? `- Конкретные шумные сообщения для поиска:\n${noisySnippets.map(m => `    • "${m}"`).join('\n')}`
      : '',
    catalogItem.missingFields.length > 0
      ? `- Добавь поля: ${catalogItem.missingFields.join(', ')}`
      : '',
    catalogItem.format !== 'structured'
      ? `- Переведи неструктурированные вызовы (console.log/console.error) в структурированный JSON через logger`
      : '',
    `- Именование event_name: <domain>.<entity>.<action> (lower_snake_case через точку)`,
    ``,
    `\n${LOGGING_STANDARD_INLINE}`,
  ].filter(Boolean).join('\n');
}

function buildObsFixSelectedPrompt(selectedItems: ObservabilityCatalogItem[], meta: Record<string, any>): string | null {
  const fieldName = meta.fieldName;
  const recommendationType = meta.recommendationType;

  // Filter out modules where the target field is already present — no work needed
  const items = fieldName
    ? selectedItems.filter(ci => ci.missingFields.includes(fieldName))
    : selectedItems;

  // All modules already compliant — signal caller to skip agent launch
  if (items.length === 0) {
    return null;
  }

  const isSuppressTask = recommendationType === 'suppress' ||
    items.every(ci => ci.recommendation === 'suppress');

  const moduleList = items.map(ci => {
    const mf = ci.missingFields.length > 0 ? ci.missingFields.join(', ') : 'нет';
    const snippets = (ci.noisyMessages || []).slice(0, 4);
    const snippetBlock = snippets.length > 0
      ? `\n  Шумные сообщения для удаления/структуризации:\n${snippets.map(m => `    • "${m}"`).join('\n')}`
      : '';
    return `- \`${ci.modulePath}\` (format: ${ci.format}, level: ${ci.level}, missing: ${mf})${snippetBlock}`;
  }).join('\n');

  let actionBlock: string;
  if (fieldName) {
    const fieldHints: Record<string, string> = {
      service: 'Имя сервиса. Берётся из конфига или env-переменной.',
      env: 'Среда (local|dev|stage|prod). Берётся из NODE_ENV.',
      trace_id: 'ID распределённого трейса. Из middleware или заголовка.',
      request_id: 'Сквозной ID запроса. Из заголовка X-Request-Id или middleware.',
      event_name: 'Доменное событие. Формат: <domain>.<entity>.<action>.',
      outcome: 'Результат: success|failure|partial.',
      error_code: 'Код ошибки из словаря. Обязателен для WARN/ERROR.',
      user_id: 'ID пользователя (user_id или user_hash). Из контекста auth.',
    };
    actionBlock = [
      `Задача: добавь поле \`${fieldName}\` во все лог-вызовы, где оно отсутствует.`,
      fieldHints[fieldName] ? `Описание поля: ${fieldHints[fieldName]}` : '',
      `Значение поля должно быть взято из контекста (request, config, env) — не хардкодь.`,
    ].filter(Boolean).join('\n');
  } else if (recommendationType === 'suppress') {
    actionBlock = [
      `Задача: убери шумные лог-вызовы уровня INFO/DEBUG/TRACE в каждом модуле.`,
      ``,
      SUPPRESS_GUARD,
      ``,
      `Для каждого шумного сообщения из списка ниже:`,
      `- УДАЛИ, если это lifecycle-мусор ("started", "done", "ok", "loaded", "ready")`,
      `- СТРУКТУРИРУЙ в logger.debug({ service, event_name, outcome, ...данные }), если несёт ценность`,
    ].join('\n');
  } else if (recommendationType) {
    const actionMap: Record<string, string> = {
      'downgrade level': 'Понизь уровень логирования (info→debug) только для INFO-логов без диагностической ценности. WARN/ERROR не трогать.',
      'enrich fields': 'Добавь недостающие обязательные поля в лог-вызовы',
      'add event': 'Добавь warn/error события для обработки ошибок',
    };
    actionBlock = `Задача: ${actionMap[recommendationType] || recommendationType} в каждом модуле из списка.`;
  } else {
    actionBlock = 'Исправь логирование в каждом модуле из списка согласно его рекомендации.';
  }

  return [
    `Исправь логирование в ${items.length} модулях.`,
    ``,
    actionBlock,
    ``,
    `Модули:\n${moduleList}`,
    ``,
    `Требования:`,
    `- Обработай каждый модуль из списка`,
    `- Для event_name используй формат <domain>.<entity>.<action> (lower_snake_case через точку)`,
    `- Для error_code используй допустимые коды из стандарта ниже (словарь logging-error-codes.json в этом проекте отсутствует)`,
    `- Переведи console.* вызовы в структурированный logger`,
    ``,
    `\n${LOGGING_STANDARD_INLINE}`,
  ].filter(Boolean).join('\n');
}

function buildE2ePlanPrompt(feat: FeatureResult, modules: ModuleInfo[]): string {
  const files = modules
    .filter(m => m.featureKeys.includes(feat.key) && m.type !== 'test' && !m.isInfra)
    .map(m => '- ' + m.relativePath.replace(/\\/g, '/'));
  return [
    `Ты — QA-инженер. Проанализируй исходный код фичи "${feat.label}" и составь подробный план E2E-тестирования.`,
    ``,
    `Файлы фичи:`,
    ...files,
    ``,
    `Прочитай эти файлы, изучи UI: формы, кнопки, навигацию, бизнес-логику.`,
    ``,
    `Верни ТОЛЬКО валидный JSON без markdown-блоков в формате:`,
    `{`,
    `  "baseUrl": "http://localhost:3000",`,
    `  "testCases": [`,
    `    {`,
    `      "id": "feature-key-01",`,
    `      "name": "Краткое название теста",`,
    `      "description": "Что проверяет тест",`,
    `      "steps": ["Шаг 1", "Шаг 2", "Шаг 3"],`,
    `      "expectedResults": ["Ожидаемый результат 1", "Ожидаемый результат 2"]`,
    `    }`,
    `  ]`,
    `}`,
    ``,
    `Требования:`,
    `- 5-15 тест-кейсов, покрывающих основные сценарии`,
    `- Каждый кейс: happy path, edge cases, обработка ошибок`,
    `- id: строчные буквы и цифры через дефис, уникальный`,
    `- Только JSON, без объяснений`,
  ].join('\n');
}

function buildWriteE2eTestPrompt(feat: FeatureResult, plan: E2ePlan, modules: ModuleInfo[]): string {
  const approvedCases = plan.testCases.filter(tc => tc.status === 'approved');
  const existingE2e = modules
    .filter(m => m.featureKeys.includes(feat.key) && (m.type as string) === 'e2e')
    .map(m => '- ' + m.relativePath.replace(/\\/g, '/'));
  return [
    `Напиши Playwright E2E тесты для фичи "${feat.label}".`,
    ``,
    `Approved тест-кейсы (${approvedCases.length}):`,
    ...approvedCases.map(tc => [
      `### ${tc.name} (id: ${tc.id})`,
      `${tc.description}`,
      `Шаги: ${tc.steps.join(' → ')}`,
      `Ожидается: ${tc.expectedResults.join('; ')}`,
    ].join('\n')),
    ``,
    existingE2e.length > 0 ? `Существующие E2E тесты (следуй паттернам):\n${existingE2e.join('\n')}` : '',
    ``,
    `Требования:`,
    `- Создай файлы в директории e2e/${feat.key}/`,
    `- Используй @playwright/test`,
    `- baseUrl: ${plan.baseUrl || 'http://localhost:3000'}`,
    `- После ключевых шагов добавь скриншоты: await page.screenshot({ path: '.viberadar/e2e-screenshots/${feat.key}/<testCaseId>/step-N.png' })`,
    `- Группируй по test case id (один файл на кейс или несколько кейсов в одном файле)`,
    `- Следуй существующим паттернам проекта`,
  ].filter(Boolean).join('\n');
}

// ─── Documentation prompt builders ───────────────────────────────────────────

function buildScreenshotInstructions(featureKey: string, routes: string[]): string {
  const screenshotDir = `docs/features/${featureKey}/screenshots`;
  return [
    ``,
    `Скриншоты интерфейса:`,
    `Перед написанием документации сделай скриншоты страниц.`,
    ``,
    `Маршруты для скриншотов (${routes.length}):`,
    ...routes.map(r => `- ${r}`),
    ``,
    `Инструкции:`,
    `1. Убедись что dev-сервер запущен (npm run dev, порт 5000). Если нет — запусти.`,
    `2. Залогинься через UI (credentials из .env: E2E_USER_EMAIL / E2E_USER_PASSWORD).`,
    `3. Для каждого маршрута:`,
    `   - Перейди на http://localhost:5000{route}`,
    `   - Дождись полной загрузки страницы`,
    `   - Сделай скриншот (полная страница)`,
    `   - Сохрани в: ${screenshotDir}/{route-name}.png`,
    `     Именование: /login → login.png, /forgot-password → forgot-password.png, / → index.png`,
    `4. Создай директорию ${screenshotDir}/ если её нет`,
    ``,
    `В документации:`,
    `- Вставляй скриншот сразу после заголовка раздела: ![Описание экрана](screenshots/{filename}.png)`,
    `- Под каждым скриншотом — курсивная подпись: *Экран входа в систему*`,
  ].join('\n');
}

function buildActualizeDocsPrompt(
  feat: FeatureResult,
  modules: ModuleInfo[],
  currentDoc: string | null,
  nextVersion: number,
  changedFiles: string[],
): string {
  const sourceFiles = modules
    .filter(m => m.featureKeys.includes(feat.key) && m.type !== 'test' && !m.isInfra)
    .map(m => '- ' + m.relativePath.replace(/\\/g, '/'));

  const isFirstVersion = nextVersion === 1;
  const outPath = `docs/features/${feat.key}/v${nextVersion}.md`;
  const screenshotBlock = feat.routes && feat.routes.length > 0
    ? buildScreenshotInstructions(feat.key, feat.routes)
    : '';

  if (isFirstVersion) {
    return [
      `Напиши пользовательскую документацию для фичи "${feat.label}".`,
      ``,
      feat.description ? `Описание фичи: ${feat.description}` : '',
      ``,
      `Файлы фичи (${sourceFiles.length}):`,
      ...sourceFiles,
      ``,
      `Задача:`,
      `1. Прочитай каждый файл фичи`,
      `2. Пойми, что пользователь может делать с этой фичей — какие экраны видит, какие действия совершает, какие сценарии проходит`,
      `3. Напиши документацию от лица пользователя в формате Markdown`,
      ``,
      `Структура документа:`,
      `# ${feat.label}`,
      `> одна строка — зачем это нужно пользователю`,
      ``,
      `## Содержание — список якорей на разделы`,
      ``,
      `Далее — разделы по каждому сценарию. Для каждого сценария:`,
      `- Заголовок = действие пользователя (например "Вход в систему", "Восстановление пароля")`,
      `- Пошаговые инструкции: что нажать, что ввести, что произойдёт`,
      `- Подразделы для разных веток поведения если есть`,
      `- Callout-блоки (> текст) для важных предупреждений`,
      ``,
      `В конце — раздел "Частые проблемы": таблица | Проблема | Что делать |`,
      screenshotBlock,
      ``,
      `Требования:`,
      `- Простой язык, без технических терминов и деталей реализации`,
      `- Не упоминать имена файлов, компонентов, API-эндпоинтов`,
      `- Описывать только то, что видит и делает пользователь`,
      `- Покрыть все сценарии включая ошибочные`,
      `- Запиши результат в: ${outPath}`,
      `- Создай директорию docs/features/${feat.key}/ если её нет`,
    ].filter(Boolean).join('\n');
  }

  return [
    `Актуализируй пользовательскую документацию для фичи "${feat.label}".`,
    ``,
    `Текущая версия документации (v${nextVersion - 1}):`,
    '```markdown',
    currentDoc,
    '```',
    ``,
    `Файлы фичи, изменившиеся с момента последней версии (${changedFiles.length}):`,
    ...changedFiles.map(f => '- ' + f.replace(/\\/g, '/')),
    ``,
    `Все файлы фичи (${sourceFiles.length}):`,
    ...sourceFiles,
    ``,
    `Задача:`,
    `1. Прочитай каждый изменившийся файл`,
    `2. Пойми, что изменилось с точки зрения пользователя — новые сценарии, изменилось поведение, убраны возможности`,
    `3. Возьми текущую версию документации за основу`,
    `4. Обнови только те разделы, которые устарели или требуют дополнений`,
    `5. Добавь новые разделы если появились новые сценарии`,
    `6. Удали разделы если соответствующие возможности убраны`,
    screenshotBlock,
    ``,
    `Требования:`,
    `- Не переписывай весь документ — меняй только то, что изменилось`,
    `- Сохрани структуру и стиль текущей версии`,
    `- Простой язык, без технических терминов`,
    `- Не упоминать имена файлов, компонентов, API-эндпоинтов`,
    `- Обнови скриншоты если экраны изменились`,
    `- Запиши результат как НОВЫЙ файл: ${outPath}`,
    `- Не удаляй и не изменяй предыдущую версию v${nextVersion - 1}`,
    `- Создай директорию docs/features/${feat.key}/ если её нет`,
  ].join('\n');
}

// ─── Main server ──────────────────────────────────────────────────────────────

export function startServer({ data: initialData, port, projectRoot }: ServerOptions): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {

    let currentData = initialData;
    const runtimeEnv = loadRuntimeEnv(projectRoot);
    process.stdout.write(
      `   ⚙️ Agent defaults: queue=${runtimeEnv.agentQueueMax}, cooldown=${runtimeEnv.agentCooldownMinMs}-${runtimeEnv.agentCooldownMaxMs}ms, codexSandbox=${runtimeEnv.codexSandboxMode}, autoFix=${runtimeEnv.autoFixFailedTests ? 'on' : 'off'}x${runtimeEnv.autoFixMaxRetries}\n`
    );
    if (runtimeEnv.envFilePath) {
      process.stdout.write(`   📄 Loaded env: ${runtimeEnv.envFilePath}\n`);
    }

    // ── State ──────────────────────────────────────────────────────────────────
    let agentRunning    = false;
    let testsRunning    = false;
    const agentQueue: AgentQueueItem[] = [];
    let queueCooldownTimer: ReturnType<typeof setTimeout> | null = null;
    let activeAgentProcess: ReturnType<typeof spawn> | null = null;
    const runs: RunRecord[] = [];
    const MAX_RUN_HISTORY = 120;
    let activeRunId: string | null = null;
    // Keyed by absolute file path → per-file failure details from last test run
    const lastTestResults = new Map<string, { failed: number; errors: TestFileError[] }>();

    // ── SSE clients ────────────────────────────────────────────────────────────
    const sseClients = new Set<http.ServerResponse>();

    function broadcast(event: string, payload: Record<string, unknown> = {}) {
      const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const client of sseClients) {
        try { client.write(msg); } catch { sseClients.delete(client); }
      }
    }

    function compactRunHistory() {
      if (runs.length <= MAX_RUN_HISTORY) return;
      runs.splice(0, runs.length - MAX_RUN_HISTORY);
    }

    function refreshQueuePositions() {
      const pos = new Map<string, number>();
      agentQueue.forEach((item, index) => pos.set(item.runId, index + 1));
      runs.forEach((run) => {
        run.queuePosition = pos.get(run.runId) ?? null;
      });
    }

    function queueSnapshotItem(item: AgentQueueItem, index: number) {
      return {
        runId: item.runId,
        title: item.title,
        task: item.task,
        featureKey: item.featureKey || null,
        filePath: item.filePath || null,
        selectedFilePaths: item.selectedFilePaths || null,
        selectedFileCount: item.selectedFilePaths?.length || 0,
        position: index + 1,
      };
    }

    function emitQueueUpdated() {
      refreshQueuePositions();
      const queue = agentQueue.map((item, index) => queueSnapshotItem(item, index));
      broadcast('agent-queue-updated', { queue });
    }

    function findRun(runId: string): RunRecord | undefined {
      return runs.find((r) => r.runId === runId);
    }

    function createRun(item: AgentQueueItem, phase: RunPhase): RunRecord {
      const now = new Date().toISOString();
      const run: RunRecord = {
        runId: item.runId,
        task: item.task,
        title: item.title,
        agent: item.agent,
        featureKey: item.featureKey,
        filePath: item.filePath,
        selectedFilePaths: item.selectedFilePaths,
        phase,
        queuePosition: null,
        createdAt: now,
      };
      runs.push(run);
      compactRunHistory();
      refreshQueuePositions();
      broadcast('agent-run-created', { run });
      return run;
    }

    function updateRun(runId: string, patch: Partial<RunRecord>) {
      const run = findRun(runId);
      if (!run) return;
      Object.assign(run, patch);
      refreshQueuePositions();
      broadcast('agent-run-updated', { run });
    }

    function setRunPhase(runId: string, phase: RunPhase, patch: Partial<RunRecord> = {}) {
      const nowIso = new Date().toISOString();
      const autoPatch: Partial<RunRecord> = {};
      if (phase === 'starting' && !findRun(runId)?.startedAt) autoPatch.startedAt = nowIso;
      if (phase === 'completed' || phase === 'failed' || phase === 'canceled') {
        autoPatch.finishedAt = nowIso;
      }
      updateRun(runId, { phase, ...autoPatch, ...patch });
      if (phase === 'running' || phase === 'starting' || phase === 'validating') {
        activeRunId = runId;
      }
      if (phase === 'completed' || phase === 'failed' || phase === 'canceled') {
        if (activeRunId === runId) activeRunId = null;
        const run = findRun(runId);
        if (run) broadcast('agent-run-finished', { run });
      }
    }

    function buildValidationStats(fileOutcomes: FileOutcome[]): ValidationStats {
      let covered = 0;
      let notCovered = 0;
      let blocked = 0;
      let infra = 0;
      for (const outcome of fileOutcomes) {
        if (outcome.status === 'covered') covered += 1;
        else if (outcome.status === 'not-covered') notCovered += 1;
        else if (outcome.status === 'blocked') blocked += 1;
        else if (outcome.status === 'infra') infra += 1;
      }
      return {
        total: fileOutcomes.length,
        covered,
        notCovered,
        blocked,
        infra,
      };
    }

    function buildFileOutcomes(targetSourcePaths: string[]): { fileOutcomes: FileOutcome[]; validationStats: ValidationStats } {
      const normalizeRelPath = (p: string) => p.replace(/\\/g, '/');
      const uniqueTargets = Array.from(new Set(targetSourcePaths.map(normalizeRelPath)));
      const srcByPath = new Map(
        currentData.modules
          .filter((m) => m.type !== 'test')
          .map((m) => [normalizeRelPath(m.relativePath), m] as const)
      );
      const fileOutcomes = uniqueTargets.map((relPath): FileOutcome => {
        const mod = srcByPath.get(relPath);
        if (!mod) {
          return {
            sourcePath: relPath,
            status: 'blocked',
            reason: 'source-file-not-found-after-rescan',
          };
        }
        if (mod.isInfra) {
          return {
            sourcePath: relPath,
            status: 'infra',
            reason: 'matched-infra-ignore-pattern',
          };
        }
        if (mod.hasTests) {
          return {
            sourcePath: relPath,
            status: 'covered',
            testFile: mod.testFile ? normalizeRelPath(mod.testFile) : undefined,
          };
        }
        return {
          sourcePath: relPath,
          status: 'not-covered',
          reason: 'scanner-did-not-link-test-file',
        };
      });
      return { fileOutcomes, validationStats: buildValidationStats(fileOutcomes) };
    }

    function moveQueueItem(runId: string, direction: 'up' | 'down'): { ok: true } | { ok: false; message: string } {
      const index = agentQueue.findIndex((item) => item.runId === runId);
      if (index === -1) return { ok: false, message: `Run ${runId} не найден в очереди` };
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= agentQueue.length) {
        return { ok: false, message: `Run ${runId} нельзя сдвинуть ${direction === 'up' ? 'вверх' : 'вниз'}` };
      }
      const [item] = agentQueue.splice(index, 1);
      agentQueue.splice(targetIndex, 0, item);
      emitQueueUpdated();
      return { ok: true };
    }

    function cancelQueuedRun(runId: string, reason = 'canceled-by-user'): { ok: true } | { ok: false; message: string } {
      const index = agentQueue.findIndex((item) => item.runId === runId);
      if (index === -1) return { ok: false, message: `Run ${runId} не найден в очереди` };
      const [item] = agentQueue.splice(index, 1);
      setRunPhase(item.runId, 'canceled', { error: reason });
      emitQueueUpdated();
      return { ok: true };
    }

    function enqueueItem(item: AgentQueueItem) {
      agentQueue.push(item);
      refreshQueuePositions();
      emitQueueUpdated();
    }

    function buildAgentStateSnapshot() {
      refreshQueuePositions();
      const queue = agentQueue.map((item, index) => queueSnapshotItem(item, index));
      const activeRun = activeRunId ? (findRun(activeRunId) || null) : null;
      return {
        activeRun,
        queue,
        runs: runs.slice(-50),
        runtimeFlags: {
          agentRunning,
          testsRunning,
          queueCooldownActive: !!queueCooldownTimer,
          queueMax: runtimeEnv.agentQueueMax,
          cooldownMinMs: runtimeEnv.agentCooldownMinMs,
          cooldownMaxMs: runtimeEnv.agentCooldownMaxMs,
          codexSandboxMode: runtimeEnv.codexSandboxMode,
          autoFixFailedTests: runtimeEnv.autoFixFailedTests,
          autoFixMaxRetries: runtimeEnv.autoFixMaxRetries,
        },
      };
    }

    function clearQueueCooldownTimer() {
      if (!queueCooldownTimer) return;
      clearTimeout(queueCooldownTimer);
      queueCooldownTimer = null;
    }

    function stopQueuedTasks(reason: string) {
      const dropped = agentQueue.length;
      clearQueueCooldownTimer();
      agentQueue.length = 0;
      process.stdout.write(`   ⛔ Queue stopped: ${reason} (dropped: ${dropped})\n`);
      broadcast('agent-output', { line: `⛔ Очередь остановлена: ${reason}`, isError: true });
      const nowIso = new Date().toISOString();
      runs.forEach((run) => {
        if (run.phase === 'queued') {
          run.phase = 'canceled';
          run.finishedAt = nowIso;
          run.error = reason;
          broadcast('agent-run-finished', { run });
        }
      });
      if (dropped > 0) {
        broadcast('agent-output', { line: `🗑 Отменено задач из очереди: ${dropped}` });
      }
      emitQueueUpdated();
      broadcast('agent-queue-stopped', { reason, dropped });
    }

    // ── File watcher + re-scan ─────────────────────────────────────────────────
    let scanDebounce: ReturnType<typeof setTimeout> | null = null;

    async function scheduleRescan(changedFile?: string) {
      if (scanDebounce) clearTimeout(scanDebounce);
      scanDebounce = setTimeout(async () => {
        try {
          const label = changedFile
            ? path.relative(projectRoot, changedFile).replace(/\\/g, '/')
            : '…';
          process.stdout.write(`\r   🔄 ${label} changed, rescanning...     `);
          currentData = await scanProject(projectRoot);
          process.stdout.write(
            `\r   ✅ ${currentData.modules.length} modules` +
            (currentData.features ? `, ${currentData.features.length} features` : '') +
            '          \n'
          );
          broadcast('data-updated');
        } catch (err: any) {
          console.error('\nRescan error:', err.message);
        }
      }, 600);
    }


    // ── Agent runner ───────────────────────────────────────────────────────────

    /** Execute next queued item, or broadcast agent-done if queue is empty */
    function processNextInQueue(withCooldown = false) {
      if (agentRunning) return;
      if (agentQueue.length > 0) {
        if (withCooldown) {
          clearQueueCooldownTimer();
          const delayMs = randomInt(runtimeEnv.agentCooldownMinMs, runtimeEnv.agentCooldownMaxMs);
          broadcast('agent-output', { line: `⏳ Пауза перед следующей задачей: ${Math.ceil(delayMs / 1000)}с` });
          queueCooldownTimer = setTimeout(() => {
            queueCooldownTimer = null;
            processNextInQueue(false);
          }, delayMs);
          return;
        }
        const next = agentQueue.shift()!;
        emitQueueUpdated();
        process.stdout.write(`   📋 Starting next from queue: "${next.title}" (remaining: ${agentQueue.length})\n`);
        broadcast('agent-output', { runId: next.runId, line: `📋 Следующая задача из очереди: ${next.title}` });
        broadcast('agent-output', { runId: next.runId, line: `   В очереди осталось: ${agentQueue.length}` });
        executeAgentItem(next);
      } else {
        clearQueueCooldownTimer();
        broadcast('agent-done', { queueLength: 0 });
      }
    }

    /** Actually spawn the agent process for a queue item */
    function executeAgentItem(item: AgentQueueItem) {
      const {
        runId, task, featureKey, filePath, selectedFilePaths, title, agent, savedErrors, savedFailedFiles, savedTestType,
        autoFixAttempt = 0, autoFixSourceTask,
      } = item;
      const normalizeRelPath = (p: string) => p.replace(/\\/g, '/');
      const emitOutput = (line: string, isError = false, isDim = false) => {
        broadcast('agent-output', { runId, line, isError, isDim });
      };
      const targetSourcePaths = (() => {
        if (task === 'write-tests-file' && filePath) {
          return [normalizeRelPath(filePath)];
        }
        if ((task === 'write-tests-selected' || task === 'refresh-tests-selected') && Array.isArray(selectedFilePaths)) {
          return Array.from(new Set(selectedFilePaths.map(normalizeRelPath)));
        }
        if (task === 'write-tests' && featureKey) {
          return currentData.modules
            .filter((m) => m.featureKeys.includes(featureKey) && m.type !== 'test' && !m.hasTests && !m.isInfra)
            .map((m) => normalizeRelPath(m.relativePath));
        }
        return [] as string[];
      })();

      setRunPhase(runId, 'starting', {
        targetSourcePaths,
        error: undefined,
        fileOutcomes: undefined,
        validationStats: undefined,
      });

      function failBeforeStart(message: string) {
        setRunPhase(runId, 'failed', { error: message, targetSourcePaths });
        broadcast('agent-error', { runId, message });
        agentRunning = false;
        processNextInQueue();
      }

      // Build prompt lazily at execution time
      let prompt: string;
      if (task === 'write-tests') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat) {
          failBeforeStart(`Фича не найдена: ${featureKey}`);
          return;
        }
        prompt = buildWriteTestsPrompt(feat, currentData.modules, currentData.testRunner || 'vitest');
      } else if (task === 'write-tests-file') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat || !filePath) {
          failBeforeStart('Не указана фича или файл');
          return;
        }
        prompt = buildWriteTestsForFilePrompt(filePath, feat, currentData.modules, currentData.testRunner || 'vitest');
      } else if (task === 'write-tests-selected') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat || !selectedFilePaths || selectedFilePaths.length === 0) {
          failBeforeStart('Не указана фича или выбранные файлы');
          return;
        }
        prompt = buildWriteTestsForSelectedPrompt(selectedFilePaths, feat, currentData.modules, currentData.testRunner || 'vitest');
      } else if (task === 'refresh-tests-selected') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat || !selectedFilePaths || selectedFilePaths.length === 0) {
          failBeforeStart('Не указана фича или выбранные файлы');
          return;
        }
        prompt = buildRefreshTestsForSelectedPrompt(selectedFilePaths, feat, currentData.modules, currentData.testRunner || 'vitest');
      } else if (task === 'fix-tests') {
        if (!filePath || !savedErrors || savedErrors.length === 0) {
          failBeforeStart(`Нет сохранённых ошибок для ${filePath}`);
          return;
        }
        prompt = buildFixTestsPrompt(filePath, savedErrors);
      } else if (task === 'fix-tests-all') {
        if (!savedFailedFiles || savedFailedFiles.length === 0) {
          failBeforeStart('Нет упавших тестов для исправления');
          return;
        }
        prompt = buildFixAllTestsPrompt(savedFailedFiles, savedTestType || 'unit');
      } else if (task === 'generate-e2e-plan') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat) {
          failBeforeStart(`Фича не найдена: ${featureKey}`);
          return;
        }
        prompt = buildE2ePlanPrompt(feat, currentData.modules);
      } else if (task === 'write-e2e-tests') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        const plan = featureKey ? loadE2ePlan(projectRoot, featureKey) : null;
        if (!feat || !plan) {
          failBeforeStart(`Фича или план не найдены: ${featureKey}`);
          return;
        }
        prompt = buildWriteE2eTestPrompt(feat, plan, currentData.modules);
      } else if (task === 'obs-suppress-pattern') {
        const obs = currentData.observability;
        if (!obs || !item.meta?.pattern) { failBeforeStart('Нет данных observability или паттерн не указан'); return; }
        prompt = buildObsSuppressPatternPrompt(item.meta.pattern, item.meta.recommendation || 'suppress', obs.catalog);
      } else if (task === 'obs-add-critical-logs') {
        const obs = currentData.observability;
        if (!obs || !item.meta?.modulePath) { failBeforeStart('Нет данных observability или модуль не указан'); return; }
        const v2Item = (obs.missingCriticalLogsV2 || []).find(
          (m: MissingCriticalLogItem) => m.modulePath === item.meta!.modulePath
        );
        prompt = v2Item
          ? buildObsAddCriticalLogsPromptV2(v2Item, obs.catalog)
          : buildObsAddCriticalLogsPrompt(item.meta.modulePath, obs.catalog);
      } else if (task === 'obs-enrich-field') {
        const obs = currentData.observability;
        if (!obs || !item.meta?.fieldName) { failBeforeStart('Нет данных observability или поле не указано'); return; }
        prompt = buildObsEnrichFieldPrompt(item.meta.fieldName, obs.catalog);
      } else if (task === 'obs-batch-recommendation') {
        const obs = currentData.observability;
        if (!obs || !item.meta?.recommendationType) { failBeforeStart('Нет данных observability или тип рекомендации не указан'); return; }
        prompt = buildObsBatchRecommendationPrompt(item.meta.recommendationType, obs.catalog);
      } else if (task === 'obs-fix-module') {
        const obs = currentData.observability;
        const idx = item.meta?.catalogIndex;
        const catalogItem = typeof idx === 'number' ? obs?.catalog[idx] : null;
        if (!obs || !catalogItem) { failBeforeStart('Нет данных observability или модуль не найден в каталоге'); return; }
        prompt = buildObsFixModulePrompt(catalogItem.modulePath, catalogItem);
      } else if (task === 'obs-fix-selected') {
        const obs = currentData.observability;
        const missingLogIndices: number[] = Array.isArray(item.meta?.missingLogIndices) ? item.meta.missingLogIndices : [];
        const indices: number[] = Array.isArray(item.meta?.catalogIndices) ? item.meta.catalogIndices : [];

        if (missingLogIndices.length > 0 && obs?.missingCriticalLogsV2) {
          // V2 batch: add critical logs to selected modules with failure points
          const selectedV2 = missingLogIndices
            .map(i => obs.missingCriticalLogsV2[i])
            .filter(Boolean);
          if (selectedV2.length === 0) { failBeforeStart('Выбранные модули не найдены'); return; }
          prompt = buildObsBatchAddCriticalLogsPrompt(selectedV2, obs.catalog);
        } else if (indices.length > 0 && obs) {
          // Existing catalog-based flow
          const selectedItems = indices.map(i => obs.catalog[i]).filter(Boolean);
          if (selectedItems.length === 0) { failBeforeStart('Выбранные модули не найдены в каталоге'); return; }
          const builtPrompt = buildObsFixSelectedPrompt(selectedItems, item.meta || {});
          if (builtPrompt === null) { failBeforeStart('Все выбранные модули уже соответствуют стандарту — нечего исправлять'); return; }
          prompt = builtPrompt;
        } else {
          failBeforeStart('Нет данных observability или модули не выбраны'); return;
        }
      } else if (task === 'actualize-docs') {
        if (!featureKey || !currentData.features) { failBeforeStart('Фича не найдена'); return; }
        const feat = currentData.features.find(f => f.key === featureKey);
        if (!feat) { failBeforeStart(`Фича ${featureKey} не найдена`); return; }
        const docStatus = currentData.documentation?.features.find(f => f.key === featureKey);
        const latestVersion = docStatus?.latestVersion ?? null;
        const nextVersion = (latestVersion ?? 0) + 1;
        let currentDoc: string | null = null;
        if (latestVersion !== null) {
          try {
            currentDoc = fs.readFileSync(
              path.join(projectRoot, 'docs', 'features', featureKey, `v${latestVersion}.md`),
              'utf-8'
            );
          } catch {}
        }
        const changedFiles = docStatus?.changedFilesSinceDoc || [];
        prompt = buildActualizeDocsPrompt(feat, currentData.modules, currentDoc, nextVersion, changedFiles);
      } else if (task === 'classify-orphan-tests') {
        const batch = item.meta?.batch ?? 0;
        const built = buildClassifyOrphanTestsPrompt(currentData.modules, currentData.features || [], projectRoot, batch);
        if (!built) { failBeforeStart('Нет тестов без фичи для этого пакета'); return; }
        prompt = built;
      } else if (task === 'link-orphan-tests') {
        const batch = item.meta?.batch ?? 0;
        const built = buildLinkOrphanTestsPrompt(currentData.modules, batch);
        if (!built) { failBeforeStart('Нет тестов без исходника для этого пакета'); return; }
        prompt = built;
      } else {
        prompt = buildMapUnmappedPrompt(currentData.modules, currentData.features || []);
      }

      agentRunning = true;
      setRunPhase(runId, 'running', { targetSourcePaths });
      broadcast('agent-started', {
        runId,
        title,
        task,
        featureKey,
        filePath: filePath || null,
        selectedFilePaths: selectedFilePaths || null,
        queueLength: agentQueue.length,
      });
      process.stdout.write(`   🤖 Running agent (${agent}): ${task}\n`);

      // Write prompt to .viberadar/task.md for reference
      const taskDir  = path.join(projectRoot, '.viberadar');
      const taskFile = path.join(taskDir, 'task.md');
      try {
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(taskFile, prompt, 'utf-8');
      } catch {}

      // Snapshot dirty files BEFORE agent runs (to detect agent-made changes later)
      const dirtyBeforeAgent = runtimeEnv.autoStage ? getGitDirtyFiles(projectRoot) : new Set<string>();

      // Spawn via shell, reading prompt from file
      if (agent === 'codex') patchCodexConfig();
      const shellCmd = buildAgentShellCmd(agent, taskFile, runtimeEnv.codexSandboxMode, (currentData as any).model);
      process.stdout.write(`   🚀 Shell cmd: ${shellCmd}\n`);
      const proc = spawn(shellCmd, [], {
        cwd: projectRoot,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildAgentSpawnEnv(agent),
      });
      activeAgentProcess = proc;
      emitOutput(`🚀 Запускаю: ${agent === 'claude' ? 'Claude Code' : 'Codex'}`);
      if (agent === 'codex') {
        emitOutput(`🔐 Codex sandbox: ${runtimeEnv.codexSandboxMode}`);
      }
      emitOutput('📄 Задача записана в .viberadar/task.md');

      // Track test files written/edited by agent (for auto-run after)
      const createdTestFiles: string[] = [];
      // Accumulate full result text for E2E plan parsing
      let agentResultText = '';
      let agentRawOutputText = '';
      let queueBlockSignal: 403 | 429 | null = null;
      let finalFileOutcomes: FileOutcome[] = [];
      let finalValidationStats: ValidationStats = buildValidationStats([]);
      let validationError: string | undefined;
      let lastTestResult: TestRunResult | null = null;
      let lastTestSummary: {
        testedFileCount: number;
        passedFileCount: number;
        failedFileCount: number;
        autoFixQueued: boolean;
      } | null = null;

      function inspectQueueBlockSignal(line: string) {
        if (queueBlockSignal !== null) return;
        const signal = detectQueueBlockSignal(line);
        if (signal !== null) {
          queueBlockSignal = signal;
          emitOutput(`⚠️ Обнаружен блокирующий сигнал ${signal}. После завершения текущей задачи очередь будет остановлена.`, true);
        }
      }

      function trackWrittenFiles(raw: string) {
        try {
          const ev = JSON.parse(raw);
          const blocks = ev.type === 'assistant'
            ? (ev.message?.content ?? [])
            : ev.type === 'tool_use' ? [ev] : [];
          for (const b of blocks) {
            if ((b.name === 'Write' || b.name === 'Edit') && b.input?.file_path) {
              const fp: string = b.input.file_path;
              if (TEST_FILE_RE.test(fp) && !createdTestFiles.includes(fp)) {
                createdTestFiles.push(fp);
              }
            }
          }
        } catch {}
      }

      // Stream stdout — parse Claude stream-json events into readable lines
      const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
      rl.on('line', (raw: string) => {
        if (!raw.trim()) return;
        if (task === 'generate-e2e-plan') {
          agentRawOutputText += raw + '\n';
        }
        inspectQueueBlockSignal(raw);
        trackWrittenFiles(raw);
        const parsed = agent === 'claude' ? parseClaudeEvent(raw) : raw;
        if (!parsed) {
          emitOutput(raw.slice(0, 120), false, true);
          return;
        }
        if (parsed.startsWith('§RESULT§')) {
          agentResultText = parsed.slice('§RESULT§'.length).trim();
          emitOutput('─────────────────────────────');
          for (const l of agentResultText.split('\n')) {
            if (l.trim()) emitOutput('  ' + l);
          }
        } else {
          for (const l of parsed.split('\n')) {
            if (l.trim()) emitOutput(l);
          }
        }
      });

      // Stderr — show as-is (warnings, errors from the CLI)
      proc.stderr!.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          if (task === 'generate-e2e-plan') {
            agentRawOutputText += line + '\n';
          }
          inspectQueueBlockSignal(line);
          emitOutput(line, true);
        }
      });

      proc.on('close', async (code) => {
        agentRunning = false;
        activeAgentProcess = null;
        const alreadyCanceled = findRun(runId)?.phase === 'canceled';
        if (alreadyCanceled) {
          process.stdout.write(`   ⏹ Agent process closed for canceled run ${runId}\n`);
          processNextInQueue(true);
          return;
        }
        let finalPhase: RunPhase = 'completed';
        let finalError: string | undefined;
        let autoFixQueued = false;

        if (code === 0) {
          // Auto-run created/fixed test files and show results
          let testFilesToRun: string[];
          if (task === 'fix-tests-all') {
            testFilesToRun = [...lastTestResults.keys()];
          } else if (task === 'fix-tests' && filePath) {
            testFilesToRun = [filePath];
          } else {
            testFilesToRun = createdTestFiles;
          }
          if ((task === 'write-tests' || task === 'write-tests-file' || task === 'write-tests-selected' || task === 'refresh-tests-selected' || task === 'fix-tests' || task === 'fix-tests-all') && testFilesToRun.length > 0) {
            setRunPhase(runId, 'validating', { targetSourcePaths });
            emitOutput('─────────────────────────────');
            emitOutput(`🧪 Запускаю тесты (${testFilesToRun.length} файлов)...`);
            const result = await runTestFiles(testFilesToRun, projectRoot);
            lastTestResult = result;

            lastTestResults.clear();
            for (const [fp, detail] of Object.entries(result.fileDetails)) {
              if (detail.failed > 0) lastTestResults.set(path.resolve(fp), { failed: detail.failed, errors: detail.errors });
            }

            const failedFiles = Object.entries(result.fileDetails)
              .filter(([, detail]) => detail.failed > 0)
              .map(([fp, detail]) => ({
                abs: path.resolve(fp),
                rel: path.relative(projectRoot, fp).replace(/\\/g, '/'),
                detail,
              }));
            const testedFileCount = testFilesToRun.length;
            const failedFileCount = failedFiles.length;
            const passedFileCount = Math.max(0, testedFileCount - failedFileCount);

            emitOutput('┌──────────────── Тест-отчёт ────────────────');
            if (result.runError) {
              emitOutput(`│ ❌ Ошибка запуска тестов: ${result.runError}`);
              finalPhase = 'failed';
              finalError = `Ошибка запуска тестов: ${result.runError}`;
            } else {
              const status = result.failed === 0 ? '✅ OK' : '❌ FAILED';
              emitOutput(`│ Статус: ${status}`);
              emitOutput(`│ Файлы: ${testedFileCount}  •  passed: ${passedFileCount}  •  failed: ${failedFileCount}`);
              emitOutput(`│ Тест-кейсы: passed ${result.passed}  •  failed ${result.failed}`);
            }
            emitOutput('└─────────────────────────────────────────────');

            if (result.failed > 0) {
              for (const f of failedFiles) {
                emitOutput(`  ❌ ${f.rel} — ${f.detail.failed} упало`);
                for (const e of f.detail.errors.slice(0, 3)) {
                  emitOutput(`     • ${e.testName}`, false, true);
                }
              }
            }

            if (!result.runError && result.failed > 0) {
              const nextAttempt = autoFixAttempt + 1;
              const sourceTask = autoFixSourceTask || task;
              const canAutoFix = runtimeEnv.autoFixFailedTests && nextAttempt <= runtimeEnv.autoFixMaxRetries;

              if (canAutoFix) {
                let fixItem: AgentQueueItem | null = null;
                const attemptSuffix = `(${nextAttempt}/${runtimeEnv.autoFixMaxRetries})`;
                if (failedFiles.length === 1) {
                  const only = failedFiles[0];
                  const fileName = only.rel.split('/').pop() || only.rel;
                  fixItem = {
                    runId: newRunId(),
                    task: 'fix-tests',
                    featureKey,
                    filePath: only.rel,
                    title: `${agent === 'claude' ? 'Claude Code' : 'Codex'} — автоисправление "${fileName}" ${attemptSuffix}`,
                    agent,
                    savedErrors: only.detail.errors,
                    autoFixAttempt: nextAttempt,
                    autoFixSourceTask: sourceTask,
                  };
                } else if (failedFiles.length > 1) {
                  fixItem = {
                    runId: newRunId(),
                    task: 'fix-tests-all',
                    featureKey,
                    title: `${agent === 'claude' ? 'Claude Code' : 'Codex'} — автоисправление ${failedFiles.length} тестов ${attemptSuffix}`,
                    agent,
                    savedFailedFiles: failedFiles.map(f => ({ filePath: f.rel, errors: f.detail.errors })),
                    savedTestType: savedTestType || 'unit',
                    autoFixAttempt: nextAttempt,
                    autoFixSourceTask: sourceTask,
                  };
                }

                if (fixItem) {
                  if (agentQueue.length < runtimeEnv.agentQueueMax) {
                    createRun(fixItem, 'queued');
                    agentQueue.unshift(fixItem);
                    emitQueueUpdated();
                    autoFixQueued = true;
                    emitOutput(`🛠️ Обнаружены падения. Запускаю автоисправление ${attemptSuffix}...`);
                    broadcast('agent-queued', {
                      runId: fixItem.runId,
                      queueLength: agentQueue.length,
                      title: fixItem.title,
                      task: fixItem.task,
                      featureKey: fixItem.featureKey || null,
                      filePath: fixItem.filePath || null,
                      selectedFilePaths: fixItem.selectedFilePaths || null,
                    });
                  } else {
                    emitOutput(`⚠️ Автоисправление не поставлено: очередь заполнена (${runtimeEnv.agentQueueMax})`, true);
                  }
                }
              } else {
                const reason = !runtimeEnv.autoFixFailedTests
                  ? 'автоисправление выключено'
                  : `достигнут лимит попыток (${runtimeEnv.autoFixMaxRetries})`;
                emitOutput(`⚠️ Автоисправление не запущено: ${reason}`);
              }
            }

            if (result.failed > 0 && !autoFixQueued) {
              emitOutput('  → Нажми 🔧 исправить в дашборде чтобы агент починил');
              finalPhase = 'failed';
              if (!finalError) finalError = 'Есть упавшие тесты';
            }
            if (result.failed > 0 && autoFixQueued && finalPhase !== 'failed') {
              finalPhase = 'completed';
            }

            lastTestSummary = { testedFileCount, passedFileCount, failedFileCount, autoFixQueued };
          }

          // E2E plan post-processing
          if (task === 'generate-e2e-plan' && featureKey) {
            try {
              const rawPlanOutput = agentResultText.trim().length > 0 ? agentResultText : agentRawOutputText;
              const parsedPlan = parseE2ePlanFromAgentOutput(rawPlanOutput);
              const feat = currentData.features?.find(f => f.key === featureKey);
              const plan: E2ePlan = {
                featureKey,
                featureLabel: feat?.label || featureKey,
                generatedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                baseUrl: parsedPlan.baseUrl,
                testCases: parsedPlan.testCases.map((tc) => ({ ...tc, status: 'pending' as const })),
              };
              saveE2ePlan(projectRoot, plan);
              broadcast('e2e-plan-ready', { featureKey, plan });
            } catch (err: any) {
              const blockHint = queueBlockSignal
                ? ` Возможная причина: блокировка/лимит агента (${queueBlockSignal}).`
                : '';
              broadcast('e2e-plan-error', {
                runId,
                featureKey,
                message: `Не удалось распарсить план: ${err.message}.${blockHint}`.trim(),
              });
              finalPhase = 'failed';
              finalError = `Не удалось распарсить E2E план: ${err.message}`;
            }
          }

          if (task === 'write-e2e-tests' && featureKey) {
            const plan = loadE2ePlan(projectRoot, featureKey);
            if (plan) {
              for (const tc of plan.testCases) {
                if (tc.status === 'approved') tc.status = 'written';
              }
              saveE2ePlan(projectRoot, plan);
              broadcast('e2e-tests-written', { featureKey, files: createdTestFiles });
            }
          }

          process.stdout.write('   ✅ Agent done, rescanning...\n');

          // Auto-stage: stage only files the agent changed (not user's pre-existing changes)
          if (runtimeEnv.autoStage) {
            const dirtyAfterAgent = getGitDirtyFiles(projectRoot);
            const stagedCount = stageAgentChanges(projectRoot, dirtyBeforeAgent, dirtyAfterAgent);
            if (stagedCount > 0) {
              emitOutput(`📦 Auto-staged ${stagedCount} file${stagedCount > 1 ? 's' : ''} (staged = agent changes, unstaged = yours)`);
              process.stdout.write(`   📦 Auto-staged ${stagedCount} agent-changed file(s)\n`);
            }
          }

          try {
            if (targetSourcePaths.length > 0) {
              setRunPhase(runId, 'validating', { targetSourcePaths });
            }
            currentData = await scanProject(projectRoot);
            if (targetSourcePaths.length > 0) {
              const matrix = buildFileOutcomes(targetSourcePaths);
              finalFileOutcomes = matrix.fileOutcomes;
              finalValidationStats = matrix.validationStats;
              const unresolved = finalFileOutcomes.filter((o) => o.status === 'not-covered');
              const blocked = finalFileOutcomes.filter((o) => o.status === 'blocked');
              if (unresolved.length > 0 || blocked.length > 0) {
                emitOutput(`⚠️ После задачи осталось без тестов: ${unresolved.length}/${targetSourcePaths.length} файлов`, true);
                unresolved.slice(0, 20).forEach((entry) => {
                  emitOutput(`   • ${entry.sourcePath}${entry.reason ? ` — ${entry.reason}` : ''}`, true);
                });
                if (blocked.length > 0) {
                  emitOutput(`⚠️ Заблокированные/несопоставленные файлы: ${blocked.length}`, true);
                  blocked.slice(0, 10).forEach((entry) => {
                    emitOutput(`   • ${entry.sourcePath}${entry.reason ? ` — ${entry.reason}` : ''}`, true);
                  });
                }
                finalPhase = 'failed';
                if (!finalError) {
                  finalError = `Валидация покрытия: covered=${finalValidationStats.covered}, not-covered=${finalValidationStats.notCovered}, blocked=${finalValidationStats.blocked}, infra=${finalValidationStats.infra}`;
                }
              } else {
                emitOutput(`✅ Проверка: все ${targetSourcePaths.length} целевых файлов теперь отмечены как с тестами`);
              }
            }
            broadcast('data-updated');
          } catch (err: any) {
            validationError = err?.message || String(err);
            finalPhase = 'failed';
            finalError = `Ошибка валидации после rescan: ${validationError}`;
            emitOutput(`❌ Не удалось выполнить валидацию после задачи: ${validationError}`, true);
          }

          if (targetSourcePaths.length > 0) {
            broadcast('agent-summary', {
              runId,
              targetSourcePaths,
              fileOutcomes: finalFileOutcomes,
              validationStats: finalValidationStats,
              ...(lastTestResult || {}),
              ...(lastTestSummary || {}),
            });
          }
          setRunPhase(runId, finalPhase, {
            targetSourcePaths,
            fileOutcomes: finalFileOutcomes,
            validationStats: finalValidationStats,
            error: finalError,
          });
          processNextInQueue(true);
        } else if (code === 255) {
          process.stdout.write(`   ❌ Agent auth error (exit code 255)\n`);
          const message = `${agent === 'claude' ? 'Claude Code' : 'Codex'} не авторизован. Нажми 🔑 Перелогиниться в меню агента.`;
          setRunPhase(runId, 'failed', { targetSourcePaths, error: message });
          broadcast('agent-error', {
            runId,
            message,
            authRequired: true,
            agent,
          });
          processNextInQueue(true);
        } else {
          process.stdout.write(`   ❌ Agent failed (exit code ${code})\n`);
          const message = `Агент завершился с кодом ${code}`;
          setRunPhase(runId, 'failed', { targetSourcePaths, error: message });
          broadcast('agent-error', { runId, message });
          if (queueBlockSignal === 403 || queueBlockSignal === 429) {
            stopQueuedTasks(`пойман ${queueBlockSignal} от ${agent === 'claude' ? 'Claude Code' : 'Codex'}`);
          }
          processNextInQueue(true);
        }
      });

      proc.on('error', (err: any) => {
        agentRunning = false;
        activeAgentProcess = null;
        if (findRun(runId)?.phase === 'canceled') {
          processNextInQueue(true);
          return;
        }
        const isNotFound = err.code === 'ENOENT' || err.message.includes('ENOENT');
        const agentName = agent === 'claude' ? 'Claude Code' : 'Codex';
        const msg = isNotFound
          ? `${agentName} не установлен. Скачай с ${agent === 'claude' ? 'claude.ai/download' : 'github.com/openai/codex'}`
          : `Не удалось запустить ${agent}: ${err.message}`;
        process.stdout.write('   ❌ Agent spawn error: ' + err.message + '\n');
        setRunPhase(runId, 'failed', { targetSourcePaths, error: msg });
        broadcast('agent-error', { runId, message: msg, notInstalled: isNotFound, agent });
        processNextInQueue(true);
      });
    }

    /** Validate task params and enqueue (prompt is built lazily at execution time) */
    function runAgent(task: string, featureKey?: string, filePath?: string, selectedFilePaths?: string[], meta?: Record<string, any>): string | null {
      const agent = currentData.agent;
      if (!agent) {
        broadcast('agent-error', { message: 'Агент не выбран. Укажи agent в viberadar.config.json' });
        return null;
      }

      const agentLabel = agent === 'claude' ? 'Claude Code' : 'Codex';
      let title: string;
      let savedErrors: TestFileError[] | undefined;
      let savedFailedFiles: Array<{ filePath: string; errors: TestFileError[] }> | undefined;
      let savedTestType: string | undefined;

      if (task === 'write-tests') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat) { broadcast('agent-error', { message: `Фича не найдена: ${featureKey}` }); return null; }
        title = `${agentLabel} — тесты для "${feat.label}"`;
      } else if (task === 'write-tests-file') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat || !filePath) { broadcast('agent-error', { message: 'Не указана фича или файл' }); return null; }
        const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
        title = `${agentLabel} — тест для "${fileName}"`;
      } else if (task === 'write-tests-selected') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        const count = selectedFilePaths?.length ?? 0;
        if (!feat || count === 0) { broadcast('agent-error', { message: 'Не указана фича или выбранные файлы' }); return null; }
        title = `${agentLabel} — тесты для выбранных файлов (${count})`;
      } else if (task === 'refresh-tests-selected') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        const count = selectedFilePaths?.length ?? 0;
        if (!feat || count === 0) { broadcast('agent-error', { message: 'Не указана фича или выбранные файлы' }); return null; }
        title = `${agentLabel} — актуализировать тесты (${count})`;
      } else if (task === 'fix-tests') {
        if (!filePath) { broadcast('agent-error', { message: 'Не указан файл для исправления' }); return null; }
        for (const [fp, detail] of lastTestResults) {
          const rel = path.relative(projectRoot, fp).replace(/\\/g, '/');
          if (rel === filePath.replace(/\\/g, '/') || fp === filePath) { savedErrors = detail.errors; break; }
        }
        if (!savedErrors || savedErrors.length === 0) {
          broadcast('agent-error', { message: `Нет сохранённых ошибок для ${filePath}. Сначала запусти тесты.` }); return null;
        }
        const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
        title = `${agentLabel} — исправить тесты в "${fileName}"`;
      } else if (task === 'fix-tests-all') {
        savedTestType = filePath || 'unit'; // filePath param is reused for testType in this case
        savedFailedFiles = [];
        for (const [fp, detail] of lastTestResults) {
          const rel = path.relative(projectRoot, fp).replace(/\\/g, '/');
          const mod = currentData.modules.find(m => m.relativePath.replace(/\\/g, '/') === rel && m.testType === savedTestType);
          if (mod && detail.errors.length > 0) {
            savedFailedFiles.push({ filePath: rel, errors: detail.errors });
          }
        }
        if (savedFailedFiles.length === 0) {
          broadcast('agent-error', { message: `Нет упавших ${savedTestType} тестов. Сначала запусти тесты.` }); return null;
        }
        title = `${agentLabel} — починить все ${savedTestType} тесты (${savedFailedFiles.length} файлов)`;
      } else if (task === 'generate-e2e-plan') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat) { broadcast('agent-error', { message: `Фича не найдена: ${featureKey}` }); return null; }
        title = `${agentLabel} — E2E план для "${feat.label}"`;
      } else if (task === 'write-e2e-tests') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat) { broadcast('agent-error', { message: `Фича не найдена: ${featureKey}` }); return null; }
        title = `${agentLabel} — пишу E2E тесты для "${feat.label}"`;
      } else if (task === 'obs-suppress-pattern') {
        const pattern = meta?.pattern || 'unknown';
        title = `${agentLabel} — исправить шумный паттерн "${String(pattern).slice(0, 40)}"`;
      } else if (task === 'obs-add-critical-logs') {
        const modulePath = meta?.modulePath || 'unknown';
        title = `${agentLabel} — добавить критичные логи в "${modulePath}"`;
      } else if (task === 'obs-enrich-field') {
        const fieldName = meta?.fieldName || 'unknown';
        title = `${agentLabel} — обогатить поле "${fieldName}"`;
      } else if (task === 'obs-batch-recommendation') {
        const recType = meta?.recommendationType || 'unknown';
        title = `${agentLabel} — исправить все (${recType})`;
      } else if (task === 'obs-fix-module') {
        const idx = meta?.catalogIndex;
        const catItem = typeof idx === 'number' ? currentData.observability?.catalog[idx] : null;
        const modName = catItem?.modulePath || 'unknown';
        title = `${agentLabel} — исправить логи в "${modName}"`;
      } else if (task === 'obs-fix-selected') {
        const count = Array.isArray(meta?.catalogIndices) ? meta.catalogIndices.length : 0;
        const label = meta?.fieldName ? `поле ${meta.fieldName}` : meta?.recommendationType || 'логи';
        title = `${agentLabel} — ${label} (${count} модулей)`;
      } else if (task === 'classify-orphan-tests') {
        const orphanCount = getOrphanTests(currentData.modules).noFeature.length;
        if (orphanCount === 0) {
          broadcast('agent-error', { message: 'Нет тестов без привязки к фичам' }); return null;
        }
        const batch = meta?.batch ?? 0;
        const totalBatches = Math.ceil(orphanCount / CLASSIFY_BATCH_SIZE);
        title = `${agentLabel} — привязать тесты к фичам (${batch + 1}/${totalBatches})`;
      } else if (task === 'link-orphan-tests') {
        const orphanCount = getOrphanTests(currentData.modules).noSource.length;
        if (orphanCount === 0) {
          broadcast('agent-error', { message: 'Нет тестов без привязки к исходникам' }); return null;
        }
        const batch = meta?.batch ?? 0;
        const totalBatches = Math.ceil(orphanCount / LINK_BATCH_SIZE);
        title = `${agentLabel} — связать тесты с исходниками (${batch + 1}/${totalBatches})`;
      } else {
        title = `${agentLabel} — разобрать unmapped`;
      }

      const item: AgentQueueItem = {
        runId: newRunId(),
        task,
        featureKey,
        filePath,
        selectedFilePaths,
        title,
        agent,
        savedErrors,
        savedFailedFiles,
        savedTestType,
        meta,
      };
      createRun(item, 'queued');

      if (agentRunning || queueCooldownTimer) {
        if (agentQueue.length >= runtimeEnv.agentQueueMax) {
          setRunPhase(item.runId, 'failed', { error: `Очередь переполнена (${runtimeEnv.agentQueueMax})` });
          const msg = `Очередь агента ограничена (${runtimeEnv.agentQueueMax}). Дождись завершения текущих задач.`;
          broadcast('agent-error', { runId: item.runId, message: msg });
          process.stdout.write(`   ⚠️ Queue limit reached (${runtimeEnv.agentQueueMax}), rejected: "${title}"\n`);
          return item.runId;
        }
        enqueueItem(item);
        const ql = agentQueue.length;
        process.stdout.write(`   📋 Agent busy, queued: "${title}" (queue size: ${ql})\n`);
        broadcast('agent-queued', {
          runId: item.runId,
          queueLength: ql,
          title,
          task,
          featureKey: featureKey || null,
          filePath: filePath || null,
          selectedFilePaths: selectedFilePaths || null,
        });
        return item.runId;
      }

      executeAgentItem(item);
      return item.runId;
    }

    // ── Chokidar watcher ───────────────────────────────────────────────────────
    chokidar.watch([
      '**/*.{ts,tsx,js,jsx,vue,svelte}',
      'viberadar.config.json',
      'docs/features/*/*.md',
    ], {
      cwd: projectRoot,
      ignored: [
        '**/node_modules/**', '**/dist/**', '**/.git/**',
        '**/coverage/**',    '**/.next/**', '**/.turbo/**',
      ],
      ignoreInitial: true,
      persistent: true,
    })
      .on('add',    f => scheduleRescan(path.join(projectRoot, f)))
      .on('change', f => scheduleRescan(path.join(projectRoot, f)))
      .on('unlink', f => scheduleRescan(path.join(projectRoot, f)));

    // ── HTTP server ────────────────────────────────────────────────────────────
    const server = http.createServer((req, res) => {
      const rawUrl = req.url ?? '/';
      const parsedUrl = new URL(rawUrl, 'http://127.0.0.1');
      const url = parsedUrl.pathname;

      if (url === '/' || url === '/radar/qa' || url === '/radar/observability' || url === '/radar/docs' || url === '/radar/services') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
        return;
      }

      if (url === '/api/data') {
        // Include per-file test errors from last test run (keyed by relative path)
        const testErrors: Record<string, { failed: number; errors: TestFileError[] }> = {};
        for (const [fp, detail] of lastTestResults) {
          const rel = path.relative(projectRoot, fp).replace(/\\/g, '/');
          testErrors[rel] = detail;
        }
        // Check which features have E2E plans
        const e2ePlansExist: Record<string, boolean> = {};
        try {
          const planDir = e2ePlanDir(projectRoot);
          if (fs.existsSync(planDir)) {
            for (const f of fs.readdirSync(planDir)) {
              if (f.endsWith('.json')) e2ePlansExist[f.replace('.json', '')] = true;
            }
          }
        } catch {}
        const agentRuntime = {
          codexSandboxMode: runtimeEnv.codexSandboxMode,
          approvalPolicy: runtimeEnv.approvalPolicy,
          queueMax: runtimeEnv.agentQueueMax,
          cooldownMinMs: runtimeEnv.agentCooldownMinMs,
          cooldownMaxMs: runtimeEnv.agentCooldownMaxMs,
          autoFixFailedTests: runtimeEnv.autoFixFailedTests,
          autoFixMaxRetries: runtimeEnv.autoFixMaxRetries,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...currentData, testErrors, hasPlaywright: hasPlaywright(projectRoot), e2ePlansExist, agentRuntime }));
        return;
      }

      if (url === '/api/service-map' && req.method === 'GET') {
        const format = parsedUrl.searchParams.get('format') || 'json';
        const sm = currentData?.serviceMap;
        if (!sm) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ nodes: [], edges: [], pipelines: [], autodiscovery: { dockerServices: 0, envConnections: 0, npmServices: 0, workerFiles: 0 } }));
          return;
        }
        if (format === 'markdown') {
          let md = `# Service Map: ${currentData?.projectName || 'Project'}\n\n`;
          md += `## Services (${sm.nodes.length})\n\n`;
          md += `| Service | Category | Host | Port | Source |\n|---------|----------|------|------|--------|\n`;
          for (const n of sm.nodes) {
            md += `| ${n.icon || ''} ${n.label} | ${n.category} | ${n.host || '-'} | ${n.port || '-'} | ${n.source} |\n`;
          }
          if (sm.edges.length > 0) {
            md += `\n## Dependencies (${sm.edges.length})\n\n`;
            md += `| From | To | Type | Label | Critical |\n|------|----|------|-------|----------|\n`;
            for (const e of sm.edges) {
              md += `| ${e.from} | ${e.to} | ${e.type} | ${e.label || '-'} | ${e.critical ? 'YES' : '-'} |\n`;
            }
          }
          if (sm.pipelines.length > 0) {
            md += `\n## Pipelines (${sm.pipelines.length})\n\n`;
            for (const p of sm.pipelines) {
              md += `### ${p.label}\n`;
              if (p.description) md += `${p.description}\n`;
              if (p.triggers?.length) md += `**Triggers:** ${p.triggers.join(', ')}\n`;
              md += `\n**Steps:**\n`;
              for (let i = 0; i < p.steps.length; i++) {
                const s = p.steps[i];
                md += `${i + 1}. ${s.label}${s.serviceId ? ` → ${s.serviceId}` : ''}\n`;
              }
              md += '\n';
            }
          }
          if (sm.nodes.some(n => n.alerts?.length)) {
            md += `\n## Alert Hints\n\n`;
            md += `| Service | Metric | Severity | Description |\n|---------|--------|----------|-------------|\n`;
            for (const n of sm.nodes) {
              for (const a of (n.alerts || [])) {
                md += `| ${n.label} | ${a.metric} | ${a.severity} | ${a.description} |\n`;
              }
            }
          }
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
          res.end(md);
          return;
        }
        if (format === 'prometheus') {
          let rules = `# Prometheus alerting rules generated by VibeRadar\n# Project: ${currentData?.projectName || 'Project'}\n\ngroups:\n  - name: viberadar_service_alerts\n    rules:\n`;
          for (const n of sm.nodes) {
            for (const a of (n.alerts || [])) {
              const severity = a.severity === 'critical' ? 'critical' : a.severity === 'warning' ? 'warning' : 'info';
              rules += `      - alert: ${n.id}_${a.metric.replace(/[^a-zA-Z0-9_]/g, '_')}\n`;
              rules += `        expr: ${a.metric}\n`;
              rules += `        for: 5m\n`;
              rules += `        labels:\n          severity: ${severity}\n          service: ${n.id}\n`;
              rules += `        annotations:\n          summary: "${a.description}"\n`;
            }
          }
          res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8' });
          res.end(rules);
          return;
        }
        // Default: JSON
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sm, null, 2));
        return;
      }

      if (url === '/api/rescan' && req.method === 'POST') {
        // Return immediately so the UI doesn't hang on large projects
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'scanning' }));
        // Scan in background, then broadcast data-updated via SSE
        (async () => {
          try {
            currentData = await scanProject(projectRoot);
            broadcast('data-updated');
          } catch (err: any) {
            console.error('Rescan error:', err.message);
            broadcast('rescan-error', { error: err.message });
          }
        })();
        return;
      }

      if (url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          agentRunning,
          queueLength: agentQueue.length,
          activeRunId,
          queueCooldownActive: !!queueCooldownTimer,
        }));
        return;
      }

      if (url === '/api/agent/state' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(buildAgentStateSnapshot()));
        return;
      }

      const queueCancelMatch = url.match(/^\/api\/queue\/([^/]+)\/cancel$/);
      if (queueCancelMatch && req.method === 'POST') {
        const runId = decodeURIComponent(queueCancelMatch[1]);
        const result = cancelQueuedRun(runId, 'canceled-by-user');
        if (!result.ok) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: result.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state: buildAgentStateSnapshot() }));
        return;
      }

      const queueRetryMatch = url.match(/^\/api\/queue\/([^/]+)\/retry$/);
      if (queueRetryMatch && req.method === 'POST') {
        const runId = decodeURIComponent(queueRetryMatch[1]);
        const existing = findRun(runId);
        if (!existing) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `Run ${runId} не найден` }));
          return;
        }
        if (existing.task === 'fix-tests' || existing.task === 'fix-tests-all') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: `Retry для ${existing.task} недоступен: нет сохраненного контекста ошибок`,
          }));
          return;
        }
        const retriedItem: AgentQueueItem = {
          runId: newRunId(),
          task: existing.task,
          featureKey: existing.featureKey,
          filePath: existing.filePath,
          selectedFilePaths: existing.selectedFilePaths,
          title: `${existing.title} (retry)`,
          agent: existing.agent,
        };
        createRun(retriedItem, 'queued');
        enqueueItem(retriedItem);
        broadcast('agent-queued', {
          runId: retriedItem.runId,
          queueLength: agentQueue.length,
          title: retriedItem.title,
          task: retriedItem.task,
          featureKey: retriedItem.featureKey || null,
          filePath: retriedItem.filePath || null,
          selectedFilePaths: retriedItem.selectedFilePaths || null,
        });
        if (!agentRunning && !queueCooldownTimer) {
          processNextInQueue(false);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, runId: retriedItem.runId, state: buildAgentStateSnapshot() }));
        return;
      }

      const queueReorderMatch = url.match(/^\/api\/queue\/([^/]+)\/reorder$/);
      if (queueReorderMatch && req.method === 'POST') {
        const runId = decodeURIComponent(queueReorderMatch[1]);
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          let direction: 'up' | 'down' = 'up';
          try {
            const parsed = JSON.parse(body || '{}');
            if (parsed?.direction === 'down') direction = 'down';
          } catch {}
          const result = moveQueueItem(runId, direction);
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: result.message }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, state: buildAgentStateSnapshot() }));
        });
        return;
      }

      if (url === '/api/run-all-tests' && req.method === 'POST') {
        if (testsRunning) {
          res.writeHead(409); res.end(JSON.stringify({ error: 'Tests already running' })); return;
        }
        const allTestFiles = (currentData.modules || [])
          .filter(m => m.type === 'test' && m.testType !== 'e2e')
          .map(m => m.path);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: allTestFiles.length }));

        if (allTestFiles.length === 0) {
          broadcast('tests-started', { featureKey: null, testType: 'all', count: 0 });
          broadcast('agent-output', { line: 'Нет unit/integration тест-файлов в проекте' });
          broadcast('tests-done', { passed: 0, failed: 0 });
          return;
        }

        testsRunning = true;
        broadcast('tests-started', { featureKey: null, testType: 'all', count: allTestFiles.length });
        broadcast('agent-output', { line: `🧪 Запускаю все тесты (${allTestFiles.length} файлов)…` });
        process.stdout.write(`   🧪 run-all-tests: ×${allTestFiles.length}\n`);

        runTestFiles(allTestFiles, projectRoot).then(result => {
          testsRunning = false;
          lastTestResults.clear();
          for (const [fp, detail] of Object.entries(result.fileDetails)) {
            if (detail.failed > 0) lastTestResults.set(path.resolve(fp), { failed: detail.failed, errors: detail.errors });
          }
          const summary = result.runError
            ? `❌ Тесты не запустились: ${result.runError}`
            : result.failed === 0
              ? `✅ Все тесты прошли: ${result.passed} passed`
              : `⚠️  ${result.passed} passed, ${result.failed} failed`;
          broadcast('agent-output', { line: summary });
          if (result.failed > 0) {
            for (const [fp, detail] of Object.entries(result.fileDetails)) {
              if (detail.failed > 0) {
                const rel = path.relative(projectRoot, fp).replace(/\\/g, '/');
                broadcast('agent-output', { line: `  ❌ ${rel} — ${detail.failed} упало` });
                for (const e of detail.errors.slice(0, 2)) {
                  broadcast('agent-output', { line: `     • ${e.testName}`, isDim: true });
                }
              }
            }
          }
          const testErrorsForClient: Record<string, { failed: number; errors: TestFileError[] }> = {};
          for (const [fp, detail] of lastTestResults) {
            testErrorsForClient[path.relative(projectRoot, fp).replace(/\\/g, '/')] = detail;
          }
          broadcast('tests-done', { passed: result.passed, failed: result.failed, testErrors: testErrorsForClient });
        });
        return;
      }

      if (url === '/api/run-tests' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', async () => {
          if (testsRunning) {
            res.writeHead(409); res.end(JSON.stringify({ error: 'Tests already running' })); return;
          }
          try {
            const { featureKey, testType } = JSON.parse(body);
            const testFiles = (currentData.modules || [])
              .filter(m => m.type === 'test' && m.testType === testType && m.featureKeys?.includes(featureKey))
              .map(m => m.path);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, count: testFiles.length }));

            if (testFiles.length === 0) {
              broadcast('tests-started', { featureKey, testType, count: 0 });
              broadcast('agent-output', { line: `Нет ${testType} тест-файлов для этой фичи` });
              broadcast('tests-done', { passed: 0, failed: 0 });
              return;
            }

            testsRunning = true;
            broadcast('tests-started', { featureKey, testType, count: testFiles.length });
            broadcast('agent-output', { line: `🧪 Запускаю ${testType} тесты (${testFiles.length} файлов)…` });
            process.stdout.write(`   🧪 run-tests: ${testType} ×${testFiles.length}\n`);

            const result = await runTestFiles(testFiles, projectRoot);
            testsRunning = false;

            // Store per-file errors (normalize paths for Windows forward-slash compat)
            lastTestResults.clear();
            for (const [fp, detail] of Object.entries(result.fileDetails)) {
              if (detail.failed > 0) lastTestResults.set(path.resolve(fp), { failed: detail.failed, errors: detail.errors });
            }

            const summary = result.failed === 0
              ? `✅ Все тесты прошли: ${result.passed} passed`
              : `⚠️  ${result.passed} passed, ${result.failed} failed`;
            broadcast('agent-output', { line: summary });
            if (result.failed > 0) {
              for (const [fp, detail] of Object.entries(result.fileDetails)) {
                if (detail.failed > 0) {
                  const rel = path.relative(projectRoot, fp).replace(/\\/g, '/');
                  broadcast('agent-output', { line: `  ❌ ${rel} — ${detail.failed} упало` });
                  for (const e of detail.errors.slice(0, 3)) {
                    broadcast('agent-output', { line: `     • ${e.testName}`, isDim: true });
                  }
                }
              }
                broadcast('agent-output', { line: '  → Нажми Починить рядом с файлом чтобы агент исправил' });
            }
            // Send testErrors directly in event — avoids path/timing issues with /api/data fetch
            const testErrorsForClient: Record<string, { failed: number; errors: TestFileError[] }> = {};
            for (const [fp, detail] of lastTestResults) {
              const rel = path.relative(projectRoot, fp).replace(/\\/g, '/');
              testErrorsForClient[rel] = detail;
            }
            const errKeys = Object.keys(testErrorsForClient);
            process.stdout.write(`   🔍 testErrors to client: ${errKeys.length} keys: ${errKeys.slice(0, 3).join(', ')}\n`);
            if (result.failed > 0 && errKeys.length === 0) {
              broadcast('agent-output', { line: `⚠️ Есть ${result.failed} упавших теста, но детали по файлам не получены — проверь viberadar лог`, isDim: true });
            }
            broadcast('tests-done', { passed: result.passed, failed: result.failed, testErrors: testErrorsForClient });
          } catch (err: any) {
            testsRunning = false;
            res.writeHead(400); res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (url === '/api/run-agent' && req.method === 'POST') {
        process.stdout.write('   📥 /api/run-agent received\n');
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { task, featureKey, filePath, selectedFilePaths, meta } = JSON.parse(body);
            process.stdout.write(`   📥 run-agent: task=${task} featureKey=${featureKey} filePath=${filePath} selected=${Array.isArray(selectedFilePaths) ? selectedFilePaths.length : 0} meta=${meta ? 'yes' : 'no'}\n`);
            const runId = runAgent(task, featureKey, filePath, selectedFilePaths, meta);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, runId }));
          } catch (err: any) {
            process.stdout.write(`   ❌ run-agent parse error: ${err.message}\n`);
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (url === '/api/agent-reauth' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        const agent = currentData.agent || 'codex';
        const emit = (line: string, isError = false) => broadcast('agent-output', { runId: null, line, isError });
        const done = () => broadcast('agent-done', { queueLength: 0 });
        emit(`🔑 Перелогинивание ${agent === 'claude' ? 'Claude Code' : 'Codex'}…`);
        const logoutCmd = WIN
          ? (agent === 'claude' ? 'claude.cmd logout' : 'codex.cmd logout')
          : (agent === 'claude' ? 'claude logout' : 'codex logout');
        const loginCmd = WIN
          ? (agent === 'claude' ? 'claude.cmd' : 'codex.cmd login')
          : (agent === 'claude' ? 'claude' : 'codex login');
        emit(`   → ${logoutCmd}`);
        const logout = spawn(logoutCmd, [], { shell: true, cwd: projectRoot });
        logout.stdout.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l: string) => emit('  ' + l)));
        logout.stderr.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l: string) => emit('  ' + l, true)));
        logout.on('close', () => {
          emit(`   → ${loginCmd}`);
          emit('   Сейчас откроется браузер для авторизации…');
          const login = spawn(loginCmd, [], { shell: true, cwd: projectRoot, detached: false });
          login.stdout.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l: string) => emit('  ' + l)));
          login.stderr.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l: string) => emit('  ' + l, true)));
          login.on('close', (code: number | null) => {
            if (code === 0) emit('✅ Авторизация успешна!');
            else emit(`⚠️ Завершено с кодом ${code}`, true);
            done();
          });
        });
        return;
      }

      if (url === '/api/cancel-agent' && req.method === 'POST') {
        const nowReason = 'canceled-by-user';
        if (activeRunId) {
          setRunPhase(activeRunId, 'canceled', { error: nowReason });
        }
        for (const q of agentQueue) {
          setRunPhase(q.runId, 'canceled', { error: nowReason });
        }
        agentRunning = false;
        if (activeAgentProcess) {
          try { activeAgentProcess.kill('SIGTERM'); } catch {}
          activeAgentProcess = null;
        }
        agentQueue.length = 0; // clear queue too
        clearQueueCooldownTimer();
        emitQueueUpdated();
        process.stdout.write('   ⏹ Agent state reset by user (queue cleared)\n');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state: buildAgentStateSnapshot() }));
        return;
      }

      if (url === '/api/clear-queue' && req.method === 'POST') {
        const cleared = agentQueue.length;
        for (const q of agentQueue) {
          setRunPhase(q.runId, 'canceled', { error: 'queue-cleared-by-user' });
        }
        agentQueue.length = 0;
        clearQueueCooldownTimer();
        emitQueueUpdated();
        process.stdout.write(`   🗑 Queue cleared (${cleared} items)\n`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cleared, state: buildAgentStateSnapshot() }));
        return;
      }

      if (url === '/api/set-agent' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { agent } = JSON.parse(body);
            const configPath = path.join(projectRoot, 'viberadar.config.json');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            config.agent = agent;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
            scheduleRescan();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, agent }));
          } catch (err: any) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // Server-Sent Events endpoint
      if (url === '/api/events') {
        res.writeHead(200, {
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection':    'keep-alive',
        });
        res.write('data: connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      // ── E2E routes ─────────────────────────────────────────────────────────

      if (url === '/api/e2e/generate-plan' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { featureKey } = JSON.parse(body);
            broadcast('e2e-plan-generating', { featureKey });
            const runId = runAgent('generate-e2e-plan', featureKey);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, runId }));
          } catch (err: any) {
            res.writeHead(400); res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      const planMatch = url.match(/^\/api\/e2e\/plan\/(.+)$/);
      if (planMatch && req.method === 'GET') {
        const featureKey = decodeURIComponent(planMatch[1]);
        const plan = loadE2ePlan(projectRoot, featureKey);
        if (!plan) { res.writeHead(404); res.end(JSON.stringify({ error: 'Plan not found' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(plan));
        return;
      }

      if (url === '/api/e2e/review' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { featureKey, testCaseId, status } = JSON.parse(body);
            const plan = loadE2ePlan(projectRoot, featureKey);
            if (!plan) { res.writeHead(404); res.end(JSON.stringify({ error: 'Plan not found' })); return; }
            const tc = plan.testCases.find(t => t.id === testCaseId);
            if (tc) tc.status = status;
            saveE2ePlan(projectRoot, plan);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, plan }));
          } catch (err: any) {
            res.writeHead(400); res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (url === '/api/e2e/review-all' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { featureKey, status } = JSON.parse(body);
            const plan = loadE2ePlan(projectRoot, featureKey);
            if (!plan) { res.writeHead(404); res.end(JSON.stringify({ error: 'Plan not found' })); return; }
            for (const tc of plan.testCases) tc.status = status;
            saveE2ePlan(projectRoot, plan);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, plan }));
          } catch (err: any) {
            res.writeHead(400); res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (url === '/api/e2e/write-tests' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { featureKey } = JSON.parse(body);
            broadcast('e2e-tests-writing', { featureKey });
            const runId = runAgent('write-e2e-tests', featureKey);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, runId }));
          } catch (err: any) {
            res.writeHead(400); res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (url === '/api/e2e/run-tests' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', async () => {
          try {
            const { featureKey } = JSON.parse(body);
            const plan = loadE2ePlan(projectRoot, featureKey);
            if (!plan) { res.writeHead(404); res.end(JSON.stringify({ error: 'Plan not found' })); return; }
            const writtenCases = plan.testCases.filter(tc => ['written', 'passed', 'failed'].includes(tc.status));
            const testFiles = writtenCases
              .map(tc => tc.testFilePath)
              .filter((f): f is string => !!f)
              .map(f => path.isAbsolute(f) ? f : path.join(projectRoot, f));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, count: testFiles.length }));

            broadcast('e2e-tests-running', { featureKey, count: testFiles.length });
            const result = await runPlaywrightTests(testFiles.length > 0 ? testFiles : [`e2e/${featureKey}`], projectRoot);

            // Update plan with results
            for (const tc of plan.testCases) {
              if (result.results[tc.name]) {
                tc.status = result.results[tc.name];
                if (result.errors[tc.name]) tc.lastError = result.errors[tc.name];
              }
              tc.screenshotPaths = collectScreenshots(projectRoot, featureKey, tc.id);
            }
            saveE2ePlan(projectRoot, plan);
            broadcast('e2e-tests-done', { featureKey, passed: result.passed, failed: result.failed, plan });
          } catch (err: any) {
            res.writeHead(400); res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // Serve doc screenshots: /api/docs/screenshot/{featureKey}/{filename}
      if (url.startsWith('/api/docs/screenshot/') && req.method === 'GET') {
        const relPath = decodeURIComponent(url.slice('/api/docs/screenshot/'.length));
        const screenshotBase = path.join(projectRoot, 'docs', 'features');
        const safePath = path.resolve(screenshotBase, relPath);
        if (!safePath.startsWith(screenshotBase)) {
          res.writeHead(403); res.end('Forbidden'); return;
        }
        try {
          const img = fs.readFileSync(safePath);
          const ext = path.extname(safePath).toLowerCase();
          const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/webp';
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=300' });
          res.end(img);
        } catch {
          res.writeHead(404); res.end('Not found');
        }
        return;
      }

      if (url.startsWith('/api/e2e/screenshot/') && req.method === 'GET') {
        const relPath = decodeURIComponent(url.slice('/api/e2e/screenshot/'.length));
        // Path traversal protection
        const screenshotBase = path.join(projectRoot, '.viberadar', 'e2e-screenshots');
        const safePath = path.resolve(screenshotBase, relPath);
        if (!safePath.startsWith(screenshotBase)) {
          res.writeHead(403); res.end('Forbidden'); return;
        }
        try {
          const img = fs.readFileSync(safePath);
          const ext = path.extname(safePath).toLowerCase();
          const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/webp';
          res.writeHead(200, { 'Content-Type': mime });
          res.end(img);
        } catch {
          res.writeHead(404); res.end('Not found');
        }
        return;
      }

      // ── Documentation API ─────────────────────────────────────────────────────
      if (url === '/api/docs/content' && req.method === 'GET') {
        const featureKey = parsedUrl.searchParams.get('feature');
        if (!featureKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing feature param' }));
          return;
        }
        // Versioned docs: find latest vN.md in docs/features/{key}/
        const docDir = path.join(projectRoot, 'docs', 'features', featureKey);
        try {
          const entries = fs.readdirSync(docDir);
          const versions = entries
            .map(e => { const m = e.match(/^v(\d+)\.md$/); return m ? { file: e, n: parseInt(m[1], 10) } : null; })
            .filter((x): x is { file: string; n: number } => x !== null)
            .sort((a, b) => b.n - a.n);
          if (versions.length === 0) throw new Error('no versions');
          const content = fs.readFileSync(path.join(docDir, versions[0].file), 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ content, exists: true, version: versions[0].n }));
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ content: null, exists: false }));
        }
        return;
      }

      if (url === '/api/docs/save' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { featureKey, content } = JSON.parse(body);
            if (!featureKey || typeof content !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing featureKey or content' }));
              return;
            }
            const docsDir = path.join(projectRoot, 'docs', 'features');
            fs.mkdirSync(docsDir, { recursive: true });
            fs.writeFileSync(path.join(docsDir, `${featureKey}.md`), content, 'utf-8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Is VibeRadar already running?`));
      } else {
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1', () => resolve({ server }));

    process.once('SIGINT', () => {
      console.log('\n👋 VibeRadar stopped.');
      // Destroy all SSE connections so server.close() doesn't hang waiting for them
      for (const client of sseClients) {
        try { client.destroy(); } catch {}
      }
      sseClients.clear();
      server.close(() => process.exit(0));
      // Force exit after 500ms in case something is still hanging
      setTimeout(() => process.exit(0), 500).unref();
    });
  });
}
