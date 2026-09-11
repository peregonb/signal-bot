import type { TgUpdate } from "./telegram";
import { handleMessage, sendDaily } from "./handler";

const WEBHOOK_PATH = "/webhook";

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

  async scheduled(_controller, env): Promise<void> {
    try {
      await sendDaily(env);
    } catch (e) {
      console.error(JSON.stringify({ event: "scheduled-error", error: e instanceof Error ? e.message : String(e) }));
    }
  },
} satisfies ExportedHandler<Env>;