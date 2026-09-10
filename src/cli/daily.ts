import { loadConfig } from "../config";
import { buildMarket } from "../binance";
import { loadState, saveState } from "../state";
import { SYMBOLS } from "../strategy";
import { evaluate } from "../signalService";
import { dailyText } from "../messages";
import { sendMessage } from "../telegram";

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.botToken) throw new Error("TELEGRAM_BOT_TOKEN не задан");

  let state = loadState(cfg.stateFile);
  const chatId = state.chatId || cfg.chatId;
  if (!chatId) {
    throw new Error(
      "Нет chat_id. Отправьте боту /start (или задайте TELEGRAM_CHAT_ID в секретах).",
    );
  }

  const market = await buildMarket(cfg.dataApiBase, cfg.signalCandles, SYMBOLS[state.strategy]);
  const { signal, state: next } = evaluate(state.strategy, market, state);

  if (next.lastDailyDate === signal.date) {
    console.log(`Дневной сигнал за ${signal.date} уже отправлен, пропускаю.`);
    return;
  }

  await sendMessage(cfg.botToken, chatId, dailyText(state.strategy, signal));
  next.lastDailyDate = signal.date;
  saveState(cfg.stateFile, next);
  console.log(`Дневной сигнал за ${signal.date}: ${signal.position}`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});