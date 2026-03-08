import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as readline from 'readline';
import chokidar from 'chokidar';
import { ScanResult, ModuleInfo, FeatureResult, scanProject } from '../scanner';

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
    envFilePath: fs.existsSync(envPath) ? envPath : null,
  };
}

function randomInt(min: number, max: number): number {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
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
 * Build shell command that pipes task file into the agent CLI.
 * --output-format stream-json gives real-time events (tool calls, writes, etc.)
 * File piping avoids TUI mode in Claude Code v2+.
 */
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
    `Требования:`,
    `- Работай только с выбранными файлами из списка`,
    `- Если теста нет — создай`,
    `- Если тест устарел — обнови`,
    `- Для unit файлов мокай внешние зависимости`,
    `- Для integration файлов используй test-helpers или pg-mem`,
    `- Используй ${testRunner}`,
    `- Следуй текущим паттернам тестов в проекте`,
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
    `Для каждого выбранного файла:`,
    `1) Проверь актуальность и качество тестов.`,
    `2) Дополни недостающие сценарии (happy path, edge cases, ошибки).`,
    `3) Если тест отсутствует — создай новый.`,
    `4) Не меняй source-код без крайней необходимости; фокус на тестах.`,
    `5) Используй ${testRunner} и паттерны проекта.`,
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
    `- После исправления запусти тест, чтобы убедиться что он проходит`,
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
    `- После исправления каждого файла запусти его тесты, чтобы убедиться что проходят`,
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
      if (dropped > 0) {
        broadcast('agent-output', { line: `🗑 Отменено задач из очереди: ${dropped}` });
      }
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
        process.stdout.write(`   📋 Starting next from queue: "${next.title}" (remaining: ${agentQueue.length})\n`);
        broadcast('agent-output', { line: `📋 Следующая задача из очереди: ${next.title}` });
        broadcast('agent-output', { line: `   В очереди осталось: ${agentQueue.length}` });
        executeAgentItem(next);
      } else {
        clearQueueCooldownTimer();
        broadcast('agent-done', { queueLength: 0 });
      }
    }

    /** Actually spawn the agent process for a queue item */
    function executeAgentItem(item: AgentQueueItem) {
      const {
        task, featureKey, filePath, selectedFilePaths, title, agent, savedErrors, savedFailedFiles, savedTestType,
        autoFixAttempt = 0, autoFixSourceTask,
      } = item;

      // Build prompt lazily at execution time
      let prompt: string;
      if (task === 'write-tests') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat) {
          broadcast('agent-error', { message: `Фича не найдена: ${featureKey}` });
          agentRunning = false; processNextInQueue(); return;
        }
        prompt = buildWriteTestsPrompt(feat, currentData.modules, currentData.testRunner || 'vitest');
      } else if (task === 'write-tests-file') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat || !filePath) {
          broadcast('agent-error', { message: 'Не указана фича или файл' });
          agentRunning = false; processNextInQueue(); return;
        }
        prompt = buildWriteTestsForFilePrompt(filePath, feat, currentData.modules, currentData.testRunner || 'vitest');
      } else if (task === 'write-tests-selected') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat || !selectedFilePaths || selectedFilePaths.length === 0) {
          broadcast('agent-error', { message: 'Не указана фича или выбранные файлы' });
          agentRunning = false; processNextInQueue(); return;
        }
        prompt = buildWriteTestsForSelectedPrompt(selectedFilePaths, feat, currentData.modules, currentData.testRunner || 'vitest');
      } else if (task === 'refresh-tests-selected') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat || !selectedFilePaths || selectedFilePaths.length === 0) {
          broadcast('agent-error', { message: 'Не указана фича или выбранные файлы' });
          agentRunning = false; processNextInQueue(); return;
        }
        prompt = buildRefreshTestsForSelectedPrompt(selectedFilePaths, feat, currentData.modules, currentData.testRunner || 'vitest');
      } else if (task === 'fix-tests') {
        if (!filePath || !savedErrors || savedErrors.length === 0) {
          broadcast('agent-error', { message: `Нет сохранённых ошибок для ${filePath}` });
          agentRunning = false; processNextInQueue(); return;
        }
        prompt = buildFixTestsPrompt(filePath, savedErrors);
      } else if (task === 'fix-tests-all') {
        if (!savedFailedFiles || savedFailedFiles.length === 0) {
          broadcast('agent-error', { message: 'Нет упавших тестов для исправления' });
          agentRunning = false; processNextInQueue(); return;
        }
        prompt = buildFixAllTestsPrompt(savedFailedFiles, savedTestType || 'unit');
      } else if (task === 'generate-e2e-plan') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat) {
          broadcast('agent-error', { message: `Фича не найдена: ${featureKey}` });
          agentRunning = false; processNextInQueue(); return;
        }
        prompt = buildE2ePlanPrompt(feat, currentData.modules);
      } else if (task === 'write-e2e-tests') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        const plan = featureKey ? loadE2ePlan(projectRoot, featureKey) : null;
        if (!feat || !plan) {
          broadcast('agent-error', { message: `Фича или план не найдены: ${featureKey}` });
          agentRunning = false; processNextInQueue(); return;
        }
        prompt = buildWriteE2eTestPrompt(feat, plan, currentData.modules);
      } else {
        prompt = buildMapUnmappedPrompt(currentData.modules, currentData.features || []);
      }

      agentRunning = true;
      broadcast('agent-started', {
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

      // Spawn via shell, reading prompt from file
      const shellCmd = buildAgentShellCmd(agent, taskFile, runtimeEnv.codexSandboxMode, (currentData as any).model);
      process.stdout.write(`   🚀 Shell cmd: ${shellCmd}\n`);
      const proc = spawn(shellCmd, [], {
        cwd: projectRoot,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      broadcast('agent-output', { line: `🚀 Запускаю: ${agent === 'claude' ? 'Claude Code' : 'Codex'}` });
      if (agent === 'codex') {
        broadcast('agent-output', { line: `🔐 Codex sandbox: ${runtimeEnv.codexSandboxMode}` });
      }
      broadcast('agent-output', { line: `📄 Задача записана в .viberadar/task.md` });

      // Track test files written/edited by agent (for auto-run after)
      const createdTestFiles: string[] = [];
      // Accumulate full result text for E2E plan parsing
      let agentResultText = '';
      let queueBlockSignal: 403 | 429 | null = null;

      function inspectQueueBlockSignal(line: string) {
        if (queueBlockSignal !== null) return;
        const signal = detectQueueBlockSignal(line);
        if (signal !== null) {
          queueBlockSignal = signal;
          broadcast('agent-output', {
            line: `⚠️ Обнаружен блокирующий сигнал ${signal}. После завершения текущей задачи очередь будет остановлена.`,
            isError: true,
          });
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
        inspectQueueBlockSignal(raw);
        trackWrittenFiles(raw);
        const parsed = agent === 'claude' ? parseClaudeEvent(raw) : raw;
        if (!parsed) {
          broadcast('agent-output', { line: raw.slice(0, 120), isDim: true });
          return;
        }
        if (parsed.startsWith('§RESULT§')) {
          agentResultText = parsed.slice('§RESULT§'.length).trim();
          broadcast('agent-output', { line: '─────────────────────────────' });
          for (const l of agentResultText.split('\n')) {
            if (l.trim()) broadcast('agent-output', { line: '  ' + l });
          }
        } else {
          for (const l of parsed.split('\n')) {
            if (l.trim()) broadcast('agent-output', { line: l });
          }
        }
      });

      // Stderr — show as-is (warnings, errors from the CLI)
      proc.stderr!.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          inspectQueueBlockSignal(line);
          broadcast('agent-output', { line, isError: true });
        }
      });

      proc.on('close', async (code) => {
        agentRunning = false;
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
            broadcast('agent-output', { line: '─────────────────────────────' });
            broadcast('agent-output', { line: `🧪 Запускаю тесты (${testFilesToRun.length} файлов)...` });
            const result = await runTestFiles(testFilesToRun, projectRoot);

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

            broadcast('agent-output', { line: '┌──────────────── Тест-отчёт ────────────────' });
            if (result.runError) {
              broadcast('agent-output', { line: `│ ❌ Ошибка запуска тестов: ${result.runError}` });
            } else {
              const status = result.failed === 0 ? '✅ OK' : '❌ FAILED';
              broadcast('agent-output', { line: `│ Статус: ${status}` });
              broadcast('agent-output', { line: `│ Файлы: ${testedFileCount}  •  passed: ${passedFileCount}  •  failed: ${failedFileCount}` });
              broadcast('agent-output', { line: `│ Тест-кейсы: passed ${result.passed}  •  failed ${result.failed}` });
            }
            broadcast('agent-output', { line: '└─────────────────────────────────────────────' });

            if (result.failed > 0) {
              for (const f of failedFiles) {
                broadcast('agent-output', { line: `  ❌ ${f.rel} — ${f.detail.failed} упало` });
                for (const e of f.detail.errors.slice(0, 3)) {
                  broadcast('agent-output', { line: `     • ${e.testName}`, isDim: true });
                }
              }
            }

            let autoFixQueued = false;
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
                    agentQueue.unshift(fixItem);
                    autoFixQueued = true;
                    broadcast('agent-output', { line: `🛠️ Обнаружены падения. Запускаю автоисправление ${attemptSuffix}...` });
                    broadcast('agent-queued', {
                      queueLength: agentQueue.length,
                      title: fixItem.title,
                      task: fixItem.task,
                      featureKey: fixItem.featureKey || null,
                      filePath: fixItem.filePath || null,
                    });
                  } else {
                    broadcast('agent-output', {
                      line: `⚠️ Автоисправление не поставлено: очередь заполнена (${runtimeEnv.agentQueueMax})`,
                      isError: true,
                    });
                  }
                }
              } else {
                const reason = !runtimeEnv.autoFixFailedTests
                  ? 'автоисправление выключено'
                  : `достигнут лимит попыток (${runtimeEnv.autoFixMaxRetries})`;
                broadcast('agent-output', { line: `⚠️ Автоисправление не запущено: ${reason}` });
              }
            }

            if (result.failed > 0 && !autoFixQueued) {
              broadcast('agent-output', { line: '  → Нажми 🔧 исправить в дашборде чтобы агент починил' });
            }

            broadcast('agent-summary', { ...result, testedFileCount, passedFileCount, failedFileCount, autoFixQueued });
          }

          // E2E plan post-processing
          if (task === 'generate-e2e-plan' && featureKey) {
            try {
              const jsonMatch = agentResultText.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
              const parsedPlan = JSON.parse(jsonMatch ? jsonMatch[0] : agentResultText);
              const feat = currentData.features?.find(f => f.key === featureKey);
              const plan: E2ePlan = {
                featureKey,
                featureLabel: feat?.label || featureKey,
                generatedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                baseUrl: parsedPlan.baseUrl,
                testCases: (parsedPlan.testCases || []).map((tc: any) => ({ ...tc, status: 'pending' as const })),
              };
              saveE2ePlan(projectRoot, plan);
              broadcast('e2e-plan-ready', { featureKey, plan });
            } catch (err: any) {
              broadcast('e2e-plan-error', { featureKey, message: `Не удалось распарсить план: ${err.message}` });
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
          try {
            currentData = await scanProject(projectRoot);
            broadcast('data-updated');
          } catch {}
          processNextInQueue(true);
        } else if (code === 255) {
          process.stdout.write(`   ❌ Agent auth error (exit code 255)\n`);
          broadcast('agent-error', {
            message: `${agent === 'claude' ? 'Claude Code' : 'Codex'} не авторизован. Нажми 🔑 Перелогиниться в меню агента.`,
            authRequired: true,
            agent,
          });
          processNextInQueue(true);
        } else {
          process.stdout.write(`   ❌ Agent failed (exit code ${code})\n`);
          broadcast('agent-error', { message: `Агент завершился с кодом ${code}` });
          if (queueBlockSignal === 403 || queueBlockSignal === 429) {
            stopQueuedTasks(`пойман ${queueBlockSignal} от ${agent === 'claude' ? 'Claude Code' : 'Codex'}`);
          }
          processNextInQueue(true);
        }
      });

      proc.on('error', (err: any) => {
        agentRunning = false;
        const isNotFound = err.code === 'ENOENT' || err.message.includes('ENOENT');
        const agentName = agent === 'claude' ? 'Claude Code' : 'Codex';
        const msg = isNotFound
          ? `${agentName} не установлен. Скачай с ${agent === 'claude' ? 'claude.ai/download' : 'github.com/openai/codex'}`
          : `Не удалось запустить ${agent}: ${err.message}`;
        process.stdout.write('   ❌ Agent spawn error: ' + err.message + '\n');
        broadcast('agent-error', { message: msg, notInstalled: isNotFound, agent });
        processNextInQueue(true);
      });
    }

    /** Validate task params and enqueue (prompt is built lazily at execution time) */
    function runAgent(task: string, featureKey?: string, filePath?: string, selectedFilePaths?: string[]) {
      const agent = currentData.agent;
      if (!agent) {
        broadcast('agent-error', { message: 'Агент не выбран. Укажи agent в viberadar.config.json' });
        return;
      }

      const agentLabel = agent === 'claude' ? 'Claude Code' : 'Codex';
      let title: string;
      let savedErrors: TestFileError[] | undefined;
      let savedFailedFiles: Array<{ filePath: string; errors: TestFileError[] }> | undefined;
      let savedTestType: string | undefined;

      if (task === 'write-tests') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat) { broadcast('agent-error', { message: `Фича не найдена: ${featureKey}` }); return; }
        title = `${agentLabel} — тесты для "${feat.label}"`;
      } else if (task === 'write-tests-file') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat || !filePath) { broadcast('agent-error', { message: 'Не указана фича или файл' }); return; }
        const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
        title = `${agentLabel} — тест для "${fileName}"`;
      } else if (task === 'write-tests-selected') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        const count = selectedFilePaths?.length ?? 0;
        if (!feat || count === 0) { broadcast('agent-error', { message: 'Не указана фича или выбранные файлы' }); return; }
        title = `${agentLabel} — тесты для выбранных файлов (${count})`;
      } else if (task === 'refresh-tests-selected') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        const count = selectedFilePaths?.length ?? 0;
        if (!feat || count === 0) { broadcast('agent-error', { message: 'Не указана фича или выбранные файлы' }); return; }
        title = `${agentLabel} — актуализировать тесты (${count})`;
      } else if (task === 'fix-tests') {
        if (!filePath) { broadcast('agent-error', { message: 'Не указан файл для исправления' }); return; }
        for (const [fp, detail] of lastTestResults) {
          const rel = path.relative(projectRoot, fp).replace(/\\/g, '/');
          if (rel === filePath.replace(/\\/g, '/') || fp === filePath) { savedErrors = detail.errors; break; }
        }
        if (!savedErrors || savedErrors.length === 0) {
          broadcast('agent-error', { message: `Нет сохранённых ошибок для ${filePath}. Сначала запусти тесты.` }); return;
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
          broadcast('agent-error', { message: `Нет упавших ${savedTestType} тестов. Сначала запусти тесты.` }); return;
        }
        title = `${agentLabel} — починить все ${savedTestType} тесты (${savedFailedFiles.length} файлов)`;
      } else if (task === 'generate-e2e-plan') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat) { broadcast('agent-error', { message: `Фича не найдена: ${featureKey}` }); return; }
        title = `${agentLabel} — E2E план для "${feat.label}"`;
      } else if (task === 'write-e2e-tests') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat) { broadcast('agent-error', { message: `Фича не найдена: ${featureKey}` }); return; }
        title = `${agentLabel} — пишу E2E тесты для "${feat.label}"`;
      } else {
        title = `${agentLabel} — разобрать unmapped`;
      }

      const item: AgentQueueItem = { task, featureKey, filePath, selectedFilePaths, title, agent, savedErrors, savedFailedFiles, savedTestType };

      if (agentRunning || queueCooldownTimer) {
        if (agentQueue.length >= runtimeEnv.agentQueueMax) {
          const msg = `Очередь агента ограничена (${runtimeEnv.agentQueueMax}). Дождись завершения текущих задач.`;
          broadcast('agent-error', { message: msg });
          process.stdout.write(`   ⚠️ Queue limit reached (${runtimeEnv.agentQueueMax}), rejected: "${title}"\n`);
          return;
        }
        agentQueue.push(item);
        const ql = agentQueue.length;
        process.stdout.write(`   📋 Agent busy, queued: "${title}" (queue size: ${ql})\n`);
        broadcast('agent-queued', {
          queueLength: ql,
          title,
          task,
          featureKey: featureKey || null,
          filePath: filePath || null,
          selectedFilePaths: selectedFilePaths || null,
        });
        return;
      }

      executeAgentItem(item);
    }

    // ── Chokidar watcher ───────────────────────────────────────────────────────
    chokidar.watch([
      '**/*.{ts,tsx,js,jsx,vue,svelte}',
      'viberadar.config.json',
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
      const url = req.url ?? '/';

      if (url === '/') {
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

      if (url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agentRunning, queueLength: agentQueue.length }));
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
            const { task, featureKey, filePath, selectedFilePaths } = JSON.parse(body);
            process.stdout.write(`   📥 run-agent: task=${task} featureKey=${featureKey} filePath=${filePath} selected=${Array.isArray(selectedFilePaths) ? selectedFilePaths.length : 0}\n`);
            runAgent(task, featureKey, filePath, selectedFilePaths);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err: any) {
            process.stdout.write(`   ❌ run-agent parse error: ${err.message}\n`);
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (url === '/api/cancel-agent' && req.method === 'POST') {
        agentRunning = false;
        agentQueue.length = 0; // clear queue too
        clearQueueCooldownTimer();
        process.stdout.write('   ⏹ Agent state reset by user (queue cleared)\n');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url === '/api/clear-queue' && req.method === 'POST') {
        const cleared = agentQueue.length;
        agentQueue.length = 0;
        clearQueueCooldownTimer();
        process.stdout.write(`   🗑 Queue cleared (${cleared} items)\n`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cleared }));
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
            runAgent('generate-e2e-plan', featureKey);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
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
            runAgent('write-e2e-tests', featureKey);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
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
