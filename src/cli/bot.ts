import { loadConfig } from "../config";
import { loadState, saveState, type BotState } from "../state";
import { getUpdates } from "../telegram";
import { processUpdates } from "../updateHandler";
import { sendDailyIfNotSent } from "../dailyReport";

const log = (m: string): void => console.log(`[${new Date().toISOString()}] ${m}`);

async function dailyTick(
  cfg: ReturnType<typeof loadConfig>,
  state: BotState,
): Promise<BotState> {
  const now = new Date();
  if (now.getUTCHours() !== 0) return state;
  if (now.getUTCMinutes() < 30 || now.getUTCMinutes() > 59) return state;
  const today = now.toISOString().slice(0, 10);
  if (state.lastDailyDate === today) return state;

  try {
    const next = await sendDailyIfNotSent(cfg, state);
    saveState(cfg.stateFile, next);
    log(`Ежедневный отчёт отправлен (${next.lastDailyDate}).`);
    return next;
  } catch (e) {
    log(`Ошибка ежедневного отчёта: ${(e as Error).message}`);
    return state;
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.botToken) throw new Error("TELEGRAM_BOT_TOKEN не задан");

  let state = loadState(cfg.stateFile);
  log(
    `SignalBot запущен (${process.version}), стратегия=${state.strategy},` +
      (state.chatId ? ` чат=${state.chatId}` : " чат ещё не известен (жду /start)"),
  );

  for (;;) {
    state = await dailyTick(cfg, state);

    try {
      const updates = await getUpdates(cfg.botToken, state.offset, 50);
      if (updates.length > 0) {
        state = await processUpdates(cfg, state, updates);
        saveState(cfg.stateFile, state);
        log(`Обработано апдейтов: ${updates.length} (offset=${state.offset}).`);
      }
    } catch (e) {
      log(`Ошибка polling: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});