import type { Config } from "./config";
import { buildMarket } from "./binance";
import { SYMBOLS } from "./strategy";
import { evaluate } from "./signalService";
import type { BotState } from "./state";
import { sendMessage } from "./telegram";
import { dailyText } from "./messages";

export async function sendDailyIfNotSent(cfg: Config, state: BotState): Promise<BotState> {
  const chatId = state.chatId || cfg.chatId;
  if (!chatId) throw new Error("Нет chat_id. Отправьте боту /start (или задайте TELEGRAM_CHAT_ID).");

  const market = await buildMarket(cfg.dataApiBase, cfg.signalCandles, SYMBOLS[state.strategy]);
  const { signal, state: next } = evaluate(state.strategy, market, state);

  if (next.lastDailyDate === signal.date) {
    console.log(`Дневной сигнал за ${signal.date} уже отправлен, пропускаю.`);
    return next;
  }

  await sendMessage(cfg.botToken, chatId, dailyText(state.strategy, signal));
  next.lastDailyDate = signal.date;
  console.log(`Дневной сигнал за ${signal.date}: ${signal.position}`);
  return next;
}