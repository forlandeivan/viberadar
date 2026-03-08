# Logging Standard (v1)

## 1) Обязательные поля

Для каждого структурированного лога используется JSON-объект. Обязательные поля:

- `timestamp` — ISO-8601 (`2026-03-08T12:30:45.123Z`)
- `service` — имя сервиса (`billing-api`)
- `env` — среда (`local|dev|stage|prod`)
- `level` — `DEBUG|INFO|WARN|ERROR`
- `trace_id` — идентификатор распределённого трейса
- `span_id` — идентификатор текущего спана
- `request_id` — сквозной request-id
- `user_id` или `user_hash` — **только один** идентификатор пользователя (`user_id` для внутренних контуров, `user_hash` для внешних)
- `event_name` — доменное имя события
- `outcome` — `success|failure|partial`
- `error_code` — код ошибки из утверждённого словаря (для `WARN`/`ERROR` обязателен, для `INFO`/`DEBUG` опционален)

### Минимальный пример

```json
{
  "timestamp": "2026-03-08T12:30:45.123Z",
  "service": "payments-api",
  "env": "prod",
  "level": "ERROR",
  "trace_id": "4f5e2f5e9aa8f8b7",
  "span_id": "4f5e2f5e9aa8f8b7",
  "request_id": "req_01HXYZ",
  "user_hash": "usr_5f16b9",
  "event_name": "payment.charge.failed",
  "outcome": "failure",
  "error_code": "PAYMENT_TIMEOUT"
}
```

## 2) Naming-конвенция для `event_name`

Формат:

`<domain>.<entity>.<action>[.<result>]`

Правила:

1. Только `lower_snake_case` сегменты, разделитель — точка.
2. 3–4 сегмента, без динамических значений (ID, email, URL-параметры запрещены).
3. Глагол действия в прошедшей или процессной форме: `started|completed|failed|retried|validated`.
4. Для ошибок предпочтителен явный суффикс `failed`.

Примеры:

- `auth.session.created`
- `payment.charge.failed`
- `catalog.import.retried`
- `profile.email.validated`

Антипаттерны:

- `payment_failed_12345`
- `Error during payment`
- `payment.charge.failed.user_42`

## 3) Словарь `error_code`

Источник истины: `config/logging-error-codes.json`.

Базовые доменные коды:

- `VALIDATION_ERROR`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `RESOURCE_NOT_FOUND`
- `CONFLICT`
- `RATE_LIMITED`
- `DEPENDENCY_TIMEOUT`
- `DEPENDENCY_UNAVAILABLE`
- `DB_TIMEOUT`
- `DB_CONSTRAINT_VIOLATION`
- `INTERNAL_ERROR`

Правило расширения:

- Новые коды добавляются только через PR в словарь.
- Формат кода: `UPPER_SNAKE_CASE`.
- Код должен быть стабильным (не переименовывать без миграции дашбордов/алертов).

## 4) Правила лог-уровней

- `DEBUG` — только локальная диагностика и временный troubleshooting; в `prod` выключен по умолчанию.
- `INFO` — значимые бизнес-события и lifecycle операции.
- `WARN` — деградация, ретраи, graceful fallback, частичная потеря данных/сигнала.
- `ERROR` — фактический сбой операции или невозможность выполнить бизнес-функцию.

Дополнительно:

- Не логировать одну и ту же ошибку многократно на каждом слое.
- Исключения логируются в точке, где принимается решение о результате операции.

## 5) CI/линтер: обязательные проверки

В CI запускается `npm run lint:logs` (поддерживает override `LOG_LINT_PATTERNS`) и проверяет:

1. Неструктурированные строки в логгере (`logger.<level>("text")`) — запрещены.
2. Отсутствие обязательных полей в `WARN`/`ERROR`-логах.
3. Запрещённые паттерны (PII/секреты): `password`, `token`, `api_key`, `authorization`, `cookie`, email, телефон и т.п.

## 6) Migration checklist (1 sprint)

1. **Инвентаризация (День 1)**
   - Собрать все точки логирования сервиса.
   - Отметить `WARN`/`ERROR` события и текущие `event_name`/`error_code`.
2. **Схема и адаптер (День 2-3)**
   - Подключить единый logger adapter с JSON-форматом.
   - Автозаполнять `timestamp`, `service`, `env`, `trace_id`, `span_id`, `request_id`.
3. **Нормализация событий (День 3-4)**
   - Привести `event_name` к новой конвенции.
   - Заменить произвольные тексты ошибок на коды из словаря.
4. **Безопасность логов (День 4-5)**
   - Включить маскирование/удаление PII и секретов.
   - Добавить тестовые кейсы на редактирование чувствительных полей.
5. **CI enforcement (День 5-6)**
   - Включить `lint:logs` в pipeline.
   - Сделать блокирующим для merge в основной ветке.
6. **Валидация в окружениях (День 6-7)**
   - Проверить в `stage`: полнота полей, корректность уровней, алерты по `ERROR`.
   - Обновить дашборды/алерты по `event_name` + `error_code`.
7. **Definition of Done**
   - 100% `WARN`/`ERROR` логов содержат обязательные поля.
   - Нет PII/секретов в выборке логов за 24 часа.
   - Команда знает runbook по добавлению нового `event_name` и `error_code`.
