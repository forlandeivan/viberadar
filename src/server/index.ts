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
function buildAgentShellCmd(agent: string, taskFile: string): string {
  const escaped = taskFile.replace(/\\/g, '\\\\');
  if (WIN) {
    if (agent === 'claude') return `type "${escaped}" | claude.cmd --print --output-format stream-json`;
    if (agent === 'codex')  return `type "${escaped}" | codex.cmd`;
  } else {
    if (agent === 'claude') return `claude --print --output-format stream-json < "${escaped}"`;
    if (agent === 'codex')  return `codex < "${escaped}"`;
  }
  return `claude --print --output-format stream-json < "${escaped}"`;
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

interface TestRunResult extends Record<string, unknown> {
  passed: number;
  failed: number;
  files: string[];
}

function runTestFiles(files: string[], projectRoot: string): Promise<TestRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(
      'npx', ['vitest', 'run', '--reporter=json', ...files],
      { cwd: projectRoot, shell: true, stdio: 'pipe' }
    );
    let stdout = '';
    proc.stdout?.on('data', (d: Buffer) => stdout += d.toString());
    proc.on('close', () => {
      try {
        // vitest --reporter=json wraps output; find the JSON object
        const match = stdout.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
        const json  = JSON.parse(match ? match[0] : stdout);
        resolve({
          passed: json.numPassedTests  ?? 0,
          failed: json.numFailedTests  ?? 0,
          files,
        });
      } catch {
        resolve({ passed: 0, failed: 0, files });
      }
    });
    proc.on('error', () => resolve({ passed: 0, failed: 0, files }));
  });
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildWriteTestsPrompt(
  feat: FeatureResult,
  modules: ModuleInfo[],
  testRunner: string,
): string {
  const untested = modules
    .filter(m => m.featureKeys.includes(feat.key) && m.type !== 'test' && !m.hasTests && !m.isInfra)
    .map(m => '- ' + m.relativePath.replace(/\\/g, '/'));

  const existing = modules
    .filter(m => m.featureKeys.includes(feat.key) && m.type === 'test')
    .map(m => '- ' + m.relativePath.replace(/\\/g, '/'));

  return [
    `Напиши тесты для фичи "${feat.label}".`,
    ``,
    `Файлов без тестов (${untested.length}):`,
    ...untested,
    ``,
    existing.length > 0
      ? `Существующие тест-файлы (для справки по паттернам):\n${existing.join('\n')}`
      : '',
    ``,
    `Требования:`,
    `- Используй ${testRunner}`,
    `- Следуй паттернам существующих тестов в проекте`,
    `- Для каждого файла создай соответствующий тест-файл`,
    `- Не изменяй существующие тесты`,
  ].filter(l => l !== null).join('\n');
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
    function runAgent(task: 'write-tests' | 'map-unmapped', featureKey?: string) {
      if (agentRunning) {
        process.stdout.write('   ⏳ Agent already running\n');
        return;
      }

      const agent = currentData.agent;
      if (!agent) {
        broadcast('agent-error', { message: 'Агент не выбран. Укажи agent в viberadar.config.json' });
        return;
      }

      // Build prompt
      let prompt: string;
      let title: string;

      if (task === 'write-tests') {
        const feat = currentData.features?.find(f => f.key === featureKey);
        if (!feat) {
          broadcast('agent-error', { message: `Фича не найдена: ${featureKey}` });
          return;
        }
        prompt = buildWriteTestsPrompt(feat, currentData.modules, currentData.testRunner || 'vitest');
        title  = `${agent === 'claude' ? 'Claude Code' : 'Codex'} — тесты для "${feat.label}"`;
      } else {
        prompt = buildMapUnmappedPrompt(currentData.modules, currentData.features || []);
        title  = `${agent === 'claude' ? 'Claude Code' : 'Codex'} — разобрать unmapped`;
      }

      agentRunning = true;
      broadcast('agent-started', { title, task, featureKey });
      process.stdout.write(`   🤖 Running agent (${agent}): ${task}\n`);

      // Write prompt to .viberadar/task.md for reference
      const taskDir  = path.join(projectRoot, '.viberadar');
      const taskFile = path.join(taskDir, 'task.md');
      try {
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(taskFile, prompt, 'utf-8');
      } catch {}

      // Spawn via shell, piping prompt from file (avoids TUI mode, supports stream-json)
      const shellCmd = buildAgentShellCmd(agent, taskFile);
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
          // Auto-run created test files and show results
          if (task === 'write-tests' && createdTestFiles.length > 0) {
            broadcast('agent-output', { line: '─────────────────────────────' });
            broadcast('agent-output', { line: `🧪 Запускаю тесты (${createdTestFiles.length} файлов)...` });
            const result = await runTestFiles(createdTestFiles, projectRoot);
            const summary = result.failed === 0
              ? `✅ Все тесты прошли: ${result.passed} passed`
              : `⚠️  ${result.passed} passed, ${result.failed} failed`;
            broadcast('agent-output', { line: summary });
            broadcast('agent-summary', result);
          }

          process.stdout.write('   ✅ Agent done, rescanning...\n');
          try {
            currentData = await scanProject(projectRoot);
            broadcast('data-updated');
          } catch {}
          broadcast('agent-done');
        } else {
          process.stdout.write(`   ❌ Agent failed (exit code ${code})\n`);
          broadcast('agent-error', { message: `Агент завершился с кодом ${code}` });
        }
      });

      proc.on('error', (err) => {
        agentRunning = false;
        process.stdout.write('   ❌ Agent spawn error: ' + err.message + '\n');
        broadcast('agent-error', { message: `Не удалось запустить ${agent}: ${err.message}` });
      });
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(currentData));
        return;
      }

      if (url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ coverageRunning, coverageError, agentRunning }));
        return;
      }

      if (url === '/api/run-coverage' && req.method === 'POST') {
        triggerCoverage();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url === '/api/run-agent' && req.method === 'POST') {
        process.stdout.write('   📥 /api/run-agent received\n');
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { task, featureKey } = JSON.parse(body);
            process.stdout.write(`   📥 run-agent: task=${task} featureKey=${featureKey}\n`);
            runAgent(task, featureKey);
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

    server.listen(port, '127.0.0.1', () => resolve({ server, triggerCoverage }));

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
