#!/usr/bin/env node

import { scanProject } from './scanner';
import { startServer } from './server';
import { runInit } from './init';

const PROJECT_ROOT = process.cwd();
const PORT = 4242;
const command = process.argv[2];

async function runDashboard() {
  console.log('🔭 VibeRadar starting...');
  console.log(`   Project: ${PROJECT_ROOT}`);

  console.log('   Scanning modules...');
  const data = await scanProject(PROJECT_ROOT);

  console.log(`   Found ${data.modules.length} modules`);

  const { triggerCoverage } = await startServer({ data, port: PORT, projectRoot: PROJECT_ROOT });

  console.log(`\n✅ Dashboard: http://localhost:${PORT}`);
  console.log('   Press Ctrl+C to stop\n');

  const { default: open } = await import('open');
  await open(`http://localhost:${PORT}`);

  // Auto-run coverage in background after browser opens
  console.log('   🧪 Running coverage in background...');
  triggerCoverage();
}

function printHelp() {
  console.log(`
🔭 VibeRadar

Команды:
  npx viberadar          Запустить дашборд на http://localhost:4242
  npx viberadar init     Сгенерировать промпт для AI-агента (настройка фич)
  npx viberadar help     Показать эту справку
`);
}

async function main() {
  switch (command) {
    case 'init':
      await runInit(PROJECT_ROOT);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    case undefined:
      await runDashboard();
      break;
    default:
      console.error(`❌ Неизвестная команда: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ VibeRadar error:', err.message);
  process.exit(1);
});
