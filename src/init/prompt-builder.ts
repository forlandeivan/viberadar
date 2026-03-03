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

// ─── Сканирование структуры проекта ───────────────────────────────────────────

const IGNORE = new Set([
  'node_modules', 'dist', 'build', '.git', '.next', 'coverage',
  '.nyc_output', '__pycache__', '.venv', '.turbo', '.cache',
]);

function buildDirTree(dir: string, prefix = '', depth = 0): string {
  if (depth > 4) return '';
  let result = '';
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }

  const filtered = entries
    .filter(e => !IGNORE.has(e.name) && !e.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 30); // не больше 30 элементов на уровень

  filtered.forEach((entry, i) => {
    const isLast = i === filtered.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';
    result += `${prefix}${connector}${entry.name}${entry.isDirectory() ? '/' : ''}\n`;
    if (entry.isDirectory()) {
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
      if (IGNORE.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (pattern.test(e.name)) results.push(full);
    }
  }
  walk(dir);
  return results;
}

function detectTechStack(pkg: Record<string, any>): string[] {
  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };
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
    name: packageJson.name || path.basename(projectRoot),
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

export function buildPrompt(snap: ProjectSnapshot): string {
  const configSchema = JSON.stringify({
    version: '1',
    features: {
      'feature-name': {
        label: 'Читаемое название фичи',
        description: 'Что делает эта фича с точки зрения пользователя',
        include: ['**/паттерн-файлов*', '**/другой-паттерн*'],
        color: '#58a6ff',
      },
    },
  }, null, 2);

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

### Структура папок:
\`\`\`
${snap.name}/
${snap.dirTree}\`\`\`

${snap.pageFiles.length > 0 ? `### Найденные страницы/компоненты:
${snap.pageFiles.map(f => `- ${f}`).join('\n')}
` : ''}
${snap.routeFiles.length > 0 ? `### Найденные роуты/API:
${snap.routeFiles.map(f => `- ${f}`).join('\n')}
` : ''}
${snap.testFiles.length > 0 ? `### Найденные тест-файлы (первые 30):
${snap.testFiles.map(f => `- ${f}`).join('\n')}
` : ''}
${snap.packageJson.scripts ? `### Скрипты из package.json:
${Object.entries(snap.packageJson.scripts).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
` : ''}

---

## Твоя задача

### Шаг 1 — Анализ
Изучи структуру проекта. Определи **бизнес-фичи** — не технические слои (не "components", не "utils"),
а именно то, что видит пользователь и что можно сломать отдельно.

Примеры хороших фич: "Авторизация", "Чаты с AI", "Навыки", "Файлы", "Биллинг", "Админ-панель"
Примеры плохих фич: "Components", "Utils", "Helpers", "Common"

### Шаг 2 — Уточнения
**ВАЖНО:** Если ты не уверен в назначении какой-то папки или модуля — **обязательно спроси**.
Не угадывай. Лучше задать 3–5 уточняющих вопросов, чем сделать неточный конфиг.

Примеры вопросов:
- "Вижу папку \`actions/\` — это фича или внутренняя система?"
- "Есть файлы \`skills\` и \`agents\` — это одна фича или разные?"
- "Что делает модуль \`no-code\`?"

### Шаг 3 — Генерация конфига
После уточнений создай файл \`viberadar.config.json\` в корне проекта.

**Правила конфига:**
- Не более 15 фич (оптимально 5–10)
- Каждая фича — понятное бизнес-название на русском или английском
- Паттерны в \`include\` — glob-паттерны относительно корня проекта
- Один файл может попадать в несколько фич (это нормально)
- Фича "other" не нужна — только значимые фичи

**Схема конфига:**
\`\`\`json
${configSchema}
\`\`\`

**Доступные цвета (используй разные для каждой фичи):**
\`#58a6ff\` (синий), \`#3fb950\` (зелёный), \`#d2a8ff\` (фиолетовый),
\`#ffa657\` (оранжевый), \`#f85149\` (красный), \`#e3b341\` (жёлтый),
\`#39d353\` (лайм), \`#79c0ff\` (голубой), \`#ff7b72\` (коралловый)

---

## Формат ответа

1. Сначала задай все уточняющие вопросы (если есть)
2. После получения ответов — создай файл \`viberadar.config.json\`
3. Кратко объясни почему выбрал именно эти фичи

Начинай с анализа и вопросов.
`;
}
