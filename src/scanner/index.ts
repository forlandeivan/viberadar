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
  features: Record<string, FeatureConfig>;
}

export interface FeatureResult {
  key: string;
  label: string;
  description: string;
  color: string;
  fileCount: number;     // source (non-test) files matched
  testFileCount: number; // test files matched
  testedCount: number;   // source files that have a test
  coveragePct?: number;  // average line coverage
}

export interface ScanResult {
  projectRoot: string;
  projectName: string;
  scannedAt: string;
  modules: ModuleInfo[];
  totalCoverage?: CoverageInfo;
  features: FeatureResult[] | null;
  hasConfig: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const IGNORE_DIRS = [
  'node_modules', 'dist', 'build', '.git', '.next',
  'coverage', '.nyc_output', '__pycache__', '.venv',
];

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte'];
const TEST_PATTERNS = ['.test.', '.spec.', '__tests__'];

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

function fileMatchesFeature(relPath: string, include: string[]): boolean {
  return include.some(p => fileMatchesGlob(relPath, p));
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
      const candidates = [
        `${base}.test${ext}`,
        `${base}.spec${ext}`,
        filePath.replace('/src/', '/tests/').replace(ext, `.test${ext}`),
        filePath.replace('\\src\\', '\\tests\\').replace(ext, `.test${ext}`),
      ];
      testFile = candidates.find((c) => testFileSet.has(c));
    }

    let size = 0;
    try { size = fs.statSync(filePath).size; } catch {}

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

  // Build map: cleanName → test file absolute path (first match wins)
  const testByCleanName = new Map<string, string>();
  for (const tf of testFileSet) {
    let base = path.basename(tf, path.extname(tf)); // e.g. "auth.test" or "chat.spec"
    base = base.replace(/\.(test|spec)$/, '');       // → "auth"
    const clean = cleanName(base.split('.')[0]);     // first dot-segment, cleaned
    if (!testByCleanName.has(clean)) {
      testByCleanName.set(clean, tf);
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

    // Assign feature keys to each module
    for (const m of modules) {
      m.featureKeys = featureEntries
        .filter(([, f]) => fileMatchesFeature(m.relativePath, f.include))
        .map(([key]) => key);
    }

    const sourceModules = modules.filter(m => m.type !== 'test');
    const testModules   = modules.filter(m => m.type === 'test');

    features = featureEntries.map(([key, feat]) => {
      const srcFiles = sourceModules.filter(m => fileMatchesFeature(m.relativePath, feat.include));
      const tstFiles = testModules.filter(m => fileMatchesFeature(m.relativePath, feat.include));
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
      };
    });
  }

  return {
    projectRoot,
    projectName,
    scannedAt: new Date().toISOString(),
    modules,
    features,
    hasConfig: config !== null,
  };
}
