import * as fs from 'fs';
import * as path from 'path';

export interface ProjectSnapshot {
  name: string;
  projectRoot: string;
  packageJson: Record<string, any>;
  dirTree: string;
  topFiles: string[];
  routeFiles: string[];
  pageFiles: string[];
  testFiles: string[];
  totalFiles: number;
  techStack: string[];
}

// ─── Директории которые не несут бизнес-смысла для агента ─────────────────────

const IGNORE_BUILD = new Set([
  'node_modules', 'dist', 'build', '.git', '.next', 'coverage',
  '.nyc_output', '__pycache__', '.venv', '.turbo', '.cache', '.idea',
  '.vscode', 'playwright-report', 'test-results',
]);

// Папки с документацией/артефактами — показываем в дереве но не углубляемся
const IGNORE_DEEP = new Set([
  'migrations', 'Releases', 'Backlog', 'attached_assets', 'temp',
  'grant-start-AI', 'initdb', 'pdfFonts', 'fonts', 'public',
  'Confluence', 'test-cases', 'user-guide', 'docs',
]);

// Шаблонные имена пакетов — заменяем на имя папки
const TEMPLATE_NAMES = new Set([
  'rest-express', 'my-app', 'app', 'project', 'starter', 'template',
  'nextjs-app', 'vite-app', 'react-app', 'express-app', 'node-app',
  'backend', 'frontend', 'fullstack', 'monorepo', 'webapp',
]);

// ─── Сканирование структуры проекта ───────────────────────────────────────────

function buildDirTree(dir: string, prefix = '', depth = 0): string {
  if (depth > 3) return '';
  let result = '';
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }

  const filtered = entries
    .filter(e => !IGNORE_BUILD.has(e.name) && !e.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 25);

  filtered.forEach((entry, i) => {
    const isLast = i === filtered.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';
    result += `${prefix}${connector}${entry.name}${entry.isDirectory() ? '/' : ''}\n`;
    if (entry.isDirectory() && !IGNORE_DEEP.has(entry.name)) {
      result += buildDirTree(path.join(dir, entry.name), prefix + childPrefix, depth + 1);
    }
  });
  return result;
}

function collectFiles(dir: string, pattern: RegExp, limit = 50): string[] {
  const results: string[] = [];
  function walk(d: string) {
    if (results.length >= limit) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORE_BUILD.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (pattern.test(e.name)) results.push(full);
    }
  }
  walk(dir);
  return results;
}

function detectTechStack(pkg: Record<string, any>): string[] {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const stack: string[] = [];
  const checks: [string, string][] = [
    ['react', 'React'],
    ['next', 'Next.js'],
    ['vue', 'Vue'],
    ['svelte', 'Svelte'],
    ['express', 'Express'],
    ['fastify', 'Fastify'],
    ['nestjs/core', 'NestJS'],
    ['typescript', 'TypeScript'],
    ['vitest', 'Vitest'],
    ['jest', 'Jest'],
    ['playwright', 'Playwright'],
    ['prisma', 'Prisma'],
    ['drizzle-orm', 'Drizzle ORM'],
    ['mongoose', 'Mongoose'],
    ['tailwindcss', 'Tailwind CSS'],
    ['trpc', 'tRPC'],
    ['graphql', 'GraphQL'],
  ];
  for (const [key, label] of checks) {
    if (Object.keys(deps).some(d => d.includes(key))) stack.push(label);
  }
  return stack;
}

function resolveProjectName(packageJson: Record<string, any>, projectRoot: string): string {
  const pkgName = packageJson.name || '';
  // Если имя выглядит как шаблонное — берём имя папки
  if (!pkgName || TEMPLATE_NAMES.has(pkgName.toLowerCase())) {
    return path.basename(projectRoot);
  }
  return pkgName;
}

function filterScripts(scripts: Record<string, string>): Record<string, string> {
  // Показываем только ключевые скрипты, не засоряем промпт CI-командами
  const KEY_SCRIPTS = ['dev', 'start', 'build', 'test', 'test:e2e', 'lint'];
  const result: Record<string, string> = {};
  for (const key of KEY_SCRIPTS) {
    if (scripts[key]) result[key] = scripts[key];
  }
  return result;
}

export function buildSnapshot(projectRoot: string): ProjectSnapshot {
  const pkgPath = path.join(projectRoot, 'package.json');
  let packageJson: Record<string, any> = {};
  try { packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch {}

  const pageFiles = collectFiles(projectRoot, /[Pp]age\.(tsx?|jsx?)$|[Pp]ages.*\.(tsx?|jsx?)$/)
    .map(f => path.relative(projectRoot, f));

  const routeFiles = collectFiles(projectRoot, /route|router|routes/i)
    .filter(f => /\.(ts|js)$/.test(f))
    .map(f => path.relative(projectRoot, f));

  const testFiles = collectFiles(projectRoot, /\.(test|spec)\.(tsx?|jsx?)$/)
    .map(f => path.relative(projectRoot, f));

  const allFiles = collectFiles(projectRoot, /\.(tsx?|jsx?)$/, 500);

  return {
    name: resolveProjectName(packageJson, projectRoot),
    projectRoot,
    packageJson,
    dirTree: buildDirTree(projectRoot),
    topFiles: allFiles.slice(0, 20).map(f => path.relative(projectRoot, f)),
    routeFiles: routeFiles.slice(0, 30),
    pageFiles: pageFiles.slice(0, 30),
    testFiles: testFiles.slice(0, 30),
    totalFiles: allFiles.length,
    techStack: detectTechStack(packageJson),
  };
}

// ─── Шаблон промпта ────────────────────────────────────────────────────────────

const CONFIG_EXAMPLE = JSON.stringify({
  version: '1',
  features: {
    auth: {
      label: 'Авторизация',
      description: 'Вход, регистрация, восстановление пароля, OAuth',
      include: ['**/auth*', '**/login*', '**/register*', '**/password*'],
      color: '#f85149',
    },
    chat: {
      label: 'Чаты с AI',
      description: 'Диалог с AI-ассистентом, история сообщений, стриминг',
      include: ['**/chat*', '**/Chat*', '**/message*'],
      color: '#58a6ff',
    },
    skills: {
      label: 'Навыки',
      description: 'Создание и настройка AI-агентов с кастомными инструкциями',
      include: ['**/skill*', '**/Skill*'],
      color: '#d2a8ff',
    },
    'knowledge-base': {
      label: 'Базы знаний',
      description: 'Загрузка документов, индексация, RAG-поиск',
      include: ['**/knowledge*', '**/Knowledge*', '**/rag*', '**/indexing*'],
      color: '#3fb950',
    },
    admin: {
      label: 'Админ-панель',
      description: 'Управление пользователями, тарифами, провайдерами',
      include: ['**/admin*', '**/Admin*'],
      color: '#e3b341',
    },
  },
}, null, 2);

export function buildPrompt(snap: ProjectSnapshot): string {
  const scripts = snap.packageJson.scripts
    ? filterScripts(snap.packageJson.scripts)
    : {};

  return `# VibeRadar — Настройка карты фич проекта

## Контекст

VibeRadar — инструмент для визуализации архитектуры проекта и тест-покрытия по фичам.
Тебе нужно проанализировать проект **${snap.name}** и создать файл \`viberadar.config.json\`
с описанием бизнес-фич и паттернами файлов, которые к ним относятся.

---

## Данные о проекте

**Название:** ${snap.name}
**Стек:** ${snap.techStack.length > 0 ? snap.techStack.join(', ') : 'не определён'}
**Всего исходных файлов:** ${snap.totalFiles}

### Структура папок (упрощённая, без node_modules/dist/docs):
\`\`\`
${snap.name}/
${snap.dirTree}\`\`\`

${snap.pageFiles.length > 0 ? `### Страницы / UI-компоненты верхнего уровня:
${snap.pageFiles.map(f => `- ${f}`).join('\n')}
` : ''}
${snap.routeFiles.length > 0 ? `### Серверные роуты / API:
${snap.routeFiles.map(f => `- ${f}`).join('\n')}
` : ''}
${snap.testFiles.length > 0 ? `### Тест-файлы (первые 30):
${snap.testFiles.map(f => `- ${f}`).join('\n')}
` : ''}
${Object.keys(scripts).length > 0 ? `### Ключевые скрипты:
${Object.entries(scripts).map(([k, v]) => `- \`${k}\`: ${v}`).join('\n')}
` : ''}

---

## Твоя задача

### Шаг 1 — Анализ
Изучи структуру проекта. Определи **бизнес-фичи** — не технические слои.

✅ Хорошие фичи (что видит пользователь, что можно сломать изолированно):
"Авторизация", "Чаты с AI", "Навыки", "Базы знаний", "Файлы", "Биллинг", "Интеграции", "Админ-панель"

❌ Плохие фичи (технические абстракции):
"Components", "Utils", "Helpers", "Common", "Shared", "Services"

### Шаг 2 — Уточняющие вопросы
**ОБЯЗАТЕЛЬНО** задай вопросы по неочевидным модулям прежде чем генерировать конфиг.
Не угадывай назначение — лучше 3–5 вопросов, чем неточный результат.

Спрашивай если видишь:
- Папки с неочевидным названием (например \`actions/\`, \`canvas/\`, \`guards/\`)
- Модули которые могут быть как фичей, так и внутренней системой
- Несколько похожих папок (например \`skills/\` и \`agents/\`)

### Шаг 3 — Генерация конфига
После получения ответов создай файл \`viberadar.config.json\` в корне проекта.

**Правила:**
- Оптимально **10–20 фич** — не дроби слишком мелко, не объединяй несвязанное
- Каждая фича — понятное бизнес-название на русском или английском
- Паттерны в \`include\` — glob относительно корня проекта, учитывай и клиент и сервер
- Один файл может попадать в несколько фич — это нормально
- Не создавай фичу "other" или "misc"

**Пример готового конфига** (для похожего AI-проекта):
\`\`\`json
${CONFIG_EXAMPLE}
\`\`\`

**Цвета** (используй разные для каждой фичи):
\`#58a6ff\` синий · \`#3fb950\` зелёный · \`#d2a8ff\` фиолетовый · \`#ffa657\` оранжевый
\`#f85149\` красный · \`#e3b341\` жёлтый · \`#39d353\` лайм · \`#79c0ff\` голубой · \`#ff7b72\` коралловый

---

## Порядок ответа

1. **Сначала** — уточняющие вопросы (если есть неясности)
2. **После ответов** — создай \`viberadar.config.json\`
3. **Кратко** — объясни логику разбивки на фичи

Начинай с вопросов.
`;
}
