#!/usr/bin/env node

import * as path from 'path';
import { scanProject } from './scanner';
import { startServer } from './server';

const PROJECT_ROOT = process.cwd();
const PORT = 4242;

async function main() {
  console.log('🔭 VibeRadar starting...');
  console.log(`   Project: ${PROJECT_ROOT}`);

  console.log('   Scanning modules...');
  const data = await scanProject(PROJECT_ROOT);

  console.log(`   Found ${data.modules.length} modules`);

  await startServer({ data, port: PORT, projectRoot: PROJECT_ROOT });

  console.log(`\n✅ Dashboard: http://localhost:${PORT}`);
  console.log('   Press Ctrl+C to stop\n');

  const { default: open } = await import('open');
  await open(`http://localhost:${PORT}`);
}

main().catch((err) => {
  console.error('❌ VibeRadar error:', err.message);
  process.exit(1);
});
