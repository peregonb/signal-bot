import type { Market } from "./strategy";

const DAY_MS = 86400000;

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function fetchDailyCandles(
  base: string,
  symbol: string,
  days: number,
): Promise<number[]> {
  const dayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const start = dayStart - (days - 1) * DAY_MS;
  const url = `${base}/api/v3/klines?symbol=${symbol}USDT&interval=1d&startTime=${start}&limit=1000`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Binance ${symbol}: HTTP ${res.status}`);
  const rows = (await res.json()) as unknown[][];
  return rows
    .filter((r) => Number(r[0]) + DAY_MS <= Date.now())
    .map((r) => Number(r[4]));
}

function datesFor(n: number): string[] {
  const dayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const out: string[] = [];
  for (let i = 1; i <= n; i++) out.push(utcDate(dayStart - (n - i + 1) * DAY_MS));
  return out;
}

export async function buildMarket(
  base: string,
  days: number,
  symbols: string[],
): Promise<Market> {
  const closes: Record<string, number[]> = {};
  for (const s of symbols) {
    closes[s] = await fetchDailyCandles(base, s, days);
    if (closes[s].length === 0) throw new Error(`Нет закрытых свечей для ${s}`);
  }
  const n = closes[symbols[0]].length;
  for (const s of symbols) {
    if (closes[s].length !== n) throw new Error(`Длина серий не совпадает для ${s}`);
  }
  return { dates: datesFor(n), closes };
}