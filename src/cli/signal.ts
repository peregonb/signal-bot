import { loadConfig } from "../config";
import { buildMarket } from "../binance";
import { loadState, saveState } from "../state";
import { SYMBOLS } from "../strategy";
import { evaluate } from "../signalService";
import { signalText } from "../messages";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const state = loadState(cfg.stateFile);
  const market = await buildMarket(cfg.dataApiBase, cfg.signalCandles, SYMBOLS[state.strategy]);
  const { signal, state: next } = evaluate(state.strategy, market, state);
  saveState(cfg.stateFile, next);
  console.log(signalText(state.strategy, signal));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});