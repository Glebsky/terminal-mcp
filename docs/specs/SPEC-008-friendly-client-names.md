# SPEC-008 · Понятные имена клиентов в Connection Monitor

- **Статус:** Реализовано (проверено тестами и сборкой)
- **Дата:** 2026-11-23
- **Область:** сервер (`src/monitor.ts`, `src/server.ts`), типы (`desktop/src/types.ts`), рендерер (`desktop/src/renderer/components/Monitor.tsx`, `desktop/src/renderer/styles/liquid-glass.css`)

## 1. Контекст и проблема

В списке **«Последние клиенты»** (Recent Clients) на вкладке «Монитор» отображаются технические идентификаторы сетевого уровня, которые непонятны пользователю:
1. `undici · ::ffff:127.0.0.1`:
   - `undici` — внутренний HTTP-клиент Node.js (используется по умолчанию в `fetch` в Claude Desktop, Cursor, расширениях VS Code).
   - `::ffff:127.0.0.1` — технический IPv6-mapped IPv4 адрес локального хоста.
2. Раздвоение клиентов:
   - В протоколе MCP клиент передаёт `clientInfo` (например, `{ name: "cursor", version: "0.42.0" }`) только в первом запросе `initialize`.
   - В последующих вызовах инструментов (`tools/call`) поле `clientInfo` отсутствует, и сервер откатывается к `User-Agent` (`undici`). В итоге один и тот же клиент делится на две записи: `cursor` с 1 запросом и `undici` с остальными запросами.
3. Сырые строки браузеров `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...` занимают всю строку и не дают понять, что это за клиент.

## 2. Требования

### FR-1 · Сохранение имени клиента по сессии (Session Persistence)
- FR-1.1 При обработке запроса `initialize` сервер фиксирует `clientInfo.name` и `clientInfo.version`.
- FR-1.2 Для SSE-транспорта имя привязывается к `sessionId`. Все последующие POST-запросы к `/messages?sessionId=...` используют это имя клиента.
- FR-1.3 Для HTTP-транспорта (`/mcp`) имя клиента сохраняется для текущего сокета / сессии (`mcp-session-id`) и пира.
- FR-1.4 Последующие запросы (`tools/call`, `tools/list` и др.) от этого клиента увеличивают счётчик запросов у уже созданной записи клиента, а не создают фиктивного клиента `undici`.

### FR-2 · Нормализация сетевого адреса (Peer Normalization)
- FR-2.1 Префикс `::ffff:` отсекается у всех IPv4-mapped адресов (`::ffff:127.0.0.1` → `127.0.0.1`).
- FR-2.2 Локальные адреса `127.0.0.1` и `::1` форматируются как `localhost`.

### FR-3 · Человекочитаемый парсинг User-Agent (Fallback)
- FR-3.1 Если `clientInfo` не был передан, распознаются частые библиотеки и среды:
  - `undici` → `Node.js (MCP Client)`
  - `node-fetch` → `Node.js Client`
  - `axios` → `Axios Client`
  - `python-requests` → `Python Client`
  - Браузерные строки `Mozilla/5.0 ...` парсятся до компактного названия браузера: `Chrome (Web)`, `Firefox (Web)`, `Safari (Web)`, `Edge (Web)` или `Web Client`.
  - `curl` → `cURL`
  - `@modelcontextprotocol/inspector` → `MCP Inspector`
  - `@modelcontextprotocol` → `MCP SDK`

### FR-4 · Структурированные данные и обратная совместимость
- FR-4.1 В `recentClients` сохраняется строковое поле `client` (для совместимости с тестами и существующим кодом), сформированное в чистом виде (например, `Cursor v0.42.0 · localhost`).
- FR-4.2 Добавляются опциональные поля: `displayName`, `version`, `peer`.

### FR-5 · Отображение в интерфейсе десктопа (UI)
- FR-5.1 В `.client-row` имя клиента отображается наглядно: имя и версия акцентным цветом, сетевой адрес (`localhost` / IP) — аккуратным второстепенным бейджем.
- FR-5.2 Аватарка берёт первую букву читаемого имени (`displayName`), избегая знаков препинания вроде двоеточия от `::ffff:`.
- FR-5.3 Вёрстка сохраняет однострочный компактный вид и корректно отображается в тёмной и светлой теме.

## 3. План задач

- [x] T1. Реализовать кэш сессий и нормализацию адресов/User-Agent в `src/monitor.ts`
- [x] T2. Подключить очистку сессий при завершении SSE в `src/server.ts`
- [x] T3. Обновить типы `desktop/src/types.ts`
- [x] T4. Обновить рендеринг в `desktop/src/renderer/components/Monitor.tsx` и стили в `liquid-glass.css`
- [x] T5. Проверить типы (`npm run check`), сборку (`npm run build:renderer`) и тесты монитора (`npm run test:monitor`)

## 4. Критерии приёмки

- AC1. В списке клиентов отсутствуют `::ffff:127.0.0.1` (заменено на `localhost`).
- AC2. При работе через SSE или HTTP клиент, передавший `initialize`, сохраняет своё имя (`Cursor`, `Claude Desktop` и т.д.) на всех последующих вызовах инструментов, не превращаясь в `undici`.
- AC3. Неизвестные клиенты с User-Agent `undici` отображаются как `Node.js (MCP Client)`.
- AC4. Все тесты `npm run test:monitor` и проверка типов `npm run check` проходят без ошибок.
