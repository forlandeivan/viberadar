import { loadProbeConfig } from './config';
import { runProbeChecks } from './runner';
import { createNotifiers, notifyAll } from './notify';
import { startProbeLoop } from './scheduler';
import { ProbeRunReport } from './types';

function parseArgs(argv: string[]): { watch: boolean; configPath?: string } {
  let watch = false;
  let configPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--watch') {
      watch = true;
    } else if (argv[i] === '--config' && argv[i + 1]) {
      configPath = argv[++i];
    }
  }

  return { watch, configPath };
}

function logReport(report: ProbeRunReport): void {
  console.log(`\n🔭 Probe: ${report.target}`);

  for (const r of report.results) {
    if (r.status === 'passed') {
      console.log(`   ✅ ${r.check} (${r.durationMs}ms)`);
    } else {
      console.log(`   ❌ ${r.check} (${r.durationMs}ms)`);
      if (r.error) {
        console.log(`      → ${r.error}`);
      }
      if (r.screenshotPath) {
        console.log(`      → Screenshot: ${r.screenshotPath}`);
      }
    }
  }

  console.log(`\n📊 Результат: ${report.passed}/${report.results.length} passed, ${report.failed} failed`);
}

export async function runProbe(argv: string[]): Promise<void> {
  const { watch, configPath } = parseArgs(argv);
  const config = loadProbeConfig(configPath);
  const notifiers = createNotifiers(config.notify);

  console.log(`🔭 Probe target: ${config.target}`);
  console.log(`   Checks: ${config.checks.length}`);
  if (notifiers.length > 0) {
    console.log(`   Notifications: ${config.notify?.telegram ? 'Telegram' : 'none'}`);
  }

  const run = async (): Promise<ProbeRunReport> => {
    const report = await runProbeChecks(config);
    logReport(report);
    return report;
  };

  const onReport = async (report: ProbeRunReport): Promise<void> => {
    if (report.failed > 0) {
      await notifyAll(notifiers, report);
    }
  };

  if (watch) {
    startProbeLoop(config.interval, run, onReport);
  } else {
    const report = await run();
    await onReport(report);
    process.exit(report.failed > 0 ? 1 : 0);
  }
}
