import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';

export interface ModuleInfo {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  type: 'component' | 'util' | 'service' | 'test' | 'config' | 'other';
  hasTests: boolean;
  testFile?: string;
  coverage?: CoverageInfo;
  size: number;
  dependencies: string[];
  featureKeys: string[];
  isInfra: boolean;        // matched by config.ignore — intentionally system/infra file
  testType?: 'unit' | 'integration' | 'e2e';  // only for test files
  testCount?: number;      // number of it()/test() cases in a test file
  testStale?: boolean;     // source file is newer than its test file → tests may be outdated
  suggestedTestType?: 'unit' | 'integration'; // recommended test type based on source imports
}

export interface CoverageInfo {
  lines: number;
  statements: number;
  functions: number;
  branches: number;
}

// ─── Feature config types ─────────────────────────────────────────────────────

export interface FeatureConfig {
  label: string;
  description?: string;
  include: string[];
  color: string;
}

export interface VibeRadarConfig {
  version: string;
  agent?: 'claude' | 'codex';  // AI agent CLI to use
  ignore?: string[];   // glob patterns for infra/system files (excluded from unmapped)
  features: Record<string, FeatureConfig>;
}

export interface FeatureResult {
  key: string;
  label: string;
  description: string;
  color: string;
  fileCount: number;          // source (non-test) files matched
  testFileCount: number;      // all test files matched
  testedCount: number;        // source files that have a test
  coveragePct?: number;       // average line coverage
  unitTestCount: number;      // test files of type 'unit'
  integrationTestCount: number;
  e2eTestCount: number;
}

export interface ScanResult {
  projectRoot: string;
  projectName: string;
  scannedAt: string;
  modules: ModuleInfo[];
  totalCoverage?: CoverageInfo;
  features: FeatureResult[] | null;
  hasConfig: boolean;
  infraCount: number;  // files matched by config.ignore
  agent?: 'claude' | 'codex';  // configured AI agent
  testRunner?: string;          // detected test runner (vitest/jest)
  observability?: ObservabilityReport;
}

export interface ObservabilityCatalogItem {
  modulePath: string;
  level: string;
  format: 'structured' | 'unstructured' | 'mixed';
  frequency: 'low' | 'medium' | 'high';
  owner: string;
  recommendation: 'suppress' | 'downgrade level' | 'enrich fields' | 'add event';
}

export interface ObservabilityMetrics {
  noise_ratio: number;
  error_actionability: number;
  structured_completeness: number;
  coverage_of_key_flows: number;
}

export interface ObservabilityRuleSummary {
  trash: number;
  useful: number;
  critical: number;
}

export interface ObservabilityInsightItem {
  pattern: string;
  count: number;
  priority: 'high' | 'medium' | 'low';
  recommendation: 'suppress' | 'downgrade level' | 'enrich fields' | 'add event';
}

export interface ObservabilityReport {
  catalog: ObservabilityCatalogItem[];
  metrics: ObservabilityMetrics;
  classification: ObservabilityRuleSummary;
  topNoisyPatterns: ObservabilityInsightItem[];
  missingCriticalLogs: ObservabilityInsightItem[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const IGNORE_DIRS = [
  'node_modules', 'dist', 'build', '.git', '.next',
  'coverage', '.nyc_output', '__pycache__', '.venv',
];

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte'];
const TEST_PATTERNS = ['.test.', '.spec.', '__tests__', '.fixture.'];
const INFRA_FILE_PATTERNS = [/\.d\.ts$/];  // type declarations — never source files
const LOG_CALL_RE = /(?:console|logger|log)\.(trace|debug|info|warn|error|fatal)\s*\(([^\n;]*)/g;

interface ParsedLogCall {
  level: string;
  argsSnippet: string;
  message: string;
  structured: boolean;
  actionableError: boolean;
}

// ─── Glob pattern matcher ─────────────────────────────────────────────────────

/**
 * Converts a glob pattern (relative to project root) to a RegExp and tests relPath.
 * Supports: **, *, exact paths.
 */
function fileMatchesGlob(relPath: string, pattern: string): boolean {
  const normalPath = relPath.replace(/\\/g, '/');
  let regexStr = pattern
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]]/g, '\\$&')  // escape regex special chars (not *)
    .replace(/\*\*/g, '\x00')             // placeholder for **
    .replace(/\*/g, '[^/]*')              // * = anything except /
    .replace(/\x00\//g, '(.+/)?')        // **/ = zero or more directory segments
    .replace(/\x00/g, '.*');             // ** alone = anything
  try {
    return new RegExp('^' + regexStr + '$').test(normalPath);
  } catch {
    return false;
  }
}

/** Expand {a,b,c} brace alternatives into multiple patterns */
function expandBraces(pattern: string): string[] {
  const m = pattern.match(/\{([^{}]+)\}/);
  if (!m) return [pattern];
  const [full, contents] = m;
  return contents.split(',').flatMap(opt =>
    expandBraces(pattern.replace(full, opt.trim()))
  );
}

function fileMatchesFeature(relPath: string, include: string[]): boolean {
  return include.some(p => expandBraces(p).some(exp => fileMatchesGlob(relPath, exp)));
}

// Imports that indicate a real DB / infra dependency → integration test
const INTEGRATION_IMPORT_PATTERNS = [
  /test-helpers/,
  /pg-mem/,
  /createTestDb/,
  /\.\.\/server\/db\b/,
  /drizzle-orm/,
  /supertest/,
];

// Source file imports that suggest integration test is needed
const SOURCE_INTEGRATION_PATTERNS = [
  /drizzle-orm/,
  /\.\/db\b/,
  /\.\.\/db\b/,
  /repository/i,
  /Repository/,
  /\.\/storage\b/,
  /\.\.\/storage\b/,
  /prisma/i,
  /sequelize/i,
  /mongoose/i,
  /typeorm/i,
  /knex/i,
];

/** Recommend test type for a SOURCE file based on its imports */
function suggestTestType(filePath: string): 'unit' | 'integration' {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return SOURCE_INTEGRATION_PATTERNS.some(re => re.test(content))
      ? 'integration'
      : 'unit';
  } catch {
    return 'unit';
  }
}

/** Classify a test file into unit / integration / e2e based on location + imports */
function detectTestType(relativePath: string, filePath?: string): 'unit' | 'integration' | 'e2e' {
  const p = relativePath.replace(/\\/g, '/');
  if (p.startsWith('e2e/') || p.includes('/e2e/')) return 'e2e';

  // For files in tests/ dir: check imports to distinguish unit vs integration
  if ((p.startsWith('tests/') || p.includes('/tests/')) && filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const isIntegration = INTEGRATION_IMPORT_PATTERNS.some(re => re.test(content));
      return isIntegration ? 'integration' : 'unit';
    } catch {}
    return 'integration'; // fallback
  }

  return 'unit'; // co-located with source
}

// ─── Module detection helpers ─────────────────────────────────────────────────

function detectType(filePath: string): ModuleInfo['type'] {
  const p = filePath.toLowerCase();
  if (TEST_PATTERNS.some((t) => p.includes(t))) return 'test';
  if (p.includes('/component') || p.endsWith('.tsx') || p.endsWith('.jsx')) return 'component';
  if (p.includes('/service') || p.includes('/api')) return 'service';
  if (p.includes('/util') || p.includes('/helper') || p.includes('/lib')) return 'util';
  if (p.includes('config') || p.endsWith('.config.ts') || p.endsWith('.config.js')) return 'config';
  return 'other';
}

function countTestCases(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Match it( / it.only( / it.skip( / test( / test.only( / test.skip(
    const re = /\b(it|test)\s*[\.(]/g;
    return (content.match(re) || []).length;
  } catch {
    return 0;
  }
}

function extractDependencies(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const deps: string[] = [];
    const importRe = /(?:import|require)\s*(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRe.exec(content)) !== null) {
      const dep = match[1];
      if (dep.startsWith('.')) deps.push(dep);
    }
    return deps;
  } catch {
    return [];
  }
}



function detectLogOwner(relativePath: string): string {
  const p = relativePath.replace(/\\/g, '/');
  if (p.startsWith('src/server/')) return 'platform';
  if (p.startsWith('src/scanner/')) return 'data';
  if (p.startsWith('src/ui/')) return 'frontend';
  const seg = p.split('/')[0] || 'unknown';
  return seg.replace(/\.[^.]+$/, '');
}

function parseLogCalls(content: string): ParsedLogCall[] {
  const calls: ParsedLogCall[] = [];
  const re = new RegExp(LOG_CALL_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const level = (m[1] || '').toLowerCase();
    const argsSnippet = (m[2] || '').trim();
    const msgMatch = argsSnippet.match(/['"`]([^'"`]{3,200})['"`]/);
    const message = (msgMatch?.[1] || '').trim();
    const structured = /\{[^}]*\}/.test(argsSnippet);
    const actionableError =
      level === 'error' &&
      (/(id|status|code|path|url|feature|module|retry|hint|action)/i.test(argsSnippet) || structured);
    calls.push({ level, argsSnippet, message, structured, actionableError });
  }
  return calls;
}

function bucketFrequency(count: number): 'low' | 'medium' | 'high' {
  if (count >= 8) return 'high';
  if (count >= 3) return 'medium';
  return 'low';
}

function computeObservabilityReport(modules: ModuleInfo[], projectRoot: string): ObservabilityReport {
  const sourceModules = modules.filter(m => m.type !== 'test' && !m.isInfra);
  const catalog: ObservabilityCatalogItem[] = [];

  let totalLogs = 0;
  let noiseLogs = 0;
  let totalErrors = 0;
  let actionableErrors = 0;
  let requiredFieldsChecks = 0;
  let requiredFieldsHits = 0;

  const noisyMap = new Map<string, number>();
  const criticalCoverage = new Set<string>();

  for (const module of sourceModules) {
    let content = '';
    try {
      content = fs.readFileSync(module.path, 'utf-8');
    } catch {
      continue;
    }

    const calls = parseLogCalls(content);
    if (calls.length === 0) continue;

    const infoDebugCalls = calls.filter(c => c.level === 'info' || c.level === 'debug' || c.level === 'trace');
    const noisyCandidates = infoDebugCalls.filter(c =>
      !c.structured ||
      /(todo|temp|debug|test|ping|heartbeat|started|done|ok|loaded)/i.test(c.message || c.argsSnippet) ||
      c.message.length < 12
    );

    for (const c of calls) {
      totalLogs += 1;
      if (c.level === 'error') {
        totalErrors += 1;
        if (c.actionableError) actionableErrors += 1;
      }
      requiredFieldsChecks += 3;
      if (/(module|feature|service)/i.test(c.argsSnippet)) requiredFieldsHits += 1;
      if (/(event|type|action)/i.test(c.argsSnippet)) requiredFieldsHits += 1;
      if (/(requestId|traceId|correlationId|id)/i.test(c.argsSnippet)) requiredFieldsHits += 1;
    }

    noiseLogs += noisyCandidates.length;

    const format: ObservabilityCatalogItem['format'] =
      calls.every(c => c.structured) ? 'structured' : calls.some(c => c.structured) ? 'mixed' : 'unstructured';

    const levelRank: Record<string, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
    const level = calls.reduce((best, c) => levelRank[c.level] > levelRank[best] ? c.level : best, 'info');

    let recommendation: ObservabilityCatalogItem['recommendation'] = 'enrich fields';
    if (noisyCandidates.length >= Math.max(2, Math.ceil(calls.length * 0.6))) recommendation = 'suppress';
    else if (format !== 'structured') recommendation = 'enrich fields';
    else if (level === 'debug' || level === 'trace') recommendation = 'downgrade level';

    catalog.push({
      modulePath: module.relativePath,
      level,
      format,
      frequency: bucketFrequency(calls.length),
      owner: detectLogOwner(module.relativePath),
      recommendation,
    });

    for (const noisy of noisyCandidates) {
      const key = (noisy.message || noisy.argsSnippet || '[unknown]').slice(0, 90);
      noisyMap.set(key, (noisyMap.get(key) || 0) + 1);
    }

    if (calls.some(c => c.level === 'error' || c.level === 'warn')) {
      criticalCoverage.add(module.relativePath);
    }
  }

  const classifiedTrash = noiseLogs;
  const classifiedCritical = actionableErrors;
  const classifiedUseful = Math.max(0, totalLogs - classifiedTrash - classifiedCritical);

  const topNoisyPatterns: ObservabilityInsightItem[] = Array.from(noisyMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([pattern, count], i) => ({
      pattern,
      count,
      priority: i < 3 ? 'high' : i < 6 ? 'medium' : 'low',
      recommendation: count >= 3 ? 'suppress' : 'downgrade level',
    }));

  const missingCriticalLogs: ObservabilityInsightItem[] = sourceModules
    .filter(m => !criticalCoverage.has(m.relativePath))
    .slice(0, 8)
    .map((m, i) => ({
      pattern: `${m.relativePath}: нет warn/error событий`,
      count: 1,
      priority: i < 3 ? 'high' : 'medium',
      recommendation: 'add event',
    }));

  const totalSource = sourceModules.length || 1;
  const metrics: ObservabilityMetrics = {
    noise_ratio: totalLogs ? noiseLogs / totalLogs : 0,
    error_actionability: totalErrors ? actionableErrors / totalErrors : 0,
    structured_completeness: requiredFieldsChecks ? requiredFieldsHits / requiredFieldsChecks : 0,
    coverage_of_key_flows: criticalCoverage.size / totalSource,
  };

  return {
    catalog: catalog.sort((a, b) => a.modulePath.localeCompare(b.modulePath)),
    metrics,
    classification: {
      trash: classifiedTrash,
      useful: classifiedUseful,
      critical: classifiedCritical,
    },
    topNoisyPatterns,
    missingCriticalLogs,
  };
}

function loadCoverageMap(projectRoot: string): Map<string, CoverageInfo> {
  const coverageMap = new Map<string, CoverageInfo>();
  const v8Coverage = path.join(projectRoot, 'coverage', 'coverage-summary.json');
  if (fs.existsSync(v8Coverage)) {
    try {
      const raw = JSON.parse(fs.readFileSync(v8Coverage, 'utf-8'));
      for (const [filePath, data] of Object.entries(raw as Record<string, any>)) {
        if (filePath === 'total') continue;
        coverageMap.set(filePath, {
          lines: data.lines?.pct ?? 0,
          statements: data.statements?.pct ?? 0,
          functions: data.functions?.pct ?? 0,
          branches: data.branches?.pct ?? 0,
        });
      }
    } catch {
      // no coverage data
    }
  }
  return coverageMap;
}

// ─── Main scan function ───────────────────────────────────────────────────────

export async function scanProject(projectRoot: string): Promise<ScanResult> {
  const pkgPath = path.join(projectRoot, 'package.json');
  let projectName = path.basename(projectRoot);
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      projectName = pkg.name || projectName;
    } catch {}
  }

  const ignorePattern = IGNORE_DIRS.map((d) => `**/${d}/**`);
  const patterns = SOURCE_EXTENSIONS.map((ext) => `**/*${ext}`);

  const files = await glob(patterns, {
    cwd: projectRoot,
    ignore: ignorePattern,
    absolute: true,
  });

  const coverageMap = loadCoverageMap(projectRoot);

  const testFileSet = new Set(
    files.filter((f) => TEST_PATTERNS.some((t) => f.includes(t)))
  );

  const modules: ModuleInfo[] = files.map((filePath) => {
    const relativePath = path.relative(projectRoot, filePath);
    const name = path.basename(filePath, path.extname(filePath));
    const isTest = TEST_PATTERNS.some((t) => filePath.includes(t));

    let testFile: string | undefined;
    if (!isTest) {
      const base = filePath.replace(/\.[^.]+$/, '');
      const ext = path.extname(filePath);
      const candidates = new Set<string>([
        `${base}.test${ext}`,
        `${base}.spec${ext}`,
        path.join(path.dirname(filePath), '__tests__', `${name}.test${ext}`),
        path.join(path.dirname(filePath), '__tests__', `${name}.spec${ext}`),
        filePath.replace('/src/', '/tests/').replace(ext, `.test${ext}`),
        filePath.replace('/src/', '/tests/').replace(ext, `.spec${ext}`),
        filePath.replace('\\src\\', '\\tests\\').replace(ext, `.test${ext}`),
        filePath.replace('\\src\\', '\\tests\\').replace(ext, `.spec${ext}`),
      ]);

      const normalRel = relativePath.replace(/\\/g, '/');
      if (normalRel.startsWith('src/')) {
        const relFromSrc = normalRel.slice(4);
        const relNoExt = relFromSrc.replace(/\.[^.]+$/, '');
        candidates.add(path.join(projectRoot, 'tests', `${relNoExt}.test${ext}`));
        candidates.add(path.join(projectRoot, 'tests', `${relNoExt}.spec${ext}`));
        candidates.add(path.join(projectRoot, 'tests', `${name}.test${ext}`));
        candidates.add(path.join(projectRoot, 'tests', `${name}.spec${ext}`));

        if (name === 'index') {
          const parentName = path.basename(path.dirname(filePath));
          if (parentName) {
            candidates.add(path.join(projectRoot, 'tests', `${parentName}.test${ext}`));
            candidates.add(path.join(projectRoot, 'tests', `${parentName}.spec${ext}`));
            candidates.add(path.join(path.dirname(filePath), `${parentName}.test${ext}`));
            candidates.add(path.join(path.dirname(filePath), `${parentName}.spec${ext}`));
            candidates.add(path.join(path.dirname(filePath), '__tests__', `${parentName}.test${ext}`));
            candidates.add(path.join(path.dirname(filePath), '__tests__', `${parentName}.spec${ext}`));
          }
        }
      }

      testFile = Array.from(candidates).find((c) => testFileSet.has(c));
    }

    let size = 0;
    let mtime = 0;
    try { const st = fs.statSync(filePath); size = st.size; mtime = st.mtimeMs; } catch {}

    const isInfra = INFRA_FILE_PATTERNS.some(p => p.test(filePath));

    // testStale: source file is newer than its test file → tests may need updating
    let testStale = false;
    if (!isTest && testFile) {
      try {
        const testMtime = fs.statSync(testFile).mtimeMs;
        testStale = mtime > testMtime;
      } catch {}
    }

    return {
      id: relativePath.replace(/[/\\]/g, '_'),
      name,
      path: filePath,
      relativePath,
      type: detectType(filePath),
      hasTests: !!testFile || isTest,
      testFile: testFile ? path.relative(projectRoot, testFile) : undefined,
      coverage: coverageMap.get(filePath),
      size,
      dependencies: extractDependencies(filePath),
      featureKeys: [], // filled below
      isInfra,
      testType: isTest ? detectTestType(relativePath, filePath) : undefined,
      testCount: isTest ? countTestCases(filePath) : undefined,
      testStale: testStale || undefined,
      suggestedTestType: (!isTest && !isInfra) ? suggestTestType(filePath) : undefined,
    };
  });

  // ─── Fuzzy test pairing for centralized test directories ─────────────────────
  // Handles patterns like: server/routes/auth.routes.ts → tests/auth.test.ts
  // Also: WorkspaceSettings.tsx → workspace-settings.test.ts
  //
  // Strategy: strip extensions + .test/.spec + dashes/underscores + lowercase
  // and match source file's first name segment against test file's clean name.

  function cleanName(s: string): string {
    return s.toLowerCase().replace(/[_\-]/g, '');
  }

  function buildDashTokenVariants(token: string): string[] {
    const normalized = token.trim();
    if (!normalized) return [];

    const parts = normalized.split('-').filter(Boolean);
    if (parts.length <= 1) return [normalized];

    const variants = new Set<string>([normalized, ...parts]);

    // Add contiguous compound parts so "skills-page-form-schema"
    // also produces "form-schema" and "page-form".
    for (let start = 0; start < parts.length; start++) {
      for (let end = start + 1; end < parts.length; end++) {
        variants.add(parts.slice(start, end + 1).join('-'));
      }
    }

    return Array.from(variants);
  }

  // Build map: cleanName → test file absolute path (first match wins)
  // Indexes both the full first dot-segment AND each individual dash-part so that
  // e.g. "webhook-send-json.test.ts" is found when searching for "webhook".
  const testByCleanName = new Map<string, string>();
  for (const tf of testFileSet) {
    let base = path.basename(tf, path.extname(tf)); // e.g. "auth.test" or "webhook-send-json.test"
    base = base.replace(/\.(test|spec)$/, '');       // → "auth" | "webhook-send-json"
    const firstDotSeg = base.split('.')[0];          // first dot-segment
    const segsToIndex = buildDashTokenVariants(firstDotSeg);
    for (const seg of segsToIndex) {
      const clean = cleanName(seg);
      if (clean.length >= 3 && !testByCleanName.has(clean)) {
        testByCleanName.set(clean, tf);
      }
    }
  }

  // Second pass: for source modules still missing a test, try fuzzy match
  for (const m of modules) {
    if (m.hasTests || m.type === 'test') continue;
    // Try each dot-segment of the module name from left to right
    const segments = m.name.split('.');
    for (const seg of segments) {
      const clean = cleanName(seg);
      if (clean.length < 3) continue; // skip too-short segments (avoid false positives)
      const matched = testByCleanName.get(clean);
      if (matched) {
        m.hasTests = true;
        m.testFile = path.relative(projectRoot, matched);
        break;
      }
    }
  }

  // ─── Load viberadar.config.json ──────────────────────────────────────────────

  let config: VibeRadarConfig | null = null;
  const configPath = path.join(projectRoot, 'viberadar.config.json');
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {}

  let features: FeatureResult[] | null = null;

  if (config) {
    const featureEntries = Object.entries(config.features);
    const ignorePatterns = config.ignore ?? [];

    // Mark infra modules (OR with already-set isInfra from INFRA_FILE_PATTERNS)
    if (ignorePatterns.length > 0) {
      for (const m of modules) {
        m.isInfra = m.isInfra || fileMatchesFeature(m.relativePath, ignorePatterns);
      }
    }

    // Assign feature keys to each module
    for (const m of modules) {
      m.featureKeys = featureEntries
        .filter(([, f]) => fileMatchesFeature(m.relativePath, f.include))
        .map(([key]) => key);
    }

    const sourceModules = modules.filter(m => m.type !== 'test');
    const testModules   = modules.filter(m => m.type === 'test');

    // ── Propagate feature keys from source files → their fuzzy-matched test files ──
    // This ensures e.g. tests/auth.test.ts gets featureKey 'auth' even if
    // it's not directly matched by the feature's include patterns.
    const testModByRelPath = new Map<string, ModuleInfo>();
    for (const m of testModules) {
      testModByRelPath.set(m.relativePath.replace(/\\/g, '/'), m);
    }
    for (const m of sourceModules) {
      if (m.testFile && m.featureKeys.length > 0) {
        const testMod = testModByRelPath.get(m.testFile.replace(/\\/g, '/'));
        if (testMod) {
          for (const key of m.featureKeys) {
            if (!testMod.featureKeys.includes(key)) testMod.featureKeys.push(key);
          }
        }
      }
    }

    features = featureEntries.map(([key, feat]) => {
      const srcFiles = sourceModules.filter(m => m.featureKeys.includes(key));
      const tstFiles = testModules.filter(m => m.featureKeys.includes(key));
      const testedCount = srcFiles.filter(m => m.hasTests).length;
      const covFiles = srcFiles.filter(m => m.coverage?.lines !== undefined);
      const coveragePct = covFiles.length > 0
        ? covFiles.reduce((s, m) => s + m.coverage!.lines, 0) / covFiles.length
        : undefined;

      return {
        key,
        label: feat.label,
        description: feat.description || '',
        color: feat.color,
        fileCount: srcFiles.length,
        testFileCount: tstFiles.length,
        testedCount,
        coveragePct,
        unitTestCount:        tstFiles.filter(m => m.testType === 'unit').length,
        integrationTestCount: tstFiles.filter(m => m.testType === 'integration').length,
        e2eTestCount:         tstFiles.filter(m => m.testType === 'e2e').length,
      };
    });
  }

  // Detect test runner from package.json
  let testRunner: string | undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scripts = pkg.scripts || {};
    if (deps['vitest'] || scripts['test']?.includes('vitest')) testRunner = 'vitest';
    else if (deps['jest'] || scripts['test']?.includes('jest')) testRunner = 'jest';
  } catch {}

  return {
    projectRoot,
    projectName,
    scannedAt: new Date().toISOString(),
    modules,
    features,
    hasConfig: config !== null,
    infraCount: modules.filter(m => m.isInfra).length,
    agent: config?.agent,
    testRunner,
    observability: computeObservabilityReport(modules, projectRoot),
  };
}
