# Правила работы с viberadar

## Git
- Всегда работать напрямую в ветке `main`
- Никаких worktree, никаких feature-веток
- После любых изменений: коммит → `git push origin main`

## npm публикация
- Публиковать синхронно с каждым пушем в main
- Порядок: `npm version patch` → `npm run build` → `npm publish` → `git push origin main`
- Версия в `package.json` всегда должна совпадать с последней опубликованной на npmjs

## Коммиты
- Коммитить сразу в main, не накапливать изменения
- Использовать Conventional Commits: `feat:`, `fix:`, `chore:`
