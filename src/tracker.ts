import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export const TRACKER_FILE_NAME = 'viberadar.tasks.json';

export const TRACKER_STATUSES = ['backlog', 'todo', 'in-progress', 'review', 'done', 'archived'] as const;
export const TRACKER_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const TRACKER_TYPES = ['bug', 'feature', 'test', 'docs', 'observability', 'refactor', 'chore'] as const;
export const TRACKER_SOURCES = ['manual', 'review-import', 'agent-run', 'scan-finding'] as const;

export type TrackerStatus = typeof TRACKER_STATUSES[number];
export type TrackerPriority = typeof TRACKER_PRIORITIES[number];
export type TrackerType = typeof TRACKER_TYPES[number];
export type TrackerSource = typeof TRACKER_SOURCES[number];

export interface TrackerTask {
  id: string;
  title: string;
  description: string;
  prompt?: string;
  status: TrackerStatus;
  priority: TrackerPriority;
  type: TrackerType;
  featureKey?: string;
  filePaths: string[];
  tags: string[];
  acceptanceCriteria: string[];
  source: TrackerSource;
  order: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  lastRunId?: string;
}

export interface TrackerFile {
  version: 1;
  updatedAt: string;
  tasks: TrackerTask[];
}

export interface TrackerValidationIssue {
  index?: number;
  field: string;
  message: string;
}

export class TrackerValidationError extends Error {
  issues: TrackerValidationIssue[];

  constructor(issues: TrackerValidationIssue[]) {
    super(issues.map((i) => `${i.field}: ${i.message}`).join('; '));
    this.name = 'TrackerValidationError';
    this.issues = issues;
  }
}

type TaskDraft = Partial<Omit<TrackerTask, 'id' | 'createdAt' | 'updatedAt'>> & {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  prompt?: unknown;
  status?: unknown;
  priority?: unknown;
  type?: unknown;
  featureKey?: unknown;
  filePaths?: unknown;
  tags?: unknown;
  acceptanceCriteria?: unknown;
  source?: unknown;
  order?: unknown;
  completedAt?: unknown;
  lastRunId?: unknown;
};

type TaskPatch = Partial<Omit<TrackerTask, 'id' | 'createdAt' | 'updatedAt' | 'source'>>;

const STATUS_SET = new Set<string>(TRACKER_STATUSES);
const PRIORITY_SET = new Set<string>(TRACKER_PRIORITIES);
const TYPE_SET = new Set<string>(TRACKER_TYPES);
const SOURCE_SET = new Set<string>(TRACKER_SOURCES);

function nowIso(): string {
  return new Date().toISOString();
}

function emptyTrackerFile(): TrackerFile {
  return { version: 1, updatedAt: nowIso(), tasks: [] };
}

export function trackerFilePath(projectRoot: string): string {
  return path.join(projectRoot, TRACKER_FILE_NAME);
}

function normalizeText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.trim();
}

function normalizeStringArray(value: unknown, maxItems = 50): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim().replace(/\\/g, '/');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maxItems) break;
  }
  return result;
}

function isValidIsoString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function normalizeEnum<T extends string>(
  value: unknown,
  allowed: Set<string>,
  fallback: T,
  field: string,
  issues: TrackerValidationIssue[],
  index?: number,
): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const raw = value.trim();
  if (allowed.has(raw)) return raw as T;
  issues.push({ index, field, message: `ожидалось одно из: ${Array.from(allowed).join(', ')}` });
  return fallback;
}

function normalizeOrder(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(value);
}

function normalizeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 120) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(raw)) return null;
  return raw;
}

function makeTaskId(): string {
  return `task_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function uniqueTaskId(preferred: string | null, usedIds: Set<string>): string {
  const base = preferred || makeTaskId();
  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }
  let counter = 2;
  while (usedIds.has(`${base}-${counter}`)) counter++;
  const id = `${base}-${counter}`;
  usedIds.add(id);
  return id;
}

function nextOrder(tasks: TrackerTask[], status: TrackerStatus): number {
  const max = tasks
    .filter((task) => task.status === status)
    .reduce((acc, task) => Math.max(acc, task.order), 0);
  return max + 1000;
}

function parseTaskDraft(
  raw: unknown,
  options: {
    index?: number;
    usedIds: Set<string>;
    existingTasks: TrackerTask[];
    defaultSource: TrackerSource;
    defaultStatus?: TrackerStatus;
  },
): { task: TrackerTask | null; issues: TrackerValidationIssue[] } {
  const issues: TrackerValidationIssue[] = [];
  const index = options.index;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      task: null,
      issues: [{ index, field: 'task', message: 'задача должна быть объектом' }],
    };
  }

  const draft = raw as TaskDraft;
  const title = normalizeText(draft.title);
  if (!title) {
    issues.push({ index, field: 'title', message: 'обязательное поле' });
  }
  if (title.length > 180) {
    issues.push({ index, field: 'title', message: 'максимум 180 символов' });
  }

  const description = normalizeText(draft.description);
  const prompt = normalizeText(draft.prompt) || undefined;
  const status = normalizeEnum<TrackerStatus>(
    draft.status,
    STATUS_SET,
    options.defaultStatus || 'backlog',
    'status',
    issues,
    index,
  );
  const priority = normalizeEnum<TrackerPriority>(draft.priority, PRIORITY_SET, 'medium', 'priority', issues, index);
  const type = normalizeEnum<TrackerType>(draft.type, TYPE_SET, 'chore', 'type', issues, index);
  const source = normalizeEnum<TrackerSource>(draft.source, SOURCE_SET, options.defaultSource, 'source', issues, index);
  const featureKey = normalizeText(draft.featureKey) || undefined;
  const filePaths = normalizeStringArray(draft.filePaths, 100);
  const tags = normalizeStringArray(draft.tags, 30);
  const acceptanceCriteria = normalizeStringArray(draft.acceptanceCriteria, 50);
  const order = normalizeOrder(draft.order, nextOrder(options.existingTasks, status) + (index || 0));
  const createdAt = isValidIsoString((draft as any).createdAt) ? String((draft as any).createdAt) : nowIso();
  const updatedAt = isValidIsoString((draft as any).updatedAt) ? String((draft as any).updatedAt) : createdAt;
  const completedAt = isValidIsoString(draft.completedAt) ? draft.completedAt.trim() : undefined;
  const lastRunId = normalizeText(draft.lastRunId) || undefined;

  if (issues.length > 0) return { task: null, issues };

  const task: TrackerTask = {
    id: uniqueTaskId(normalizeId(draft.id), options.usedIds),
    title,
    description,
    prompt,
    status,
    priority,
    type,
    featureKey,
    filePaths,
    tags,
    acceptanceCriteria,
    source,
    order,
    createdAt,
    updatedAt,
    completedAt: status === 'done' ? (completedAt || updatedAt) : completedAt,
    lastRunId,
  };

  return { task, issues: [] };
}

function normalizeLoadedTask(raw: unknown, index: number, usedIds: Set<string>): TrackerTask {
  const parsed = parseTaskDraft(raw, {
    index,
    usedIds,
    existingTasks: [],
    defaultSource: 'manual',
  });
  if (parsed.issues.length > 0 || !parsed.task) {
    throw new TrackerValidationError(parsed.issues);
  }
  return parsed.task;
}

export function readTrackerFile(projectRoot: string): TrackerFile {
  const filePath = trackerFilePath(projectRoot);
  if (!fs.existsSync(filePath)) return emptyTrackerFile();
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TrackerValidationError([{ field: 'root', message: 'файл задач должен быть объектом' }]);
  }
  const version = (parsed as any).version;
  const tasksRaw = (parsed as any).tasks;
  if (version !== 1) {
    throw new TrackerValidationError([{ field: 'version', message: 'поддерживается только версия 1' }]);
  }
  if (!Array.isArray(tasksRaw)) {
    throw new TrackerValidationError([{ field: 'tasks', message: 'должен быть массив' }]);
  }
  const usedIds = new Set<string>();
  const tasks = tasksRaw.map((task, index) => normalizeLoadedTask(task, index, usedIds));
  const updatedAt = isValidIsoString((parsed as any).updatedAt) ? (parsed as any).updatedAt : nowIso();
  return { version: 1, updatedAt, tasks };
}

function writeTrackerFile(projectRoot: string, file: TrackerFile): TrackerFile {
  const filePath = trackerFilePath(projectRoot);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const updated: TrackerFile = {
    version: 1,
    updatedAt: nowIso(),
    tasks: file.tasks
      .slice()
      .sort((a, b) => a.status.localeCompare(b.status) || a.order - b.order || a.createdAt.localeCompare(b.createdAt)),
  };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return updated;
}

export function createTrackerTask(projectRoot: string, rawTask: unknown): TrackerTask {
  const file = readTrackerFile(projectRoot);
  const usedIds = new Set(file.tasks.map((task) => task.id));
  const parsed = parseTaskDraft(rawTask, {
    usedIds,
    existingTasks: file.tasks,
    defaultSource: 'manual',
    defaultStatus: 'backlog',
  });
  if (parsed.issues.length > 0 || !parsed.task) throw new TrackerValidationError(parsed.issues);
  const saved = writeTrackerFile(projectRoot, { ...file, tasks: [...file.tasks, parsed.task] });
  return saved.tasks.find((task) => task.id === parsed.task!.id)!;
}

export function importTrackerTasks(projectRoot: string, payload: unknown): { file: TrackerFile; imported: number } {
  const rawTasks: unknown[] | null = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as any).tasks)
      ? (payload as any).tasks
      : null;

  if (!rawTasks) {
    throw new TrackerValidationError([{ field: 'tasks', message: 'ожидается массив задач или объект { tasks: [...] }' }]);
  }

  const file = readTrackerFile(projectRoot);
  const usedIds = new Set(file.tasks.map((task) => task.id));
  const imported: TrackerTask[] = [];
  const issues: TrackerValidationIssue[] = [];

  rawTasks.forEach((rawTask, index) => {
    const parsed = parseTaskDraft(rawTask, {
      index,
      usedIds,
      existingTasks: [...file.tasks, ...imported],
      defaultSource: 'review-import',
      defaultStatus: 'backlog',
    });
    if (parsed.issues.length > 0 || !parsed.task) {
      issues.push(...parsed.issues);
      return;
    }
    imported.push(parsed.task);
  });

  if (issues.length > 0) throw new TrackerValidationError(issues);
  const saved = writeTrackerFile(projectRoot, { ...file, tasks: [...file.tasks, ...imported] });
  return { file: saved, imported: imported.length };
}

function applyTaskPatch(task: TrackerTask, patch: unknown): TrackerTask {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TrackerValidationError([{ field: 'patch', message: 'ожидается объект изменений' }]);
  }
  const raw = patch as TaskPatch;
  const issues: TrackerValidationIssue[] = [];
  const next: TrackerTask = { ...task };

  if ('title' in raw) {
    const title = normalizeText(raw.title);
    if (!title) issues.push({ field: 'title', message: 'обязательное поле' });
    else if (title.length > 180) issues.push({ field: 'title', message: 'максимум 180 символов' });
    else next.title = title;
  }
  if ('description' in raw) next.description = normalizeText(raw.description);
  if ('prompt' in raw) next.prompt = normalizeText((raw as any).prompt) || undefined;
  if ('status' in raw) next.status = normalizeEnum<TrackerStatus>(raw.status, STATUS_SET, task.status, 'status', issues);
  if ('priority' in raw) next.priority = normalizeEnum<TrackerPriority>(raw.priority, PRIORITY_SET, task.priority, 'priority', issues);
  if ('type' in raw) next.type = normalizeEnum<TrackerType>(raw.type, TYPE_SET, task.type, 'type', issues);
  if ('featureKey' in raw) next.featureKey = normalizeText(raw.featureKey) || undefined;
  if ('filePaths' in raw) next.filePaths = normalizeStringArray(raw.filePaths, 100);
  if ('tags' in raw) next.tags = normalizeStringArray(raw.tags, 30);
  if ('acceptanceCriteria' in raw) next.acceptanceCriteria = normalizeStringArray(raw.acceptanceCriteria, 50);
  if ('order' in raw) next.order = normalizeOrder(raw.order, task.order);
  if ('lastRunId' in raw) next.lastRunId = normalizeText(raw.lastRunId) || undefined;
  if ('completedAt' in raw) {
    next.completedAt = isValidIsoString(raw.completedAt) ? String(raw.completedAt) : undefined;
  }
  if (issues.length > 0) throw new TrackerValidationError(issues);

  if (next.status === 'done' && !next.completedAt) next.completedAt = nowIso();
  if (task.status === 'done' && next.status !== 'done' && !('completedAt' in raw)) delete next.completedAt;
  next.updatedAt = nowIso();
  return next;
}

export function updateTrackerTask(projectRoot: string, taskId: string, patch: unknown): TrackerTask {
  const file = readTrackerFile(projectRoot);
  const index = file.tasks.findIndex((task) => task.id === taskId);
  if (index === -1) {
    throw new TrackerValidationError([{ field: 'id', message: `задача не найдена: ${taskId}` }]);
  }
  const next = applyTaskPatch(file.tasks[index], patch);
  const tasks = file.tasks.slice();
  tasks[index] = next;
  const saved = writeTrackerFile(projectRoot, { ...file, tasks });
  return saved.tasks.find((task) => task.id === taskId)!;
}

export function archiveTrackerTask(projectRoot: string, taskId: string): TrackerTask {
  return updateTrackerTask(projectRoot, taskId, { status: 'archived' });
}

export function setTrackerTaskRun(projectRoot: string, taskId: string, runId: string | null): TrackerTask {
  return updateTrackerTask(projectRoot, taskId, { lastRunId: runId || undefined });
}

export function buildTrackerTaskPrompt(task: TrackerTask): string {
  const preparedPrompt = typeof task.prompt === 'string' ? task.prompt.trim() : '';
  const lines = [
    `Выполни задачу VibeRadar Task Tracker.`,
    ``,
    `Задача: ${task.title}`,
    `ID: ${task.id}`,
    `Тип: ${task.type}`,
    `Приоритет: ${task.priority}`,
    task.featureKey ? `Фича: ${task.featureKey}` : '',
    task.filePaths.length ? `Связанные файлы:\n${task.filePaths.map((p) => `- ${p}`).join('\n')}` : '',
    task.tags.length ? `Теги: ${task.tags.join(', ')}` : '',
    ``,
    task.description ? `Описание:\n${task.description}` : '',
    ``,
    task.acceptanceCriteria.length
      ? `Критерии приемки:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`
      : '',
    preparedPrompt ? `Подготовленный промпт:\n${preparedPrompt}` : '',
    ``,
    `Правила выполнения:`,
    `- Сначала классифицируй намерение, тип источников, требуемый результат и возможные side effects.`,
    `- Не хардкодь поведение под конкретный документ, домен, формулировку или единичный промпт.`,
    `- Делай обобщенное решение для класса задач, входов, ошибок или контрактов данных.`,
    `- После изменений запусти релевантные проверки проекта и кратко опиши результат.`,
  ].filter(Boolean);
  return lines.join('\n');
}
