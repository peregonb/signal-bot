import { loadConfig } from "../config";
import { loadState, saveState } from "../state";
import { sendDailyIfNotSent } from "../dailyReport";

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.botToken) throw new Error("TELEGRAM_BOT_TOKEN не задан");

  const state = await sendDailyIfNotSent(cfg, loadState(cfg.stateFile));
  saveState(cfg.stateFile, state);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});