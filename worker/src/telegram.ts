const API = "https://api.telegram.org";

export interface TgUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string };
}

export async function getUpdates(token: string, offset: number, timeoutSec = 0): Promise<TgUpdate[]> {
  const url =
    `${API}/bot${token}/getUpdates?limit=100&timeout=${timeoutSec}` + (offset ? `&offset=${offset}` : "");
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutSec > 0 ? timeoutSec * 1000 + 15000 : 25000),
  });
  const data = (await res.json()) as { ok?: boolean; result?: TgUpdate[]; description?: string };
  if (!data.ok) throw new Error(`Telegram getUpdates: ${data.description ?? "error"}`);
  return data.result ?? [];
}

export async function sendMessage(
  token: string,
  chatId: string,
  text: string,
  replyTo?: number,
): Promise<void> {
  const res = await fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_to_message_id: replyTo,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(25000),
  });
  const data = (await res.json()) as { ok?: boolean; description?: string };
  if (!data.ok) throw new Error(`Telegram sendMessage: ${data.description ?? "error"}`);
}