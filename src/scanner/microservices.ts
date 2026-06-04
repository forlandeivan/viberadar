import * as fs from 'fs';

import type {
  DocumentationReport,
  FeatureResult,
  ModuleInfo,
  ObservabilityReport,
  ServiceMapReport,
} from './index';

export type MicroserviceSizeCategory = 'normal' | 'large' | 'god' | 'critical';
export type MicroserviceReadinessTier = 'ready' | 'watch' | 'risky';

export interface MicroserviceFileRisk {
  code: string;
  label: string;
  severity: 'low' | 'medium' | 'high';
}

export interface MicroserviceFileReport {
  path: string;
  type: ModuleInfo['type'];
  sizeBytes: number;
  sizeKb: number;
  lineCount: number;
  sizeCategory: MicroserviceSizeCategory;
  featureKeys: string[];
  riskCodes: string[];
  risks: MicroserviceFileRisk[];
  dependencyCount: number;
  hasTests: boolean;
  testStale: boolean;
  boundaryHints: string[];
}

export interface MicroserviceModuleReport {
  key: string;
  label: string;
  color: string;
  description: string;
  fileCount: number;
  largeFileCount: number;
  godFileCount: number;
  criticalFileCount: number;
  testedCount: number;
  staleTestCount: number;
  unmappedFileCount: number;
  multiFeatureFileCount: number;
  largestFile: MicroserviceFileReport | null;
  readinessScore: number;
  readinessTier: MicroserviceReadinessTier;
  sizeHealth: number;
  ownershipClarity: number;
  testReadiness: number;
  boundaryReadiness: number;
  observabilityReadiness: number;
  boundaryHints: string[];
  serviceNodes: string[];
  pipelineIds: string[];
  topRisks: string[];
}

export interface MicroservicesReport {
  budgets: {
    largeKb: number;
    largeLines: number;
    godKb: number;
    godLines: number;
    criticalKb: number;
    criticalLines: number;
  };
  summary: {
    sourceFiles: number;
    modules: number;
    largeFiles: number;
    godFiles: number;
    criticalFiles: number;
    readyModules: number;
    riskyModules: number;
    unmappedFiles: number;
    multiFeatureFiles: number;
  };
  files: MicroserviceFileReport[];
  modules: MicroserviceModuleReport[];
  topRisks: MicroserviceFileReport[];
}

interface BuildMicroservicesReportInput {
  projectRoot: string;
  modules: ModuleInfo[];
  features: FeatureResult[] | null;
  serviceMap?: ServiceMapReport;
  documentation?: DocumentationReport;
  observability?: ObservabilityReport;
}

const BUDGETS = {
  largeKb: 50,
  largeLines: 1200,
  godKb: 150,
  godLines: 3000,
  criticalKb: 300,
  criticalLines: 6000,
};

const ARTIFACT_PATH_PATTERNS = [
  /^artifacts\//,
  /^temp\//,
  /^tmp\//,
  /^test-results\//,
  /^playwright-report\//,
  /^coverage\//,
  /^dist\//,
  /^build\//,
  /^\.cache\//,
  /^\.next\//,
  /^\.viberadar\//,
];

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function isArtifactPath(relativePath: string): boolean {
  const p = normalizePath(relativePath);
  return ARTIFACT_PATH_PATTERNS.some(re => re.test(p));
}

function countLines(filePath: string): number {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw) return 0;
    return raw.split(/\r?\n/).length;
  } catch {
    return 0;
  }
}

function sizeCategory(sizeKb: number, lineCount: number): MicroserviceSizeCategory {
  if (sizeKb >= BUDGETS.criticalKb || lineCount >= BUDGETS.criticalLines) return 'critical';
  if (sizeKb >= BUDGETS.godKb || lineCount >= BUDGETS.godLines) return 'god';
  if (sizeKb >= BUDGETS.largeKb || lineCount >= BUDGETS.largeLines) return 'large';
  return 'normal';
}

function pathHasAny(p: string, words: string[]): boolean {
  return words.some(w => p.includes(w));
}

function boundaryHintsForModule(m: ModuleInfo): string[] {
  const p = normalizePath(m.relativePath).toLowerCase();
  const hints: string[] = [];
  if (pathHasAny(p, ['/routes/', '.routes.', '/api/'])) hints.push('route/api');
  if (pathHasAny(p, ['/worker', '/workers/', '/jobs/', '/queues/', '/cron/'])) hints.push('worker');
  if (pathHasAny(p, ['service.ts', '-service.ts', '/services/', '.service.'])) hints.push('service');
  if (pathHasAny(p, ['/repositories/', '.repository.', '/db', 'database', 'schema'])) hints.push('persistence');
  if (pathHasAny(p, ['/shared/', '/contracts/', '.port.', '/ports/'])) hints.push('contract/shared');
  if (m.type === 'component') hints.push('ui');
  return Array.from(new Set(hints));
}

function risk(code: string, label: string, severity: MicroserviceFileRisk['severity']): MicroserviceFileRisk {
  return { code, label, severity };
}

function fileRisks(m: ModuleInfo, category: MicroserviceSizeCategory, dependencyCount: number, hints: string[]): MicroserviceFileRisk[] {
  const risks: MicroserviceFileRisk[] = [];
  if (category === 'critical') risks.push(risk('critical-size', 'critical size budget exceeded', 'high'));
  else if (category === 'god') risks.push(risk('god-size', 'god file size budget exceeded', 'high'));
  else if (category === 'large') risks.push(risk('large-size', 'large file budget exceeded', 'medium'));
  if (!m.featureKeys || m.featureKeys.length === 0) risks.push(risk('unknown-owner', 'no feature ownership', 'medium'));
  if (m.featureKeys && m.featureKeys.length > 1) risks.push(risk('multi-feature', 'cross-feature ownership', 'high'));
  if (!m.hasTests) risks.push(risk('missing-tests', 'missing linked tests', 'medium'));
  if (m.testStale) risks.push(risk('stale-tests', 'tests older than source', 'medium'));
  if (dependencyCount >= 16) risks.push(risk('high-coupling', 'many import dependencies', 'high'));
  else if (dependencyCount >= 10) risks.push(risk('medium-coupling', 'elevated import dependencies', 'medium'));
  if (hints.includes('persistence') && (!m.featureKeys || m.featureKeys.length !== 1)) {
    risks.push(risk('data-ownership', 'data ownership boundary unclear', 'high'));
  }
  return risks;
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function readinessTier(score: number): MicroserviceReadinessTier {
  if (score >= 70) return 'ready';
  if (score < 40) return 'risky';
  return 'watch';
}

function categoryWeight(category: MicroserviceSizeCategory): number {
  if (category === 'critical') return 4;
  if (category === 'god') return 3;
  if (category === 'large') return 2;
  return 1;
}

function textMatchesKey(text: string, key: string): boolean {
  const a = text.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '');
  const b = key.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '');
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

function matchingServiceNodes(feature: FeatureResult, serviceMap?: ServiceMapReport): string[] {
  if (!serviceMap) return [];
  return serviceMap.nodes
    .filter(n => textMatchesKey(`${n.id} ${n.label} ${n.group || ''}`, `${feature.key} ${feature.label}`))
    .map(n => n.label || n.id);
}

function matchingPipelines(feature: FeatureResult, serviceMap?: ServiceMapReport): string[] {
  if (!serviceMap) return [];
  return serviceMap.pipelines
    .filter(p => textMatchesKey(`${p.id} ${p.label} ${p.description || ''}`, `${feature.key} ${feature.label}`))
    .map(p => p.id);
}

function observabilityScore(featureKey: string, observability?: ObservabilityReport): number {
  if (!observability?.byFeature) return 55;
  const f = observability.byFeature.find(x => x.key === featureKey);
  if (!f) return 55;
  return clampScore(f.score);
}

function topRiskLabels(files: MicroserviceFileReport[]): string[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const f of files) {
    for (const r of f.risks) {
      const prev = counts.get(r.code) || { label: r.label, count: 0 };
      prev.count += 1;
      counts.set(r.code, prev);
    }
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
    .map(x => `${x.label}: ${x.count}`);
}

function buildUnknownModule(files: MicroserviceFileReport[]): MicroserviceModuleReport | null {
  if (files.length === 0) return null;
  const large = files.filter(f => f.sizeCategory !== 'normal');
  const tested = files.filter(f => f.hasTests).length;
  const largestFile = [...files].sort((a, b) => b.sizeBytes - a.sizeBytes)[0] || null;
  const sizeHealth = clampScore(100 - (large.length / files.length) * 100);
  const ownershipClarity = 0;
  const testReadiness = clampScore((tested / files.length) * 100);
  const boundaryReadiness = 20;
  const observabilityReadiness = 55;
  const readinessScore = clampScore(
    sizeHealth * 0.28 +
    ownershipClarity * 0.24 +
    testReadiness * 0.22 +
    boundaryReadiness * 0.18 +
    observabilityReadiness * 0.08
  );

  return {
    key: '__unknown__',
    label: 'Unknown ownership',
    color: '#7d8590',
    description: 'Files that are not mapped to a feature.',
    fileCount: files.length,
    largeFileCount: files.filter(f => f.sizeCategory === 'large').length,
    godFileCount: files.filter(f => f.sizeCategory === 'god').length,
    criticalFileCount: files.filter(f => f.sizeCategory === 'critical').length,
    testedCount: tested,
    staleTestCount: files.filter(f => f.testStale).length,
    unmappedFileCount: files.length,
    multiFeatureFileCount: 0,
    largestFile,
    readinessScore,
    readinessTier: readinessTier(readinessScore),
    sizeHealth,
    ownershipClarity,
    testReadiness,
    boundaryReadiness,
    observabilityReadiness,
    boundaryHints: Array.from(new Set(files.flatMap(f => f.boundaryHints))).slice(0, 8),
    serviceNodes: [],
    pipelineIds: [],
    topRisks: topRiskLabels(files),
  };
}

export function buildMicroservicesReport(input: BuildMicroservicesReportInput): MicroservicesReport {
  const sourceModules = input.modules.filter(m =>
    m.type !== 'test' &&
    !m.isInfra &&
    !isArtifactPath(m.relativePath)
  );

  const files: MicroserviceFileReport[] = sourceModules.map(m => {
    const lineCount = countLines(m.path);
    const sizeKb = Math.round(m.size / 1024);
    const category = sizeCategory(sizeKb, lineCount);
    const boundaryHints = boundaryHintsForModule(m);
    const dependencyCount = m.dependencies.length;
    const risks = fileRisks(m, category, dependencyCount, boundaryHints);
    return {
      path: normalizePath(m.relativePath),
      type: m.type,
      sizeBytes: m.size,
      sizeKb,
      lineCount,
      sizeCategory: category,
      featureKeys: m.featureKeys || [],
      riskCodes: risks.map(r => r.code),
      risks,
      dependencyCount,
      hasTests: m.hasTests,
      testStale: !!m.testStale,
      boundaryHints,
    };
  });

  const fileByPath = new Map(files.map(f => [f.path, f]));
  const features = input.features || [];
  const modules: MicroserviceModuleReport[] = features.map(feature => {
    const featureFiles = sourceModules
      .filter(m => (m.featureKeys || []).includes(feature.key))
      .map(m => fileByPath.get(normalizePath(m.relativePath)))
      .filter((m): m is MicroserviceFileReport => !!m);
    const fileCount = featureFiles.length;
    const largeFiles = featureFiles.filter(f => f.sizeCategory !== 'normal');
    const testedCount = featureFiles.filter(f => f.hasTests).length;
    const staleTestCount = featureFiles.filter(f => f.testStale).length;
    const multiFeatureFileCount = featureFiles.filter(f => f.featureKeys.length > 1).length;
    const largestFile = [...featureFiles].sort((a, b) => b.sizeBytes - a.sizeBytes)[0] || null;
    const serviceNodes = matchingServiceNodes(feature, input.serviceMap);
    const pipelineIds = matchingPipelines(feature, input.serviceMap);
    const docStatus = input.documentation?.features.find(f => f.key === feature.key);

    const sizeHealth = fileCount ? clampScore(100 - (largeFiles.length / fileCount) * 100) : 100;
    const ownershipClarity = fileCount ? clampScore(100 - (multiFeatureFileCount / fileCount) * 100) : 100;
    const testReadiness = fileCount ? clampScore(((testedCount - staleTestCount * 0.5) / fileCount) * 100) : 100;
    const boundaryHints = Array.from(new Set(featureFiles.flatMap(f => f.boundaryHints))).slice(0, 8);
    let boundaryReadiness = 35;
    if (serviceNodes.length > 0) boundaryReadiness += 25;
    if (pipelineIds.length > 0) boundaryReadiness += 20;
    if (boundaryHints.includes('service')) boundaryReadiness += 10;
    if (boundaryHints.includes('route/api') || boundaryHints.includes('worker')) boundaryReadiness += 5;
    if (docStatus?.docExists && !docStatus.isStale) boundaryReadiness += 5;
    boundaryReadiness = clampScore(boundaryReadiness);
    const observabilityReadiness = observabilityScore(feature.key, input.observability);
    const readinessScore = clampScore(
      sizeHealth * 0.28 +
      ownershipClarity * 0.24 +
      testReadiness * 0.22 +
      boundaryReadiness * 0.18 +
      observabilityReadiness * 0.08
    );

    return {
      key: feature.key,
      label: feature.label,
      color: feature.color,
      description: feature.description || '',
      fileCount,
      largeFileCount: featureFiles.filter(f => f.sizeCategory === 'large').length,
      godFileCount: featureFiles.filter(f => f.sizeCategory === 'god').length,
      criticalFileCount: featureFiles.filter(f => f.sizeCategory === 'critical').length,
      testedCount,
      staleTestCount,
      unmappedFileCount: 0,
      multiFeatureFileCount,
      largestFile,
      readinessScore,
      readinessTier: readinessTier(readinessScore),
      sizeHealth,
      ownershipClarity,
      testReadiness,
      boundaryReadiness,
      observabilityReadiness,
      boundaryHints,
      serviceNodes,
      pipelineIds,
      topRisks: topRiskLabels(featureFiles),
    };
  });

  const unknown = buildUnknownModule(files.filter(f => f.featureKeys.length === 0));
  if (unknown) modules.push(unknown);

  const topRisks = [...files]
    .filter(f => f.risks.length > 0)
    .sort((a, b) => {
      const severity = (f: MicroserviceFileReport) =>
        f.risks.reduce((s, r) => s + (r.severity === 'high' ? 3 : r.severity === 'medium' ? 2 : 1), 0);
      return categoryWeight(b.sizeCategory) - categoryWeight(a.sizeCategory) ||
        severity(b) - severity(a) ||
        b.sizeBytes - a.sizeBytes;
    })
    .slice(0, 20);

  return {
    budgets: BUDGETS,
    summary: {
      sourceFiles: files.length,
      modules: modules.length,
      largeFiles: files.filter(f => f.sizeCategory === 'large').length,
      godFiles: files.filter(f => f.sizeCategory === 'god').length,
      criticalFiles: files.filter(f => f.sizeCategory === 'critical').length,
      readyModules: modules.filter(m => m.readinessScore >= 70).length,
      riskyModules: modules.filter(m => m.readinessScore < 40).length,
      unmappedFiles: files.filter(f => f.featureKeys.length === 0).length,
      multiFeatureFiles: files.filter(f => f.featureKeys.length > 1).length,
    },
    files,
    modules: modules.sort((a, b) =>
      a.readinessScore - b.readinessScore ||
      (b.criticalFileCount + b.godFileCount) - (a.criticalFileCount + a.godFileCount)
    ),
    topRisks,
  };
}
