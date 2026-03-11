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
  missingFields: string[];
  noisyMessages: string[]; // конкретные шумные сниппеты из этого модуля
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

export type ModuleRiskTier = 'critical' | 'important' | 'normal';

export interface FailurePoint {
  type: 'empty-catch' | 'catch-no-log' | 'promise-catch-no-log'
      | 'http-no-error-handling' | 'db-no-error-handling'
      | 'throw-no-log' | 'error-check-no-log';
  lineApprox: number;
  snippet: string;
}

export interface MissingCriticalLogItem {
  modulePath: string;
  riskTier: ModuleRiskTier;
  riskScore: number;
  failurePoints: FailurePoint[];
  hasAnyWarnError: boolean;
  roleHint: string;
}

export interface ObservabilityReport {
  catalog: ObservabilityCatalogItem[];
  metrics: ObservabilityMetrics;
  classification: ObservabilityRuleSummary;
  topNoisyPatterns: ObservabilityInsightItem[];
  missingCriticalLogs: ObservabilityInsightItem[];
  missingCriticalLogsV2: MissingCriticalLogItem[];
  fieldGaps: Record<string, number>;
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
      if (dep.startsWith('.') || dep.startsWith('/') || dep.includes('/')) deps.push(dep);
    }
    return deps;
  } catch {
    return [];
  }
}

interface TsPathResolver {
  hasWildcard: boolean;
  keyPrefix: string;
  keySuffix: string;
  targets: string[];
}

interface TsPathConfig {
  baseUrlAbs: string;
  resolvers: TsPathResolver[];
}

function loadTsPathConfig(projectRoot: string): TsPathConfig {
  const defaultConfig: TsPathConfig = { baseUrlAbs: projectRoot, resolvers: [] };
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return defaultConfig;

  try {
    const raw = fs.readFileSync(tsconfigPath, 'utf-8');
    // Minimal tolerant parse: remove BOM and JS-style comments.
    const sanitized = raw
      .replace(/^\uFEFF/, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const json = JSON.parse(sanitized);
    const compilerOptions = json?.compilerOptions ?? {};
    const baseUrl = typeof compilerOptions.baseUrl === 'string'
      ? compilerOptions.baseUrl
      : '.';
    const paths = compilerOptions.paths && typeof compilerOptions.paths === 'object'
      ? compilerOptions.paths
      : {};

    const resolvers: TsPathResolver[] = Object.entries(paths)
      .filter(([, value]) => Array.isArray(value) && value.length > 0)
      .map(([key, value]) => {
        const keyStr = String(key);
        const wildcardIndex = keyStr.indexOf('*');
        if (wildcardIndex === -1) {
          return {
            hasWildcard: false,
            keyPrefix: keyStr,
            keySuffix: '',
            targets: (value as unknown[]).map(String),
          };
        }
        return {
          hasWildcard: true,
          keyPrefix: keyStr.slice(0, wildcardIndex),
          keySuffix: keyStr.slice(wildcardIndex + 1),
          targets: (value as unknown[]).map(String),
        };
      });

    return {
      baseUrlAbs: path.resolve(projectRoot, baseUrl),
      resolvers,
    };
  } catch {
    return defaultConfig;
  }
}

function expandImportBase(basePath: string): string[] {
  const clean = basePath.replace(/[?#].*$/, '');
  const ext = path.extname(clean).toLowerCase();
  if (SOURCE_EXTENSIONS.includes(ext)) {
    return [path.resolve(clean)];
  }

  return [
    path.resolve(clean),
    ...SOURCE_EXTENSIONS.map((e) => path.resolve(`${clean}${e}`)),
    ...SOURCE_EXTENSIONS.map((e) => path.resolve(path.join(clean, `index${e}`))),
  ];
}

function resolveImportCandidates(
  dep: string,
  fromFile: string,
  projectRoot: string,
  tsPathConfig: TsPathConfig,
): string[] {
  const raw = dep.trim();
  if (!raw) return [];

  const baseCandidates: string[] = [];

  if (raw.startsWith('.')) {
    baseCandidates.push(path.resolve(path.dirname(fromFile), raw));
  } else if (raw.startsWith('/')) {
    baseCandidates.push(path.resolve(projectRoot, '.' + raw));
  } else {
    for (const resolver of tsPathConfig.resolvers) {
      if (!resolver.hasWildcard) {
        if (raw !== resolver.keyPrefix) continue;
        for (const target of resolver.targets) {
          baseCandidates.push(path.resolve(tsPathConfig.baseUrlAbs, target));
        }
        continue;
      }

      if (!raw.startsWith(resolver.keyPrefix)) continue;
      if (resolver.keySuffix && !raw.endsWith(resolver.keySuffix)) continue;
      const wildcardValue = raw.slice(
        resolver.keyPrefix.length,
        raw.length - resolver.keySuffix.length
      );
      for (const target of resolver.targets) {
        baseCandidates.push(path.resolve(
          tsPathConfig.baseUrlAbs,
          target.replace('*', wildcardValue)
        ));
      }
    }

    if (raw.startsWith('src/') || raw.startsWith('client/') || raw.startsWith('server/')) {
      baseCandidates.push(path.resolve(projectRoot, raw));
    }
  }

  return baseCandidates.flatMap(expandImportBase);
}

function normalizeAbsPath(p: string): string {
  return path.resolve(p).replace(/\\/g, '/');
}



function detectLogOwner(relativePath: string): string {
  const p = relativePath.replace(/\\/g, '/');
  if (p.startsWith('src/server/')) return 'platform';
  if (p.startsWith('src/scanner/')) return 'data';
  if (p.startsWith('src/ui/')) return 'frontend';
  const seg = p.split('/')[0] || 'unknown';
  return seg.replace(/\.[^.]+$/, '');
}

// ─── Module risk classification ──────────────────────────────────────────────

const PATH_ROLE_RULES: Array<{ re: RegExp; tier: ModuleRiskTier; role: string; score: number }> = [
  // Critical — must have error handling
  { re: /\/routes?\//i,         tier: 'critical',  role: 'route handler',   score: 90 },
  { re: /\/controllers?\//i,   tier: 'critical',  role: 'controller',      score: 90 },
  { re: /\/api\//i,            tier: 'critical',  role: 'API endpoint',    score: 85 },
  { re: /\/middleware/i,       tier: 'critical',  role: 'middleware',       score: 85 },
  { re: /\/auth/i,             tier: 'critical',  role: 'auth module',     score: 95 },
  { re: /\/payment/i,          tier: 'critical',  role: 'payment module',  score: 95 },
  { re: /\/webhook/i,          tier: 'critical',  role: 'webhook handler', score: 90 },
  { re: /\/handler/i,          tier: 'critical',  role: 'handler',         score: 85 },
  { re: /server\/[^/]+\.ts$/i, tier: 'critical',  role: 'server module',   score: 80 },
  // Important — should have error handling
  { re: /\/services?\//i,      tier: 'important', role: 'service',         score: 70 },
  { re: /\/repository/i,      tier: 'important', role: 'data layer',      score: 70 },
  { re: /\/db\b/i,            tier: 'important', role: 'database layer',  score: 75 },
  { re: /\/storage/i,         tier: 'important', role: 'storage layer',   score: 70 },
  { re: /\/queue/i,           tier: 'important', role: 'queue handler',   score: 70 },
  { re: /\/worker/i,          tier: 'important', role: 'worker',          score: 70 },
  { re: /\/cron/i,            tier: 'important', role: 'cron job',        score: 65 },
  { re: /\/jobs?\//i,         tier: 'important', role: 'background job',  score: 65 },
  { re: /\/integration/i,     tier: 'important', role: 'integration',     score: 65 },
  { re: /\/client/i,          tier: 'important', role: 'external client', score: 65 },
  { re: /\/lib\//i,           tier: 'important', role: 'library module',  score: 55 },
];

const CONTENT_RISK_PATTERNS: Array<{ re: RegExp; boost: number }> = [
  { re: /\bfetch\s*\(/,                       boost: 15 },
  { re: /\baxios[\s.]/,                       boost: 15 },
  { re: /\bgot[\s.(]/,                        boost: 12 },
  { re: /\bprisma[\s.]/i,                     boost: 15 },
  { re: /\bmongoose[\s.]/i,                   boost: 15 },
  { re: /\bsequelize[\s.]/i,                  boost: 15 },
  { re: /\btypeorm[\s.]/i,                    boost: 15 },
  { re: /\bknex[\s.(]/i,                      boost: 15 },
  { re: /\bdrizzle/i,                         boost: 15 },
  { re: /\.query\s*\(\s*['"`](?:SELECT|INSERT|UPDATE|DELETE)/i, boost: 15 },
  { re: /\btry\s*\{/,                         boost: 5 },
  { re: /\.catch\s*\(/,                       boost: 8 },
  { re: /\bthrow\s+new\s+/,                   boost: 5 },
  { re: /\bfs\.\w+Sync\b/,                    boost: 8 },
  { re: /\bchild_process\b/,                  boost: 10 },
  { re: /\b(exec|spawn)\s*\(/,                boost: 10 },
  { re: /\bredis\b/i,                         boost: 12 },
  { re: /\b(amqp|rabbitmq)\b/i,               boost: 12 },
  { re: /\bstripe\b/i,                        boost: 20 },
  { re: /\bnodemailer\b|\bsendgrid\b/i,       boost: 10 },
];

function classifyModuleRole(relativePath: string, content: string): { tier: ModuleRiskTier; roleHint: string; baseScore: number } {
  const normPath = relativePath.replace(/\\/g, '/').toLowerCase();

  let tier: ModuleRiskTier = 'normal';
  let roleHint = 'utility';
  let baseScore = 20;

  for (const rule of PATH_ROLE_RULES) {
    if (rule.re.test(normPath)) {
      tier = rule.tier;
      roleHint = rule.role;
      baseScore = rule.score;
      break;
    }
  }

  let contentBoost = 0;
  for (const pat of CONTENT_RISK_PATTERNS) {
    if (pat.re.test(content)) contentBoost += pat.boost;
  }
  contentBoost = Math.min(contentBoost, 40);

  if (tier === 'normal' && contentBoost >= 25) {
    tier = 'important';
    roleHint = 'module with external calls';
  }

  return { tier, roleHint, baseScore: Math.min(100, baseScore + contentBoost) };
}

// ─── Failure point detection ─────────────────────────────────────────────────

function detectFailurePoints(content: string): FailurePoint[] {
  const points: FailurePoint[] = [];
  const lines = content.split('\n');

  function hasLogInRange(start: number, end: number): boolean {
    for (let i = start; i < Math.min(end, lines.length); i++) {
      if (/(?:console|logger|log)\.(warn|error|fatal)\s*\(/.test(lines[i])) return true;
    }
    return false;
  }

  function snip(lineIdx: number): string {
    const raw = (lines[lineIdx] || '').trim();
    return raw.length > 80 ? raw.slice(0, 77) + '...' : raw;
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // 1. Empty catch blocks
    if (/\bcatch\s*(\([^)]*\))?\s*\{\s*\}/.test(trimmed)) {
      points.push({ type: 'empty-catch', lineApprox: i + 1, snippet: snip(i) });
      continue; // don't also fire catch-no-log for same line
    }

    // 2. catch without logging
    if (/\bcatch\s*\(/.test(trimmed)) {
      if (!hasLogInRange(i, Math.min(i + 15, lines.length))) {
        points.push({ type: 'catch-no-log', lineApprox: i + 1, snippet: snip(i) });
      }
    }

    // 3. .catch() without logging
    if (/\.catch\s*\(/.test(trimmed) && !/(?:console|logger|log)\.\w+\s*\(/.test(trimmed)) {
      if (!hasLogInRange(i, Math.min(i + 10, lines.length))) {
        points.push({ type: 'promise-catch-no-log', lineApprox: i + 1, snippet: snip(i) });
      }
    }

    // 4. fetch/axios without nearby try/catch
    if (/\b(fetch|axios)\s*[.(]/.test(trimmed) || /\baxios\.\w+\s*\(/.test(trimmed)) {
      let hasTryCatch = false;
      for (let j = Math.max(0, i - 3); j < Math.min(i + 8, lines.length); j++) {
        if (/\btry\s*\{/.test(lines[j]) || /\.catch\s*\(/.test(lines[j])) { hasTryCatch = true; break; }
      }
      if (!hasTryCatch) {
        points.push({ type: 'http-no-error-handling', lineApprox: i + 1, snippet: snip(i) });
      }
    }

    // 5. DB operations without nearby try/catch
    if (/\b(prisma|mongoose|sequelize|typeorm|knex|drizzle)\b.*\.\w+\s*\(/i.test(trimmed) ||
        /\.query\s*\(\s*['"`](?:SELECT|INSERT|UPDATE|DELETE)/i.test(trimmed)) {
      let hasTryCatch = false;
      for (let j = Math.max(0, i - 3); j < Math.min(i + 8, lines.length); j++) {
        if (/\btry\s*\{/.test(lines[j]) || /\.catch\s*\(/.test(lines[j])) { hasTryCatch = true; break; }
      }
      if (!hasTryCatch) {
        points.push({ type: 'db-no-error-handling', lineApprox: i + 1, snippet: snip(i) });
      }
    }

    // 6. throw without preceding logger.error
    if (/\bthrow\s+new\s+\w*Error/.test(trimmed)) {
      if (!hasLogInRange(Math.max(0, i - 3), i + 1)) {
        points.push({ type: 'throw-no-log', lineApprox: i + 1, snippet: snip(i) });
      }
    }

    // 7. if (err) / if (error) without logging
    if (/\bif\s*\(\s*!?(err|error|e)\b/.test(trimmed) && !/\.test\s*\(/.test(trimmed)) {
      if (!hasLogInRange(i, Math.min(i + 8, lines.length))) {
        points.push({ type: 'error-check-no-log', lineApprox: i + 1, snippet: snip(i) });
      }
    }
  }

  // Dedup by line: prefer empty-catch over catch-no-log
  const seen = new Map<number, FailurePoint>();
  for (const fp of points) {
    const existing = seen.get(fp.lineApprox);
    if (!existing || fp.type === 'empty-catch') {
      seen.set(fp.lineApprox, fp);
    }
  }

  return Array.from(seen.values()).sort((a, b) => a.lineApprox - b.lineApprox).slice(0, 10);
}

function parseLogCalls(content: string): ParsedLogCall[] {
  const calls: ParsedLogCall[] = [];
  const lines = content.split('\n');
  const re = new RegExp(LOG_CALL_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const level = (m[1] || '').toLowerCase();
    let argsSnippet = (m[2] || '').trim();

    // Multi-line call: argsSnippet captured only "{" (object starts but doesn't close on same line).
    // Scan up to 10 subsequent lines to find the closing }, "message string" pattern.
    // e.g. logger.debug({ key: val }, "[MODULE] Human readable message")
    if (/^\{[^}]*$/.test(argsSnippet)) {
      const callLine = content.slice(0, m.index).split('\n').length; // 1-based line index
      const lookahead = lines.slice(callLine, callLine + 10).join(' ');
      const afterClose = lookahead.match(/\}\s*,\s*['"`]([^'"`]{3,200})['"`]/);
      if (afterClose) {
        argsSnippet = argsSnippet + ` ... "${afterClose[1]}"`;
      }
    }

    const msgMatch = argsSnippet.match(/['"`]([^'"`]{3,200})['"`]/);
    const message = (msgMatch?.[1] || '').trim();
    const structured = /^\{/.test((m[2] || '').trim()) || /\{[^}]*\}/.test(argsSnippet);
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

  // 8 required fields from logging-standard.md (timestamp/level/span_id set by logger framework)
  const REQUIRED_FIELDS: { name: string; re: RegExp; warnErrorOnly?: boolean }[] = [
    { name: 'service',    re: /\b(service|serviceName|service_name)\b/i },
    { name: 'env',        re: /\b(env|environment|NODE_ENV)\b/i },
    { name: 'trace_id',   re: /\b(trace_?[Ii]d|traceId|traceid)\b/i },
    { name: 'request_id', re: /\b(request_?[Ii]d|requestId|req_?[Ii]d|correlationId|correlation_id)\b/i },
    { name: 'event_name', re: /\b(event_?[Nn]ame|eventName|event_type|eventType)\b/i },
    { name: 'outcome',    re: /\b(outcome|result|status)\b/i },
    { name: 'error_code', re: /\b(error_?[Cc]ode|errorCode|err_?code)\b/i, warnErrorOnly: true },
    { name: 'user_id',    re: /\b(user_?[Ii]d|userId|user_?[Hh]ash|userHash)\b/i },
  ];
  const fieldGapCounts: Record<string, number> = {};
  for (const f of REQUIRED_FIELDS) fieldGapCounts[f.name] = 0;

  const noisyMap = new Map<string, number>();
  const criticalCoverage = new Set<string>();
  const moduleFailureData = new Map<string, { content: string; failurePoints: FailurePoint[] }>();

  for (const module of sourceModules) {
    let content = '';
    try {
      content = fs.readFileSync(module.path, 'utf-8');
    } catch {
      continue;
    }

    // Detect failure points BEFORE skipping modules with no log calls
    const failurePoints = detectFailurePoints(content);
    if (failurePoints.length > 0) {
      moduleFailureData.set(module.relativePath, { content, failurePoints });
    }

    const calls = parseLogCalls(content);
    if (calls.length === 0) continue;

    const infoDebugCalls = calls.filter(c => c.level === 'info' || c.level === 'debug' || c.level === 'trace');
    const noisyCandidates = infoDebugCalls.filter(c =>
      !c.structured ||
      /(todo|temp|debug|test|ping|heartbeat|started|done|ok|loaded)/i.test(c.message || c.argsSnippet) ||
      c.message.length < 12
    );

    const moduleMissingFields = new Set<string>();

    for (const c of calls) {
      totalLogs += 1;
      if (c.level === 'error') {
        totalErrors += 1;
        if (c.actionableError) actionableErrors += 1;
      }

      const isWarnError = c.level === 'warn' || c.level === 'error' || c.level === 'fatal';
      const applicableFields = REQUIRED_FIELDS.filter(f => !f.warnErrorOnly || isWarnError);
      requiredFieldsChecks += applicableFields.length;
      for (const field of applicableFields) {
        if (field.re.test(c.argsSnippet)) {
          requiredFieldsHits += 1;
        } else {
          fieldGapCounts[field.name] += 1;
          moduleMissingFields.add(field.name);
        }
      }
    }

    noiseLogs += noisyCandidates.length;

    const format: ObservabilityCatalogItem['format'] =
      calls.every(c => c.structured) ? 'structured' : calls.some(c => c.structured) ? 'mixed' : 'unstructured';

    const levelRank: Record<string, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
    const level = calls.reduce((best, c) => levelRank[c.level] > levelRank[best] ? c.level : best, 'info');

    let recommendation: ObservabilityCatalogItem['recommendation'] = 'enrich fields';
    if (noisyCandidates.length >= Math.max(2, Math.ceil(calls.length * 0.6))) recommendation = 'suppress';
    else if (format !== 'structured') recommendation = 'enrich fields';
    else if (moduleMissingFields.size > 0) recommendation = 'enrich fields';
    else if (level === 'debug' || level === 'trace') recommendation = 'downgrade level';

    // Сохраняем конкретные шумные сниппеты (только INFO/DEBUG/TRACE) для точных промптов агенту.
    // Предпочитаем человекочитаемое сообщение (c.message); fallback на argsSnippet,
    // но отфильтровываем мусор типа "{" который появляется при многострочных вызовах.
    const noisyMessages = noisyCandidates
      .map(c => {
        if (c.message && c.message.length >= 5) return c.message;
        const s = c.argsSnippet.trim();
        // Skip obvious code fragments that aren't human-readable messages
        if (s.length < 5 || /^\{[\s,]*$/.test(s) || /^\{[\s\n]*$/.test(s)) return '';
        return s.slice(0, 80);
      })
      .filter(s => s.length >= 5)
      .filter((v, i, arr) => arr.indexOf(v) === i) // unique
      .slice(0, 6);

    catalog.push({
      modulePath: module.relativePath,
      level,
      format,
      frequency: bucketFrequency(calls.length),
      owner: detectLogOwner(module.relativePath),
      recommendation,
      missingFields: Array.from(moduleMissingFields).sort(),
      noisyMessages,
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

  // ── Build missingCriticalLogsV2 with risk classification + failure points ──
  const missingCriticalLogsV2: MissingCriticalLogItem[] = [];
  for (const module of sourceModules) {
    const fpData = moduleFailureData.get(module.relativePath);
    const hasCoverage = criticalCoverage.has(module.relativePath);
    const failurePoints = fpData?.failurePoints || [];

    // Include if: no warn/error, OR has unlogged failure points
    if (!hasCoverage || failurePoints.length > 0) {
      let content = fpData?.content || '';
      if (!content) {
        try { content = fs.readFileSync(module.path, 'utf-8'); } catch { continue; }
      }

      const cls = classifyModuleRole(module.relativePath, content);

      // Skip normal-tier with zero failure points that already have some coverage
      if (cls.tier === 'normal' && failurePoints.length === 0 && hasCoverage) continue;

      const coveragePenalty = hasCoverage ? -15 : 0;
      const fpBoost = Math.min(failurePoints.length * 5, 25);
      const riskScore = Math.max(0, Math.min(100, cls.baseScore + fpBoost + coveragePenalty));

      missingCriticalLogsV2.push({
        modulePath: module.relativePath,
        riskTier: cls.tier,
        riskScore,
        failurePoints,
        hasAnyWarnError: hasCoverage,
        roleHint: cls.roleHint,
      });
    }
  }
  const tierOrder: Record<ModuleRiskTier, number> = { critical: 0, important: 1, normal: 2 };
  missingCriticalLogsV2.sort((a, b) => {
    if (a.riskTier !== b.riskTier) return tierOrder[a.riskTier] - tierOrder[b.riskTier];
    return b.riskScore - a.riskScore;
  });

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
    missingCriticalLogsV2,
    fieldGaps: fieldGapCounts,
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

  // ─── Import-based source<->test linking ─────────────────────────────────────
  // Handles aggregated test files that cover multiple source modules where
  // filename heuristics alone are insufficient.
  const tsPathConfig = loadTsPathConfig(projectRoot);
  const sourceByAbsPath = new Map<string, ModuleInfo>();
  const testModules = modules.filter((m) => m.type === 'test');
  for (const m of modules) {
    if (m.type === 'test') continue;
    sourceByAbsPath.set(normalizeAbsPath(m.path), m);
  }

  for (const testMod of testModules) {
    for (const dep of testMod.dependencies) {
      const candidates = resolveImportCandidates(dep, testMod.path, projectRoot, tsPathConfig);
      for (const cand of candidates) {
        const srcMod = sourceByAbsPath.get(normalizeAbsPath(cand));
        if (!srcMod) continue;
        srcMod.hasTests = true;
        if (!srcMod.testFile) {
          srcMod.testFile = path.relative(projectRoot, testMod.path);
        }
      }
    }
  }

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
