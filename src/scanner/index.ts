import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import * as yaml from 'js-yaml';

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
  routes?: string[];  // URL paths for doc screenshots: ["/login", "/profile"]
}

export interface VibeRadarConfig {
  version: string;
  agent?: 'claude' | 'codex';  // AI agent CLI to use
  ignore?: string[];   // glob patterns for infra/system files (excluded from unmapped)
  features: Record<string, FeatureConfig>;
  services?: ServiceMapConfig;
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
  routes?: string[];          // URL paths for doc screenshots
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
  documentation?: DocumentationReport;
  serviceMap?: ServiceMapReport;
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
  featureKeys: string[];
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
  byFeature?: FeatureObservabilityResult[];
}

export interface FeatureObservabilityResult {
  key: string;
  label: string;
  color: string;
  score: number;
  metrics: ObservabilityMetrics;
  catalogCount: number;
  noisyPatternCount: number;
  missingCriticalCount: number;
  fieldGapCount: number;
  failurePointCount: number;
}

// ─── Documentation report types ─────────────────────────────────────────────

export interface FeatureDocStatus {
  key: string;
  label: string;
  color: string;
  docExists: boolean;
  docPath: string;                // 'docs/features/{key}/v{N}.md' — latest version
  docMtime: number | null;        // mtimeMs of the latest version file
  maxSourceMtime: number;         // max mtimeMs across feature source files
  isStale: boolean;               // maxSourceMtime > docMtime
  changedFilesSinceDoc: string[]; // relativePaths of source files newer than doc
  sourceFileCount: number;
  docSizeBytes: number | null;
  lastUpdated: string | null;     // ISO date string
  latestVersion: number | null;   // current version number (1, 2, 3, ...)
  docVersions: string[];          // all version paths relative to project root
}

export interface DocumentationReport {
  docsDir: string;
  features: FeatureDocStatus[];
  totalFeatures: number;
  freshCount: number;
  staleCount: number;
  missingCount: number;
}

// ─── Service Map types ────────────────────────────────────────────────────────

export type ServiceCategory =
  | 'database' | 'cache' | 'queue' | 'storage'
  | 'external-api' | 'internal-service' | 'worker' | 'gateway';

export type ServiceSource = 'autodiscovery' | 'config' | 'both';

export interface ServiceNode {
  id: string;
  label: string;
  category: ServiceCategory;
  source: ServiceSource;
  host?: string;
  port?: number;
  healthCheck?: HealthCheckDef;
  alerts?: AlertHint[];
  icon?: string;
  color?: string;
  group?: string;
}

export interface ServiceEdge {
  from: string;
  to: string;
  label?: string;
  type: 'sync' | 'async' | 'pubsub' | 'data';
  critical?: boolean;
}

export interface PipelineStep {
  id: string;
  label: string;
  serviceId?: string;
  description?: string;
}

export interface PipelineDef {
  id: string;
  label: string;
  description?: string;
  steps: PipelineStep[];
  triggers?: string[];
}

export interface HealthCheckDef {
  type: 'tcp' | 'http' | 'command';
  target: string;
  interval?: string;
}

export interface AlertHint {
  metric: string;
  severity: 'critical' | 'warning' | 'info';
  description: string;
}

export interface ServiceMapReport {
  nodes: ServiceNode[];
  edges: ServiceEdge[];
  pipelines: PipelineDef[];
  autodiscovery: {
    dockerServices: number;
    envConnections: number;
    npmServices: number;
    workerFiles: number;
  };
}

export interface ServiceMapConfig {
  nodes?: Partial<ServiceNode>[];
  edges?: ServiceEdge[];
  pipelines?: PipelineDef[];
  autodiscovery?: {
    dockerCompose?: boolean;
    envFiles?: boolean;
    npmDeps?: boolean;
    workers?: boolean;
  };
  workerPatterns?: string[];
  routePatterns?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const IGNORE_DIRS = [
  'node_modules', 'dist', 'build', '.git', '.next',
  'coverage', '.nyc_output', '__pycache__', '.venv',
];

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte'];
const TEST_PATTERNS = ['.test.', '.spec.', '__tests__', '.fixture.'];
const INFRA_FILE_PATTERNS = [/\.d\.ts$/];  // type declarations — never source files
const LOG_CALL_RE = /\b(console|logger|log(?:ger)?|winston|pino|bunyan|\w*[Ll]ogger|\w*[Ll]og)\.(trace|debug|info|warn|error|fatal)\s*\(([^\n;]*)/g;

interface ParsedLogCall {
  level: string;
  argsSnippet: string;
  message: string;
  structured: boolean;
  actionableError: boolean;
  /** true when the call site is console.* (not a custom/framework logger) */
  isConsoleCall: boolean;
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
      // Any identifier.warn/error/fatal( — catches custom loggers (authLogger, winston, pino, etc.)
      if (/\b\w+\.(warn|error|fatal)\s*\(/.test(lines[i])) return true;
      // Chained multi-line call: logger\n  .error(...) — leading dot on its own line
      if (/^\s*\.(warn|error|fatal)\s*\(/.test(lines[i])) return true;
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
      if (!hasLogInRange(i, Math.min(i + 20, lines.length))) {
        points.push({ type: 'catch-no-log', lineApprox: i + 1, snippet: snip(i) });
      }
    }

    // 3. .catch() without logging
    if (/\.catch\s*\(/.test(trimmed) && !/(?:console|logger|log)\.\w+\s*\(/.test(trimmed)) {
      if (!hasLogInRange(i, Math.min(i + 15, lines.length))) {
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
    // 25-line lookback: structured logger.error({ ...context }, "msg") can span 16–20 lines.
    if (/\bthrow\s+new\s+\w*Error/.test(trimmed)) {
      if (!hasLogInRange(Math.max(0, i - 25), i + 1)) {
        points.push({ type: 'throw-no-log', lineApprox: i + 1, snippet: snip(i) });
      }
    }

    // 7. if (err) / if (error) without logging
    if (/\bif\s*\(\s*!?(err|error|e)\b/.test(trimmed) && !/\.test\s*\(/.test(trimmed)) {
      if (!hasLogInRange(i, Math.min(i + 12, lines.length))) {
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

  return Array.from(seen.values()).sort((a, b) => a.lineApprox - b.lineApprox);
}

function parseLogCalls(content: string): ParsedLogCall[] {
  const calls: ParsedLogCall[] = [];
  const lines = content.split('\n');
  const re = new RegExp(LOG_CALL_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const isConsoleCall = (m[1] || '').toLowerCase() === 'console';
    const level = (m[2] || '').toLowerCase();
    let argsSnippet = (m[3] || '').trim();

    // Multi-line call: object arg may start on the same line (argsSnippet = "{...") OR
    // on the next line (argsSnippet = "" when logger.error(\n  { ... })).
    // Expand up to 25 subsequent lines so field-name regexes can match.
    const callLine = content.slice(0, m.index).split('\n').length; // 1-based line index
    if (/^\{[^}]*$/.test(argsSnippet)) {
      // Case 1: opening { on same line, body continues below
      const body = lines.slice(callLine, callLine + 25).join(' ');
      argsSnippet = (argsSnippet + ' ' + body).slice(0, 800);
    } else if (argsSnippet === '') {
      // Case 2: first arg is on the next line — check if it's an object
      const nextLine = (lines[callLine] || '').trim();
      if (nextLine.startsWith('{')) {
        const body = lines.slice(callLine, callLine + 25).join(' ');
        argsSnippet = body.slice(0, 800);
      }
    }

    const msgMatch = argsSnippet.match(/['"`]([^'"`]{3,200})['"`]/);
    const message = (msgMatch?.[1] || '').trim();
    const structured = /^\{/.test((m[3] || '').trim()) || /\{[^}]*\}/.test(argsSnippet);
    const actionableError =
      level === 'error' &&
      (/(id|status|code|path|url|feature|module|retry|hint|action)/i.test(argsSnippet) || structured);
    calls.push({ level, argsSnippet, message, structured, actionableError, isConsoleCall });
  }
  return calls;
}

function bucketFrequency(count: number): 'low' | 'medium' | 'high' {
  if (count >= 8) return 'high';
  if (count >= 3) return 'medium';
  return 'low';
}

function computeObservabilityReport(modules: ModuleInfo[], projectRoot: string, configFeatures?: Record<string, { label: string; color: string; include: string[] }>): ObservabilityReport {
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

  // Fields auto-injected by custom logger wrappers (not visible at call site).
  // Custom loggers (structuredLogger, winston, pino, etc.) typically inject service/env/
  // trace_id/request_id from their own config. We only penalise console.* calls for these.
  const FRAMEWORK_AUTO_FIELDS = new Set(['service', 'env', 'trace_id', 'request_id']);

  const noisyMap = new Map<string, number>();
  const criticalCoverage = new Set<string>();
  const moduleFailureData = new Map<string, { content: string; failurePoints: FailurePoint[] }>();
  // Per-module stats for efficient per-feature aggregation
  const moduleStats = new Map<string, { totalLogs: number; noiseLogs: number; totalErrors: number; actionableErrors: number; fieldChecks: number; fieldHits: number; hasCritCov: boolean }>();

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
    let mTotalLogs = 0, mTotalErrors = 0, mActionableErrors = 0, mFieldChecks = 0, mFieldHits = 0;

    for (const c of calls) {
      totalLogs += 1;
      mTotalLogs += 1;
      if (c.level === 'error') {
        totalErrors += 1;
        mTotalErrors += 1;
        if (c.actionableError) { actionableErrors += 1; mActionableErrors += 1; }
      }

      const isWarnError = c.level === 'warn' || c.level === 'error' || c.level === 'fatal';
      const applicableFields = REQUIRED_FIELDS.filter(f => !f.warnErrorOnly || isWarnError);
      requiredFieldsChecks += applicableFields.length;
      mFieldChecks += applicableFields.length;

      // If the call spreads a context/log helper, assume it provides all standard fields.
      // e.g. ...getFailureLogContext(...), ...buildLogCtx(...), ...logContext, ...ctx
      // We can't statically resolve what helpers return, so treat as fully compliant.
      const hasContextSpread = /\.\.\.\s*(?:get\w*(?:Log|Failure|Error|Request|Trace|Auth)?Context\w*\s*\(|build\w*(?:Log|Context)\w*\s*\(|\w*[Ll]og[Cc]ontext\b|\w*[Cc]tx\b)/
        .test(c.argsSnippet);

      for (const field of applicableFields) {
        // Non-console loggers (structuredLogger, pino, winston, etc.) inject service/env/
        // trace_id/request_id from their own config — don't penalise missing them at call site.
        const autoProvided = !c.isConsoleCall && FRAMEWORK_AUTO_FIELDS.has(field.name);
        if (hasContextSpread || autoProvided || field.re.test(c.argsSnippet)) {
          requiredFieldsHits += 1;
          mFieldHits += 1;
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
      featureKeys: module.featureKeys || [],
    });

    for (const noisy of noisyCandidates) {
      const key = (noisy.message || noisy.argsSnippet || '[unknown]').slice(0, 90);
      noisyMap.set(key, (noisyMap.get(key) || 0) + 1);
    }

    const hasCritCov = calls.some(c => c.level === 'error' || c.level === 'warn');
    if (hasCritCov) {
      criticalCoverage.add(module.relativePath);
    }

    moduleStats.set(module.relativePath, {
      totalLogs: mTotalLogs, noiseLogs: noisyCandidates.length,
      totalErrors: mTotalErrors, actionableErrors: mActionableErrors,
      fieldChecks: mFieldChecks, fieldHits: mFieldHits, hasCritCov,
    });
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

  // ── Build per-feature observability results ──
  let byFeature: FeatureObservabilityResult[] | undefined;
  if (configFeatures) {
    const sortedCatalog = catalog.sort((a, b) => a.modulePath.localeCompare(b.modulePath));
    // Build module→featureKeys lookup for missingCriticalLogsV2 matching
    const moduleFeatureMap = new Map<string, string[]>();
    for (const m of sourceModules) moduleFeatureMap.set(m.relativePath, m.featureKeys || []);

    byFeature = Object.entries(configFeatures).map(([key, feat]) => {
      const fCatalog = sortedCatalog.filter(c => c.featureKeys.includes(key));
      const fMissing = missingCriticalLogsV2.filter(m => (moduleFeatureMap.get(m.modulePath) || []).includes(key));
      const fSourceModules = sourceModules.filter(m => (m.featureKeys || []).includes(key));

      // Aggregate from pre-computed per-module stats (no file re-reading)
      let fTotalLogs = 0, fNoiseLogs = 0, fTotalErrors = 0, fActionableErrors = 0;
      let fFieldChecks = 0, fFieldHits = 0;
      let fCritCovCount = 0;

      for (const m of fSourceModules) {
        const s = moduleStats.get(m.relativePath);
        if (!s) continue;
        fTotalLogs += s.totalLogs;
        fNoiseLogs += s.noiseLogs;
        fTotalErrors += s.totalErrors;
        fActionableErrors += s.actionableErrors;
        fFieldChecks += s.fieldChecks;
        fFieldHits += s.fieldHits;
        if (s.hasCritCov) fCritCovCount++;
      }

      const fTotalSource = fSourceModules.length || 1;
      const fMetrics: ObservabilityMetrics = {
        noise_ratio: fTotalLogs ? fNoiseLogs / fTotalLogs : 0,
        error_actionability: fTotalErrors ? fActionableErrors / fTotalErrors : 0,
        structured_completeness: fFieldChecks ? fFieldHits / fFieldChecks : 0,
        coverage_of_key_flows: fCritCovCount / fTotalSource,
      };

      const score = Math.round(
        (1 - fMetrics.noise_ratio) * 25 +
        fMetrics.structured_completeness * 25 +
        fMetrics.error_actionability * 25 +
        fMetrics.coverage_of_key_flows * 25
      );

      return {
        key,
        label: feat.label,
        color: feat.color,
        score,
        metrics: fMetrics,
        catalogCount: fCatalog.length,
        noisyPatternCount: fCatalog.reduce((s, c) => s + c.noisyMessages.length, 0),
        missingCriticalCount: fMissing.length,
        fieldGapCount: fCatalog.reduce((s, c) => s + c.missingFields.length, 0),
        failurePointCount: fMissing.reduce((s, m) => s + m.failurePoints.length, 0),
      };
    });
  }

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
    byFeature,
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

// ─── Documentation report ────────────────────────────────────────────────────

function computeDocumentationReport(
  modules: ModuleInfo[],
  projectRoot: string,
  configFeatures?: Record<string, FeatureConfig>,
): DocumentationReport | undefined {
  if (!configFeatures) return undefined;

  const docsDir = path.join(projectRoot, 'docs', 'features');
  const featureEntries = Object.entries(configFeatures);
  let freshCount = 0;
  let staleCount = 0;
  let missingCount = 0;

  const features: FeatureDocStatus[] = featureEntries.map(([key, fc]) => {
    const sourceModules = modules.filter(
      m => m.type !== 'test' && !m.isInfra && m.featureKeys.includes(key),
    );

    // Collect mtimes of source files
    const mtimes: number[] = [];
    for (const m of sourceModules) {
      try { mtimes.push(fs.statSync(m.path).mtimeMs); } catch { /* deleted */ }
    }
    const maxSourceMtime = mtimes.length > 0 ? Math.max(...mtimes) : 0;

    // Versioned docs: docs/features/{key}/v1.md, v2.md, ...
    const docDir = path.join(docsDir, key);
    let docExists = false;
    let docMtime: number | null = null;
    let docSizeBytes: number | null = null;
    let latestVersion: number | null = null;
    let docVersions: string[] = [];
    let latestDocFilePath: string | null = null;

    try {
      const entries = fs.readdirSync(docDir);
      const versionFiles = entries
        .map(e => { const m = e.match(/^v(\d+)\.md$/); return m ? { file: e, n: parseInt(m[1], 10) } : null; })
        .filter((x): x is { file: string; n: number } => x !== null)
        .sort((a, b) => a.n - b.n);

      if (versionFiles.length > 0) {
        docVersions = versionFiles.map(v => `docs/features/${key}/${v.file}`);
        const latest = versionFiles[versionFiles.length - 1];
        latestVersion = latest.n;
        latestDocFilePath = path.join(docDir, latest.file);
        const st = fs.statSync(latestDocFilePath);
        docExists = true;
        docMtime = st.mtimeMs;
        docSizeBytes = st.size;
      }
    } catch { /* dir does not exist */ }

    const docRelPath = latestDocFilePath
      ? `docs/features/${key}/v${latestVersion}.md`
      : `docs/features/${key}/v1.md`;

    const isStale = docExists && docMtime !== null && maxSourceMtime > docMtime;
    const isMissing = !docExists;

    const changedFilesSinceDoc: string[] = [];
    if (docExists && docMtime !== null) {
      for (const m of sourceModules) {
        try {
          if (fs.statSync(m.path).mtimeMs > docMtime) {
            changedFilesSinceDoc.push(m.relativePath);
          }
        } catch { /* skip */ }
      }
    }

    if (isMissing) missingCount++;
    else if (isStale) staleCount++;
    else freshCount++;

    return {
      key,
      label: fc.label,
      color: fc.color,
      docExists,
      docPath: docRelPath,
      docMtime,
      maxSourceMtime,
      isStale,
      changedFilesSinceDoc,
      sourceFileCount: sourceModules.length,
      docSizeBytes,
      lastUpdated: docMtime ? new Date(docMtime).toISOString() : null,
      latestVersion,
      docVersions,
    };
  });

  return {
    docsDir,
    features,
    totalFeatures: featureEntries.length,
    freshCount,
    staleCount,
    missingCount,
  };
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
        routes: feat.routes,
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
    observability: computeObservabilityReport(modules, projectRoot, config?.features),
    documentation: computeDocumentationReport(modules, projectRoot, config?.features),
    serviceMap: computeServiceMapReport(projectRoot, config?.services),
  };
}

// ─── Service Map autodiscovery ───────────────────────────────────────────────

const DOCKER_IMAGE_MAP: Record<string, { category: ServiceCategory; label: string; icon: string }> = {
  postgres:   { category: 'database',  label: 'PostgreSQL',  icon: '🐘' },
  postgresql: { category: 'database',  label: 'PostgreSQL',  icon: '🐘' },
  mysql:      { category: 'database',  label: 'MySQL',       icon: '🐬' },
  mariadb:    { category: 'database',  label: 'MariaDB',     icon: '🐬' },
  mongo:      { category: 'database',  label: 'MongoDB',     icon: '🍃' },
  redis:      { category: 'cache',     label: 'Redis',       icon: '⚡' },
  valkey:     { category: 'cache',     label: 'Valkey',      icon: '⚡' },
  memcached:  { category: 'cache',     label: 'Memcached',   icon: '⚡' },
  rabbitmq:   { category: 'queue',     label: 'RabbitMQ',    icon: '🐰' },
  kafka:      { category: 'queue',     label: 'Kafka',       icon: '📨' },
  nats:       { category: 'queue',     label: 'NATS',        icon: '📨' },
  minio:      { category: 'storage',   label: 'MinIO',       icon: '📦' },
  qdrant:     { category: 'database',  label: 'Qdrant',      icon: '🔍' },
  weaviate:   { category: 'database',  label: 'Weaviate',    icon: '🔍' },
  elasticsearch: { category: 'database', label: 'Elasticsearch', icon: '🔎' },
  opensearch: { category: 'database',  label: 'OpenSearch',  icon: '🔎' },
  clickhouse: { category: 'database',  label: 'ClickHouse',  icon: '🏠' },
  nginx:      { category: 'gateway',   label: 'Nginx',       icon: '🌐' },
  traefik:    { category: 'gateway',   label: 'Traefik',     icon: '🌐' },
  caddy:      { category: 'gateway',   label: 'Caddy',       icon: '🌐' },
  vault:      { category: 'internal-service', label: 'Vault', icon: '🔐' },
  consul:     { category: 'internal-service', label: 'Consul', icon: '📋' },
};

const NPM_PACKAGE_MAP: Record<string, { id: string; category: ServiceCategory; label: string; icon: string }> = {
  'pg':                     { id: 'postgres',       category: 'database',      label: 'PostgreSQL',     icon: '🐘' },
  '@prisma/client':         { id: 'postgres',       category: 'database',      label: 'PostgreSQL',     icon: '🐘' },
  'typeorm':                { id: 'postgres',       category: 'database',      label: 'PostgreSQL',     icon: '🐘' },
  'sequelize':              { id: 'postgres',       category: 'database',      label: 'PostgreSQL',     icon: '🐘' },
  'drizzle-orm':            { id: 'postgres',       category: 'database',      label: 'PostgreSQL',     icon: '🐘' },
  'mysql2':                 { id: 'mysql',          category: 'database',      label: 'MySQL',          icon: '🐬' },
  'mongoose':               { id: 'mongodb',        category: 'database',      label: 'MongoDB',        icon: '🍃' },
  'mongodb':                { id: 'mongodb',        category: 'database',      label: 'MongoDB',        icon: '🍃' },
  'ioredis':                { id: 'redis',          category: 'cache',         label: 'Redis',          icon: '⚡' },
  'redis':                  { id: 'redis',          category: 'cache',         label: 'Redis',          icon: '⚡' },
  '@qdrant/js-client-rest': { id: 'qdrant',         category: 'database',      label: 'Qdrant',         icon: '🔍' },
  'minio':                  { id: 'minio',          category: 'storage',       label: 'MinIO',          icon: '📦' },
  '@aws-sdk/client-s3':     { id: 'minio',           category: 'storage',       label: 'S3/MinIO',       icon: '📦' },
  'amqplib':                { id: 'rabbitmq',       category: 'queue',         label: 'RabbitMQ',       icon: '🐰' },
  'kafkajs':                { id: 'kafka',          category: 'queue',         label: 'Kafka',          icon: '📨' },
  'bullmq':                 { id: 'bullmq',         category: 'queue',         label: 'BullMQ',         icon: '🐂' },
  'bull':                   { id: 'bull',           category: 'queue',         label: 'Bull',           icon: '🐂' },
  'openai':                 { id: 'openai',         category: 'external-api',  label: 'OpenAI',         icon: '🤖' },
  '@anthropic-ai/sdk':      { id: 'anthropic',      category: 'external-api',  label: 'Anthropic',      icon: '🤖' },
  'nodemailer':             { id: 'smtp',           category: 'external-api',  label: 'SMTP',           icon: '📧' },
  '@elastic/elasticsearch': { id: 'elasticsearch',  category: 'database',      label: 'Elasticsearch',  icon: '🔎' },
  '@clickhouse/client':     { id: 'clickhouse',     category: 'database',      label: 'ClickHouse',     icon: '🏠' },
};

const ENV_PATTERNS: { pattern: RegExp; id: string; category: ServiceCategory; label: string; icon: string }[] = [
  { pattern: /^(DATABASE_URL|PG_HOST|POSTGRES_HOST)/,   id: 'postgres',  category: 'database',     label: 'PostgreSQL',     icon: '🐘' },
  { pattern: /^(REDIS_URL|REDIS_HOST)/,                 id: 'redis',     category: 'cache',        label: 'Redis',          icon: '⚡' },
  { pattern: /^(QDRANT_URL|QDRANT_HOST)/,               id: 'qdrant',    category: 'database',     label: 'Qdrant',         icon: '🔍' },
  { pattern: /^(MINIO_ENDPOINT|MINIO_HOST|S3_ENDPOINT)/,id: 'minio',    category: 'storage',      label: 'MinIO',          icon: '📦' },
  { pattern: /^(SMTP_HOST|MAIL_HOST)/,                  id: 'smtp',      category: 'external-api', label: 'SMTP',           icon: '📧' },
  { pattern: /^OPENAI_API_KEY$/,                        id: 'openai',    category: 'external-api', label: 'OpenAI',         icon: '🤖' },
  { pattern: /^ANTHROPIC_API_KEY$/,                     id: 'anthropic', category: 'external-api', label: 'Anthropic',      icon: '🤖' },
  { pattern: /^(MONGO_URL|MONGODB_URI|MONGO_HOST)/,     id: 'mongodb',   category: 'database',     label: 'MongoDB',        icon: '🍃' },
  { pattern: /^(RABBITMQ_URL|AMQP_URL)/,                id: 'rabbitmq',  category: 'queue',        label: 'RabbitMQ',       icon: '🐰' },
  { pattern: /^(KAFKA_BROKERS|KAFKA_URL)/,               id: 'kafka',     category: 'queue',        label: 'Kafka',          icon: '📨' },
  { pattern: /^(ELASTICSEARCH_URL|ES_HOST)/,              id: 'elasticsearch', category: 'database', label: 'Elasticsearch', icon: '🔎' },
  { pattern: /^(CLICKHOUSE_URL|CLICKHOUSE_HOST)/,        id: 'clickhouse', category: 'database',    label: 'ClickHouse',    icon: '🏠' },
];

function scanDockerCompose(projectRoot: string): ServiceNode[] {
  const nodes: ServiceNode[] = [];
  const names = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  for (const name of names) {
    const filePath = path.join(projectRoot, name);
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const doc = yaml.load(content) as any;
      if (!doc || typeof doc !== 'object' || !doc.services) continue;
      for (const [svcName, svcDef] of Object.entries(doc.services as Record<string, any>)) {
        const image: string = svcDef?.image || '';
        const imageLower = image.toLowerCase();
        // Find matching known image
        let matched = false;
        for (const [key, meta] of Object.entries(DOCKER_IMAGE_MAP)) {
          if (imageLower.includes(key)) {
            nodes.push({
              id: key,
              label: meta.label,
              category: meta.category,
              source: 'autodiscovery',
              icon: meta.icon,
              host: svcName,
              port: extractPort(svcDef),
              group: meta.category === 'database' ? 'databases' :
                     meta.category === 'cache' ? 'cache' :
                     meta.category === 'queue' ? 'queues' :
                     meta.category === 'storage' ? 'storage' :
                     meta.category === 'gateway' ? 'gateway' : 'services',
            });
            matched = true;
            break;
          }
        }
        // Unknown service from docker-compose
        if (!matched && image) {
          nodes.push({
            id: svcName,
            label: svcName,
            category: 'internal-service',
            source: 'autodiscovery',
            icon: '🐳',
            host: svcName,
            port: extractPort(svcDef),
            group: 'services',
          });
        }
      }
    } catch {}
    break; // only parse first found compose file
  }
  return nodes;
}

function extractPort(svcDef: any): number | undefined {
  if (!svcDef?.ports || !Array.isArray(svcDef.ports)) return undefined;
  for (const p of svcDef.ports) {
    const str = String(p);
    // "8080:80" → 80, "5432" → 5432
    const parts = str.split(':');
    const last = parts[parts.length - 1].replace(/\/.*/, ''); // strip /tcp etc.
    const num = parseInt(last, 10);
    if (!isNaN(num)) return num;
  }
  return undefined;
}

function scanEnvFiles(projectRoot: string): ServiceNode[] {
  const nodes: ServiceNode[] = [];
  const seen = new Set<string>();
  const envFiles = ['.env', '.env.local', '.env.example', '.env.development'];
  for (const envFile of envFiles) {
    const filePath = path.join(projectRoot, envFile);
    if (!fs.existsSync(filePath)) continue;
    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim();
        for (const ep of ENV_PATTERNS) {
          if (ep.pattern.test(key) && !seen.has(ep.id)) {
            seen.add(ep.id);
            nodes.push({
              id: ep.id,
              label: ep.label,
              category: ep.category,
              source: 'autodiscovery',
              icon: ep.icon,
              host: value || undefined,
              group: ep.category === 'database' ? 'databases' :
                     ep.category === 'cache' ? 'cache' :
                     ep.category === 'queue' ? 'queues' :
                     ep.category === 'storage' ? 'storage' : 'external',
            });
          }
        }
      }
    } catch {}
  }
  return nodes;
}

function scanNpmDeps(projectRoot: string): ServiceNode[] {
  const nodes: ServiceNode[] = [];
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return nodes;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const seen = new Set<string>();
    for (const [depName] of Object.entries(deps)) {
      const mapping = NPM_PACKAGE_MAP[depName];
      if (mapping && !seen.has(mapping.id)) {
        seen.add(mapping.id);
        nodes.push({
          id: mapping.id,
          label: mapping.label,
          category: mapping.category,
          source: 'autodiscovery',
          icon: mapping.icon,
          group: mapping.category === 'database' ? 'databases' :
                 mapping.category === 'cache' ? 'cache' :
                 mapping.category === 'queue' ? 'queues' :
                 mapping.category === 'storage' ? 'storage' : 'external',
        });
      }
    }
  } catch {}
  return nodes;
}

function scanWorkerFiles(projectRoot: string): ServiceNode[] {
  const nodes: ServiceNode[] = [];
  const workerPatterns = ['**/workers/**/*.{ts,js}', '**/jobs/**/*.{ts,js}', '**/queues/**/*.{ts,js}', '**/cron/**/*.{ts,js}'];
  for (const pattern of workerPatterns) {
    try {
      const files = glob.sync(pattern, {
        cwd: projectRoot,
        ignore: IGNORE_DIRS.map(d => `**/${d}/**`),
        absolute: false,
      });
      for (const f of files) {
        const base = path.basename(f, path.extname(f));
        if (base === 'index') continue; // skip barrel files
        const id = `worker-${base}`;
        nodes.push({
          id,
          label: base.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          category: 'worker',
          source: 'autodiscovery',
          icon: '⚙️',
          group: 'workers',
        });
      }
    } catch {}
  }
  return nodes;
}

function computeServiceMapReport(projectRoot: string, svcConfig?: ServiceMapConfig): ServiceMapReport {
  const toggles = svcConfig?.autodiscovery ?? {};
  const autoDocker = toggles.dockerCompose !== false;
  const autoEnv = toggles.envFiles !== false;
  const autoNpm = toggles.npmDeps !== false;
  const autoWorkers = toggles.workers !== false;

  // Autodiscovery
  const dockerNodes = autoDocker ? scanDockerCompose(projectRoot) : [];
  const envNodes = autoEnv ? scanEnvFiles(projectRoot) : [];
  const npmNodes = autoNpm ? scanNpmDeps(projectRoot) : [];
  const workerNodes = autoWorkers ? scanWorkerFiles(projectRoot) : [];

  // Merge autodiscovered nodes (dedup by id, first wins with enrichment)
  const nodeMap = new Map<string, ServiceNode>();
  for (const node of [...dockerNodes, ...envNodes, ...npmNodes, ...workerNodes]) {
    if (nodeMap.has(node.id)) {
      // Enrich existing node with any missing fields
      const existing = nodeMap.get(node.id)!;
      if (!existing.host && node.host) existing.host = node.host;
      if (!existing.port && node.port) existing.port = node.port;
    } else {
      nodeMap.set(node.id, { ...node });
    }
  }

  // Merge config nodes (override autodiscovery)
  if (svcConfig?.nodes) {
    for (const cfgNode of svcConfig.nodes) {
      if (!cfgNode.id) continue;
      const existing = nodeMap.get(cfgNode.id);
      if (existing) {
        Object.assign(existing, cfgNode, { source: 'both' as ServiceSource });
      } else {
        nodeMap.set(cfgNode.id, {
          id: cfgNode.id,
          label: cfgNode.label || cfgNode.id,
          category: cfgNode.category || 'internal-service',
          source: 'config',
          ...cfgNode,
        } as ServiceNode);
      }
    }
  }

  const nodes = Array.from(nodeMap.values());
  const edges = svcConfig?.edges ?? [];
  const pipelines = svcConfig?.pipelines ?? [];

  return {
    nodes,
    edges,
    pipelines,
    autodiscovery: {
      dockerServices: dockerNodes.length,
      envConnections: envNodes.length,
      npmServices: npmNodes.length,
      workerFiles: workerNodes.length,
    },
  };
}
