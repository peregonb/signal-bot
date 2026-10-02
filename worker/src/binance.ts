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
  errors: string[]; // почему не удалось получить свежие свечи (пусто, если всё ок)
  provisional: string[]; // даты свечей, взятых с Bybit (ещё не подтверждены архивом Binance)
}

// Итог загрузки рынка: сами данные + проверка свежести.
export interface MarketResult {
  market: Market;
  expectedDate: string; // последняя закрытая дневная свеча (вчера по UTC)
  lastDate: string; // фактическая последняя свеча в данных
  fresh: boolean;
  errors: string[];
  // Последняя свеча хотя бы одной монеты взята с Bybit (архив Binance ещё не вышел).
  provisional: boolean;
  provisionalSymbols: string[];
}

interface CachedSeries {
  firstOpenTime: number;
  lastOpenTime: number;
  closes: number[];
  // openTime свечей, взятых с Bybit; заменяются архивом Binance, как только он выйдет.
  provisional?: number[];
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

// Свежие закрытые дневные свечи через REST API Binance (появляются сразу после
// закрытия свечи в 00:00 UTC, в отличие от архива, который выкладывается ~через 2 ч).
// Только Binance: публичный market-data хост и основной API.
const REST_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];

function httpError(status: number, body: string): Error {
  const b = body.trim();
  // HTML-страницы ошибок (403 от CDN) не тащим в сообщение
  const short = b.startsWith("<") ? "" : b.slice(0, 120).replace(/\s+/g, " ");
  return new Error(`HTTP ${status}${short ? ` ${short}` : ""}`);
}

async function binanceRows(host: string, symbol: string, fromMs: number, now: number): Promise<Kline[]> {
  const url = `${host}/api/v3/klines?symbol=${symbol}USDT&interval=1d&startTime=${fromMs}&limit=1000`;
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw httpError(res.status, await res.text());
  const rows = (await res.json()) as unknown[][];
  return rows
    .filter((r) => Number(r[0]) >= fromMs && Number(r[0]) + DAY_MS <= now)
    .map((r) => ({ openTime: Number(r[0]), close: Number(r[4]) }));
}

// Bybit spot, дневные свечи (UTC, старт 00:00) — временная замена, пока Binance недоступен.
export async function bybitRows(symbol: string, fromMs: number, now = Date.now()): Promise<Kline[]> {
  const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}USDT&interval=D&start=${fromMs}&limit=1000`;
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw httpError(res.status, await res.text());
  const json = (await res.json()) as { retCode?: number; retMsg?: string; result?: { list?: string[][] } };
  if (json.retCode !== 0 || !Array.isArray(json.result?.list)) {
    throw new Error(`retCode ${json.retCode} ${json.retMsg ?? ""}`.trim());
  }
  return json.result!.list!
    .map((r) => ({ openTime: Number(r[0]), close: Number(r[4]) }))
    .filter((k) => k.openTime >= fromMs && k.openTime + DAY_MS <= now)
    .sort((a, b) => a.openTime - b.openTime);
}

// Свежие закрытые дневные свечи. Сначала Binance (если когда-нибудь пустит Cloudflare),
// затем Bybit — его свечи помечаются как предварительные и потом заменяются архивом Binance.
async function restDailyRows(
  symbol: string,
  fromMs: number,
  errors: string[],
): Promise<{ rows: Kline[]; provisional: boolean }> {
  const now = Date.now();
  for (const host of REST_HOSTS) {
    try {
      const rows = await binanceRows(host, symbol, fromMs, now);
      console.log(JSON.stringify({ event: "rest-ok", host, symbol, rows: rows.length }));
      if (rows.length) return { rows, provisional: false };
    } catch (e) {
      errors.push(`${symbol}: REST ${new URL(host).hostname}: ${(e as Error).message}`);
      console.log(JSON.stringify({ event: "rest-miss", host, symbol, error: (e as Error).message }));
    }
  }
  try {
    const rows = await bybitRows(symbol, fromMs, now);
    console.log(JSON.stringify({ event: "bybit-ok", symbol, rows: rows.length }));
    if (rows.length) return { rows, provisional: true };
  } catch (e) {
    errors.push(`${symbol}: Bybit: ${(e as Error).message}`);
    console.log(JSON.stringify({ event: "bybit-miss", symbol, error: (e as Error).message }));
  }
  return { rows: [], provisional: false };
}

// Быстрая проверка: отвечают ли REST Binance и Bybit этому воркеру прямо сейчас (для /status).
export async function probeBinance(): Promise<string[]> {
  const bybit = (async () => {
    try {
      const rows = await bybitRows("BTC", Math.floor(Date.now() / DAY_MS) * DAY_MS - 3 * DAY_MS);
      return `✅ api.bybit.com: ${rows.length} свеч.`;
    } catch (e) {
      return `❌ api.bybit.com: ${(e as Error).message}`;
    }
  })();
  const binance = Promise.all(
    REST_HOSTS.map(async (host) => {
      const name = new URL(host).hostname;
      try {
        const res = await fetch(`${host}/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=1`, {
          headers: { "user-agent": UA, accept: "application/json" },
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) return `✅ ${name}: HTTP ${res.status}`;
        return `❌ ${name}: ${httpError(res.status, await res.text()).message}`;
      } catch (e) {
        return `❌ ${name}: ${(e as Error).message}`;
      }
    }),
  );
  return [...(await binance), await bybit];
}

// Сравнение свечей Bybit и Binance за последний день, который уже есть в кэше от Binance
// (для /status: насколько Bybit расходится с Binance на практике).
export async function compareBybit(kv: KVNamespace, symbols: string[]): Promise<string[]> {
  const out: string[] = [];
  let day = "";
  for (const s of symbols) {
    const c = await loadCache(kv, s);
    if (!c) continue;
    const prov = new Set(c.provisional ?? []);
    let t = c.lastOpenTime;
    while (prov.has(t) && t > c.firstOpenTime) t -= DAY_MS; // берём последнюю свечу именно Binance
    const binClose = c.closes[(t - c.firstOpenTime) / DAY_MS];
    try {
      const rows = await bybitRows(s, t);
      const by = rows.find((k) => k.openTime === t);
      if (!by) {
        out.push(`${s}: нет свечи Bybit`);
        continue;
      }
      day = ymd(t);
      const pct = ((by.close - binClose) / binClose) * 100;
      out.push(`${s}: ${pct >= 0 ? "+" : ""}${pct.toFixed(3)}%`);
    } catch (e) {
      out.push(`${s}: ${(e as Error).message}`);
    }
  }
  return out.length ? [`Bybit vs Binance, close ${day || "—"}:`, out.join(" · ")] : [];
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
  opts: { provisional?: boolean } = {},
): Promise<CachedSeries> {
  const byTime = new Map<number, number>();
  for (let i = 0; i < cache.closes.length; i++) byTime.set(cache.firstOpenTime + i * DAY_MS, cache.closes[i]);
  const prov = new Set(cache.provisional ?? []);
  for (const k of rows) {
    byTime.set(k.openTime, k.close);
    if (opts.provisional) prov.add(k.openTime);
    else prov.delete(k.openTime); // свеча Binance заменяет свечу Bybit
  }
  const times = [...byTime.keys()].filter((t) => t <= lastClosed).sort((a, b) => a - b);
  const next = seriesFrom(times, byTime);
  const kept = [...prov].filter((t) => t >= next.firstOpenTime && t <= next.lastOpenTime).sort((a, b) => a - b);
  if (kept.length) next.provisional = kept;
  return save(kv, symbol, next);
}

export async function fetchDailySeries(kv: KVNamespace, symbol: string, days: number): Promise<DailySeries> {
  const now = Date.now();
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const targetStart = dayStart - (days - 1) * DAY_MS;
  const lastClosed = dayStart - DAY_MS;
  const errors: string[] = [];

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
  }

  // Предварительные свечи Bybit → заменяем архивом Binance, если он уже вышел.
  if (cache.provisional?.length) {
    const urls = cache.provisional.map((t) => dailyUrl(symbol, ymd(t)));
    const rows = await boundedFetch(urls, symbol);
    if (rows.length) {
      const diffs = rows
        .map((k) => {
          const i = (k.openTime - cache!.firstOpenTime) / DAY_MS;
          const old = cache!.closes[i];
          return old ? `${ymd(k.openTime)} ${(((k.close - old) / old) * 100).toFixed(3)}%` : "";
        })
        .filter(Boolean);
      console.log(JSON.stringify({ event: "bybit-replaced", symbol, diffs }));
      cache = await extend(kv, symbol, cache, rows, cache.lastOpenTime);
    }
  }

  // Хвост (свечи после кэша): сначала REST Binance, затем Bybit (свеча доступна
  // сразу после закрытия); архив Binance — если REST не ответил (появляется ~через 2 ч).
  if (cache.lastOpenTime < lastClosed) {
    const r = await restDailyRows(symbol, cache.lastOpenTime + DAY_MS, errors);
    if (r.rows.length) cache = await extend(kv, symbol, cache, r.rows, lastClosed, { provisional: r.provisional });
  }
  if (cache.lastOpenTime < lastClosed) {
    const urls: string[] = [];
    for (let t = cache.lastOpenTime + DAY_MS; t <= lastClosed; t += DAY_MS) {
      urls.push(dailyUrl(symbol, ymd(t)));
    }
    const rows = await boundedFetch(urls, symbol);
    cache = await extend(kv, symbol, cache, rows, lastClosed);
    if (cache.lastOpenTime < lastClosed) {
      errors.push(`${symbol}: архив за ${ymd(lastClosed)} ещё не опубликован`);
    }
  }

  const n = Math.min(cache.closes.length, Math.max(days, 1));
  const startIdx = cache.closes.length - n;
  const prov = new Set((cache.provisional ?? []).map((t) => ymd(t)));
  const out: DailySeries = { dates: [], closes: [], errors, provisional: [] };
  for (let i = 0; i < n; i++) {
    out.dates.push(utcDate(cache.firstOpenTime + (startIdx + i) * DAY_MS));
    out.closes.push(cache.closes[startIdx + i]);
    if (prov.has(out.dates[i])) out.provisional.push(out.dates[i]);
  }
  return out;
}

export async function buildMarket(kv: KVNamespace, days: number, symbols: string[]): Promise<MarketResult> {
  const expectedDate = utcDate(Math.floor(Date.now() / DAY_MS) * DAY_MS - DAY_MS);
  const per: DailySeries[] = [];
  for (const s of symbols) {
    per.push(await fetchDailySeries(kv, s, days));
    if (per[per.length - 1].closes.length === 0) throw new Error(`Нет закрытых свечей для ${s}`);
  }
  // Выравниваем по дате: все ряды обрезаются до самой ранней «последней» свечи,
  // чтобы при частично свежих данных не сдвинуть ряды друг относительно друга.
  const lastDate = per.map((p) => p.dates[p.dates.length - 1]).sort()[0];
  const trimmed = per.map((p) => {
    const end = p.dates.lastIndexOf(lastDate) + 1;
    return { dates: p.dates.slice(0, end), closes: p.closes.slice(0, end) };
  });
  const n = Math.min(...trimmed.map((p) => p.closes.length));
  const closes: Record<string, number[]> = {};
  const dates = trimmed[0].dates.slice(-n);
  for (let i = 0; i < symbols.length; i++) {
    closes[symbols[i]] = trimmed[i].closes.slice(-n);
  }
  const fresh = lastDate === expectedDate;
  const provisionalSymbols = symbols.filter((_, i) => per[i].provisional.includes(lastDate));
  return {
    provisional: provisionalSymbols.length > 0,
    provisionalSymbols,
    market: { dates, closes },
    expectedDate,
    lastDate,
    fresh,
    errors: fresh ? [] : per.flatMap((p) => p.errors),
  };
}
