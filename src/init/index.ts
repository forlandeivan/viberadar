import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { buildSnapshot, buildPrompt } from './prompt-builder';

const PROMPT_FILE = 'VIBERADAR_PROMPT.md';

function copyToClipboard(text: string): boolean {
  try {
    const platform = process.platform;
    if (platform === 'win32') {
      child_process.execSync('clip', { input: text });
    } else if (platform === 'darwin') {
      child_process.execSync('pbcopy', { input: text });
    } else {
      // Linux — пробуем xclip, потом xsel
      try {
        child_process.execSync('xclip -selection clipboard', { input: text });
      } catch {
        child_process.execSync('xsel --clipboard --input', { input: text });
      }
    }
    return true;
  } catch {
    return false;
  }
}

function printBox(lines: string[]) {
  const width = Math.max(...lines.map(l => l.length)) + 4;
  const border = '─'.repeat(width);
  console.log(`┌${border}┐`);
  for (const line of lines) {
    const padding = ' '.repeat(width - line.length - 2);
    console.log(`│  ${line}${padding}│`);
  }
  console.log(`└${border}┘`);
}

export async function runInit(projectRoot: string) {
  console.log('\n🔭 VibeRadar Init\n');
  console.log('   Сканирую структуру проекта...');

  const snap = buildSnapshot(projectRoot);

  console.log(`   Проект: ${snap.name}`);
  if (snap.techStack.length > 0) {
    console.log(`   Стек: ${snap.techStack.join(', ')}`);
  }
  console.log(`   Файлов: ${snap.totalFiles}`);
  console.log(`   Страниц: ${snap.pageFiles.length}`);
  console.log(`   Роутов: ${snap.routeFiles.length}`);
  console.log(`   Тестов: ${snap.testFiles.length}`);

  console.log('\n   Генерирую промпт для AI-агента...');
  const prompt = buildPrompt(snap);

  // Сохраняем файл
  const promptPath = path.join(projectRoot, PROMPT_FILE);
  fs.writeFileSync(promptPath, prompt, 'utf-8');
  console.log(`   Сохранён: ${PROMPT_FILE}`);

  // Копируем в буфер
  const copied = copyToClipboard(prompt);

  console.log('');
  printBox([
    copied
      ? '✅ Промпт скопирован в буфер обмена!'
      : `📄 Промпт сохранён в ${PROMPT_FILE}`,
    '',
    'Дальше:',
    `1. Вставь промпт в Cursor / Claude / Windsurf (Ctrl+V)`,
    '2. Ответь на уточняющие вопросы агента',
    '3. Агент создаст viberadar.config.json',
    '4. Запусти: npx viberadar',
  ]);

  if (!copied) {
    console.log(`\n   Не удалось скопировать в буфер. Открой файл:\n   ${promptPath}\n`);
  }

  console.log('');
}
