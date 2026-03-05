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
  triggerCoverage: () => void;
}

const DASHBOARD_HTML = fs.readFileSync(
  path.join(__dirname, '../ui/dashboard.html'),
  'utf-8'
);

// ─── Agent CLI commands ───────────────────────────────────────────────────────

const WIN = process.platform === 'win32';

/**
 * Build shell command that pipes task file into the agent CLI.
 * --output-format stream-json gives real-time events (tool calls, writes, etc.)
 * File piping avoids TUI mode in Claude Code v2+.
 */
function buildAgentShellCmd(agent: string, taskFile: string, model?: string): string {
  const escaped = taskFile.replace(/\\/g, '\\\\');
  const modelFlag = (agent === 'claude' && model) ? ` --model ${model}` : '';
  if (WIN) {
    if (agent === 'claude') return `type "${escaped}" | claude.cmd --print --verbose --output-format stream-json${modelFlag}`;
    if (agent === 'codex')  return `type "${escaped}" | codex.cmd exec - --color never --sandbox workspace-write`;
  } else {
    if (agent === 'claude') return `claude --print --verbose --output-format stream-json${modelFlag} < "${escaped}"`;
    if (agent === 'codex')  return `codex exec - --color never --sandbox workspace-write < "${escaped}"`;
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
  runError?: string; // set when tests couldn't start (import/syntax error)
}

interface AgentQueueItem {
  task: 'write-tests' | 'write-tests-file' | 'fix-tests' | 'fix-tests-all' | 'map-unmapped';
  featureKey?: string;
  filePath?: string;
  title: string;
  agent: string;
  // Prompt is NOT pre-built — it is constructed lazily in executeAgentItem() to save memory.
  // For fix tasks we snapshot only the small error data at queue time (not the full prompt).
  savedErrors?: TestFileError[];                                    // fix-tests
  savedFailedFiles?: { filePath: string; errors: TestFileError[] }[]; // fix-tests-all
  savedTestType?: string;                                           // fix-tests-all
}

/**
 * Normalize a file path (possibly git-bash style /c/Users/...) to a path
 * relative to projectRoot, so vitest can always find it regardless of OS.
 */
function toRelativeTestPath(filePath: string, projectRoot: string): string {
  // Convert git-bash absolute path (/c/Users/foo) → Windows-style (c:/Users/foo)
  const normalized = filePath.replace(/^\/([a-zA-Z])\//, '$1:/').replace(/\\/g, '/');
  const rootNorm = projectRoot.replace(/\\/g, '/');
  if (normalized.startsWith(rootNorm + '/')) {
    return normalized.slice(rootNorm.length + 1); // relative, forward slashes
  }
  // Already relative or unrecognized format — return as-is
  return filePath.replace(/\\/g, '/');
}

function runTestFiles(files: string[], projectRoot: string): Promise<TestRunResult> {
  return new Promise((resolve) => {
    const relFiles = files.map(f => toRelativeTestPath(f, projectRoot));
    const proc = spawn(
      'npx', ['vitest', 'run', '--reporter=json', ...relFiles],
      { cwd: projectRoot, shell: true, stdio: 'pipe' }
    );
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => stdout += d.toString());
    proc.stderr?.on('data', (d: Buffer) => stderr += d.toString());
    proc.on('close', (code) => {
      try {
        // vitest --reporter=json wraps output; find the JSON object
        const match = stdout.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
        if (!match) {
          // JSON not found — tests likely failed to start (import error, syntax error, etc.)
          const hint = (stderr || stdout).split('\n')
            .filter(l => l.trim() && !l.includes('VITE') && !l.includes('Duration'))
            .slice(0, 5).join('\n');
          resolve({ passed: 0, failed: files.length, files, fileDetails: {}, runError: hint || `exit code ${code}` });
          return;
        }
        const json = JSON.parse(match[0]);

        // Extract per-file failure details
        const fileDetails: Record<string, TestFileDetail> = {};
        for (const tr of (json.testResults ?? [])) {
          const fp: string = tr.name ?? tr.testFilePath ?? '';
          const errors: TestFileError[] = [];
          for (const ar of (tr.assertionResults ?? [])) {
            if (ar.status === 'failed') {
              errors.push({
                testName: ar.fullName ?? ar.title ?? 'unknown',
                message: (ar.failureMessages?.[0] ?? '').split('\n')[0].slice(0, 300),
              });
            }
          }
          fileDetails[fp] = {
            passed: (tr.assertionResults ?? []).filter((a: any) => a.status === 'passed').length,
            failed: errors.length,
            errors,
          };
        }

        resolve({
          passed: json.numPassedTests  ?? 0,
          failed: json.numFailedTests  ?? 0,
          files,
          fileDetails,
        });
      } catch (e: any) {
        const hint = (stderr || stdout).split('\n').filter(l => l.trim()).slice(0, 5).join('\n');
        resolve({ passed: 0, failed: files.length, files, fileDetails: {}, runError: hint || e.message });
      }
    });
    proc.on('error', (err) => resolve({ passed: 0, failed: files.length, files, fileDetails: {}, runError: err.message }));
  });
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

/** Safely read a file, return null if not found */
function tryReadFile(absPath: string): string | null {
  try { return fs.readFileSync(absPath, 'utf-8'); } catch { return null; }
}

const FILE_BLOCK_LINE_LIMIT = 500;

/** Embed file content as a fenced code block in prompt.
 *  For large files (> FILE_BLOCK_LINE_LIMIT lines) only embeds the first 200 lines
 *  (imports + types) and instructs the agent to read the full file by path. */
function fileBlock(relPath: string, absPath: string): string {
  const content = tryReadFile(absPath);
  if (!content) return '';
  const ext = absPath.split('.').pop() ?? 'ts';
  const lines = content.split('\n');
  if (lines.length > FILE_BLOCK_LINE_LIMIT) {
    const preview = lines.slice(0, 200).join('\n');
    return `### \`${relPath}\`\n_Файл большой (${lines.length} строк) — ниже первые 200 строк для контекста. Прочитай полный файл по пути: \`${absPath}\`_\n\`\`\`${ext}\n${preview}\n\`\`\``;
  }
  return `### \`${relPath}\`\n\`\`\`${ext}\n${content}\n\`\`\``;
}

/**
 * Pick up to `n` example test files most relevant to `forRelPath`.
 * Prefer tests in the same directory (e.g. tests/client/ for client/src/pages/).
 */
function pickExampleTests(forRelPath: string, testModules: ModuleInfo[], n = 2): ModuleInfo[] {
  const isClient = forRelPath.includes('client/');
  const preferred = testModules.filter(m =>
    isClient ? m.relativePath.includes('client') : !m.relativePath.includes('client')
  );
  const pool = preferred.length > 0 ? preferred : testModules;
  return pool.slice(0, n);
}

function buildWriteTestsPrompt(
  feat: FeatureResult,
  modules: ModuleInfo[],
  testRunner: string,
  projectRoot: string,
): string {
  const untestedMods = modules
    .filter(m => m.featureKeys.includes(feat.key) && m.type !== 'test' && !m.hasTests && !m.isInfra);

  const existingTestMods = modules
    .filter(m => m.featureKeys.includes(feat.key) && m.type === 'test');

  const hasNoTestInfra = modules.filter(m => m.type === 'test').length === 0;

  // Split by suggested type
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

  // Embed source file contents (cap at 8 files to avoid huge prompts)
  const sourceBlocks = untestedMods.slice(0, 8).map(m =>
    fileBlock(m.relativePath.replace(/\\/g, '/'), m.path)
  ).filter(Boolean);

  // Pick example tests separately for client and server files
  const clientMods  = untestedMods.filter(m => m.relativePath.includes('client/'));
  const serverMods  = untestedMods.filter(m => !m.relativePath.includes('client/'));
  const allTestMods = existingTestMods.length > 0 ? existingTestMods
    : modules.filter(m => m.type === 'test');

  const exampleSet = new Map<string, ModuleInfo>();
  if (clientMods.length > 0) {
    pickExampleTests(clientMods[0].relativePath, allTestMods, 1)
      .forEach(m => exampleSet.set(m.path, m));
  }
  if (serverMods.length > 0) {
    pickExampleTests(serverMods[0].relativePath, allTestMods, 1)
      .forEach(m => exampleSet.set(m.path, m));
  }
  if (exampleSet.size === 0) {
    pickExampleTests('', allTestMods, 2).forEach(m => exampleSet.set(m.path, m));
  }
  const exampleBlocks = [...exampleSet.values()].map(m =>
    fileBlock(m.relativePath.replace(/\\/g, '/'), m.path)
  ).filter(Boolean);

  // Embed test infrastructure: setup.ts + test-helpers.ts
  const infraBlocks: string[] = [];
  const setupPath   = path.join(projectRoot, 'tests', 'setup.ts');
  const helpersPath = path.join(projectRoot, 'tests', 'test-helpers.ts');
  if (tryReadFile(setupPath))   infraBlocks.push(fileBlock('tests/setup.ts',        setupPath));
  if (tryReadFile(helpersPath)) infraBlocks.push(fileBlock('tests/test-helpers.ts', helpersPath));

  return [
    `Напиши тесты для фичи "${feat.label}".`,
    ``,
    typeSummary ? `Рекомендации по типам тестов:\n${typeSummary}` : '',
    ``,
    `## Исходные файлы для покрытия`,
    ...sourceBlocks,
    ``,
    exampleBlocks.length > 0 ? `## Примеры тестов (следуй этим паттернам)` : '',
    ...exampleBlocks,
    ``,
    infraBlocks.length > 0 ? `## Тестовая инфраструктура` : '',
    ...infraBlocks,
    ``,
    hasNoTestInfra
      ? `⚠️ В проекте пока нет ни одного теста. Если нужна тестовая инфраструктура (test-helpers.ts, vitest.config.ts) — создай её сначала.`
      : '',
    `## Требования`,
    `- Используй ${testRunner}`,
    `- Для каждого исходного файла создай соответствующий тест-файл`,
    `- Покрой: happy path, edge cases, обработку ошибок`,
    `- Следуй паттернам примеров выше`,
    `- Не изменяй существующие тесты`,
    hasNoTestInfra
      ? `- Если нужно — создай test-helpers.ts и vitest.config.ts перед написанием тестов`
      : `- Если в исходном файле есть импорты типов которых нет выше — прочитай только эти файлы с типами. Не исследуй проект вширь.`,
  ].filter(s => s !== null && s !== undefined && s !== '').join('\n');
}

function buildWriteTestsForFilePrompt(
  filePath: string,
  feat: FeatureResult,
  modules: ModuleInfo[],
  testRunner: string,
  projectRoot: string,
): string {
  const normalPath = filePath.replace(/\\/g, '/');

  // Find module info to get suggestedTestType and absolute path
  const sourceModule = modules.find(m =>
    m.relativePath.replace(/\\/g, '/') === normalPath || m.path === filePath
  );
  const suggestedTestType = sourceModule?.suggestedTestType ?? 'unit';
  const absSourcePath = sourceModule?.path ?? path.join(projectRoot, filePath);

  // Embed source file content
  const sourceBlock = fileBlock(normalPath, absSourcePath);

  // Pick 1-2 example tests most relevant to this file
  const existingTestMods = modules.filter(m => m.type === 'test');
  const featureTestMods  = modules.filter(m => m.featureKeys.includes(feat.key) && m.type === 'test');
  const examplePool = featureTestMods.length > 0 ? featureTestMods : existingTestMods;
  const exampleTests = pickExampleTests(normalPath, examplePool, 2);
  const exampleBlocks = exampleTests.map(m =>
    fileBlock(m.relativePath.replace(/\\/g, '/'), m.path)
  ).filter(Boolean);

  // Embed test infrastructure: setup.ts + test-helpers.ts
  const infraBlocks: string[] = [];
  const setupPath   = path.join(projectRoot, 'tests', 'setup.ts');
  const helpersPath = path.join(projectRoot, 'tests', 'test-helpers.ts');
  if (tryReadFile(setupPath))   infraBlocks.push(fileBlock('tests/setup.ts',        setupPath));
  if (tryReadFile(helpersPath)) infraBlocks.push(fileBlock('tests/test-helpers.ts', helpersPath));

  const testTypeBlock = suggestedTestType === 'integration'
    ? [
        `Тип теста: INTEGRATION`,
        `→ Используй test-helpers или реальную БД.`,
        `→ Не мокай репозитории — проверяй реальное поведение.`,
      ].join('\n')
    : [
        `Тип теста: UNIT`,
        `→ Замокай все внешние зависимости через \`vi.mock()\`.`,
        `→ Не используй реальную БД или внешние сервисы.`,
      ].join('\n');

  const hasNoTestInfra = existingTestMods.length === 0;

  return [
    `Напиши тест для файла \`${normalPath}\`. Фича: "${feat.label}"`,
    ``,
    testTypeBlock,
    ``,
    `## Исходный файл`,
    sourceBlock,
    ``,
    exampleBlocks.length > 0 ? `## Примеры тестов (следуй этим паттернам)` : '',
    ...exampleBlocks,
    ``,
    infraBlocks.length > 0 ? `## Тестовая инфраструктура` : '',
    ...infraBlocks,
    ``,
    hasNoTestInfra
      ? `⚠️ В проекте пока нет ни одного теста. Если нужна тестовая инфраструктура (test-helpers.ts, vitest.config.ts) — создай её сначала.`
      : '',
    `## Требования`,
    `- Используй ${testRunner}`,
    `- Создай один тест-файл для \`${normalPath}\``,
    `- Покрой: happy path, edge cases, обработку ошибок`,
    `- Следуй паттернам примеров выше`,
    `- Не изменяй существующие тесты`,
    hasNoTestInfra
      ? `- Если нужно — создай test-helpers.ts и vitest.config.ts перед написанием тестов`
      : `- Если в исходном файле есть импорты типов которых нет выше — прочитай только эти файлы с типами. Не исследуй проект вширь.`,
  ].filter(s => s !== null && s !== undefined && s !== '').join('\n');
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

function buildFixAllTestsPrompt(
  failedFiles: { filePath: string; errors: TestFileError[] }[],
  testType: string,
): string {
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

// ─── Coverage provider auto-install ──────────────────────────────────────────

function autoInstallCoverageProvider(projectRoot: string): Promise<boolean> {
  return new Promise(resolve => {
    // Detect vitest version to install matching coverage package
    let vitestVersion = 'latest';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const raw = deps['vitest'] as string | undefined;
      if (raw) vitestVersion = raw.replace(/[\^~>=<\s]/g, '') || 'latest';
    } catch {}

    const pkg = `@vitest/coverage-v8@${vitestVersion}`;
    process.stdout.write(`   📦 Installing ${pkg}...\n`);

    const proc = spawn('npm', ['install', '--save-dev', '--legacy-peer-deps', pkg], {
      cwd: projectRoot,
      shell: true,
      stdio: 'pipe',
    });

    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        process.stdout.write(`   ✅ Installed ${pkg}\n`);
        resolve(true);
      } else {
        process.stdout.write(`   ❌ Failed to install ${pkg}: ${stderr.slice(0, 200)}\n`);
        resolve(false);
      }
    });

    proc.on('error', (err) => {
      process.stdout.write(`   ❌ Install error: ${err.message}\n`);
      resolve(false);
    });
  });
}

// ─── Coverage command detection ───────────────────────────────────────────────

function detectCoverageCommand(projectRoot: string): { cmd: string; args: string[] } {
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const scripts = pkg.scripts || {};
      if (deps['vitest'] || scripts['test']?.includes('vitest')) {
        return { cmd: 'npx', args: ['vitest', 'run', '--coverage'] };
      }
      if (deps['jest'] || scripts['test']?.includes('jest')) {
        return { cmd: 'npx', args: ['jest', '--coverage', '--coverageReporters=json-summary'] };
      }
    }
  } catch {}
  return { cmd: 'npm', args: ['test', '--', '--coverage'] };
}

// ─── Main server ──────────────────────────────────────────────────────────────

export function startServer({ data: initialData, port, projectRoot }: ServerOptions): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {

    let currentData = initialData;

    // ── State ──────────────────────────────────────────────────────────────────
    let coverageRunning = false;
    let coverageError   = false;
    let agentRunning    = false;
    let testsRunning    = false;
    const agentQueue: AgentQueueItem[] = [];
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

    // ── Coverage runner ────────────────────────────────────────────────────────
    function triggerCoverage() {
      if (coverageRunning) {
        process.stdout.write('   ⏳ Coverage already running, skipping\n');
        return;
      }
      coverageRunning = true;
      coverageError   = false;
      broadcast('coverage-started');

      const { cmd, args } = detectCoverageCommand(projectRoot);
      process.stdout.write(`   🧪 Running coverage: ${cmd} ${args.join(' ')}\n`);

      const proc = spawn(cmd, args, { cwd: projectRoot, shell: true, stdio: 'pipe' });

      let coverageStderr = '';
      proc.stderr?.on('data', (d: Buffer) => { coverageStderr += d.toString(); });

      proc.on('close', async (code) => {
        coverageRunning = false;
        if (code === 0) {
          process.stdout.write('   ✅ Coverage done, rescanning...\n');
          try {
            currentData = await scanProject(projectRoot);
            broadcast('data-updated');
            broadcast('coverage-done');
          } catch (err: any) {
            process.stdout.write('   ❌ Rescan after coverage failed: ' + err.message + '\n');
            broadcast('coverage-error');
          }
        } else {
          const isMissingProvider =
            coverageStderr.includes('@vitest/coverage') ||
            coverageStderr.includes('coverage provider') ||
            coverageStderr.includes('Cannot find package') ||
            coverageStderr.includes('ERR_MODULE_NOT_FOUND');

          if (isMissingProvider && currentData.testRunner === 'vitest') {
            // Auto-install matching @vitest/coverage-v8
            autoInstallCoverageProvider(projectRoot).then(ok => {
              if (ok) {
                process.stdout.write('   🔄 Retrying coverage after install...\n');
                triggerCoverage();
              } else {
                coverageError = true;
                broadcast('coverage-error');
              }
            });
          } else {
            coverageError = true;
            process.stdout.write(`   ❌ Coverage failed (exit code ${code})\n`);
            broadcast('coverage-error');
          }
        }
      });

      proc.on('error', (err) => {
        coverageRunning = false;
        coverageError   = true;
        process.stdout.write('   ❌ Coverage spawn error: ' + err.message + '\n');
        broadcast('coverage-error');
      });
    }

    // ── Agent runner ───────────────────────────────────────────────────────────

    /** Check if the configured agent CLI is installed; broadcast a warning if not */
    function checkAgentInstalled(agent: string | undefined) {
      if (!agent) return;
      const cliName = agent === 'claude'
        ? (WIN ? 'claude.cmd' : 'claude')
        : (WIN ? 'codex.cmd' : 'codex');
      const agentName = agent === 'claude' ? 'Claude Code' : 'Codex';
      const downloadUrl = agent === 'claude' ? 'claude.ai/download' : 'github.com/openai/codex';

      const check = spawn(cliName, ['--version'], { shell: true, stdio: 'pipe' });
      check.on('error', () => {
        process.stdout.write(`   ⚠️  ${agentName} не найден (${cliName})\n`);
        broadcast('agent-error', {
          message: `${agentName} не установлен. Скачай с ${downloadUrl}`,
          notInstalled: true,
          agent,
        });
      });
      check.on('close', (code) => {
        if (code === 255) {
          process.stdout.write(`   ⚠️  ${agentName} не авторизован (exit 255 при --version)\n`);
          broadcast('agent-error', {
            message: `${agentName} не авторизован. Нажми 🔑 Перелогиниться в меню агента.`,
            authRequired: true,
            agent,
          });
        } else if (code === 0) {
          process.stdout.write(`   ✅ ${agentName} доступен\n`);
        }
      });
    }

    /** Execute the next queued item, or broadcast agent-done if queue is empty */
    function processNextInQueue() {
      if (agentQueue.length > 0) {
        const next = agentQueue.shift()!;
        process.stdout.write(`   📋 Starting next from queue: "${next.title}" (remaining: ${agentQueue.length})\n`);
        broadcast('agent-output', { line: `📋 Следующая задача из очереди: ${next.title}` });
        broadcast('agent-output', { line: `   В очереди осталось: ${agentQueue.length}` });
        executeAgentItem(next);
      } else {
        broadcast('agent-done', { queueLength: 0 });
      }
    }

    /** Actually spawn the agent process for a queue item */
    function executeAgentItem(item: AgentQueueItem) {
      const { task, featureKey, filePath, title, agent, savedErrors, savedFailedFiles, savedTestType } = item;

      // ── Build prompt lazily here (not pre-built in queue) to avoid holding large strings in memory ──
      let prompt: string;
      if (task === 'write-tests') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat) {
          broadcast('agent-error', { message: `Фича не найдена: ${featureKey}` });
          agentRunning = false; processNextInQueue(); return;
        }
        prompt = buildWriteTestsPrompt(feat, currentData.modules, currentData.testRunner || 'vitest', projectRoot);
      } else if (task === 'write-tests-file') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat || !filePath) {
          broadcast('agent-error', { message: 'Не указана фича или файл' });
          agentRunning = false; processNextInQueue(); return;
        }
        prompt = buildWriteTestsForFilePrompt(filePath, feat, currentData.modules, currentData.testRunner || 'vitest', projectRoot);
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
      } else {
        prompt = buildMapUnmappedPrompt(currentData.modules, currentData.features || []);
      }

      agentRunning = true;
      broadcast('agent-started', { title, task, featureKey, filePath: filePath || null, queueLength: agentQueue.length });
      process.stdout.write(`   🤖 Running agent (${agent}): ${task}\n`);

      // Write prompt to .viberadar/task.md for reference
      const taskDir  = path.join(projectRoot, '.viberadar');
      const taskFile = path.join(taskDir, 'task.md');
      try {
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(taskFile, prompt, 'utf-8');
      } catch {}

      // Spawn via shell, piping prompt from file (avoids TUI mode, supports stream-json)
      const shellCmd = buildAgentShellCmd(agent, taskFile, currentData.model);
      process.stdout.write(`   🚀 Shell cmd: ${shellCmd}\n`);
      const proc = spawn(shellCmd, [], {
        cwd: projectRoot,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      broadcast('agent-output', { line: `🚀 Запускаю: ${agent === 'claude' ? 'Claude Code' : 'Codex'}` });
      broadcast('agent-output', { line: `📄 Задача записана в .viberadar/task.md` });

      // Track test files written/edited by agent (for auto-run after)
      const createdTestFiles: string[] = [];

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
        trackWrittenFiles(raw);
        const parsed = agent === 'claude' ? parseClaudeEvent(raw) : raw;
        // If parsing returned null (noise), still show raw line dimmed so user knows output is coming
        if (!parsed) {
          broadcast('agent-output', { line: raw.slice(0, 120), isDim: true });
          return;
        }

        if (parsed.startsWith('§RESULT§')) {
          // Full result summary — split into lines and prefix with indent
          broadcast('agent-output', { line: '─────────────────────────────' });
          for (const l of parsed.slice('§RESULT§'.length).split('\n')) {
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
          if ((task === 'write-tests' || task === 'write-tests-file' || task === 'fix-tests' || task === 'fix-tests-all') && testFilesToRun.length > 0) {
            broadcast('agent-output', { line: '─────────────────────────────' });
            broadcast('agent-output', { line: `🧪 Запускаю тесты (${testFilesToRun.length} файлов)...` });
            const result = await runTestFiles(testFilesToRun, projectRoot);

            // Store per-file results for "fix-tests" feature
            lastTestResults.clear();
            for (const [fp, detail] of Object.entries(result.fileDetails)) {
              if (detail.failed > 0) lastTestResults.set(path.resolve(fp), { failed: detail.failed, errors: detail.errors });
            }

            const summary = result.runError
              ? `❌ Тесты не запустились: ${result.runError}`
              : result.failed === 0 && result.passed > 0
                ? `✅ Все тесты прошли: ${result.passed} passed`
                : result.failed === 0 && result.passed === 0
                  ? `⚠️ 0 тестов запустилось — проверь файл на ошибки импорта`
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
              broadcast('agent-output', { line: '  → Нажми 🔧 исправить в дашборде чтобы агент починил' });
            }
            broadcast('agent-summary', result);
          }

          process.stdout.write('   ✅ Agent done, rescanning...\n');
          try {
            currentData = await scanProject(projectRoot);
            broadcast('data-updated');
          } catch {}
          processNextInQueue();
        } else if (code === 255) {
          process.stdout.write(`   ❌ Agent auth error (exit code 255)\n`);
          broadcast('agent-error', {
            message: `${agent === 'claude' ? 'Claude Code' : 'Codex'} не авторизован. Нажми 🔑 Перелогиниться в меню агента.`,
            authRequired: true,
            agent,
          });
          processNextInQueue();
        } else {
          process.stdout.write(`   ❌ Agent failed (exit code ${code})\n`);
          broadcast('agent-error', { message: `Агент завершился с кодом ${code}` });
          processNextInQueue();
        }
      });

      proc.on('error', (err: NodeJS.ErrnoException) => {
        agentRunning = false;
        const isNotFound = err.code === 'ENOENT' || err.message.includes('ENOENT');
        const agentName = agent === 'claude' ? 'Claude Code' : 'Codex';
        const msg = isNotFound
          ? `${agentName} не установлен. Скачай с ${agent === 'claude' ? 'claude.ai/download' : 'github.com/openai/codex'}`
          : `Не удалось запустить ${agent}: ${err.message}`;
        process.stdout.write('   ❌ Agent spawn error: ' + err.message + '\n');
        broadcast('agent-error', { message: msg, notInstalled: isNotFound, agent });
        processNextInQueue();
      });
    }

    /** Validate task params and enqueue (prompt is built lazily at execution time) */
    function runAgent(task: 'write-tests' | 'write-tests-file' | 'fix-tests' | 'fix-tests-all' | 'map-unmapped', featureKey?: string, filePath?: string) {
      const agent = currentData.agent;
      if (!agent) {
        broadcast('agent-error', { message: 'Агент не выбран. Укажи agent в viberadar.config.json' });
        return;
      }

      // Validate params upfront and snapshot only the small error data for fix tasks.
      // The full prompt is NOT built here — executeAgentItem() builds it lazily to save memory.
      let title: string;
      let savedErrors: TestFileError[] | undefined;
      let savedFailedFiles: { filePath: string; errors: TestFileError[] }[] | undefined;
      let savedTestType: string | undefined;
      const agentLabel = agent === 'claude' ? 'Claude Code' : 'Codex';

      if (task === 'write-tests') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat) { broadcast('agent-error', { message: `Фича не найдена: ${featureKey}` }); return; }
        title = `${agentLabel} — тесты для "${feat.label}"`;
      } else if (task === 'write-tests-file') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat || !filePath) { broadcast('agent-error', { message: 'Не указана фича или файл' }); return; }
        const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
        title = `${agentLabel} — тест для "${fileName}"`;
      } else if (task === 'fix-tests') {
        if (!filePath) { broadcast('agent-error', { message: 'Не указан файл для исправления' }); return; }
        for (const [fp, detail] of lastTestResults) {
          const rel = path.relative(projectRoot, fp).replace(/\\/g, '/');
          if (rel === filePath.replace(/\\/g, '/') || fp === filePath) {
            savedErrors = detail.errors;
            break;
          }
        }
        if (!savedErrors || savedErrors.length === 0) {
          broadcast('agent-error', { message: `Нет сохранённых ошибок для ${filePath}. Сначала запусти тесты.` });
          return;
        }
        const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
        title = `${agentLabel} — исправить тесты в "${fileName}"`;
      } else if (task === 'fix-tests-all') {
        savedTestType = filePath || 'unit';
        savedFailedFiles = [];
        for (const [fp, detail] of lastTestResults) {
          const rel = path.relative(projectRoot, fp).replace(/\\/g, '/');
          const mod = currentData.modules.find(m =>
            m.relativePath.replace(/\\/g, '/') === rel && m.testType === savedTestType
          );
          if (mod && detail.errors.length > 0) {
            savedFailedFiles.push({ filePath: rel, errors: detail.errors });
          }
        }
        if (savedFailedFiles.length === 0) {
          broadcast('agent-error', { message: `Нет упавших ${savedTestType} тестов. Сначала запусти тесты.` });
          return;
        }
        title = `${agentLabel} — починить все ${savedTestType} тесты (${savedFailedFiles.length} файлов)`;
      } else {
        title = `${agentLabel} — разобрать unmapped`;
      }

      const item: AgentQueueItem = { task, featureKey, filePath, title, agent, savedErrors, savedFailedFiles, savedTestType };

      if (agentRunning) {
        agentQueue.push(item);
        const ql = agentQueue.length;
        process.stdout.write(`   📋 Agent busy, queued: "${title}" (queue size: ${ql})\n`);
        broadcast('agent-queued', { queueLength: ql, title, task, featureKey: featureKey || null, filePath: filePath || null });
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...currentData, testErrors }));
        return;
      }

      if (url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ coverageRunning, coverageError, agentRunning, queueLength: agentQueue.length }));
        return;
      }

      if (url === '/api/run-coverage' && req.method === 'POST') {
        triggerCoverage();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
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

            const summary = result.runError
              ? `❌ Тесты не запустились: ${result.runError}`
              : result.failed === 0 && result.passed > 0
                ? `✅ Все тесты прошли: ${result.passed} passed`
                : result.failed === 0 && result.passed === 0
                  ? `⚠️ 0 тестов запустилось — проверь файл на ошибки импорта`
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
              broadcast('agent-output', { line: '  → Нажми 🔧 исправить рядом с файлом чтобы агент починил' });
            }
            // Send testErrors directly in event — avoids path/timing issues with /api/data fetch
            const testErrorsForClient: Record<string, { failed: number; errors: TestFileError[] }> = {};
            for (const [fp, detail] of lastTestResults) {
              const rel = path.relative(projectRoot, fp).replace(/\\/g, '/');
              testErrorsForClient[rel] = detail;
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
            const { task, featureKey, filePath } = JSON.parse(body);
            process.stdout.write(`   📥 run-agent: task=${task} featureKey=${featureKey} filePath=${filePath}\n`);
            runAgent(task, featureKey, filePath);
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
        process.stdout.write('   ⏹ Agent state reset by user (queue cleared)\n');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url === '/api/get-prompt' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { task, featureKey, filePath } = JSON.parse(body);
            let prompt = '';
            if (task === 'write-tests-file') {
              const feat = currentData.features?.find(f => f.key === featureKey);
              if (!feat || !filePath) {
                res.writeHead(400); res.end(JSON.stringify({ error: 'Missing feat or file' })); return;
              }
              prompt = buildWriteTestsForFilePrompt(filePath, feat, currentData.modules, currentData.testRunner || 'vitest', projectRoot);
            } else if (task === 'write-tests') {
              const feat = currentData.features?.find(f => f.key === featureKey);
              if (!feat) {
                res.writeHead(400); res.end(JSON.stringify({ error: 'Feature not found' })); return;
              }
              prompt = buildWriteTestsPrompt(feat, currentData.modules, currentData.testRunner || 'vitest', projectRoot);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ prompt }));
          } catch (err: any) {
            res.writeHead(400); res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (url === '/api/clear-queue' && req.method === 'POST') {
        const cleared = agentQueue.length;
        agentQueue.length = 0;
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

      if (url === '/api/set-model' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { model } = JSON.parse(body);
            const configPath = path.join(projectRoot, 'viberadar.config.json');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            config.model = model || undefined;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
            scheduleRescan();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, model }));
          } catch (err: any) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (url === '/api/agent-reauth' && req.method === 'POST') {
        const agent = currentData.agent;
        if (!agent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No agent configured' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

        const cliName = agent === 'claude' ? (WIN ? 'claude.cmd' : 'claude') : (WIN ? 'codex.cmd' : 'codex');
        // Claude: `claude auth logout` / `claude auth login`
        // Codex:  `codex logout`       / `codex login`  (no `auth` subcommand)
        const logoutArgs = agent === 'claude' ? ['auth', 'logout'] : ['logout'];
        const loginArgs  = agent === 'claude' ? ['auth', 'login']  : ['login'];

        // Step 1: logout
        broadcast('agent-output', { line: `🔑 Выхожу из ${agent}...` });
        const logoutProc = spawn(cliName, logoutArgs, {
          cwd: projectRoot, shell: true, stdio: 'pipe',
        });
        let logoutStderr = '';
        logoutProc.stderr?.on('data', (d: Buffer) => { logoutStderr += d.toString(); });
        logoutProc.stdout?.on('data', (d: Buffer) => {
          for (const l of d.toString().split('\n').filter(Boolean)) {
            broadcast('agent-output', { line: l });
          }
        });

        logoutProc.on('close', (logoutCode) => {
          if (logoutCode === 0) {
            broadcast('agent-output', { line: '✅ Вышли из аккаунта' });
          } else {
            broadcast('agent-output', { line: `⚠ logout вернул код ${logoutCode}` });
            if (logoutStderr.trim()) {
              broadcast('agent-output', { line: logoutStderr.trim(), isDim: true });
            }
          }

          // Step 2: login (opens browser)
          broadcast('agent-output', { line: `🔑 Запускаю авторизацию ${agent}...` });
          const loginProc = spawn(cliName, loginArgs, {
            cwd: projectRoot, shell: true, stdio: 'pipe',
          });
          loginProc.stdout?.on('data', (d: Buffer) => {
            for (const l of d.toString().split('\n').filter(Boolean)) {
              broadcast('agent-output', { line: l });
            }
          });
          loginProc.stderr?.on('data', (d: Buffer) => {
            for (const l of d.toString().split('\n').filter(Boolean)) {
              broadcast('agent-output', { line: l });
            }
          });
          loginProc.on('close', (loginCode) => {
            if (loginCode === 0) {
              broadcast('agent-output', { line: '✅ Авторизация завершена! Можно запускать агента.' });
            } else {
              broadcast('agent-output', { line: `⚠ Авторизация не завершена (код ${loginCode}).` });
              broadcast('agent-output', { line: `   Попробуй вручную: ${[cliName, ...loginArgs].join(' ')}` });
            }
          });
          loginProc.on('error', () => {
            broadcast('agent-output', { line: `❌ Не удалось запустить ${cliName} auth login` });
          });
        });
        logoutProc.on('error', () => {
          broadcast('agent-output', { line: `❌ Не удалось запустить ${cliName}. Проверь что CLI установлен.` });
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

    server.listen(port, '127.0.0.1', () => {
      resolve({ server, triggerCoverage });
      // Async startup check — runs after server is up, doesn't block
      checkAgentInstalled(currentData.agent);
    });

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
