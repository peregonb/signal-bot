import { buildMarket } from "./binance";
import { SYMBOLS, type Market } from "./strategy";
import { evaluate } from "./signalService";
import type { BotState } from "./state";
import { loadState, saveState } from "./state";
import { sendMessage } from "./telegram";
import { helpText, signalText, statusText, lastText, switchStrategyReply, dailyText } from "./messages";

function parseCommand(text: string): { cmd: string; arg: string } {
  const t = text.trim().toLowerCase();
  if (!t.startsWith("/")) return { cmd: "message", arg: "" };
  const parts = t.split(/\s+/);
  return { cmd: parts[0].split("@")[0], arg: parts.slice(1).join(" ") };
}

function isAllowed(chatId: number, allowedIds: string[]): boolean {
  return allowedIds.length === 0 || allowedIds.includes(String(chatId));
}

function marketFor(env: Env, strategy: "B" | "D"): Promise<Market> {
  return buildMarket(env.STATE, env.SIGNAL_CANDLES, SYMBOLS[strategy]);
}

export async function handleMessage(env: Env, chatId: number, messageId: number, text: string): Promise<void> {
  const allowed = (env.TELEGRAM_ALLOWED_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!isAllowed(chatId, allowed)) {
    console.log(JSON.stringify({ event: "ignored", chatId }));
    return;
  }

  const { cmd, arg } = parseCommand(text);
  const state = await loadState(env.STATE);
  let next: BotState = state;
  let reply: string;

  try {
    switch (cmd) {
      case "/start":
      case "/help":
        reply = helpText();
        break;
      case "/signal":
      case "/status":
      case "/last": {
        const market = await marketFor(env, state.strategy);
        const r = evaluate(state.strategy, market, state);
        next = r.state;
        reply =
          cmd === "/signal"
            ? signalText(state.strategy, r.signal)
            : cmd === "/status"
              ? statusText(state.strategy, r.signal, next)
              : lastText(state.strategy, next.history, r.signal);
        break;
      }
      case "/strategy": {
        const v = arg.trim().toUpperCase();
        if (v !== "B" && v !== "D") {
          reply = `Не распознал «${arg}». Используй /strategy B или /strategy D`;
          break;
        }
        next = { ...state, strategy: v };
        reply = switchStrategyReply(v);
        break;
      }
      default:
        reply = `Не знаю команду «${cmd}». Подсказка: /help`;
    }
  } catch (e) {
    reply = `⚠️ Ошибка: ${(e as Error).message}`;
  }

  if (!next.chatId) next.chatId = String(chatId);
  await sendMessage(env.TELEGRAM_BOT_TOKEN, String(chatId), reply, messageId);
  await saveState(env.STATE, next);
  console.log(JSON.stringify({ event: "handled", chatId, cmd, strategy: next.strategy }));
}

export async function sendDaily(env: Env): Promise<void> {
  const state = await loadState(env.STATE);
  const chatId = state.chatId ?? env.TELEGRAM_CHAT_ID ?? "";
  if (!chatId) throw new Error("Нет chat_id: напишите боту /start или задайте TELEGRAM_CHAT_ID");

  const market = await marketFor(env, state.strategy);
  const { signal, state: next } = evaluate(state.strategy, market, state);
  if (next.lastDailyDate === signal.date) {
    console.log(JSON.stringify({ event: "daily-skip", date: signal.date, strategy: state.strategy }));
    return;
  }
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, dailyText(state.strategy, signal));
  next.lastDailyDate = signal.date;
  await saveState(env.STATE, next);
  console.log(JSON.stringify({ event: "daily-sent", date: signal.date, position: signal.position, strategy: state.strategy }));
}