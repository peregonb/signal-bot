import type { Config } from "./config";
import { buildMarket } from "./binance";
import { SYMBOLS } from "./strategy";
import { evaluate } from "./signalService";
import type { BotState } from "./state";
import type { TgUpdate } from "./telegram";
import { sendMessage } from "./telegram";
import { helpText, signalText, statusText, lastText, switchStrategyReply } from "./messages";

interface ParsedCommand {
  cmd: string;
  arg: string;
}

function parseCommand(text: string): ParsedCommand {
  const t = text.trim().toLowerCase();
  if (!t.startsWith("/")) return { cmd: "message", arg: "" };
  const parts = t.split(/\s+/);
  return { cmd: parts[0].split("@")[0], arg: parts.slice(1).join(" ") };
}

function isAllowed(chatId: number, allowedIds: string[]): boolean {
  return allowedIds.length === 0 || allowedIds.includes(String(chatId));
}

export async function processUpdates(
  cfg: Config,
  state: BotState,
  updates: TgUpdate[],
): Promise<BotState> {
  if (updates.length === 0) return state;

  const maxId = Math.max(...updates.map((u) => u.update_id));
  const textMsgs = updates.filter(
    (u) => u.message && typeof u.message.text === "string" && isAllowed(u.message.chat.id, cfg.allowedIds),
  );
  if (textMsgs.length === 0) return { ...state, offset: maxId };

  const market = await buildMarket(cfg.dataApiBase, cfg.signalCandles, SYMBOLS[state.strategy]);
  let cur = state;

  for (const u of updates) {
    const msg = u.message;
    if (!msg || typeof msg.text !== "string" || !isAllowed(msg.chat.id, cfg.allowedIds)) continue;

    let reply: string;
    let next: BotState = cur;
    try {
      const { cmd, arg } = parseCommand(msg.text);
      switch (cmd) {
        case "/start":
        case "/help":
          reply = helpText();
          break;
        case "/signal": {
          const r = evaluate(cur.strategy, market, cur);
          next = r.state;
          reply = signalText(cur.strategy, r.signal);
          break;
        }
        case "/status": {
          const r = evaluate(cur.strategy, market, cur);
          next = r.state;
          reply = statusText(cur.strategy, r.signal, next);
          break;
        }
        case "/last": {
          const r = evaluate(cur.strategy, market, cur);
          next = r.state;
          reply = lastText(cur.strategy, next.history, r.signal);
          break;
        }
        case "/strategy": {
          const v = arg.trim().toUpperCase();
          if (v !== "B" && v !== "D") {
            reply = `Не распознал «${arg}». Используй /strategy B или /strategy D`;
            break;
          }
          next = { ...cur, strategy: v };
          reply = switchStrategyReply(v);
          break;
        }
        default:
          reply = `Не знаю команду «${cmd}». Подсказка: /help`;
      }
    } catch (e) {
      reply = `⚠️ Ошибка: ${(e as Error).message}`;
    }

    if (!next.chatId) next.chatId = String(msg.chat.id);
    await sendMessage(cfg.botToken, String(msg.chat.id), reply, msg.message_id);
    cur = next;
  }

  return { ...cur, offset: maxId };
}