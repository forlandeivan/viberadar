import { ProbeRunReport } from './types';

type RunFn = () => Promise<ProbeRunReport>;
type ReportFn = (report: ProbeRunReport) => Promise<void>;

export function startProbeLoop(
  intervalSec: number,
  runFn: RunFn,
  onReport: ReportFn,
): void {
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async () => {
    if (running) {
      console.log('   ⏳ Previous run still in progress, skipping...');
      return;
    }
    running = true;
    try {
      const report = await runFn();
      await onReport(report);
    } catch (err: any) {
      console.error(`   ❌ Probe run error: ${err.message}`);
    } finally {
      running = false;
    }
  };

  const shutdown = () => {
    console.log('\n🛑 Probe stopping...');
    if (timer) clearInterval(timer);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`   Interval: every ${intervalSec}s`);
  console.log('   Press Ctrl+C to stop\n');

  tick();
  timer = setInterval(tick, intervalSec * 1000);
}
