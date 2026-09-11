// Обновляет webhook Telegram на адрес Worker'а.
// Единоразовая настройка: Telegram будет слать апдейты на <URL>/webhook.
//
// Использование:
//   TELEGRAM_BOT_TOKEN=123:ABC node scripts/set-webhook.mjs \
//     https://signal-bot.<account>.workers.dev <WEBHOOK_SECRET>
//   (аргумент секрета опциональный, но должен совпадать с secret put WEBHOOK_SECRET)

const workerBase = String(process.argv[2] ?? "").replace(/\/+$/, "");
const secret = process.argv[3] ?? "";
const token = process.env.TELEGRAM_BOT_TOKEN ?? "";

if (!workerBase || !token) {
  console.error(
    "Usage: TELEGRAM_BOT_TOKEN=... node scripts/set-webhook.mjs <https://signal-bot.X.workers.dev> [WEBHOOK_SECRET]",
  );
  process.exit(1);
}

const url = `${workerBase}/webhook`;
const params = new URLSearchParams({ url });
if (secret) params.set("secret_token", secret);

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook?${params}`);
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
if (!data.ok) process.exit(1);