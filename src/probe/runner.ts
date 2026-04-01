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

async function runPlaywrightFile(check: ProbeCheck, target: string, timeout: number): Promise<ProbeResult> {
  const start = Date.now();
  const filePath = path.resolve(process.cwd(), check.file!);
  if (!fs.existsSync(filePath)) {
    return { check: check.name, status: 'failed', durationMs: 0, error: `File not found: ${filePath}` };
  }
  return new Promise(resolve => {
    const env = { ...process.env, BASE_URL: target, PLAYWRIGHT_BASE_URL: target };
    const proc = child_process.spawn('npx', ['playwright', 'test', filePath, '--reporter=line'], {
      env, cwd: process.cwd(), shell: true, timeout,
    });
    let output = '';
    proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    proc.on('close', code => {
      const passed = code === 0;
      resolve({
        check: check.name,
        status: passed ? 'passed' : 'failed',
        durationMs: Date.now() - start,
        error: passed ? undefined : output.slice(-500),
      });
    });
    proc.on('error', err => {
      resolve({ check: check.name, status: 'failed', durationMs: Date.now() - start, error: err.message });
    });
  });
}

async function runCheck(browser: any, check: ProbeCheck, config: ProbeConfig): Promise<ProbeResult> {
  // Run real Playwright test file if specified
  if (check.file) {
    return runPlaywrightFile(check, config.target, config.timeout);
  }

  const start = Date.now();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    for (const step of (check.steps || [])) {
      await executeStep(page, step, config.target, config.timeout);
    }
    return {
      check: check.name,
      status: 'passed',
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    ensureScreenshotsDir();
    const filename = screenshotName(check.name);
    const screenshotPath = path.join(SCREENSHOTS_DIR, filename);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch {}

    return {
      check: check.name,
      status: 'failed',
      durationMs: Date.now() - start,
      error: err.message,
      screenshotPath,
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

export async function runProbeChecks(config: ProbeConfig): Promise<ProbeRunReport> {
  const pw = loadPlaywright();
  const browser = await pw.chromium.launch({ headless: true });

  try {
    const results: ProbeResult[] = [];
    for (const check of config.checks) {
      const result = await runCheck(browser, check, config);
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
