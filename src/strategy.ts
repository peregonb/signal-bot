import { ema, pctChange } from "./indicators";
import type { BotMinHold } from "./state";

// F55 = F-реко с Ингибитором +5% и Катализатором −5% (подобрано в spot-tracker, задержка ≤ 1 ч)
export type StrategyId = "B" | "D" | "F" | "F55";

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
  /** итоговый режим: в рынке (с учётом Ингибитора/Катализатора) или в стейбле */
  inMarket: boolean;
  /** какой модификатор поменял решение EMA-гейта (только у стратегий с модификаторами) */
  modifier?: "inhibitor" | "catalyst";
  /** 30-дневный моментум BTC — по нему срабатывают Ингибитор/Катализатор */
  momBTC: number;
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
  /** Ингибитор: EMA бычий, но моментум BTC < порога → стейбл (доля, 0.05 = +5%) */
  inhibitor?: number;
  /** Катализатор: EMA медвежий, но моментум BTC > порога → покупаем лидера (доля) */
  catalyst?: number;
}

export const SYMBOLS: Record<StrategyId, string[]> = {
  B: ["BTC", "ETH"],
  D: ["BTC", "ETH", "BNB", "SOL"],
  F: ["BTC", "ETH", "BNB", "SOL", "SUI"],
  F55: ["BTC", "ETH", "BNB", "SOL", "SUI"],
};

export const STRATEGIES: Record<StrategyId, StrategyMeta> = {
  B: {
    name: "B-реко",
    desc: "BTC ↔ ETH, EMA 20/80, моментум 30д, min_hold 1",
    fast: 20,
    slow: 80,
    mom: 30,
    minHold: 1,
  },
  D: {
    name: "D-реко",
    desc: "ротация топ-1 (BTC/ETH/BNB/SOL), EMA 10/50, моментум 30д, min_hold 1",
    fast: 10,
    slow: 50,
    mom: 30,
    minHold: 1,
  },
  F: {
    name: "F-реко",
    desc: "ротация топ-1 (BTC/ETH/BNB/SOL/SUI), EMA 10/50, моментум 30д, min_hold 1",
    fast: 10,
    slow: 50,
    mom: 30,
    minHold: 1,
  },
  F55: {
    name: "F (+5/−5)",
    desc: "F-реко + Ингибитор +5% / Катализатор −5% по моментуму BTC 30д, EMA 10/50, min_hold 1",
    fast: 10,
    slow: 50,
    mom: 30,
    minHold: 1,
    inhibitor: 0.05,
    catalyst: -0.05,
  },
};

/** Разбор ID стратегии из команды: B, D, F, F55 (а также «F+5-5», «F (+5/−5)»). */
export function parseStrategyId(arg: string): StrategyId | null {
  const v = arg.trim().toUpperCase().replace(/[−–]/g, "-").replace(/[\s()/]/g, "");
  if (v === "B" || v === "D" || v === "F" || v === "F55") return v;
  if (v === "F+5-5" || v === "F5-5" || v === "F+55") return "F55";
  return null;
}

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

  // Ингибитор / Катализатор (как gateWithOptions в spot-tracker): работают только при полной
  // истории моментума BTC; Ингибитор — в бычьем режиме, Катализатор — в медвежьем.
  const momBTC = pctChange(btc, meta.mom)[i];
  let inMarket = bull;
  let modifier: Signal["modifier"];
  if (i >= meta.mom && !Number.isNaN(momBTC) && !Number.isNaN(btc[i])) {
    if (bull && meta.inhibitor !== undefined && momBTC < meta.inhibitor) {
      inMarket = false;
      modifier = "inhibitor";
    } else if (!bull && meta.catalyst !== undefined && momBTC > meta.catalyst) {
      inMarket = true;
      modifier = "catalyst";
    }
  }

  let raw = "USDT";
  if (inMarket) {
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
      inMarket,
      modifier,
      momBTC,
      emaFast: eFast,
      emaSlow: eSlow,
      moms,
    },
    minHoldNext,
  };
}