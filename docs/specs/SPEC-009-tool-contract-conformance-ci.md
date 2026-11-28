# SPEC-009 · Контракт инструментов, тесты «чёрного ящика», CI и нейтральный протокол UI ↔ сервер

- **Статус:** утверждена; реализация проверена локально в ветке `spec-009-contract-ci`. Первый запуск GitHub Actions ещё не подтверждён.
- **Дата:** 2026-11-28
- **Основание:** `docs/audit/2026-11-28-zeroide-parity.md` (разделы 9 и 12; решение: Rust-ядро + Tauri 2, поэтапно)
- **Область:** `contracts/` (новое), `tests/conformance/` (новое), `scripts/` (новое), `src/index.ts`, `src/monitor.ts`, `src/tunnel/status.ts`, `desktop/src/main/server-manager.ts`, `.github/workflows/ci.yml` (новое), `package.json`

## 1. Контекст и проблема

Мы переносим сервер на Rust так, чтобы клиенты (Notion, ClickUp, Cursor, Claude и др.) ничего не заметили. Для этого поведение сервера нужно сначала зафиксировать снаружи, независимо от языка реализации. Сейчас:

1. Набора инструментов как документа нет: README и AGENTS.md говорят о 20 инструментах, в коде 24 (`src/tools/index.ts`).
2. Тесты: три скрипта (`tests/monitor.cjs`, `tests/tunnels.cjs`, `tests/packaged-smoke.cjs`), файловые инструменты, авторизация и терминал снаружи не проверяются; стенд `docs/audit/race-audit.cjs` запускается вручную.
3. CI нет (только `.github/dependabot.yml`), поэтому PR dependabot (в том числе MCP SDK 1.32.2) некому проверить.
4. Desktop общается с сервером через Node IPC: `spawn(process.execPath, [serverScript])` с каналом `process.send` (события `server:ready`, `server:error`, `tunnel:status`, `monitor:snapshot`; команды `monitor:set`, `shutdown`). Не-Node сервер этим каналом пользоваться не может, значит Rust-бинарник не встанет на место `dist/index.js` без правок UI.

## 2. Требования

### FR-1 · Снимок контракта инструментов
- FR-1.1 Файл `contracts/tools.json`: результат `tools/list` текущего сервера, нормализованный (сортировка по имени; для каждого инструмента `name`, `title`, `description`, `inputSchema`, `annotations`, если есть).
- FR-1.2 Скрипт `npm run contract:dump` поднимает сервер на временном порту с временным `FILES_ROOT`, снимает `tools/list` и перезаписывает `contracts/tools.json`. Перезапись только явная, этим скриптом.
- FR-1.3 Контракт описывает все 24 инструмента; `DISABLED_TOOLS` при снятии снимка пуст.

### FR-2 · Тесты «чёрного ящика» (`tests/conformance/`)
- FR-2.1 Запуск: `npm run test:conformance` (`node --test tests/conformance/`). Без переменных набор сам собирает и поднимает `dist/index.js` на случайном порту с временным `FILES_ROOT` и случайным ключом (как `tests/monitor.cjs`). С `MCP_URL` и `MCP_KEY` идёт против уже запущенного сервера; так же будет проверяться Rust-сервер.
- FR-2.2 Клиент: `@modelcontextprotocol/sdk` (`Client` + `StreamableHTTPClientTransport`), для SSE `SSEClientTransport`. Никаких импортов из `src/`.
- FR-2.3 Набор проверяет:
  - **contract:** живой `tools/list` совпадает с `contracts/tools.json`; при расхождении тест падает и показывает diff.
  - **auth:** без ключа `401`; `Authorization: Bearer` и `x-api-key` дают `200`; ключ в URL отклоняется, пока `query` не включён в `AUTH_METHODS`; чужой `Host` отклоняется.
  - **files:** `file_write` → `file_read` (UTF-8 и base64) → `file_replace` → повторный `file_replace` возвращает `already_applied: true` → `file_move` → `file_stat` → `file_delete`; кириллица сохраняется байт в байт.
  - **sandbox:** при `FULL_ACCESS=false` абсолютный путь вне `FILES_ROOT` и `..` отклоняются у чтения и записи.
  - **terminal:** `terminal_execute` возвращает `exitCode` 0 и stdout для `Write-Output 'ok'`; ненулевой код даёт `isError: true`; `timeout_ms: 1000` на `Start-Sleep 10` даёт `timedOut: true` за не более чем 3 с.
  - **workspace:** `workspace_set_cwd` на подпапку, после чего относительная запись попадает в неё.
  - **sse:** рукопожатие `/sse` + `tools/list` через `/messages`.
  - **browser** (только при `CONFORMANCE_BROWSER=1`): `browser_open` локальной страницы, `browser_get_content`, `browser_close`.
- FR-2.4 Каждый тест работает в своей временной папке и убирает за собой; установленную копию и реальный `FILES_ROOT` не трогает.

### FR-3 · CI
- FR-3.1 `.github/workflows/ci.yml`: на каждый push и pull request; `windows-latest`; Node 24; права `contents: read`; `ELECTRON_SKIP_BINARY_DOWNLOAD=1` для шагов, которым не нужен Electron.
- FR-3.2 Шаги: `npm ci` → `npm run check` → `npm run build` → `npm run test:conformance` → `npm run test:monitor`. `test:tunnels` и стенд гонок включаются отдельной задачей после проверки, что они детерминированы без сети.
- FR-3.3 Проверка, что в индекс не попали `.env`, `*.bak`, `release/`, `dist*/` (по правилам AGENTS.md 5.3).

### FR-4 · Нейтральный протокол управления
- FR-4.1 Переменная `MCP_CONTROL=stdio` включает протокол JSON-строк:
  - сервер → UI: строки stdout вида `[CTL] {"type":"server:ready"}`; те же типы, что сейчас уходят через `process.send` (`server:ready`, `server:error`, `tunnel:status`, `monitor:snapshot`), с тем же содержимым;
  - UI → сервер: JSON-строки в stdin (`{"type":"monitor:set","enabled":true}`, `{"type":"shutdown"}`).
- FR-4.2 Если сервер запущен с Node IPC (`process.send` есть), события продолжают уходить и туда, поэтому `tests/monitor.cjs` работает без изменений.
- FR-4.3 `server-manager.ts` переходит на `MCP_CONTROL=stdio`: читает `[CTL]` из того же построчного буфера, что уже разбирает `[AUDIT]`, и пишет команды в stdin. Поведение UI (статусы, монитор, туннель, выход) не меняется.
- FR-4.4 Строка `[CTL]` никогда не содержит секретов (как сейчас снимок монитора: `assert(!JSON.stringify(first).includes(key))`).
- FR-4.5 Протокол описывается в `contracts/control.md`; Rust-сервер (SPEC-011) реализует его же.

## 3. Дизайн

- Общий модуль `src/control.ts`: `emit(event)` пишет в `process.send` (если есть) и, при `MCP_CONTROL=stdio`, в stdout строкой `[CTL] ` + JSON; `onCommand(handler)` слушает `process.on("message")` и, при `MCP_CONTROL=stdio`, построчно stdin. `src/index.ts`, `src/monitor.ts` и `src/tunnel/status.ts` вызывают `emit` вместо `process.send`. Проверки `process.send` / `process.connected` в `monitor.ts` (сейчас строки 144 и 198: без IPC монитор выключен) заменяются на `control.isAttached()`, иначе при `MCP_CONTROL=stdio` монитор останется пустым.
- Помощник тестов `tests/conformance/_server.mjs`: сборка не выполняется (CI делает её отдельным шагом); если `dist/index.js` нет, тест падает с понятным сообщением. Порт выбирается через `listen(0)` и освобождается перед стартом сервера; готовность ждём по `GET /health`.
- Сравнение контракта: глубокое сравнение JSON после сортировки ключей; diff выводится через `node:assert` `deepStrictEqual`.
- Новые скрипты в `package.json`: `contract:dump`, `test:conformance`.

## 4. План задач

- [x] T1. `src/control.ts` + перевод `src/index.ts`, `src/monitor.ts`, `src/tunnel/status.ts`; тест: при `MCP_CONTROL=stdio` stdout содержит `[CTL] {"type":"server:ready"}`, а `{"type":"shutdown"}` в stdin завершает процесс с кодом 0
- [x] T2. `server-manager.ts` на stdio-протокол; ручная проверка в `npm run app:dev`: запуск, монитор, туннель, стоп, выход
- [x] T3. `scripts/contract-dump.mjs` и `contracts/tools.json` (24 инструмента)
- [x] T4. `tests/conformance/` по FR-2.3 (сначала тест падает на заведомо неверном снимке, потом зелёный)
- [x] T5. `contracts/control.md`
- [ ] T6. `.github/workflows/ci.yml`; первый прогон на ветке
- [x] T7. `npm run check`, `npm run build:renderer`, `npm run test:conformance`, `npm run test:monitor` локально

## 5. Критерии приёмки

- AC1. `npm run test:conformance` зелёный против текущего TS-сервера локально и в CI.
- AC2. Изменение схемы любого инструмента без `npm run contract:dump` роняет тест contract.
- AC3. `MCP_URL=... MCP_KEY=... npm run test:conformance` проходит против вручную запущенного сервера (готовность к проверке Rust-сервера).
- AC4. Desktop работает на stdio-протоколе: статусы «запуск / работает / ошибка порта», монитор и туннель как раньше; `tests/monitor.cjs` проходит без изменений.
- AC5. CI запускается на push и PR; PR dependabot получают статус.

## 6. Риски

- Тесты терминала на Windows-раннере медленнее локальных: таймауты задаются с запасом, не короче 3 с.
- Запись в stdin после выхода процесса: `server-manager.ts` проверяет `writable` перед отправкой.

## 7. Проверено в изолированной копии на Windows, 28.11.2026

- Сервер, Electron main и renderer собраны. Прошли `npm run check`, полный `npm run build` и все 13 conformance-тестов с `CONFORMANCE_BROWSER=1`, включая отдельный headless-браузер. Эталон содержит 24 инструмента: повторное снятие даёт те же байты; изменение одного поля схемы в копии даёт ненулевой выход и diff.
- 3 теста адаптера десктопа прошли. В реальном окне Electron на отдельном профиле проверены ошибка занятого порта, запуск, появление клиента в мониторе, пауза/возобновление, остановка и освобождение локального порта при выходе. Старый Node IPC проверен через `test:monitor` и `test:tunnels`; использовались имитации провайдеров, реальные туннели не открывались.
- Проверен режим `MCP_URL`/`MCP_KEY` против отдельно запущенного временного экземпляра. В последнем прогоне 8 проверок прошли; 5, требующие запуска или управления дочерним процессом, изменения конфигурации либо нового браузера, пропущены по назначению. Клиент конечных RPC не подписывается на необязательный бесконечный `GET /mcp`; связка `/sse` + `/messages` проверяется отдельным настоящим соединением.
- Для T6 готов workflow на push/PR, `windows-latest`, Node 24 и `contents: read`. Его структура и проверка Git-индекса проверены локально (включая отрицательный пример). Локальные тесты выполнялись на Node 22.22.2; результат GitHub Actions не заявляется до запуска на GitHub.
