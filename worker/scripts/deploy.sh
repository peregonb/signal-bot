#!/usr/bin/env bash
# Полный деплой SignalBot на Cloudflare Workers.
#
# Переменные окружения (все опциональные):
#   TELEGRAM_BOT_TOKEN     — если задан, сохранится как секрет и выполнится setWebhook
#   WEBHOOK_SECRET         — секрет для проверки X-Telegram-Bot-Api-Secret-Token
#   TELEGRAM_CHAT_ID       — опционально: chat_id для дневного отчёта (иначе берётся из /start)
#   TELEGRAM_ALLOWED_IDS   — опционально: список chat_id через запятую
#
# Пример:
#   TELEGRAM_BOT_TOKEN=123:ABC WEBHOOK_SECRET=my-secret ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

npx wrangler whoami >/dev/null 2>&1 || {
  echo "Ошибка: не залогинены в Cloudflare. Сначала: npx wrangler login"
  exit 1
}

if grep -q "REPLACE_ME_KV_NAMESPACE_ID" wrangler.jsonc; then
  echo "→ Создаю KV namespace STATE..."
  OUT=$(mktemp)
  npx wrangler kv namespace create STATE 2>&1 | tee "$OUT"
  ID=$(node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      const m = s.match(/"id"\s*[:=]\s*"([0-9a-fA-F]+)"/) || s.match(/"id"\s*:\s*"([0-9a-fA-F]+)"/);
      process.stdout.write(m ? m[1] : "");
    });
  ' < "$OUT")
  rm -f "$OUT"
  if [ -z "$ID" ]; then
    echo "Не удалось получить id KV namespace (см. выше). Запишите его вручную в wrangler.jsonc."
    exit 1
  fi
  sed -i.bak "s/REPLACE_ME_KV_NAMESPACE_ID/$ID/g" wrangler.jsonc && rm -f wrangler.jsonc.bak
  echo "→ KV id: $ID (записан в wrangler.jsonc)"
else
  echo "→ KV id уже задан в wrangler.jsonc"
fi

echo "→ Деплой..."
DEPLOY_OUT=$(npx wrangler deploy 2>&1 | tee /dev/stderr)
URL=$(printf '%s\n' "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9-]+\.workers\.dev' | head -1 || true)

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo "→ Сохраняю секрет TELEGRAM_BOT_TOKEN..."
  printf '%s\n' "$TELEGRAM_BOT_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN
else
  echo "→ TELEGRAM_BOT_TOKEN не задан — пропускаю секреты и webhook."
  echo "  Затем выполните вручную: npx wrangler secret put TELEGRAM_BOT_TOKEN"
fi

if [ -n "${WEBHOOK_SECRET:-}" ]; then
  printf '%s\n' "$WEBHOOK_SECRET" | npx wrangler secret put WEBHOOK_SECRET
fi
if [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  printf '%s\n' "$TELEGRAM_CHAT_ID" | npx wrangler secret put TELEGRAM_CHAT_ID
fi
if [ -n "${TELEGRAM_ALLOWED_IDS:-}" ]; then
  printf '%s\n' "$TELEGRAM_ALLOWED_IDS" | npx wrangler secret put TELEGRAM_ALLOWED_IDS
fi

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${WEBHOOK_SECRET:-}" ] && [ -n "$URL" ]; then
  echo "→ Ставлю Telegram webhook на $URL/webhook ..."
  TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" node scripts/set-webhook.mjs "$URL" "$WEBHOOK_SECRET"
else
  echo "→ Готово. Webhook вручную: node scripts/set-webhook.mjs <URL> <WEBHOOK_SECRET>"
fi