import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ProbeConfig, ProbeCheck } from './types';

const DEFAULT_INTERVAL = 300;
const DEFAULT_TIMEOUT = 30000;

function interpolateEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_match, name) => {
    const envVal = process.env[name];
    if (envVal === undefined) {
      console.warn(`   ⚠️  Env variable \${${name}} not found, left as-is`);
      return '${' + name + '}';
    }
    return envVal;
  });
}

function interpolateDeep(obj: any): any {
  if (typeof obj === 'string') return interpolateEnv(obj);
  if (Array.isArray(obj)) return obj.map(interpolateDeep);
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const key of Object.keys(obj)) {
      result[key] = interpolateDeep(obj[key]);
    }
    return result;
  }
  return obj;
}

export function loadProbeConfig(configPath?: string): ProbeConfig | null {
  const resolved = configPath
    ? path.resolve(configPath)
    : path.join(process.cwd(), 'probe.config.yml');

  if (!fs.existsSync(resolved)) {
    return null;
  }

  let raw: any;
  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    raw = yaml.load(content);
  } catch (err: any) {
    console.warn(`   ⚠️  Failed to parse ${resolved}: ${err.message}`);
    return null;
  }

  if (!raw || typeof raw !== 'object') {
    console.warn(`   ⚠️  Invalid probe config: expected YAML object`);
    return null;
  }

  if (!raw.target || typeof raw.target !== 'string') {
    console.warn(`   ⚠️  Probe config: "target" is required`);
    return null;
  }

  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    console.warn(`   ⚠️  Probe config: "checks" must be a non-empty array`);
    return null;
  }

  const interpolated = interpolateDeep(raw);

  return {
    target: interpolated.target.replace(/\/+$/, ''),
    interval: Number(interpolated.interval) || DEFAULT_INTERVAL,
    timeout: Number(interpolated.timeout) || DEFAULT_TIMEOUT,
    notify: interpolated.notify || undefined,
    checks: interpolated.checks as ProbeCheck[],
  };
}

export function requireProbeConfig(configPath?: string): ProbeConfig {
  const resolved = configPath
    ? path.resolve(configPath)
    : path.join(process.cwd(), 'probe.config.yml');

  const config = loadProbeConfig(configPath);
  if (!config) {
    console.error(`❌ Probe config not found or invalid: ${resolved}`);
    console.error(`   Create probe.config.yml or use --config <path>`);
    process.exit(1);
  }
  return config;
}
