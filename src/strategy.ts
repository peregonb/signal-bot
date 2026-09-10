import { ema, pctChange } from "./indicators";
import type { BotMinHold } from "./state";

export type StrategyId = "B" | "D";

export interface Market {
  dates: string[];
  closes: Record<string, number[]>;
}

export interface Signal {
  date: string;
  position: string;
  raw: string;
  bull: boolean;
  blocked: boolean;
  emaFast: number;
  emaSlow: number;
  moms: { s: string; m: number }[];
}

export interface StrategyMeta {
  name: string;
  desc: string;
  fast: number;
  slow: number;
  mom: number;
  minHold: number;
}

export const SYMBOLS: Record<StrategyId, string[]> = {
  B: ["BTC", "ETH"],
  D: ["BTC", "ETH", "BNB", "SOL"],
};

export const STRATEGIES: Record<StrategyId, StrategyMeta> = {
  B: {
    name: "B-реко",
    desc: "BTC ↔ ETH, EMA 20/80, моментум 30д",
    fast: 20,
    slow: 80,
    mom: 30,
    minHold: 0,
  },
  D: {
    name: "D-реко",
    desc: "ротация топ-1 (BTC/ETH/BNB/SOL), EMA 10/50, моментум 30д, min_hold 10",
    fast: 10,
    slow: 50,
    mom: 30,
    minHold: 10,
  },
};

function tradingDaysBetween(dates: string[], from: string, to: string): number {
  const f = dates.indexOf(from);
  const t = dates.indexOf(to);
  if (f >= 0 && t >= 0) return Math.max(0, t - f);
  const df = Date.parse(from + "T00:00:00Z");
  const dt = Date.parse(to + "T00:00:00Z");
  return Math.max(0, Math.round((dt - df) / 86400000));
}

export function computeSignal(
  id: StrategyId,
  market: Market,
  minHold?: BotMinHold,
): { signal: Signal; minHoldNext: BotMinHold } {
  const meta = STRATEGIES[id];
  const syms = SYMBOLS[id];
  const i = market.dates.length - 1;
  const btc = market.closes["BTC"];
  const ef = ema(btc, meta.fast);
  const es = ema(btc, meta.slow);
  const eFast = ef[i];
  const eSlow = es[i];
  const bull = !Number.isNaN(eFast) && !Number.isNaN(eSlow) && eFast > eSlow;

  const moms = syms.map((s) => {
    const m = pctChange(market.closes[s], meta.mom)[i];
    return { s, m: Number.isNaN(m) ? -Infinity : m };
  });

  let raw = "USDT";
  if (bull) {
    let best = syms[0];
    let bestM = moms[0].m;
    for (const x of moms) {
      if (x.m > bestM) {
        bestM = x.m;
        best = x.s;
      }
    }
    raw = best;
  }

  let position = raw;
  let blocked = false;
  if (meta.minHold > 0 && minHold?.holding && minHold.lastChangeDate) {
    if (minHold.holding !== raw) {
      if (tradingDaysBetween(market.dates, minHold.lastChangeDate, market.dates[i]) < meta.minHold) {
        position = minHold.holding;
        blocked = true;
      }
    }
  }

  let minHoldNext: BotMinHold = minHold ?? {};
  if (blocked) {
    minHoldNext = minHold ?? {};
  } else if (!minHold?.holding) {
    minHoldNext = { holding: position, lastChangeDate: market.dates[i] };
  } else if (position !== minHold.holding) {
    minHoldNext = { holding: position, lastChangeDate: market.dates[i] };
  }

  return {
    signal: {
      date: market.dates[i],
      position,
      raw,
      bull,
      blocked,
      emaFast: eFast,
      emaSlow: eSlow,
      moms,
    },
    minHoldNext,
  };
}