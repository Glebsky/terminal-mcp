# SPEC-010 · Самозащита сервера, маскирование секретов в ответах, аннотации инструментов

- **Статус:** Черновик (на утверждении)
- **Дата:** 2026-11-28
- **Основание:** `docs/audit/2026-11-28-zeroide-parity.md`, раздел 4 (П0) и раздел 11
- **Зависит от:** SPEC-009 (тесты пишутся в `tests/conformance/`, контракт обновляется через `contract:dump`)
- **Область:** `src/tools/filesystem.ts`, `src/tools/types.ts`, `src/tools/index.ts`, `src/tools/browser.ts`, `src/utils/env.ts`, `src/utils/logger.ts`, `src/config.ts`, `src/tunnel/cli.ts` (пометка quick tunnel), `desktop/src/renderer/components/TunnelSettings.tsx`, i18n (`en.ts`, `ru.ts`, `uk.ts`), `README.md`, `README_RU.md`, `AGENTS.md`

## 1. Контекст и проблема

1. **Агент видит секреты самого сервера.** На рабочем ПК `FILES_ROOT` = `C:\OSPanel\home`, а `.env` проекта лежит внутри (`terminal-mcp\.env`). Конфиг десктопа лежит в `%APPDATA%\mcp-terminal\config\.env` или в `MCP Terminal Data\` рядом с portable exe (`desktop/src/main/index.ts:283-285`) и при `FULL_ACCESS=true` тоже доступен. Любой подключённый агент может прочитать `MCP_API_KEY`, `NGROK_AUTHTOKEN`, `BASIC_AUTH_PASSWORD` и токены туннелей через `file_read`, `file_search`, `terminal_execute` (`Get-Content`) или `browser_navigate` на `file:///`.
2. **Маскирование только в аудите.** `redact()` из `src/utils/logger.ts` вызывается только из `auditLog`; ответы инструментов (`textResult` в `src/tools/types.ts`) идут как есть. `scrubbedEnv()` убирает секреты из окружения дочерних процессов, но не защищает файл на диске.
3. **Нет аннотаций MCP.** Ни у одного из 24 инструментов нет `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`, поэтому клиенты не могут отличить чтение от удаления и спросить подтверждение.
4. **Cloudflare quick tunnel выглядит как рабочий вариант.** По документации Cloudflare quick tunnels не поддерживают SSE, держат не более 200 запросов в полёте и не дают гарантий; в аудите от 2026-11-20 он умирал после переподключения.
5. **Документация разъехалась:** 20 инструментов вместо 24, ссылка клонирования на `Speedstu/notion-terminal-mcp`, в таблице конфигурации нет части переменных.

## 2. Требования

### FR-1 · Защищённые пути
- FR-1.1 Набор защищённых путей строится при старте сервера:
  - файл `DOTENV_PATH`, если задан, и вся его папка (это `%APPDATA%\mcp-terminal\config` или `MCP Terminal Data`);
  - `.env` и `.env.*` в папке сервера (`process.cwd()` при запуске, откуда его читает dotenv), кроме `.env.example`;
  - файл `AUDIT_LOG_FILE`, если задан;
  - дополнительные пути из новой переменной `PROTECTED_PATHS` (через `;`).
- FR-1.2 Сравнение по реальному пути (после symlink и junction, тем же `realTarget`, что и для песочницы), на Windows без учёта регистра. Защищённая папка защищает всё внутри.
- FR-1.3 Проверка стоит в одной точке: `resolveTarget()` в `src/tools/filesystem.ts`, сразу после `enforceSandbox()`, и действует при любом `FULL_ACCESS`.
  - `file_read`, `file_write`, `file_replace`, `file_move` (источник и приёмник), `file_delete`, `file_mkdir` внутри защищённой папки: отказ с ошибкой `Access denied: "<путь>" is protected server configuration`.
  - `file_delete` и `file_move` папки, которая содержит защищённый путь: тот же отказ.
  - `file_search`: защищённые файлы не читаются и попадают в `skipped` с `reason: "protected"`.
  - `file_list` и `file_stat`: метаданные доступны (имя, размер), содержимое нет; добавляется поле `protected: true`.
- FR-1.4 `browser_open` / `browser_navigate` / `browser_new_tab` с `file:` URL на защищённый путь: отказ (проверка в `normalizeBrowserUrl`).
- FR-1.5 Каждый отказ пишется в аудит событием `protected_denied` (инструмент, путь).
- FR-1.6 Отключение только явным подтверждением, по образцу `ALLOW_NO_AUTH`: `ALLOW_SELF_ACCESS=I_UNDERSTAND_AGENTS_CAN_READ_SERVER_SECRETS`, с предупреждением `[SECURITY]` при старте.
- FR-1.7 Десктоп продолжает читать и писать свой конфиг как раньше: это делает главный процесс Electron (`server-manager.ts`), а не MCP-инструменты.

### FR-2 · Маскирование секретов в ответах
- FR-2.1 Все ответы инструментов проходят через одну функцию в `textResult()` / `errorResult()`: текущие значения из `sensitiveValues()` (длиной от 8 символов) заменяются на `[REDACTED]`. Это накрывает `terminal_execute` (`Get-Content .env`, `echo $env:...`), содержимое страниц браузера и ошибки.
- FR-2.2 Заменяются только точные значения секретов сервера. Общие шаблоны `SECRET_PATTERNS` из `logger.ts` в ответах **не** применяются: они портили бы обычный код (`token = ...`, `password:` в исходниках проектов агента).
- FR-2.3 Для `file_read` с `encoding: "base64"` маскирование невозможно без декодирования, поэтому защита обеспечивается FR-1 (файлы с секретами защищены); это ограничение фиксируем в AGENTS.md.
- FR-2.4 Сохраняется правило SPEC-006: маскирование не разрезает символы и не ломает `offset` / `next_offset`, потому что применяется к готовому JSON-тексту ответа после пагинации.

### FR-3 · Аннотации инструментов
- FR-3.1 У каждого `server.registerTool(...)` появляется `annotations` по таблице (R = `readOnlyHint`, D = `destructiveHint`, I = `idempotentHint`, O = `openWorldHint`):

| Инструмент | R | D | I | O |
|---|---|---|---|---|
| `terminal_execute` | false | true | false | true |
| `file_read`, `file_list`, `file_stat`, `file_search` | true | false | true | false |
| `file_write` (есть `append`) | false | true | false | false |
| `file_replace` (повтор даёт `already_applied`) | false | true | true | false |
| `file_mkdir` | false | false | true | false |
| `file_move` | false | true | false | false |
| `file_delete` | false | true | true | false |
| `workspace_get_cwd` | true | false | true | false |
| `workspace_set_cwd` | false | false | true | false |
| `browser_open`, `browser_navigate`, `browser_new_tab`, `browser_connect` | false | false | false | true |
| `browser_evaluate`, `browser_click`, `browser_type` | false | true | false | true |
| `browser_get_content`, `browser_list_tabs` | true | false | true | true |
| `browser_screenshot` (может писать файл) | false | false | true | true |
| `browser_select_tab`, `browser_close` | false | false | true | false |

- FR-3.2 Имена, `title`, описания и `inputSchema` не меняются; `contracts/tools.json` обновляется через `npm run contract:dump`, и diff контракта содержит только `annotations`.
- FR-3.3 Аннотации это подсказка клиенту, а не защита: в AGENTS.md и README так и пишем.

### FR-4 · Cloudflare quick tunnel только для теста
- FR-4.1 В настройках туннеля (`TunnelSettings.tsx`) у режима `quick` пометка «Для теста: адрес меняется, SSE не поддерживается» на трёх языках (ключ добавляется в `en.ts`, `ru.ts`, `uk.ts`).
- FR-4.2 При старте quick tunnel сервер пишет в лог предупреждение и совет пользоваться `/mcp`, а не `/sse`. Поведение туннеля не меняется.
- FR-4.3 В README, README_RU и TUNNELS.md то же предупреждение со ссылкой на документацию Cloudflare.

### FR-5 · Документация
- FR-5.1 README, README_RU, AGENTS.md: 24 инструмента, описание `browser_connect`, `browser_list_tabs`, `browser_new_tab`, `browser_select_tab` (из их схем в `contracts/tools.json`).
- FR-5.2 Ссылка клонирования: `https://github.com/Glebsky/terminal-mcp.git`.
- FR-5.3 Таблица конфигурации дополнена: `AUTH_METHODS`, `BASIC_AUTH_USER`, `BASIC_AUTH_PASSWORD`, `ALLOW_NO_AUTH`, `TUNNEL_PROVIDER`, `DISABLED_TOOLS`, `AUDIT_LOG_FILE`, `MAX_SSE_SESSIONS`, настройки tuna / cloudflare / localtunnel, новые `PROTECTED_PATHS` и `ALLOW_SELF_ACCESS`.
- FR-5.4 Раздел «Безопасность» в SECURITY.md: самозащита, маскирование, что они **не** закрывают (команда может скопировать файл или закодировать секрет; настоящая защита команд будет в SPEC-013).

## 3. Дизайн

- Новый модуль `src/utils/protected.ts`: `buildProtectedSet()` при старте, `isProtected(realPath): boolean`, `containsProtected(dirRealPath): boolean`. Используется в `resolveTarget()` (нужен новый параметр `options.intent: "read" | "write" | "meta"`, по умолчанию `"read"`; `file_list` / `file_stat` передают `"meta"`), в `searchFiles()` и в `normalizeBrowserUrl()`.
- `redactOutput(text)` в `src/utils/logger.ts` рядом с `redact()`: только точные значения из `sensitiveValues()`. Вызывается в `textResult()`; список значений кэшируется на старте (окружение сервера после старта не меняется).
- Аннотации: таблица `TOOL_ANNOTATIONS` в `src/tools/annotations.ts`, чтобы Rust-сервер и сайт брали те же значения из `contracts/tools.json`. Тест: у каждого инструмента есть все четыре флага.

## 4. План задач

- [ ] T1. Падающие тесты в `tests/conformance/protected.test.mjs`: сервер с `DOTENV_PATH` внутри временного `FILES_ROOT`; `file_read`, `file_write`, `file_replace`, `file_move`, `file_delete` на нём отклоняются; `file_search` по значению ключа ничего не находит и показывает `reason: "protected"`; `terminal_execute` с `Get-Content` этого файла возвращает `[REDACTED]` и не содержит ключа; обычный файл со строкой `token = "abc"` читается без изменений
- [ ] T2. `src/utils/protected.ts` + интеграция в `filesystem.ts` и `browser.ts`; аудит `protected_denied`; `ALLOW_SELF_ACCESS` в `config.ts`
- [ ] T3. `redactOutput` в `textResult()` / `errorResult()`
- [ ] T4. `src/tools/annotations.ts` + `annotations` во всех 24 регистрациях; `npm run contract:dump`; проверить, что diff контракта только про аннотации
- [ ] T5. Пометка quick tunnel в UI (3 словаря) и в логе сервера
- [ ] T6. README, README_RU, AGENTS.md, SECURITY.md, TUNNELS.md по FR-4.3 и FR-5
- [ ] T7. `npm run check`, `npm run build:renderer`, `npm run test:conformance`, `npm run test:monitor`; ручная проверка: из ClickUp через подключение `file_read` на `terminal-mcp\.env` отклоняется, обычная работа с проектами не затронута

## 5. Критерии приёмки

- AC1. Ни один MCP-инструмент не возвращает содержимое `.env` сервера и значения `MCP_API_KEY`, `NGROK_AUTHTOKEN`, `BASIC_AUTH_PASSWORD`, токенов туннелей (проверено тестами T1) при `FULL_ACCESS=false` и `FULL_ACCESS=true`.
- AC2. Запись, замена, перемещение и удаление защищённых путей отклоняются и пишутся в аудит.
- AC3. Обычные файлы со словами `token`, `password`, `secret` читаются и правятся без искажений; все тесты SPEC-009 зелёные.
- AC4. `tools/list` отдаёт аннотации по таблице FR-3.1 для всех 24 инструментов; имена и схемы входа не изменились.
- AC5. Десктоп читает и сохраняет настройки как раньше.
- AC6. Документация соответствует `contracts/tools.json` (24 инструмента, правильная ссылка, полная таблица переменных).

## 6. Риски и что это не решает

- Команда может скопировать `.env` в другое место или вывести его в base64; значение в base64 не совпадёт с секретом и не замаскируется. Полная защита команд даётся только одобрениями и оценкой риска (SPEC-013) и хранением секретов в DPAPI (SPEC-015).
- Проверка папок на `containsProtected` при рекурсивном удалении должна быть дешёвой: сравниваем пути из набора префиксом, дерево не обходим.
- Если какой-то клиент начнёт по аннотациям спрашивать подтверждение на каждый `terminal_execute`, это ожидаемое поведение, а не регрессия.
