// Предзаполняет KV-кэш дневных свечей для всех символов стратегий B и D
// из официального архива Binance (data.binance.vision). Данные — точные Binance-клоузы.
// Запуск: node scripts/seed-candles.mjs   (должен быть выполнен wrangler login)
import { inflateRawSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DAY_MS = 86400000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const ARCHIVE = "https://data.binance.vision/data/spot";
const SYMBOLS = ["BTC", "ETH", "BNB", "SOL"];
const DAYS = 400;
const MAX_CANDLES = 900;

const dailyUrl = (s, d) => `${ARCHIVE}/daily/klines/${s}USDT/1d/${s}USDT-1d-${d}.zip`;
const monthlyUrl = (s, ym) => `${ARCHIVE}/monthly/klines/${s}USDT/1d/${s}USDT-1d-${ym}.zip`;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() + delta);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const namespaceId = (() => {
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const cfg = JSON.parse(raw);
  const ns = (cfg.kv_namespaces ?? [])[0];
  if (!ns?.id || String(ns.id).startsWith("REPLACE")) {
    console.error("wrangler.jsonc: нет id KV namespace. Выполните сначала scripts/deploy.sh");
    process.exit(1);
  }
  return ns.id;
})();

async function fetchZipRows(url, symbol) {
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${symbol} ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const method = buf.readUInt16LE(8);
  const compSize = buf.readUInt32LE(18);
  const fnameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const dataStart = 30 + fnameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + compSize);
  const text = method === 0 ? raw.toString() : inflateRawSync(raw).toString();
  const rows = [];
  for (const line of text.split("\n")) {
    const f = line.split(",");
    if (f.length < 5) continue;
    let t = Number(f[0]);
    const c = Number(f[4]);
    if (t > 1e14) t = t / 1000; // архив пишет openTime в микросекундах
    if (Number.isFinite(t) && Number.isFinite(c)) rows.push([t, c]);
  }
  return rows;
}

async function buildSeries(symbol) {
  const now = Date.now();
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const targetStart = dayStart - (DAYS - 1) * DAY_MS;
  const lastClosed = dayStart - DAY_MS;
  const startYM = ymd(targetStart).slice(0, 7);
  const curYM = ymd(lastClosed).slice(0, 7);

  const urls = [];
  let ym = startYM;
  while (ym < curYM) {
    urls.push(monthlyUrl(symbol, ym));
    ym = shiftMonth(ym, 1);
  }
  for (let t = targetStart; t <= lastClosed; t += DAY_MS) {
    const d = ymd(t);
    if (d.slice(0, 7) === startYM || d.slice(0, 7) === curYM) urls.push(dailyUrl(symbol, d));
  }

  const rows = (await Promise.all(urls.map(async (u) => {
    try {
      return await fetchZipRows(u, symbol);
    } catch (e) {
      console.log(`  skip ${u} -> ${e.message}`);
      return [];
    }
  }))).flat();

  const byTime = new Map(rows);
  const times = [...byTime.keys()].filter((t) => t <= lastClosed).sort((a, b) => a - b);
  if (times.length === 0) throw new Error(`нет свечей для ${symbol}`);

  let first = times[0];
  let closes = [];
  let prev = Number.NaN;
  for (const t of times) {
    if (Number.isNaN(prev) || t - prev === DAY_MS) closes.push(byTime.get(t));
    else {
      first = t;
      closes = [byTime.get(t)];
    }
    prev = t;
  }
  if (closes.length > MAX_CANDLES) {
    first += (closes.length - MAX_CANDLES) * DAY_MS;
    closes = closes.slice(-MAX_CANDLES);
  }
  const last = first + (closes.length - 1) * DAY_MS;
  return { firstOpenTime: first, lastOpenTime: last, closes };
}

for (const sym of SYMBOLS) {
  const series = await buildSeries(sym);
  const value = JSON.stringify(series);
  console.log(`${sym}: ${series.closes.length} свечей (${ymd(series.firstOpenTime)} .. ${ymd(series.lastOpenTime)}), пишу в KV...`);
  execFileSync("npx", ["wrangler", "kv", "key", "put", "--namespace-id", namespaceId, `binance:${sym}`, value], {
    stdio: "inherit",
  });
}
console.log("Готово.");