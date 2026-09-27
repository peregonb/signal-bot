import { loadConfig } from "../config";
import { buildMarket } from "../binance";
import { loadState, saveState } from "../state";
import { STRATEGIES, SYMBOLS, type StrategyId } from "../strategy";
import { evaluate } from "../signalService";
import { signalText } from "../messages";

// Разбирает переопределение стратегии из аргументов: "F" или "--strategy F"/"-s F".
// Возвращает null, если переопределения нет.
function parseStrategyOverride(argv: string[]): StrategyId | null {
  const args = argv.slice(2);
  let v = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--strategy" || a === "-s") {
      v = args[i + 1] ?? "";
      break;
    }
    if (a.startsWith("--strategy=")) {
      v = a.slice("--strategy=".length);
      break;
    }
    if (!a.startsWith("-")) {
      v = a;
      break;
    }
  }
  if (!v) return null;
  const up = v.trim().toUpperCase();
  if (up in STRATEGIES) return up as StrategyId;
  console.error(
    `Неизвестная стратегия «${v}». Доступные: ${Object.keys(STRATEGIES).join(", ")}`,
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const state = loadState(cfg.stateFile);
  const override = parseStrategyOverride(process.argv);
  const strategy = override ?? state.strategy;

  const market = await buildMarket(cfg.dataApiBase, cfg.signalCandles, SYMBOLS[strategy]);
  const { signal, state: next } = evaluate(strategy, market, state);
  // С переопределением — только предпросмотр, состояние бота не трогаем.
  if (!override) saveState(cfg.stateFile, next);
  console.log(signalText(strategy, signal));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
