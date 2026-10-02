import { computeSignal, type Market, type Signal, type StrategyId } from "./strategy";
import type { BotState } from "./state";

export function evaluate(
  id: StrategyId,
  market: Market,
  state: BotState,
): { signal: Signal; state: BotState } {
  const date = market.dates[market.dates.length - 1];
  const base =
    state.minHoldBase?.date === date ? state.minHoldBase : { date, minHold: state.minHold };
  const { signal, minHoldNext } = computeSignal(id, market, base.minHold);
  const next: BotState = { ...state, minHold: minHoldNext, minHoldBase: base };

  const history = next.history ?? [];
  const last = history[history.length - 1];
  if (!last || last.date !== signal.date) {
    next.history = [...history, { date: signal.date, position: signal.position }].slice(-30);
  } else if (last.position !== signal.position) {
    // та же дата, но данные уточнились (Bybit → Binance) — обновляем запись
    next.history = [...history.slice(0, -1), { date: signal.date, position: signal.position }];
  }

  return { signal, state: next };
}