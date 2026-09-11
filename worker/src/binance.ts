import type { Market } from "./strategy";

const DAY_MS = 86400000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const ARCHIVE = "https://data.binance.vision/data/spot";
const MAX_CANDLES = 900;

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface DailySeries {
  dates: string[];
  closes: number[];
}

interface CachedSeries {
  firstOpenTime: number;
  lastOpenTime: number;
  closes: number[];
}

interface Kline {
  openTime: number;
  close: number;
}

function kvKey(symbol: string): string {
  return `binance:${symbol}`;
}

async function inflateRaw(buf: Uint8Array): Promise<string> {
  try {
    const ds = new DecompressionStream("deflate-raw");
    return await new Response(new Blob([buf]).stream().pipeThrough(ds)).text();
  } catch {
    const ds = new DecompressionStream("deflate");
    return await new Response(new Blob([buf]).stream().pipeThrough(ds)).text();
  }
}

async function fetchZipRows(url: string, symbol: string): Promise<Kline[]> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/zip" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${symbol} ${url}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const method = dv.getUint16(8, true);
  const compSize = dv.getUint32(18, true);
  const fnameLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  const dataStart = 30 + fnameLen + extraLen;
  const raw = buf.slice(dataStart, dataStart + compSize);
  const text = method === 0 ? new TextDecoder().decode(raw) : await inflateRaw(raw);

  const rows: Kline[] = [];
  for (const line of text.split("\n")) {
    const f = line.split(",");
    if (f.length < 5) continue;
    let t = Number(f[0]);
    const c = Number(f[4]);
    if (t > 1e14) t = t / 1000; // архив пишет openTime в микросекундах
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    rows.push({ openTime: t, close: c });
  }
  return rows;
}

function dailyUrl(symbol: string, date: string): string {
  return `${ARCHIVE}/daily/klines/${symbol}USDT/1d/${symbol}USDT-1d-${date}.zip`;
}

function monthlyUrl(symbol: string, ym: string): string {
  return `${ARCHIVE}/monthly/klines/${symbol}USDT/1d/${symbol}USDT-1d-${ym}.zip`;
}

function ymd(ms: number): string {
  return utcDate(ms);
}

function prevMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function nextMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function loadCache(kv: KVNamespace, symbol: string): Promise<CachedSeries | null> {
  try {
    const raw = await kv.get(kvKey(symbol));
    if (!raw) return null;
    const c = JSON.parse(raw) as CachedSeries;
    if (!Array.isArray(c.closes) || c.closes.length === 0) return null;
    return c;
  } catch {
    return null;
  }
}

async function save(kv: KVNamespace, symbol: string, cache: CachedSeries): Promise<CachedSeries> {
  await kv.put(kvKey(symbol), JSON.stringify(cache), { expirationTtl: 3600 * 24 * 400 });
  return cache;
}

// Строит непрерывный ряд closes по дням от first до last из map openTime->close.
function seriesFrom(times: number[], byTime: Map<number, number>): CachedSeries {
  let first = times[0];
  let closes: number[] = [];
  let prev = Number.NaN;
  for (const t of times) {
    if (Number.isNaN(prev) || t - prev === DAY_MS) {
      closes.push(byTime.get(t)!);
    } else {
      first = t;
      closes = [byTime.get(t)!];
    }
    prev = t;
  }
  if (closes.length > MAX_CANDLES) {
    first += (closes.length - MAX_CANDLES) * DAY_MS;
    closes = closes.slice(-MAX_CANDLES);
  }
  const last = closes.length ? first + (closes.length - 1) * DAY_MS : 0;
  return { firstOpenTime: first, lastOpenTime: last, closes };
}

async function boundedFetch(urls: string[], symbol: string, concurrency = 8): Promise<Kline[]> {
  const out: Kline[][] = [];
  for (let i = 0; i < urls.length; i += concurrency) {
    const chunk = urls.slice(i, i + concurrency);
    const res = await Promise.all(
      chunk.map(async (u) => {
        try {
          return await fetchZipRows(u, symbol);
        } catch (e) {
          console.log(JSON.stringify({ event: "zip-miss", symbol, url: u, error: (e as Error).message }));
          return [] as Kline[];
        }
      }),
    );
    out.push(...res);
  }
  return out.flat();
}

// Обновляет кэш новыми свечами (merge по openTime) и сохраняет.
async function extend(
  kv: KVNamespace,
  symbol: string,
  cache: CachedSeries,
  rows: Kline[],
  lastClosed: number,
): Promise<CachedSeries> {
  const byTime = new Map<number, number>();
  for (let i = 0; i < cache.closes.length; i++) byTime.set(cache.firstOpenTime + i * DAY_MS, cache.closes[i]);
  for (const k of rows) byTime.set(k.openTime, k.close);
  const times = [...byTime.keys()].filter((t) => t <= lastClosed).sort((a, b) => a - b);
  return save(kv, symbol, seriesFrom(times, byTime));
}

export async function fetchDailySeries(kv: KVNamespace, symbol: string, days: number): Promise<DailySeries> {
  const now = Date.now();
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const targetStart = dayStart - (days - 1) * DAY_MS;
  const lastClosed = dayStart - DAY_MS;

  let cache = await loadCache(kv, symbol);
  if (!cache) {
    const urls: string[] = [];
    const startYM = ymd(targetStart).slice(0, 7);
    const curYM = ymd(lastClosed).slice(0, 7);
    let ym = ymd(targetStart).slice(0, 7);
    while (ym < curYM) {
      urls.push(monthlyUrl(symbol, ym));
      ym = nextMonth(ym);
    }
    for (let t = targetStart; t <= lastClosed; t += DAY_MS) {
      const d = ymd(t);
      if (d.slice(0, 7) === startYM || d.slice(0, 7) === curYM) {
        urls.push(dailyUrl(symbol, d));
      }
    }
    const rows = await boundedFetch(urls, symbol);
    const byTime = new Map<number, number>();
    for (const k of rows) byTime.set(k.openTime, k.close);
    if (byTime.size === 0) throw new Error(`Нет свечей для ${symbol}`);
    const times = [...byTime.keys()].filter((t) => t <= lastClosed).sort((a, b) => a - b);
    cache = await save(kv, symbol, seriesFrom(times, byTime));
  } else {
    if (cache.lastOpenTime < targetStart) {
      // История короче нужного окна — подтягиваем месячные файлы назад.
      const urls: string[] = [];
      const ym = ymd(cache.firstOpenTime).slice(0, 7);
      let m = ym;
      const startYM = ymd(targetStart).slice(0, 7);
      // месяцы строго раньше месяца первой свечи кэша и ≥ startYM
      while (m > startYM) {
        m = prevMonth(m);
        urls.push(monthlyUrl(symbol, m));
      }
      // хвост месяца первой свечи (дни раньше неё)
      for (let t = cache.firstOpenTime - DAY_MS; t >= targetStart; t -= DAY_MS) {
        urls.push(dailyUrl(symbol, ymd(t)));
      }
      if (urls.length) {
        const rows = await boundedFetch(urls, symbol);
        cache = await extend(kv, symbol, cache, rows, cache.lastOpenTime);
      }
    }
    if (cache.lastOpenTime < lastClosed) {
      const urls: string[] = [];
      for (let t = cache.lastOpenTime + DAY_MS; t <= lastClosed; t += DAY_MS) {
        urls.push(dailyUrl(symbol, ymd(t)));
      }
      if (urls.length) {
        const rows = await boundedFetch(urls, symbol);
        cache = await extend(kv, symbol, cache, rows, lastClosed);
      }
    }
  }

  const n = Math.min(cache.closes.length, Math.max(days, 1));
  const startIdx = cache.closes.length - n;
  const out: DailySeries = { dates: [], closes: [] };
  for (let i = 0; i < n; i++) {
    out.dates.push(utcDate(cache.firstOpenTime + (startIdx + i) * DAY_MS));
    out.closes.push(cache.closes[startIdx + i]);
  }
  return out;
}

export async function buildMarket(kv: KVNamespace, days: number, symbols: string[]): Promise<Market> {
  const per: DailySeries[] = [];
  for (const s of symbols) {
    per.push(await fetchDailySeries(kv, s, days));
    if (per[per.length - 1].closes.length === 0) throw new Error(`Нет закрытых свечей для ${s}`);
  }
  const n = Math.min(...per.map((p) => p.closes.length));
  const closes: Record<string, number[]> = {};
  const dates = per[0].dates.slice(-n);
  for (let i = 0; i < symbols.length; i++) {
    closes[symbols[i]] = per[i].closes.slice(-n);
  }
  return { dates, closes };
}