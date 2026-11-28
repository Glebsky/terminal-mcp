# Аудит: MCP Terminal и ZeroIDE MCP · сайт, видео, стек · 2026-11-28

Источники: код ZeroIDE (ветка main, v0.5.0), сайт ZeroIDE и его репозиторий, сайт dopamine.annenkov.me (исходники шейдеров), наш репозиторий (master `5fb0a5f`), ресёрч стека на 2026-11-28. Факты о ZeroIDE собраны суб-агентами по исходникам; что прочитать не удалось, помечено «не проверено». Цифры о сторонних SDK и спецификациях взяты из ресёрча на эту дату и перепроверяются при старте соответствующего SPEC.

**Вердикт.** ZeroIDE сильнее нас не инструментами, а обвязкой доверия: одобрения с карточками риска и diff, откат правок, самозащита, именные токены и OAuth, мастер подключения, CI с изолированными тестами, сайт и три видео. По «рукам» у нас больше: 24 инструмента против 19, из них 12 браузерных, которых у ZeroIDE нет совсем. «Написан на C#» верно наполовину: MCP-сервер у них на Node.js (`server/server.mjs`, около 297 КБ одним файлом), на C# только трей на .NET 8, а поддержка .NET 8 закончилась 10.11.2026. Догонять стоит в доверии, отрываться в браузере, откате команд, структурированных ответах и подписанной поставке.

**Решения на старт:** (1) стек: рекомендую Rust-ядро + Tauri 2 с переносом текущего React UI (раздел 9); (2) имя продукта и адрес сайта (раздел 13); (3) начать с SPEC-009/010 в текущем TS: контракт инструментов, CI и быстрые победы безопасности, потому что `.env` сервера сейчас лежит в зоне досягаемости любого подключённого агента (раздел 4).

## 1. Что такое ZeroIDE на самом деле

- Версия 0.5.0 (релиз 2026-11-20), лицензия MIT-0, репозиторий создан 2026-11-10.
- Два процесса. Node-сервер MCP: `server/server.mjs` (Express, express-rate-limit, Zod, MCP SDK, в поставке 1.32.2). Трей: C# .NET 8 WinForms, самодостаточный single-file `win-x64` (по GitHub около 1,44 МБ исходников C#: `Program.cs`, `SettingsForm.cs`, `ApprovalManager.cs`, `AccessStore.cs`, `ChangeHistory.cs`, `AutoUpdater.cs` и др.). Плюс PowerShell-помощники установки и подключений (`installer/install.ps1`, `tools/Onboarding.*.ps1`).
- Порты: 39011 = MCP (только 127.0.0.1); 39012 = управляющий канал трея (одобрения, сообщения, карточки задач), тоже loopback, с секретным заголовком `X-ZeroIDE-Control`, сравнением за постоянное время, запретом браузерных Origin и лимитом тела. Трей держит дочерние процессы в Job Object с kill-on-close.
- Транспорты: Streamable HTTP `/mcp` и legacy `/sse`; stdio не найден.
- Установка: `install.ps1` качает portable Node v24.22.2 и сверяет закреплённый SHA-256; ставит в `%LOCALAPPDATA%\ZeroIDE-MCP` без прав администратора; MCP сам не включается; автозапуск выключен; есть `-Update` (сохраняет конфиг, токены, журналы) и «Удаление» одной кнопкой.
- Пакет v0.5.0: 71 988 348 байт (около 68,6 МиБ): самодостаточный .NET exe + `server/node_modules`. Node докачивается при установке.
- Тесты: CI на windows-latest (Node 24, .NET 8), наборы копируют сервер во временную папку и не трогают установленную копию; в release notes заявлено 10 наборов и 563 проверки (не пересчитывали). Покрытия и SAST нет.
- Релиз: zip + `zeroide-mcp.zip.sha256` через GitHub Actions; бинарники не подписаны; апдейтер сверяет хеш из того же релиза, то есть проверяет целостность, но не подлинность издателя.
- В 0.5 ещё есть уведомления в Telegram, автообновление и чат нескольких агентов в трее.
- «Расширенные инструменты»: раздела с таким названием нет. Ближе всего «Настройки → Инструменты и права» (`SettingsForm.cs`, `PermissionsConfig.cs`): группы Чтение / Выполнение / Запись файлов / Журнал, пресеты (сбалансированный, осторожный, доверчивый), режим allow / ask / deny на каждый инструмент, переключатели защиты «высокий риск» и «критично», режим ожидания владельца `await_owner`. На сайте похожая группа называется «Записи и ПК» (`system_info`, `audit_log`, `journal_entry`, `journal_log`); особых прав она не даёт.

## 2. Сравнение по возможностям

| Возможность | MCP Terminal (мы) | ZeroIDE 0.5.0 | Вывод |
|---|---|---|---|
| Инструменты | 24: терминал 1, файлы 9, рабочая папка 2, браузер 12 | 19: команды 3, файлы 6, экран 2, связь 4, записи 4 | у нас шире, у них обвязка |
| Браузер (CDP) | 12 инструментов, подключение к уже запущенному Chrome/Edge с сессиями и вкладками | нет | наш козырь |
| Долгие команды | синхронно, таймаут до 15 мин | фоновые задания `job_status` / `job_output`, дедуп по `requestId` 6 ч, вывод head+tail | догнать (через MCP Tasks) |
| Экран и картинки | только скриншот страницы браузера | `take_screenshot` экрана (с одобрением и превью в карточке), `read_image` со сжатием до 1600 px | догнать |
| Связь с владельцем | нет | `user_message`, `task_status`, `await_owner`, `agent_message` | догнать частично |
| Одобрения | нет | карточки в трее; нет ответа 60 с → отказ; трей недоступен → отказ | критично догнать |
| Оценка риска | нет | правила на regex, уровни low…critical; critical только «разрешить один раз» | догнать и обогнать (AST) |
| Diff перед записью | нет | LCS-diff до 3000 строк, `dryRun`, `expectedSha256` | догнать |
| Откат | нет | история 30 дней для write / edit / file_ops, «Сравнить» и «Откатить»; изменения от команд не откатываются | догнать и обогнать |
| Самозащита | нет | блок своих токенов, настроек, журналов, истории; команды с этими путями = critical | критично |
| Доступ | один общий ключ: Bearer / x-api-key, ключ в URL, HTTP Basic, none с подтверждением | именные токены (read / readwrite / full, папка, срок, лимит, ротация, отзыв, SHA-256), OAuth (DCR + PKCE S256, согласие в трее, ротация refresh) | догнать; наши URL-методы оставить для клиентов, где есть только поле адреса |
| Лимиты | 30 неудачных входов в минуту глобально | 1200/мин, 60 неудач за 5 мин, лимиты OAuth; всё по IP, а за туннелем это один IP | сделать лимиты по токену |
| Аннотации инструментов | нет | readOnlyHint / destructiveHint / idempotentHint / openWorldHint | быстрая победа |
| Структурированный ответ | JSON внутри текста | текст | обогнать: `outputSchema` + `structuredContent` |
| Аудит | строки `[AUDIT]` в stdout + JSONL при `AUDIT_LOG_FILE`, маскирование | `audit.jsonl` с seq, ротация 5 МиБ × 5 gz, инструмент `audit_log` | догнать |
| Туннели | ngrok SDK, tuna, Cloudflare quick / named, localtunnel | локально, Tailscale Serve, ngrok, Cloudflare named, свой SSH | добавить Tailscale; quick tunnel = только тест |
| Мастер подключения | карточка Notion с копированием данных | мастер по клиентам (ChatGPT, Claude, Notion, агент на ПК, другой ПК), сам ставит и проверяет ngrok / Tailscale / cloudflared | догнать |
| Установка агентом | нет | `AGENT_INSTALL.md` + `agent-manifest.json` | догнать |
| Несколько ПК | технически можно, не описано | описано и показано: свой токен, права и журнал на каждом ПК | догнать + режим хаба |
| UI | Electron + React, Liquid Glass, монитор клиентов с лентой потока, en / ru / uk | WinForms, ru / en | у нас красивее |
| Транспорты | `/mcp` (stateless, JSON-ответы) + `/sse`, cwd на сессию SSE | `/mcp` + `/sse` | паритет |
| Размер | Portable 102,5 МБ, Setup 102,8 МБ | zip 68,6 МиБ + Node при установке | оба тяжёлые |
| CI и тесты | CI нет (только dependabot), три smoke-скрипта, стенд гонок `race-audit.cjs` | CI, 10 изолированных наборов | догнать |
| Подпись | нет (`signExecutable: false`) | нет | обогнать |
| Сайт / видео | нет / нет | статический сайт ru / en, три видео | делаем |
| Платформы | Windows | только Windows | обогнать (Rust и Tauri кроссплатформенны) |

## 3. Инструменты: сопоставление

Инвариант: имена и входные схемы наших 24 инструментов не меняем, на них уже завязаны агенты (Notion, ClickUp и др.). Новое добавляем рядом.

| Их инструмент (режим по умолчанию) | Наш аналог | Что сделать |
|---|---|---|
| `run_command` (ask) | `terminal_execute` | фоновый режим, `requestId`, вывод head+tail |
| `job_status`, `job_output` (allow) | нет | MCP Tasks + запасные `job_status` / `job_output` для клиентов без Tasks |
| `read_file` (allow) | `file_read` | отдавать SHA-256 файла, чтение по строкам |
| `list_directory` (allow) | `file_list` | по умолчанию пропускать `node_modules`, `.git`, `dist` и т. п. |
| `search_files` (allow) | `file_search` | строки контекста, общее число совпадений |
| `write_file` (ask) | `file_write` | `expectedSha256`, `dryRun` с diff, копия в историю |
| `edit_file` (ask) | `file_replace` | пакет правок `edits[]`, `expectedSha256`, `dryRun` |
| `file_ops` (ask) | `file_move`, `file_delete`, `file_mkdir` | добавить `file_copy`; удаление в корзину истории |
| `take_screenshot` (ask) | нет (есть `browser_screenshot`) | `screen_capture` с одобрением и превью |
| `read_image` (ask) | нет | `image_read`: image content, сжатие на ПК |
| `user_message`, `task_status` (allow) | нет | `owner_notify` (тост + трей), `task_status` |
| `agent_message` (allow), `await_owner` (deny) | нет | позже, вместе с режимом хаба |
| `system_info` (allow) | нет | `system_info` |
| `audit_log`, `journal_entry`, `journal_log` (allow) | нет | `audit_log`; журнал агента (память о сделанном) |
| нет | `browser_*` (12), `workspace_*` (2), `file_stat` | наше преимущество |

## 4. Безопасность: что чинить и в каком порядке

**П0, сейчас, в TS (SPEC-010):**

1. Самозащита. `FILES_ROOT` = `C:\OSPanel\home`, а `.env` проекта лежит внутри (`terminal-mcp\.env`), поэтому любой подключённый агент может прочитать `MCP_API_KEY` и токены туннелей даже без `FULL_ACCESS`. Маскирование `redact()` применяется только к аудиту (`src/utils/logger.ts`), не к ответам инструментов. Фикс: список защищённых путей (свой `.env`, `MCP Terminal Data/` портативной версии, `%APPDATA%\mcp-terminal\config`, логи) с отказом на чтение, запись, поиск и перемещение; маскирование известных секретов в выводе всех инструментов; для команд, которые упоминают эти пути, отказ или подтверждение.
2. Аннотации инструментов: `readOnlyHint` у чтения, `destructiveHint` у записи, удаления и команд, `openWorldHint` у браузера и команд. Клиенты (ChatGPT, Claude) начнут сами спрашивать подтверждение для опасного.
3. Cloudflare quick tunnel пометить «только для теста»: по документации Cloudflare quick tunnels не поддерживают SSE и держат не больше 200 запросов в полёте. `/mcp` у нас отвечает JSON и может работать, `/sse` через него работать не обязан; в аудите от 20.11 он ещё и умирал после переподключения.

**П1, в новом ядре:** одобрения + риск + diff (SPEC-013), история и откат (SPEC-014), токены и OAuth (SPEC-015).

**Где обгоняем ZeroIDE:**

- Риск по AST PowerShell (`System.Management.Automation.Language.Parser`; pwsh 7.6 на ПК уже стоит) с раскрытием `-EncodedCommand`; regex только вторым слоем. У ZeroIDE только regex, и сами они пишут «rules, not a guarantee».
- Лимиты по токену и клиенту, а не по IP: у ZeroIDE за туннелем все клиенты делят один адрес, и один шумный клиент блокирует остальных на 5 минут.
- Секреты в DPAPI / Windows Credential Manager, а не открытым текстом (у них legacy `MCP_TOKEN` лежит в `config.env`).
- OAuth по ревизии MCP 2026-07-28: Protected Resource Metadata (RFC 9728) обязательна при авторизации, Client ID Metadata Documents предпочтительны, DCR только для совместимости (по ресёрчу в 2026-07-28 он deprecated).
- Elicitation не заменяет одобрение: форма в клиенте годится только для низкого риска, потому что удалённый клиент может её не показать или быть скомпрометирован. Команды, запись, браузер и всё опасное подтверждаются локально (трей, по желанию Telegram).

## 5. Сайт ZeroIDE: как сделан

- Чистая статика без сборки: `index.html` 61 КБ, 4 CSS (75 КБ), 4 JS (81 КБ: `field.js`, `i18n.js`, `main.js`, `stage.js`), свои шрифты 190 КБ (Unbounded, Inter, JetBrains Mono), 3 MP4 прямо в репозитории (20,9 МБ). GitHub Pages из ветки main, без workflow.
- Приёмы: «сайт выключен, как и программа» (переключатель с `aria-checked`, сам включается через 2,6 с или при прокрутке); фон героя: сетка точек на 2D canvas с волнами от переключателя; живая сцена «чат слева, ПК справа» на DOM и CSS, 4 сценария, отмена по `runId`, тост одобрения с 60-секундной полосой, лента `audit.jsonl` на 40 строк; схема «пропускного пункта» на canvas с машиной состояний пакетов (go / hold / back); конструктор «пропуска для ИИ» с 3D-наклоном и голограммой; каталог инструментов со значками «сразу» и «ваше да»; видео-театр с плейлистом и подсветкой `.ambi` (blur 70px, saturate 1.6). Как именно берётся цвет из кадра, прочитать не удалось (не проверено).
- Дизайн-токены: фон `#060709`, лайм `#c6f82c`, фиолетовый `#937dff`, янтарь `#ffb547`, красный `#ff5d5d`; радиусы 10 / 16 / 24 / 32; одна кривая `cubic-bezier(.22,1,.36,1)`; только тёмная тема; `prefers-reduced-motion` учтён и в CSS, и в JS.
- Слабые места: английский только переключением на клиенте (нет `/en/`, плохо для SEO и шаринга); нет OG, JSON-LD, sitemap, robots, `llms.txt`, MCP-карточки; 20,9 МБ видео без стратегии загрузки; JS не минифицирован; вопросы к доступности (live-регионы, фокус в модалке видео).

## 6. Анимации dopamine.annenkov.me: это не скилл

Dopamine Talk сам по себе набор из пяти Markdown-скиллов для кодинг-агентов (talk, plan, engineering, changelog, readme), но фон героя к ним не относится. Это код сайта: три написанных вручную модуля WebGL1 без библиотек, которые `app.js` подгружает через `import()` через 90 мс после старта:

- `/shader.js` (9,9 КБ): фоновый фрагментный шейдер: fbm на value noise, каустика, смешивание четырёх цветов в OKLab, зерно, лёгкий дрейф от прокрутки. В шапке файла: «Adapted from Paper Shaders / 21st.dev Liquid Metal (Apache-2.0)». Пауза через IntersectionObserver, `visibilitychange`, `prefers-reduced-motion` и отдельную кнопку.
- `/crystal-live.js` (15,6 КБ): «оживление» статичной картинки кристалла (`hero-crystal.webp`): нормали по Собелю из яркости, блики Блинна-Фонга, хроматическая дисперсия, наклон за курсором, на Android гироскоп.
- `/liquid-glass.js` (35,6 КБ): многопроходное «жидкое стекло» на FBO (размытие, преломление, френель), адаптировано из `@ybouane/liquidglass` (MIT).
- На узких тач-экранах фоновый шейдер не запускается.

Лицензии: Paper Shaders под Apache-2.0, в MIT-проекте использовать можно, сохранив LICENSE и NOTICE и пометив изменённые файлы. liquidglass заявлен как MIT в README и npm, но файла LICENSE в репозитории нет: фиксировать версию npm и хранить уведомление. WebMCP, который сайт тоже подключает, пока черновик Community Group, не стандарт: актуальный API `document.modelContext`, `navigator.modelContext` убран в Chrome 152. Только как прогрессивное улучшение.

Как сделаем у себя: свой шейдер «потока» в цветах нашей ленты (`#3cc8ff → #4a92ff → #6a6dff → #b26bff`, SPEC-003), который пульсирует от симулированного MCP-трафика. Фон сайта продолжит фирменный визуал приложения, а не скопирует dopamine. Бюджет: не больше 12 КБ gz, без библиотек, DPR не выше 1,5, не больше 2 мс на кадр на встроенной графике, пауза вне экрана и в скрытой вкладке, статичный градиент при reduced motion и без WebGL. Рецепт можно оформить ClickUp-скиллом, чтобы тот же приём шёл в Pink City, Memoria и ELSA.

## 7. Видео

У ZeroIDE три записи экрана на английском: обзор (1:01), установка с ИИ-агентом и первая задача в Notion (2:01), установка вручную через мастер (1:18). MP4 лежат в репозитории сайта и играют одно за другим.

Наш план (SPEC-019):

1. **Промо 30–40 с** (16:9 и вертикальная нарезка 9:16): моушн-дизайн в стиле Liquid Glass. Лента потока «втекает» в ПК, оживают терминал, браузер и файлы, загорается карточка одобрения, монитор показывает клиентов, в конце логотип и призыв. Сгенерированные кадры и клипы + реальные кадры UI, озвучка RU и EN, музыка.
2. **Демо 60–90 с**: настоящая задача без постановки. Агент (ClickUp Brain, Claude или ChatGPT) открывает проект, запускает сборку, правит файл, проверяет результат в браузере; владелец одобряет; в конце откат. Запись экрана на этом ПК (ffmpeg или OBS; ffmpeg на хосте сейчас не установлен), монтаж с зумами и субтитрами.
3. **Гайды по подключению по 60–90 с**: локальный агент, веб-чат через ngrok, другой ПК через Tailscale. Снимаем после мастера (SPEC-017).

Хранение: MP4 не кладём в git (у ZeroIDE 20,9 МБ в репозитории). Ассеты релиза или видеохостинг, `preload="none"`, постер, субтитры VTT RU и EN; подсветку по кадру делаем через выборку 32×18 на canvas не чаще 4 раз в секунду с постером как запасным вариантом.

## 8. Наш сайт (SPEC-018)

- Стек: статика на Vite (уже в devDependencies) + TypeScript без фреймворка. На сборке генерируем `/ru/`, `/en/`, `/uk/` из одного шаблона и словарей. Деплой: GitHub Actions → GitHub Pages; свой домен по желанию.
- Разделы (своя история, не копия): герой с шейдером и мини-монитором потока; «Что умеет»: каталог инструментов генерируется из JSON-контракта SPEC-009, поэтому не разъедется с кодом; живая сцена «чат ↔ ПК» с терминалом, браузером и файлами, одобрениями и лентой аудита + текстовая расшифровка для экранных чтецов; безопасность («выключен по умолчанию», одобрения, токены, откат, «это не песочница»); гид по подключению по клиентам (ChatGPT, Claude, Claude Code, Cursor, Codex, Notion, ClickUp, VS Code, Gemini CLI) и по каналам (локально, ngrok, Cloudflare named, tuna, Tailscale) с кнопками копирования; несколько ПК; видео; установка в 3 шага с SHA-256 и помощью при SmartScreen; FAQ.
- Для агентов: `llms.txt`, `llms-full.txt`, `AGENT_INSTALL.md`, `agent-manifest.json`, `server.json` для MCP Registry, JSON-LD (SoftwareApplication, VideoObject), OG и Twitter, sitemap, robots.
- Планки: Lighthouse mobile не ниже 95 по производительности, доступности и SEO; LCP не больше 2,0 с; CLS = 0; JS не больше 60 КБ gz; всё доступно с клавиатуры; reduced motion.

## 9. Язык и архитектура

Сначала поправка к вводным: всё, что исполняет команды и говорит по MCP, у ZeroIDE на Node.js; C# только трей. Наш вес тоже не от Node, а от Electron (102,5 МБ). Значит, язык ядра и оболочка это два отдельных решения.

Варианты (по ресёрчу на 2026-11-28):

| | A: Rust-ядро + Tauri 2 | B: C# / .NET 10 | C: TS-ядро + Tauri 2 |
|---|---|---|---|
| MCP SDK | `rmcp` 3.12.0 (2026-11-26): ревизия 2026-07-28 + совместимость с 2025-11-25, Streamable HTTP на axum, OAuth, elicitation, structured output | официальный 2.4.0 (2026-11-07), стабилен под 2026-07-28, ASP.NET Core | текущий TS SDK, новую ревизию догонять |
| UI | текущий React переезжает в Tauri почти без изменений | WinUI 3 = переписать UI; React в WebView2 = свой мост; WinForms / WPF плохо дружат с Native AOT | React переезжает |
| Рантайм в поставке | один нативный бинарник; сервер можно держать прямо в процессе приложения | .NET (self-contained около 50–80 МБ) | Node (`node.exe` + `node_modules`) рядом с Tauri |
| Туннели | официальный ngrok SDK на Rust (0.19.1) | у ngrok нет .NET SDK, только CLI и REST | как сейчас |
| Браузер | `chromiumoxide` (CDP, умеет подключаться к запущенному Chrome); паритет с puppeteer надо доказать | PuppeteerSharp | puppeteer-core как сейчас |
| Windows | `windows-rs`: Job Objects, DPAPI, захват экрана (`windows-capture`, `xcap`) | лучшая интеграция | через Rust-часть Tauri |
| Кроссплатформенность | да | ядро да, UI нет | да |
| Риски | переписать около 3,4 тыс. строк сервера; паритет браузера; нужен Rust + MSVC Build Tools (на ПК пока нет) | переписать UI или строить мост; Windows-only; нужен .NET 10 SDK (на ПК нет) | два рантайма, цепочка npm, размер |

**Рекомендация: A, поэтапно (strangler).**

1. Нового кода впереди больше, чем переносимого: одобрения, риск, история, токены, OAuth, задания, экран, мастер. Писать его лучше сразу на целевом языке, а не дважды.
2. Один бинарник без Node и `node_modules` для программы, которая исполняет удалённые команды: и скорость, и меньше поверхность атаки через цепочку поставок.
3. Tauri написан на Rust: оболочка и ядро на одном языке, а React UI, i18n и лента потока переезжают как есть.
4. `rmcp` уже поддерживает новую ревизию протокола.

B второй: отличен для Windows, но тянет переписывание UI, а трей ZeroIDE на .NET 8 как раз сейчас без поддержки. C запасной, если важнее выйти быстрее, чем стать лёгкими.

Размер и память до замеров не обещаем: сторонние замеры 2026 года дают инсталлятор Tauri в единицы МБ против примерно 100 МБ у Electron, но процессы WebView2 по памяти могут съесть разницу. Меряем на нашем приложении (SPEC-012).

### Целевая структура

```
terminal-mcp/
├─ crates/
│  ├─ core/        политика: инструменты, одобрения, риск, история, токены, аудит (без веб-фреймворка)
│  ├─ server/      axum + rmcp: /mcp (2025-11-25 и 2026-07-28), /sse, OAuth, auth-middleware
│  ├─ win/         Windows: Job Objects, DPAPI, захват экрана, тосты (cfg(windows))
│  ├─ browser/     CDP через chromiumoxide
│  ├─ tunnels/     ngrok SDK; cloudflared, tuna, localtunnel, tailscale как дочерние процессы
│  └─ cli/         безголовый бинарник (CI, сервер)
├─ app/            Tauri 2: трей, окно, сервер в процессе; рендерер из desktop/src/renderer
├─ desktop/        текущий React UI (Electron main/preload уходят в SPEC-012)
├─ src/            TS-сервер: эталон до паритета, потом в архив
├─ tests/conformance/  чёрный ящик: MCP-клиент против любого URL
├─ site/           сайт
└─ docs/
```

### Инварианты миграции

- Имена и входные схемы 24 инструментов не меняются; новые добавляются рядом.
- Имя сервера `notion-terminal-files` не трогаем без отдельного решения: некоторые клиенты строят из него префикс инструментов (в ClickUp они видны как `notion_terminal_files__*`).
- Совместимость конфигурации `.env`: `MCP_API_KEY`, `AUTH_METHODS` (bearer, query, basic, none + `ALLOW_NO_AUTH`), `FULL_ACCESS`, `FILES_ROOT`, `TUNNEL_PROVIDER`, `DISABLED_TOOLS`, лимиты.
- Поведение из SPEC-005 и SPEC-006 (блокировки, атомарная запись, идемпотентный replace, кодировки, порционный вывод, cwd на сессию) переносится один в один и проверяется стендом `docs/audit/race-audit.cjs`.
- По ресёрчу ревизия 2026-07-28 убирает `initialize` и `Mcp-Session-Id` на уровне протокола. Тогда cwd на сессию и имена клиентов из SPEC-008 (они берутся из `clientInfo` в `initialize`) придётся привязать к явному параметру, токену или `_meta`. Проверить первым делом в SPEC-011.
- Сначала нейтральный протокол между UI и сервером. Сейчас Electron говорит с сервером через Node IPC (`server:ready`, `server:error`, `tunnel:status`, `monitor:set`, `shutdown`) и парсит строки `[AUDIT]` из stdout (`desktop/src/main/server-manager.ts`); не-Node сервер так не умеет. Переводим на JSON-строки по stdio (или loopback-порт управления с секретом, как 39012 у ZeroIDE), и Rust-бинарник встаёт вместо `dist/index.js` без правки UI.
- Правила анимаций из AGENTS.md (reduced motion, `.motion-off`, покадровая работа на canvas) и цвета ленты действуют и на сайте.

## 10. Предложения сверх ZeroIDE

1. Откат команд, а не только файлов: перед `terminal_execute` в git-репозитории делать теневой чекпоинт (отдельный ref) и дать «откатить всю сессию агента». У ZeroIDE изменения от `run_command` не откатываются.
2. Риск по AST PowerShell и раскрытие `-EncodedCommand` (раздел 4).
3. Структурированные ответы: `outputSchema` + `structuredContent` у всех инструментов; скриншоты и большие файлы ссылками `resource_link`. У ZeroIDE всё текстом.
4. Долгие задачи через расширение MCP Tasks (отмена + таймаут на Job Object) и запасные `job_*` для старых клиентов.
5. Одобрение с телефона: кнопки «Разрешить» и «Отклонить» в Telegram (наработки по Telegram-подтверждениям уже есть); critical только в трее.
6. Лимиты и квоты по токену, а не по IP.
7. Режим хаба для нескольких ПК: один адрес, маршрутизация по ПК, у каждого свои права. У ZeroIDE каждый ПК добавляется в клиент отдельно.
8. MCP Apps (стабильное расширение с 2026-01-26): карточки статуса и одобрения прямо в клиентах, которые это умеют; безопасность от этого не зависит.
9. Поставка с доверием: подпись через SignPath Foundation (бесплатно для OSS с OSI-лицензией и публичной сборкой; Azure Artifact Signing для частных лиц по ресёрчу сейчас только США и Канада), SBOM, GitHub attestations, подписанный апдейтер Tauri, манифест winget, публикация в MCP Registry (`server.json`, пока preview). Репутация SmartScreen всё равно копится со временем.
10. Позже macOS и Linux: Rust и Tauri это позволяют, ZeroIDE нет.
11. Своё имя продукта: «MCP Terminal» тонет в поиске, а `notion-terminal-files` осталось от старого названия.

## 11. Наши долги (дёшево, сразу)

- README и AGENTS.md пишут про 20 инструментов, в коде 24: не описаны `browser_connect`, `browser_list_tabs`, `browser_new_tab`, `browser_select_tab`.
- В README ссылка клонирования ведёт на `Speedstu/notion-terminal-mcp`, а remote `Glebsky/terminal-mcp`. В таблице конфигурации нет `AUTH_METHODS`, `TUNNEL_PROVIDER`, `DISABLED_TOOLS`, `AUDIT_LOG_FILE`, `MAX_SSE_SESSIONS` и настроек tuna, cloudflare, localtunnel.
- CI нет (только `dependabot.yml`); тестов три smoke-скрипта; висят ветки dependabot (в том числе MCP SDK 1.32.2).
- Сборка не подписана (`signExecutable: false`), 102,5 МБ.
- В `release/` лежит `.env` (469 байт; содержимое не открывал). В git он не попадает и electron-builder его не пакует, но при ручной раздаче папки `release/` уедет вместе с ней.
- Три неотслеживаемых `desktop/icon.old.*.bak` (по AGENTS.md такое не коммитим).

## 12. Дорожная карта по спекам

Каждый SPEC в текущем формате: контекст, FR, дизайн, задачи, критерии приёмки. Цикл по каждому: суб-агенты собирают факты (только чтение) → пишется SPEC → владелец утверждает → реализация маленькими проверяемыми шагами, тест сначала → отдельный агент-ревьюер сверяет код со SPEC → приёмка. Суб-агенты кода не пишут: исследование и ревью идут параллельно, реализация последовательно (или параллельно отдельными кодинг-агентами в своих worktree).

| SPEC | Что | Зависит от | Приёмка |
|---|---|---|---|
| 009 Контракт и CI | снимок схем 24 инструментов в JSON; чёрный ящик `tests/conformance` (`node --test` против любого URL); GitHub Actions на windows-latest (check, build, тесты); нейтральный протокол UI ↔ сервер | | набор зелёный против текущего TS; CI на каждый push |
| 010 Быстрые победы безопасности (TS) | самозащита, маскирование секретов в ответах, аннотации, пометка quick tunnel, правка README и AGENTS.md | 009 | агент не читает `.env`; тесты на отказ; клиенты видят аннотации |
| 011 Rust-ядро, паритет | транспорты, auth, файлы, терминал на Job Objects, cwd, туннели, браузер; две ревизии протокола | 009 | conformance и `race-audit.cjs` зелёные против Rust; Electron UI работает с Rust-бинарником |
| 012 Оболочка Tauri 2 | перенос рендерера, трей, один экземпляр, автозапуск по желанию, NSIS / MSI / portable, подписанный апдейтер; замеры | 011 | инсталлятор и замеры размера, памяти и старта против Electron |
| 013 Одобрения и риск | карточки, diff, 60 с → отказ, critical только один раз, AST-риск, Telegram по желанию, elicitation для низкого риска | 011 | сценарии одобрить / отклонить / таймаут / трей недоступен |
| 014 История и откат | история 30 дней, сравнение, откат, чекпоинты для команд, откат сессии | 011 | откат каждой операции и сессии в тестах |
| 015 Доступ | именные токены, OAuth 2.1 (PRM, CIMD, DCR для совместимости, PKCE S256), согласие в трее, лимиты по токену, секреты в DPAPI | 011 | тесты по образцу их `oauth-test.mjs` + наши |
| 016 Новые инструменты | Tasks и `job_*`, `screen_capture`, `image_read`, `owner_notify`, `task_status`, `system_info`, `audit_log`, журнал, `file_copy` | 011, 013 | conformance расширен |
| 017 Подключения и мастер | мастер по клиентам, Tailscale Serve, `AGENT_INSTALL.md`, `agent-manifest.json` | 012, 015 | установка на чистой Windows и подключение каждого клиента из списка |
| 018 Сайт | раздел 8 | 009 (каталог), имя | Lighthouse не ниже 95, три языка |
| 019 Видео | раздел 7 | 012 и 013 для демо, имя | три ролика с субтитрами RU и EN |
| 020 Релизы | подпись, SBOM, attestations, winget, MCP Registry | 012 | подписанный релиз с проверяемым издателем |

Сразу и параллельно можно начать: SPEC-009, SPEC-010, SPEC-018 (после выбора имени) и заявку в SignPath.

## 13. Нужны решения владельца

1. ~~Стек: A (Rust + Tauri, рекомендую), B (C# / .NET 10) или C (TS + Tauri).~~ **Решено 2026-11-28: A, Rust-ядро + Tauri 2, поэтапно (раздел 9).**
2. Имя продукта и адрес сайта (`glebsky.github.io/...` или свой домен).
3. Языки сайта: RU + EN + UK, как в приложении?
4. Начинаем ли с SPEC-009 и SPEC-010 в текущем TS.

## Источники

- ZeroIDE MCP: https://github.com/Danywalery/ZeroIDE-MCP (`server/server.mjs`, `tray/PermissionsConfig.cs`, `tray/ApprovalManager.cs`, `tray/AccessStore.cs`, `tray/ChangeHistory.cs`, `installer/install.ps1`, `AGENT_INSTALL.md`, `agent-manifest.json`, `CONNECTIONS.md`, `docs/AGENT_CONNECTIONS.md`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`); релизы: https://api.github.com/repos/Danywalery/ZeroIDE-MCP/releases ; каталог схем: https://glama.ai/mcp/servers/Danywalery/ZeroIDE-MCP/schema
- Сайт ZeroIDE: https://danywalery.github.io/zeroide-mcp-site/ ; исходники: https://github.com/Danywalery/zeroide-mcp-site (`index.html`, `css/*.css`, `js/field.js`, `js/main.js`, `js/stage.js`, `js/i18n.js`)
- Dopamine: https://dopamine.annenkov.me/ (`/app.js`, `/shader.js`, `/crystal-live.js`, `/liquid-glass.js`), https://github.com/AnnenkovLabs/dopamine-talk
- Лицензии: https://github.com/paper-design/shaders (Apache-2.0); https://github.com/ybouane/liquidglass и https://www.npmjs.com/package/@ybouane/liquidglass (MIT по README и npm)
- WebMCP: https://webmachinelearning.github.io/webmcp/ ; https://developer.chrome.com/docs/ai/webmcp/updates
- MCP: https://modelcontextprotocol.io/specification/2026-07-28 (authorization, tools, elicitation); https://modelcontextprotocol.io/extensions/tasks/overview ; https://modelcontextprotocol.io/extensions/apps/overview ; https://modelcontextprotocol.io/registry/about
- SDK: https://github.com/modelcontextprotocol/rust-sdk ; https://crates.io/crates/rmcp ; https://github.com/modelcontextprotocol/csharp-sdk
- .NET: https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core
- Tauri: https://v2.tauri.app/develop/sidecar/ ; https://v2.tauri.app/plugin/updater/ ; https://v2.tauri.app/distribute/windows-installer/
- chromiumoxide: https://github.com/mattsse/chromiumoxide ; ngrok для Rust: https://crates.io/crates/ngrok , https://ngrok.com/docs/agent-sdks
- Cloudflare quick tunnels: https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
- Подпись: https://azure.microsoft.com/en-us/products/artifact-signing ; https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart ; https://signpath.org/terms.html
- Наш репозиторий: `src/config.ts`, `src/server.ts`, `src/index.ts`, `src/middleware/auth.ts`, `src/utils/logger.ts`, `src/tools/index.ts`, `desktop/src/main/server-manager.ts`, `electron-builder.yml`, `docs/audit/2026-11-20-stability-races.md`.
- Подробные отчёты суб-агентов (EN) приложены к сообщению в ClickUp.
