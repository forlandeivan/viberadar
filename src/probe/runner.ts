import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { createRequire } from 'module';
import { ProbeConfig, ProbeCheck, ProbeStep, ProbeResult, ProbeRunReport } from './types';

const SCREENSHOTS_DIR = path.join(process.cwd(), '.viberadar', 'probe-screenshots');

function ensureScreenshotsDir(): void {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
}

function screenshotName(checkName: string): string {
  const safe = checkName.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '-').toLowerCase();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${safe}-${ts}.png`;
}

function getStepType(step: ProbeStep): string {
  return Object.keys(step)[0];
}

async function executeStep(page: any, step: ProbeStep, target: string, timeout: number): Promise<void> {
  const type = getStepType(step);

  switch (type) {
    case 'goto': {
      const urlPath = (step as any).goto as string;
      const fullUrl = urlPath.startsWith('http') ? urlPath : target + urlPath;
      await page.goto(fullUrl, { timeout, waitUntil: 'domcontentloaded' });
      break;
    }
    case 'fill': {
      const { selector, value } = (step as any).fill;
      await page.fill(selector, value, { timeout });
      break;
    }
    case 'click': {
      const selector = (step as any).click as string;
      await page.click(selector, { timeout });
      break;
    }
    case 'wait': {
      const ms = (step as any).wait as number;
      await page.waitForTimeout(ms);
      break;
    }
    case 'expect.visible': {
      const selector = (step as any)['expect.visible'] as string;
      await page.locator(selector).waitFor({ state: 'visible', timeout });
      break;
    }
    case 'expect.text': {
      const { selector, contains } = (step as any)['expect.text'];
      const locator = page.locator(selector);
      await locator.waitFor({ state: 'visible', timeout });
      const text = await locator.textContent({ timeout });
      if (!text || !text.includes(contains)) {
        throw new Error(`Expected "${selector}" to contain "${contains}", got "${text || ''}"`);
      }
      break;
    }
    default:
      throw new Error(`Unknown step type: ${type}`);
  }
}

function findPlaywrightConfig(filePath: string): { configFile: string; projectRoot: string } | null {
  let dir = path.dirname(filePath);
  for (let i = 0; i < 8; i++) {
    // Prefer external config when found — it's scoped to remote-only runs
    for (const name of [
      'playwright.external.config.ts',
      'playwright.external.config.js',
      'playwright.config.ts',
      'playwright.config.js',
    ]) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return { configFile: candidate, projectRoot: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function runPlaywrightFile(check: ProbeCheck, target: string, timeout: number, config: ProbeConfig, onOutput?: (chunk: string) => void): Promise<ProbeResult> {
  const start = Date.now();
  const filePath = path.resolve(process.cwd(), check.file!);
  if (!fs.existsSync(filePath)) {
    return { check: check.name, status: 'failed', durationMs: 0, error: `File not found: ${filePath}` };
  }
  const pwConfig = findPlaywrightConfig(filePath);
  const configArgs = pwConfig ? ['--config', pwConfig.configFile] : [];
  const runCwd = pwConfig ? pwConfig.projectRoot : process.cwd();

  // Playwright's testMatch only picks up *.spec.ts / *.test.ts by default.
  // If the file doesn't match, create a temporary .spec.ts copy so it gets discovered.
  let runFilePath = filePath;
  let tempSpecFile: string | null = null;
  if (!/\.(spec|test)\.[jt]sx?$/.test(filePath)) {
    tempSpecFile = filePath.replace(/\.[jt]sx?$/, '.spec.ts');
    if (tempSpecFile === filePath) tempSpecFile = filePath + '.spec.ts';
    try { fs.copyFileSync(filePath, tempSpecFile); } catch {}
    runFilePath = tempSpecFile;
  }
  // Use relative path so Playwright treats it as a filter pattern against discovered files
  const relFilePath = path.relative(runCwd, runFilePath).replace(/\\/g, '/');

  ensureScreenshotsDir();
  const checkSafe = (check.name || 'unnamed').replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '-').toLowerCase();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const pwOutputDir = path.join(SCREENSHOTS_DIR, `pw-${checkSafe}-${ts}`);

  return new Promise(resolve => {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      BASE_URL: target,
      PLAYWRIGHT_BASE_URL: target,
      PLAYWRIGHT_USE_WEBSERVER: '0',
      PLAYWRIGHT_BROWSERS: 'chromium',
      // External e2e vars — used by playwright.external.config.ts
      EXTERNAL_E2E_BASE_URL: target,
    };
    if (config.e2eEmail) {
      env.E2E_USER_EMAIL = config.e2eEmail;
      env.E2E_EMAIL = config.e2eEmail;
      env.EXTERNAL_E2E_USER_EMAIL = config.e2eEmail;
    }
    if (config.e2ePassword) {
      env.E2E_USER_PASSWORD = config.e2ePassword;
      env.E2E_PASSWORD = config.e2ePassword;
      env.EXTERNAL_E2E_USER_PASSWORD = config.e2ePassword;
    }
    if (config.e2eAdminEmail) {
      env.EXTERNAL_E2E_ADMIN_EMAIL = config.e2eAdminEmail;
    }
    if (config.e2eAdminPassword) {
      env.EXTERNAL_E2E_ADMIN_PASSWORD = config.e2eAdminPassword;
    }
    const proc = child_process.spawn('npx', [
      'playwright', 'test', relFilePath,
      '--reporter=line',
      `--output=${pwOutputDir}`,
      ...configArgs,
    ], { env, cwd: runCwd, shell: true, timeout });
    let output = '';
    proc.stdout.on('data', (d: Buffer) => { const chunk = d.toString(); output += chunk; onOutput?.(chunk); });
    proc.stderr.on('data', (d: Buffer) => { const chunk = d.toString(); output += chunk; onOutput?.(chunk); });
    proc.on('close', code => {
      if (tempSpecFile) { try { fs.unlinkSync(tempSpecFile); } catch {} }
      const passed = code === 0;
      // Collect screenshots from output dir
      let screenshotFiles: string[] = [];
      try {
        if (fs.existsSync(pwOutputDir)) {
          const collect = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (entry.isDirectory()) collect(path.join(dir, entry.name));
              else if (entry.name.endsWith('.png')) {
                // Copy to SCREENSHOTS_DIR flat with unique name
                const destName = `pw-${checkSafe}-${ts}-${entry.name}`;
                const destPath = path.join(SCREENSHOTS_DIR, destName);
                fs.copyFileSync(path.join(dir, entry.name), destPath);
                screenshotFiles.push(destName);
              }
            }
          };
          collect(pwOutputDir);
          // Clean up nested output dir after copying
          fs.rmSync(pwOutputDir, { recursive: true, force: true });
        }
      } catch {}
      resolve({
        check: check.name,
        status: passed ? 'passed' : 'failed',
        durationMs: Date.now() - start,
        output: output.slice(-3000),
        error: passed ? undefined : output.slice(-800),
        screenshotFiles: screenshotFiles.length ? screenshotFiles : undefined,
      });
    });
    proc.on('error', err => {
      if (tempSpecFile) { try { fs.unlinkSync(tempSpecFile); } catch {} }
      resolve({ check: check.name, status: 'failed', durationMs: Date.now() - start, error: err.message, output: err.message });
    });
  });
}

function stepLabel(step: ProbeStep): string {
  const type = getStepType(step);
  const val = (step as any)[type];
  if (typeof val === 'string') return `${type}: ${val}`;
  if (typeof val === 'object' && val !== null) return `${type}: ${JSON.stringify(val)}`;
  return `${type}: ${val}`;
}

function nowHms(): string {
  return new Date().toTimeString().slice(0, 8);
}

async function runCheck(browser: any, check: ProbeCheck, config: ProbeConfig, onOutput?: (chunk: string) => void): Promise<ProbeResult> {
  // Run real Playwright test file if specified
  if (check.file) {
    return runPlaywrightFile(check, config.target, config.timeout, config, onOutput);
  }

  const start = Date.now();
  const context = await browser.newContext();
  const page = await context.newPage();
  const logLines: string[] = [];

  ensureScreenshotsDir();
  const checkSafe = (check.name || 'unnamed').replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '-').toLowerCase();
  const runTs = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshotFiles: string[] = [];

  const emit = (line: string) => { logLines.push(line); onOutput?.(line + '\n'); };

  const takeScreenshot = async (label: string) => {
    try {
      const fname = `dsl-${checkSafe}-${label}-${runTs}.png`;
      const fpath = path.join(SCREENSHOTS_DIR, fname);
      await page.screenshot({ path: fpath, fullPage: true });
      screenshotFiles.push(fname);
      emit(`[${nowHms()}] 📸 ${fname}`);
    } catch {}
  };

  try {
    for (let i = 0; i < (check.steps || []).length; i++) {
      const step = check.steps![i];
      const label = stepLabel(step);
      const t0 = Date.now();
      emit(`[${nowHms()}] ▶ ${label}`);
      await executeStep(page, step, config.target, config.timeout);
      const elapsed = Date.now() - t0;
      emit(`[${nowHms()}] ✓ ${label}  +${elapsed}ms`);
      await takeScreenshot(`step${i + 1}`);
    }
    return {
      check: check.name,
      status: 'passed',
      durationMs: Date.now() - start,
      output: logLines.join('\n'),
      screenshotFiles: screenshotFiles.length ? screenshotFiles : undefined,
    };
  } catch (err: any) {
    emit(`[${nowHms()}] ✗ ${err.message}`);
    await takeScreenshot('fail');
    const lastScreenshot = screenshotFiles[screenshotFiles.length - 1];
    return {
      check: check.name,
      status: 'failed',
      durationMs: Date.now() - start,
      error: err.message,
      screenshotPath: lastScreenshot ? path.join(SCREENSHOTS_DIR, lastScreenshot) : undefined,
      screenshotFiles: screenshotFiles.length ? screenshotFiles : undefined,
      output: logLines.join('\n'),
    };
  } finally {
    await context.close();
  }
}

function loadPlaywright(): any {
  // Try from cwd first — playwright installed in the monitoring project
  try {
    const cwdRequire = createRequire(path.join(process.cwd(), 'package.json'));
    return cwdRequire('playwright');
  } catch {}
  // Fallback: playwright installed alongside viberadar
  try {
    return require('playwright');
  } catch {}
  console.error('❌ Playwright not installed. Run:');
  console.error('   npm install playwright');
  console.error('   npx playwright install chromium');
  process.exit(1);
}

export interface RunProbeOptions {
  checkNames?: string[];                                           // run only these checks (by name)
  onCheckStart?: (checkName: string) => void;                      // fired just before each check
  onCheckDone?: (result: ProbeResult) => void;                     // fired after each check
  onCheckOutput?: (checkName: string, chunk: string) => void;      // fired for each output chunk (streaming)
}

export async function runProbeChecks(config: ProbeConfig, options?: RunProbeOptions): Promise<ProbeRunReport> {
  const checksToRun = options?.checkNames
    ? config.checks.filter(c => options.checkNames!.includes(c.name))
    : config.checks;

  const pw = loadPlaywright();
  const browser = await pw.chromium.launch({ headless: true });

  try {
    const results: ProbeResult[] = [];
    for (const check of checksToRun) {
      options?.onCheckStart?.(check.name);
      const onOutput = options?.onCheckOutput
        ? (chunk: string) => options.onCheckOutput!(check.name, chunk)
        : undefined;
      const result = await runCheck(browser, check, config, onOutput);
      options?.onCheckDone?.(result);
      results.push(result);
    }

    return {
      target: config.target,
      timestamp: new Date().toISOString(),
      results,
      passed: results.filter(r => r.status === 'passed').length,
      failed: results.filter(r => r.status === 'failed').length,
    };
  } finally {
    await browser.close();
  }
}
