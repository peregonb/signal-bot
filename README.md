# SignalBot — Telegram-уведомитель по спот-стратегиям

Бот присылает **один раз в день** сигнал по выбранной стратегии (00:30 UTC) и отвечает
на команды **мгновенно** (Telegram webhook на Cloudflare Workers). Только уведомления —
**без авто-трейдинга**.

Данные: Binance (дневные свечи, `data-api.binance.vision`).

## Стратегии

| ID | Название | Правило |
|----|----------|---------|
| `B` | B-реко | BTC ↔ ETH, EMA 20/80. В бычьем тренде — в сильнейший из BTC/ETH по моментуму 30д, в медвежьем — стейбл (USDT) |
| `D` | D-реко | Ротация топ-1 (BTC/ETH/BNB/SOL), EMA 10/50, моментум 30д, min_hold 10 дней |

Текущая стратегия хранится в `state/bot-state.json` и меняется командой `/strategy B|D`.
Те же правила и параметры, что в верифицированном бэктесте `spot-tracker` (совпадение с
Python-эталоном 0.0%).

## Команды бота

- `/start`, `/help` — справка
- `/signal` — сигнал сейчас (по последней закрытой дневной свече)
- `/status` — текущая стратегия и позиция
- `/strategy B` / `/strategy D` — сменить стратегию
- `/last` — последние сигналы

## Архитектура

```
signal-bot/
  worker/                — ПРОДУКЦИОННАЯ версия на Cloudflare Workers
    wrangler.jsonc       — конфиг: KV (состояние), cron 00:30 UTC, секреты
    src/                 — webhook (fetch/scheduled) + переиспользованные модули
    scripts/             — deploy.sh (полный деплой), set-webhook.mjs
  src/                   — эталонная Node-реализация (локальный тулинг)
    strategy.ts          — правила B/D (EMA, моментум, min_hold)
    signalService.ts     — расчёт сигнала + обновление состояния
    binance.ts           — загрузка дневных свечей
    telegram.ts          — Telegram API (sendMessage, long-poll getUpdates)
    updateHandler.ts     — обработка команд из апдейтов
    dailyReport.ts       — отправка дневного отчёта (идемпотентная)
    state.ts             — состояние бота (стратегия, offset, история, min_hold)
    messages.ts          — тексты сообщений (русский)
    cli/                 — signal, daily, poll, bot (VPS/long-poll вариант)
  state/bot-state.json — состояние (для Node-варианта; в Workers его заменяет KV)
deploy/
  signal-bot.service   — юнит systemd (для VPS-варианта)
```

### Ключевые моменты

- **Свеча дня** = последняя *закрытая* дневная свеча (UTC). Дневной отчёт приходит в
  00:30 UTC — сразу после закрытия торгового дня.
- **`min_hold` для D** — защита от слишком частой смены позиции: сигнал не переключается,
  если с прошлой смены прошло меньше 10 торговых дней. Последняя смена хранится в состоянии.
  Начинает отсчёт с первого запуска бота.
- **Оффсет Telegram** хранится в `state/bot-state.json` (Node-вариант). В Workers оффсет не
  нужен — апдейты приходят по webhook, а состояние живёт в KV, пишется после каждого апдейта.
- **Прогрев EMA** — для сигнала берутся ~320 дневных свечей, EMA считается по всей истории
  (с прогревом), в отличие от демо-бэктеста, где индикаторы считались по сегменту.
- **Дневной отчёт** шлётся один раз в сутки: в Workers — cron в 00:30 UTC, в Node-варианте —
  окно 00:30–00:59 UTC (после закрытия дневной свечи). Дубль невозможен: `lastDailyDate`
  пишется в состояние.
- **Задержка ответа** — в Workers мгновенно (webhook), в Node-варианте 1–2 секунды
  (long-polling с timeout=50 c), без cron.

## Локальный запуск

```bash
npm install

# просто посмотреть текущий сигнал (без бота и токена)
npm run signal
```

Отправка в Telegram и polling требуют токен (см. ниже `.env` или переменные окружения).

## Развёртывание на Cloudflare Workers (рекомендуется)

Бесплатный тариф: Worker + KV, 100 000 запросов/день. Ответ на команды — мгновенный через
Telegram webhook, ежедневный отчёт — по cron в 00:30 UTC. Сервер держать не нужно.

1. **Логин в Cloudflare** (откроется браузер):
   ```bash
   cd worker
   npx wrangler login
   ```
2. **Полный деплой одним вызовом** (создаёт KV namespace, заливает Worker, секреты и webhook):
   ```bash
   cd worker
   TELEGRAM_BOT_TOKEN=<токен от BotFather> \
   WEBHOOK_SECRET=<любая строка> \
   ./scripts/deploy.sh
   ```
   Опционально: `TELEGRAM_CHAT_ID=123` (иначе chat_id берётся из `/start`),
   `TELEGRAM_ALLOWED_IDS=123,456` (белый список).
3. **Проверка**: напишите боту `/start` → справка; `/signal` → сигнал по последней закрытой
   дневной свече; `/strategy D` — сменить стратегию. Дневной отчёт придёт в 00:30 UTC.
4. **Очередное обновление**: `cd worker && ./scripts/deploy.sh` (без токена в env — секреты
   не перезаписываются).

Секреты хранятся в Cloudflare (`wrangler secret put`), в репозиторий не попадают.
URL бота: `https://signal-bot.<ваш-subdomain>.workers.dev`.

### Локальная разработка Worker

```bash
cd worker
cp .dev.vars.example .dev.vars   # впишите TELEGRAM_BOT_TOKEN и WEBHOOK_SECRET
npm install
npm run dev                      # wrangler dev --test-scheduled на :8787
# вебхук: curl -X POST http://127.0.0.1:8787/webhook -H 'content-type: application/json' \
#   -H 'X-Telegram-Bot-Api-Secret-Token: <secret>' -d '{"update_id":1,"message":{"message_id":1,"chat":{"id":123},"text":"/start"}}'
# триггер cron: curl -X POST 'http://127.0.0.1:8787/__scheduled?cron=30+0+*+*+*'
npm run typecheck                # tsc --noEmit
```

## Альтернатива: развёртывание на VPS (Ubuntu)

> Требуется любой VPS c Linux (Ubuntu 22.04/24.04), 1 vCPU, 1–2 GB RAM — например,
> `VPS 2G` от ukraine.com.ua или `KVM 1` от Hostinger. Входящие порты не нужны:
> бот только делает исходящие HTTPS-запросы. Шаринг-хостинг (cPanel) **не подходит** —
> нельзя держать постоянный процесс.

1. **Создайте бота в Telegram** (если ещё не создан): @BotFather → `/newbot` → токен вида
   `123456:ABC-...`.
2. **На сервере, под `root`**:
   ```bash
   cd /opt
   git clone https://github.com/peregonb/signal-bot.git
   cd signal-bot
   npm ci
   ```
3. **Установите Node.js 22** (если нет):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
   apt-get install -y nodejs
   ```
4. **Создайте `.env`** из шаблона:
   ```bash
   cp .env.example .env
   nano .env
   # TELEGRAM_BOT_TOKEN=<токен от BotFather>
   # TELEGRAM_CHAT_ID=<ваш chat_id, опционально> — иначе бот возьмёт чат из /start
   # TELEGRAM_ALLOWED_IDS= — опционально, через запятую
   ```
5. **Подготовьте системного пользователя и systemd-сервис**:
   ```bash
   useradd -r -s /usr/sbin/nologin signalbot
   chown -R signalbot:signalbot /opt/signal-bot
   cp deploy/signal-bot.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now signal-bot
   systemctl status signal-bot        # active (running)
   ```
   Логи: `tail -f /var/log/signal-bot.log`.
6. **Напишите боту `/start`** — в ответ придёт справка, а chat_id сохранится в состоянии
   (если не задан `TELEGRAM_CHAT_ID` — с этого момента дневной отчёт летит вам).
7. **Проверка**: `/signal`, `/strategy B`, `/strategy D`, `/status`, `/last` — ответ приходит
   мгновенно. Дневной отчёт — в 00:30 UTC.

Команды для управления: `systemctl restart signal-bot`, `systemctl stop signal-bot`,
`journalctl -u signal-bot -f`.

### Как узнать свой chat_id

Отправьте боту любое сообщение, затем посмотрите на сервере
`/opt/signal-bot/state/bot-state.json` → поле `chatId`. Либо используйте бота
[@userinfobot](https://t.me/userinfobot).

## Важно и ограничения

- **Канал**: бот постоянно висит в памяти (~150–300 MB RAM). При сбое systemd перезапускает
  его (Restart=always). Для надёжности можно добавить мониторинг (uptimerobot/ping в лог).
- **`min_hold` считается по торговым дням** (по датам свечей), как в бэктесте.
- **Секреты**: токен храните только в `.env` (не коммитьте в репо).
- **Дневной отчёт** шлётся в окне 00:30–00:59 UTC; если сервер был выключен в этом окне —
  отчёт за день пропустится.