import type { TgUpdate } from "./telegram";
import { handleMessage, sendDaily, verifyDaily } from "./handler";

const WEBHOOK_PATH = "/webhook";
// Минуты попыток дневного отчёта (должны совпадать с cron «5,7,9,11,13 0 * * *» в wrangler.jsonc).
const DAILY_MINUTES = [5, 7, 9, 11, 13];

async function verifySecret(request: Request, env: Env): Promise<boolean> {
  const secret = env.WEBHOOK_SECRET;
  if (!secret) return true;
  const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== WEBHOOK_PATH) return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    try {
      if (!(await verifySecret(request, env))) {
        console.warn(JSON.stringify({ event: "webhook-rejected" }));
        return new Response("Unauthorized", { status: 401 });
      }
      const update = (await request.json()) as TgUpdate;
      const msg = update.message;
      if (msg && typeof msg.text === "string") {
        await handleMessage(env, msg.chat.id, msg.message_id, msg.text);
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "webhook-error", error: e instanceof Error ? e.message : String(e) }));
    }
    return new Response("OK");
  },

  async scheduled(controller, env): Promise<void> {
    try {
      // 30 2 * * * — сверка Bybit → Binance; остальное — дневной отчёт.
      if (controller.cron === "30 2 * * *") await verifyDaily(env);
      else {
        const at = new Date(controller.scheduledTime);
        const minute = at.getUTCMinutes();
        const attempts = DAILY_MINUTES.filter((x) => x <= minute).length || 1;
        await sendDaily(env, {
          cron: controller.cron,
          at: at.toISOString(),
          attempt: attempts,
          total: DAILY_MINUTES.length,
          final: minute >= DAILY_MINUTES[DAILY_MINUTES.length - 1],
        });
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "scheduled-error", error: e instanceof Error ? e.message : String(e) }));
    }
  },
} satisfies ExportedHandler<Env>;