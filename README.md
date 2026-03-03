# 🔭 VibeRadar

> Live module map with test coverage for vibecoding projects.

Run it in any project root — VibeRadar scans your source files, reads Playwright/Istanbul coverage, and opens an interactive dashboard in your browser.

## Usage

```bash
npx viberadar
```

Opens `http://localhost:4242` with a live map of:
- All source modules (TypeScript, JavaScript, Vue, Svelte)
- Which ones have tests and which don't
- Coverage metrics (lines, statements, functions, branches)
- Module sizes and local dependency graph

## Dashboard

- **Filter by type** — component, service, util, test, config
- **Search** by name or path
- **Click any card** to see full coverage breakdown and dependencies

## Coverage data

VibeRadar reads coverage from `coverage/coverage-summary.json` (Istanbul/V8 format).

Generate it with:

```bash
# Vitest
npx vitest run --coverage

# Jest
npx jest --coverage

# Playwright (with coverage plugin)
npx playwright test
```

## Tech

- CLI: TypeScript + Node.js
- Dashboard: vanilla HTML/JS (zero dependencies in browser)
- Server: Node.js `http` module
- Port: `4242`

## License

MIT
