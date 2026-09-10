import { loadConfig } from "../config";
import { loadState, saveState } from "../state";
import { getUpdates } from "../telegram";
import { processUpdates } from "../updateHandler";

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.botToken) throw new Error("TELEGRAM_BOT_TOKEN не задан");

  let state = loadState(cfg.stateFile);
  const updates = await getUpdates(cfg.botToken, state.offset, 0);
  if (updates.length === 0) {
    console.log("Новых апдейтов нет.");
    return;
  }

  state = await processUpdates(cfg, state, updates);
  saveState(cfg.stateFile, state);
  console.log(`Обработано апдейтов: ${updates.length}, offset=${state.offset}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});