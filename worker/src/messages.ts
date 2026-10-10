import { STRATEGIES, SYMBOLS, type Signal, type StrategyId } from "./strategy";
import type { BotState } from "./state";

// Метка версии кода — меняйте при значимых правках, чтобы видеть в /help и /status, что задеплоено.
export const BOT_BUILD = "2026-10-10 · F55, один отчёт 00:05 (тихие повторы до 00:13), тихая сверка 02:30 UTC";

function posEmoji(position: string): string {
  return position === "USDT" ? "⚪" : "🟢";
}

function fmtPct(m: number): string {
  if (!isFinite(m)) return "—";
  const s = (m * 100).toFixed(1);
  return (m >= 0 ? "+" : "") + s + "%";
}

function fmtNum(n: number): string {
  if (!isFinite(n)) return "—";
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 0 });
}

function momLines(id: StrategyId, signal: Signal): string[] {
  const sorted = [...signal.moms].sort((a, b) => b.m - a.m);
  return sorted.map((x, idx) => {
    const lead = idx === 0 ? "👑 " : "  ";
    return `${lead}${x.s} ${fmtPct(x.m)}${idx === 0 && id === "B" ? " (сильнейший)" : ""}`;
  });
}

export function helpText(): string {
  return [
    "🤖 SignalBot — дневной сигнал по спот-стратегиям",
    "",
    "Команды:",
    "/start — приветствие",
    "/signal — сигнал сейчас",
    "/status — статус и настройки",
    "/strategy B — B-реко (BTC ↔ ETH, EMA 20/80)",
    "/strategy D — D-реко (ротация топ-1, EMA 10/50)",
    "/strategy F — F-реко (D + SUI, ротация топ-1, EMA 10/50)",
    "/strategy F55 — F (+5/−5): F-реко + Ингибитор +5% / Катализатор −5%",
    "/last — последние сигналы",
    "/help — помощь",
    "",
    "Данные: Binance, дневные свечи (UTC). Только уведомления, без авто-трейдинга.",
    "Ежедневный отчёт: одно сообщение в 00:05 UTC (03:05 Киев летом / 02:05 зимой), максимум до 00:13.",
    `Версия: ${BOT_BUILD}`,
  ].join("\n");
}

export function signalText(id: StrategyId, signal: Signal): string {
  const meta = STRATEGIES[id];
  const bull = signal.bull ? "бычий" : "медвежий";
  const cmp = signal.bull ? ">" : "<";
  const lines = [
    `📊 Сигнал • ${meta.name}`,
    `📅 Свеча ${signal.date} (UTC, закрытая)`,
    "",
    `${posEmoji(signal.position)} Позиция: ${signal.position}${signal.position === "USDT" ? " (кэш)" : " 100%"}`,
    "",
    `EMA${meta.fast} ${fmtNum(signal.emaFast)} ${cmp} EMA${meta.slow} ${fmtNum(signal.emaSlow)} — ${bull}`,
  ];
  if (signal.modifier === "inhibitor") {
    lines.push(
      `🛑 Ингибитор: моментум BTC ${meta.mom}д ${fmtPct(signal.momBTC)} < ${fmtPct(meta.inhibitor ?? 0)} → стейбл, хотя тренд бычий.`,
    );
  } else if (signal.modifier === "catalyst") {
    lines.push(
      `⚡ Катализатор: моментум BTC ${meta.mom}д ${fmtPct(signal.momBTC)} > ${fmtPct(meta.catalyst ?? 0)} → покупаем лидера, хотя тренд медвежий.`,
    );
  } else if (meta.inhibitor !== undefined || meta.catalyst !== undefined) {
    lines.push(`Моментум BTC ${meta.mom}д ${fmtPct(signal.momBTC)} — модификаторы не сработали.`);
  }
  if (signal.inMarket) {
    lines.push(`Моментум ${meta.mom}д (${SYMBOLS[id].join(" / ")}):`);
    lines.push(...momLines(id, signal));
  } else if (signal.modifier !== "inhibitor") {
    lines.push("BTC в медвежьем тренде → держим стейбл (USDT).");
  }
  if (signal.blocked) {
    lines.push(`🔒 min_hold ${meta.minHold}: смену откладываем, держим ${signal.position}`);
  }
  lines.push("", "/last · /status · /help");
  return lines.join("\n");
}

export function dailyText(id: StrategyId, signal: Signal): string {
  return `📆 Ежедневный отчёт\n\n${signalText(id, signal)}`;
}

export function statusText(id: StrategyId, signal: Signal, state: BotState, extra: string[] = []): string {
  const meta = STRATEGIES[id];
  const lines = [
    `ℹ️ Статус • ${meta.name}`,
    meta.desc,
    "",
    `📅 Закрытая свеча: ${signal.date}`,
    `${posEmoji(signal.position)} Позиция: ${signal.position}`,
  ];
  if (id !== "B" && state.minHold?.holding) {
    lines.push(
      `🔒 min_hold: держим ${state.minHold.holding} (последняя смена ${state.minHold.lastChangeDate ?? "—"})`,
    );
  }
  if (extra.length) lines.push("", ...extra);
  lines.push("", "Сменить стратегию: /strategy B | /strategy D | /strategy F | /strategy F55");
  return lines.join("\n");
}

export function lastText(id: StrategyId, history: BotState["history"], current: Signal): string {
  const meta = STRATEGIES[id];
  if (!history.length) return `🕐 История по «${meta.name}» ещё пуста.`;
  const rows = history
    .slice(-7)
    .map((h) => ` ${h.date.slice(5)}  ${posEmoji(h.position)} ${h.position}`)
    .join("\n");
  return [
    `🕐 Последние сигналы • ${meta.name}`,
    rows,
    "—",
    `Текущий: ${posEmoji(current.position)} ${current.position}`,
    "",
    "Дата — день закрытия свечи (UTC).",
  ].join("\n");
}

export function switchStrategyReply(id: StrategyId): string {
  const meta = STRATEGIES[id];
  return `Стратегия: ${meta.name} (${meta.desc}). Текущий сигнал — /signal`;
}
// Причины неудачи: ошибки вида «BTC: причина» группируем по причине: «причина (BTC, ETH, …)».
function reasonLines(errors: string[]): string[] {
  if (!errors.length) return [];
  const byReason = new Map<string, string[]>();
  for (const e of errors) {
    const i = e.indexOf(": ");
    const sym = i > 0 ? e.slice(0, i) : "";
    const reason = i > 0 ? e.slice(i + 2) : e;
    byReason.set(reason, [...(byReason.get(reason) ?? []), sym].filter(Boolean));
  }
  const lines = ["", "Причина:"];
  for (const [reason, syms] of byReason) lines.push(`• ${reason}${syms.length ? ` (${syms.join(", ")})` : ""}`);
  return lines;
}

// Предупреждение для /signal: свеча за вчера (UTC) ещё не получена, сигнал посчитан по старым данным.
export function staleText(expectedDate: string, lastDate: string, errors: string[]): string {
  return [
    `⚠️ Нет свечи за ${expectedDate} — данные только по ${lastDate}.`,
    "Сигнал ниже — СТАРЫЙ, не по последней закрытой свече.",
    ...reasonLines(errors),
    "",
    "Повтори /signal позже или запусти локально: npm run signal",
  ].join("\n");
}

// Дневной отчёт: все попытки не получили свежую свечу. Старый сигнал не показываем.
export function dailyStaleText(expectedDate: string, lastDate: string, errors: string[], attempts: number): string {
  return [
    "📆 Ежедневный отчёт — НЕ УДАЛОСЬ получить свежие данные",
    "",
    `⚠️ Свеча за ${expectedDate} не получена (${attempts} попыток, 00:05–00:13 UTC). Последние данные — за ${lastDate}.`,
    ...reasonLines(errors),
    "",
    "👉 Отправь /signal — команда выполняется рядом с тобой и обычно получает свечу с Bybit.",
    "Примерно в 02:30 UTC (05:30 Киев) выходит архив Binance — /signal после этого возьмёт его.",
  ].join("\n");
}

export function dailyErrorText(error: string): string {
  return [
    "📆 Ежедневный отчёт — ОШИБКА",
    "",
    `⚠️ ${error}`,
    "",
    "Сигнал не посчитан. Повтори /signal позже или запусти локально: npm run signal",
  ].join("\n");
}

export function provisionalNote(date: string, symbols: string[]): string {
  return [
    `📡 Свеча ${date} по ${symbols.join(", ")} — с Bybit (предварительно): Binance не пускает Cloudflare,`,
    "а архив Binance выходит ~через 2 ч после закрытия.",
    "В 02:30 UTC (05:30 Киев летом) бот сверит с архивом Binance и напишет — без звука — ТОЛЬКО если сигнал изменится.",
  ].join("\n");
}

export function verifyChangedText(id: StrategyId, signal: Signal, before: string): string {
  return [
    "❗ Сверка с архивом Binance: сигнал ИЗМЕНИЛСЯ (сообщение без звука)",
    `По Bybit было: ${before} → по Binance: ${signal.position}`,
    "",
    signalText(id, signal),
  ].join("\n");
}
