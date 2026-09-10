import { computeSignal, type Market, type Signal, type StrategyId } from "./strategy";
import type { BotState } from "./state";

export function evaluate(
  id: StrategyId,
  market: Market,
  state: BotState,
): { signal: Signal; state: BotState } {
  const { signal, minHoldNext } = computeSignal(id, market, state.minHold);
  const next: BotState = { ...state, minHold: minHoldNext };

  const history = next.history ?? [];
  const last = history[history.length - 1];
  if (!last || last.date !== signal.date) {
    next.history = [...history, { date: signal.date, position: signal.position }].slice(-30);
  }

  return { signal, state: next };
}