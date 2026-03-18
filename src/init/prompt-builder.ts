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
  existingConfig: string | null; // содержимое viberadar.config.json если уже есть
  // Service map discovery data
  dockerComposeServices: string[];
  envConnections: string[];
  workerFiles: string[];
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

  // Читаем существующий конфиг если есть
  let existingConfig: string | null = null;
  const configPath = path.join(projectRoot, 'viberadar.config.json');
  try {
    existingConfig = fs.readFileSync(configPath, 'utf-8');
  } catch {}

  // ─── Service discovery data for AI prompt ──────────────────────────────────
  const dockerComposeServices: string[] = [];
  for (const dcName of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const dcPath = path.join(projectRoot, dcName);
    if (fs.existsSync(dcPath)) {
      try {
        const content = fs.readFileSync(dcPath, 'utf-8');
        // Extract service names and images (simple line-based scan)
        let inServices = false;
        let indent = 0;
        for (const line of content.split('\n')) {
          if (/^services\s*:/.test(line)) { inServices = true; continue; }
          if (inServices) {
            const m = line.match(/^(\s+)(\w[\w-]*)\s*:/);
            if (m && m[1].length === 2) {
              dockerComposeServices.push(m[2]);
            }
            // If we hit another top-level key, stop
            if (/^\S/.test(line) && !line.startsWith('#')) inServices = false;
          }
        }
      } catch {}
      break;
    }
  }

  const envConnections: string[] = [];
  const envPatterns = /^(DATABASE_URL|PG_HOST|POSTGRES_HOST|REDIS_URL|REDIS_HOST|QDRANT_URL|MINIO_ENDPOINT|SMTP_HOST|OPENAI_API_KEY|ANTHROPIC_API_KEY|MONGO_URL|RABBITMQ_URL|KAFKA_BROKERS|ELASTICSEARCH_URL|CLICKHOUSE_URL)/;
  for (const envName of ['.env', '.env.example', '.env.local']) {
    const envPath = path.join(projectRoot, envName);
    if (!fs.existsSync(envPath)) continue;
    try {
      for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const key = trimmed.split('=')[0]?.trim();
        if (key && envPatterns.test(key) && !envConnections.includes(key)) {
          envConnections.push(key);
        }
      }
    } catch {}
  }

  const workerFiles = collectFiles(projectRoot, /worker|job|queue|cron/i, 30)
    .filter(f => /\.(ts|js)$/.test(f) && !/node_modules|dist|build/.test(f))
    .map(f => path.relative(projectRoot, f));

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
    existingConfig,
    dockerComposeServices,
    envConnections,
    workerFiles: workerFiles.slice(0, 30),
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

const SERVICES_CONFIG_EXAMPLE = JSON.stringify({
  nodes: [
    { id: 'docling', label: 'Docling', category: 'external-api', icon: '📄' },
    { id: 'speechkit', label: 'Yandex SpeechKit', category: 'external-api', icon: '🎙️' },
  ],
  edges: [
    { from: 'app', to: 'postgres', label: 'sessions, data', type: 'sync', critical: true },
    { from: 'app', to: 'redis', label: 'cache, pubsub', type: 'async' },
    { from: 'kb-indexing-worker', to: 'qdrant', label: 'vector store', type: 'sync' },
  ],
  pipelines: [
    {
      id: 'kb-indexing',
      label: 'KB Indexing Pipeline',
      description: 'Загрузка документа → парсинг → эмбеддинги → векторное хранилище',
      steps: [
        { id: 'upload', label: 'File Upload', serviceId: 'minio' },
        { id: 'parse', label: 'Document Parsing', serviceId: 'docling' },
        { id: 'embed', label: 'Embedding', serviceId: 'openai' },
        { id: 'store', label: 'Vector Storage', serviceId: 'qdrant' },
        { id: 'index', label: 'Metadata Index', serviceId: 'postgres' },
      ],
      triggers: ['POST /api/kb/upload', 'file-event-outbox worker'],
    },
  ],
}, null, 2);

export function buildPrompt(snap: ProjectSnapshot): string {
  const scripts = snap.packageJson.scripts
    ? filterScripts(snap.packageJson.scripts)
    : {};

  const isUpdate = snap.existingConfig !== null;

  const projectData = `
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
` : ''}`;

  const serviceDiscoveryData = `
${snap.dockerComposeServices.length > 0 ? `### Docker Compose сервисы:
${snap.dockerComposeServices.map(s => `- ${s}`).join('\n')}
` : ''}
${snap.envConnections.length > 0 ? `### Подключения из .env:
${snap.envConnections.map(s => `- ${s}`).join('\n')}
` : ''}
${snap.workerFiles.length > 0 ? `### Воркеры / фоновые задачи:
${snap.workerFiles.map(f => `- ${f}`).join('\n')}
` : ''}`;

  const configRules = `**Правила конфига:**
- Оптимально **10–20 фич** — не дроби слишком мелко, не объединяй несвязанное
- Каждая фича — понятное бизнес-название на русском или английском
- Паттерны в \`include\` — glob относительно корня проекта, учитывай и клиент и сервер
- Один файл может попадать в несколько фич — это нормально
- Не создавай фичу "other" или "misc"

**Цвета** (используй разные для каждой фичи):
\`#58a6ff\` синий · \`#3fb950\` зелёный · \`#d2a8ff\` фиолетовый · \`#ffa657\` оранжевый
\`#f85149\` красный · \`#e3b341\` жёлтый · \`#39d353\` лайм · \`#79c0ff\` голубой · \`#ff7b72\` коралловый · \`#a371f7\` лаванда · \`#ff7b72\` коралловый`;

  if (isUpdate) {
    // ── Режим обновления ──────────────────────────────────────────────────────
    return `# VibeRadar — Обновление карты фич и сервисов проекта

## Контекст

VibeRadar — инструмент для визуализации архитектуры проекта, тест-покрытия по фичам и карты сервисов.
Конфиг для проекта **${snap.name}** уже существует. Твоя задача — **обновить** его
согласно пожеланиям пользователя.
${projectData}
${serviceDiscoveryData}
---

## Текущий конфиг (viberadar.config.json):

\`\`\`json
${snap.existingConfig}
\`\`\`

---

## Твоя задача

Пользователь хочет изменить конфиг. Выслушай его пожелания и внеси изменения.

**Что можно делать с features:**
- Разбить одну фичу на несколько (например, "admin" → "admin-users" + "admin-workspaces")
- Объединить несколько фич в одну
- Переименовать фичу
- Добавить новую фичу
- Изменить паттерны \`include\` чтобы точнее покрывать файлы
- Изменить цвет фичи

**Что можно делать с services:**
- Добавить/удалить ноды (внешние API, микросервисы)
- Добавить/изменить рёбра (зависимости между сервисами)
- Добавить/изменить пайплайны и их шаги
- Добавить алерт-хинты для мониторинга
- Если секции services ещё нет — создать её

${configRules}

---

## Порядок ответа

1. **Уточни** что именно пользователь хочет изменить (если непонятно)
2. **Внеси изменения** в конфиг — покажи только изменённые секции или весь файл целиком
3. **Сохрани** обновлённый \`viberadar.config.json\` в корне проекта

Спроси: "Что хочешь изменить в текущем конфиге?"
`;
  }

  // ── Режим создания ────────────────────────────────────────────────────────
  return `# VibeRadar — Настройка карты фич и сервисов проекта

## Контекст

VibeRadar — инструмент для визуализации архитектуры проекта, тест-покрытия по фичам и карты сервисов.
Тебе нужно проанализировать проект **${snap.name}** и создать файл \`viberadar.config.json\`
с описанием бизнес-фич, паттернами файлов и **картой сервисов** (зависимости, пайплайны, алерты).
${projectData}
${serviceDiscoveryData}
---

## Твоя задача

### Часть 1: Карта фич

#### Шаг 1 — Анализ
Изучи структуру проекта. Определи **бизнес-фичи** — не технические слои.

✅ Хорошие фичи (что видит пользователь, что можно сломать изолированно):
"Авторизация", "Чаты с AI", "Навыки", "Базы знаний", "Файлы", "Биллинг", "Интеграции", "Админ-панель"

❌ Плохие фичи (технические абстракции):
"Components", "Utils", "Helpers", "Common", "Shared", "Services"

#### Шаг 2 — Уточняющие вопросы
**ОБЯЗАТЕЛЬНО** задай вопросы по неочевидным модулям прежде чем генерировать конфиг.
Не угадывай назначение — лучше 3–5 вопросов, чем неточный результат.

${configRules}

### Часть 2: Карта сервисов (services)

VibeRadar автоматически обнаруживает сервисы из docker-compose, .env и package.json.
Но тебе нужно **дополнить** автодискаверинг:

1. **Ноды** — внешние сервисы которые НЕ видны в docker-compose/env (сторонние API, микросервисы)
2. **Рёбра (edges)** — связи между сервисами: кто от кого зависит, тип связи (sync/async/pubsub/data), какие critical
3. **Пайплайны** — ключевые потоки данных в системе (это бизнес-логика, её нельзя угадать!)
4. **Алерт-хинты** — рекомендации для мониторинга (опционально)

**Категории нод:** database, cache, queue, storage, external-api, internal-service, worker, gateway

**Типы рёбер:** sync (синхронный вызов), async (асинхронный), pubsub (pub/sub), data (поток данных)

**Пример services-конфига:**
\`\`\`json
${SERVICES_CONFIG_EXAMPLE}
\`\`\`

**Правила services:**
- id нод из docker-compose/env уже автодискаверятся (postgres, redis, qdrant, minio и т.д.) — не дублируй их в nodes
- В edges используй эти id для ссылок
- Пайплайны — самое важное! Опиши ВСЕ ключевые потоки данных
- Каждый шаг пайплайна привязан к сервису через serviceId
- triggers — что запускает пайплайн (HTTP endpoint, cron, событие)

#### Шаг 3 — Генерация конфига
После ответов создай \`viberadar.config.json\` в корне проекта.
Конфиг должен содержать И features И services.

**Пример features-конфига:**
\`\`\`json
${CONFIG_EXAMPLE}
\`\`\`

---

## Порядок ответа

1. **Сначала** — уточняющие вопросы (по фичам И по сервисам/пайплайнам)
2. **После ответов** — создай \`viberadar.config.json\` с features + services
3. **Кратко** — объясни логику разбивки

Начинай с вопросов.
`;
}
