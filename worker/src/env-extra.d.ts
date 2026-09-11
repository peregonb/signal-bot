// Секреты (wrangler secret put) доступны как string, но не попадают в сгенерированные
// wrangler types. Дополняем глобальный интерфейс Env (interface merging с env.d.ts).
interface Env {
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_ALLOWED_IDS?: string;
}