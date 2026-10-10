import { buildMarket, compareBybit, probeBinance, type MarketResult } from "./binance";
import { SYMBOLS, parseStrategyId, type StrategyId } from "./strategy";
import { evaluate } from "./signalService";
import type { BotState } from "./state";
import { loadState, saveState } from "./state";
import { sendMessage } from "./telegram";
import {
  helpText,
  signalText,
  statusText,
  lastText,
  switchStrategyReply,
  dailyText,
  dailyStaleText,
  dailyErrorText,
  staleText,
  provisionalNote,
  verifyChangedText,
  BOT_BUILD,
} from "./messages";

function parseCommand(text: string): { cmd: string; arg: string } {
  const t = text.trim().toLowerCase();
  if (!t.startsWith("/")) return { cmd: "message", arg: "" };
  const parts = t.split(/\s+/);
  return { cmd: parts[0].split("@")[0], arg: parts.slice(1).join(" ") };
}

function isAllowed(chatId: number, allowedIds: string[]): boolean {
  return allowedIds.length === 0 || allowedIds.includes(String(chatId));
}

function marketFor(env: Env, strategy: StrategyId): Promise<MarketResult> {
  return buildMarket(env.STATE, env.SIGNAL_CANDLES, SYMBOLS[strategy]);
}

async function versionLines(env: Env, strategy: StrategyId): Promise<string[]> {
  const v = env.CF_VERSION;
  const deployed = v ? `${v.id.slice(0, 8)} от ${v.timestamp.slice(0, 16).replace("T", " ")} UTC` : "—";
  return [
    `🛠 Код: ${BOT_BUILD}`,
    `🚀 Деплой: ${deployed}`,
    "REST из Cloudflare:",
    ...(await probeBinance()),
    ...(await compareBybit(env.STATE, SYMBOLS[strategy])),
  ];
}

export async function handleMessage(env: Env, chatId: number, messageId: number, text: string): Promise<void> {
  const allowed = (env.TELEGRAM_ALLOWED_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!isAllowed(chatId, allowed)) {
    console.log(JSON.stringify({ event: "ignored", chatId }));
    return;
  }

  const { cmd, arg } = parseCommand(text);
  const state = await loadState(env.STATE);
  let next: BotState = state;
  let reply: string;

  try {
    switch (cmd) {
      case "/start":
      case "/help":
        reply = helpText();
        break;
      case "/signal":
      case "/status":
      case "/last": {
        const m = await marketFor(env, state.strategy);
        const r = evaluate(state.strategy, m.market, state);
        next = r.state;
        reply =
          cmd === "/signal"
            ? signalText(state.strategy, r.signal)
            : cmd === "/status"
              ? statusText(state.strategy, r.signal, next, await versionLines(env, state.strategy))
              : lastText(state.strategy, next.history, r.signal);
        if (!m.fresh) reply = `${staleText(m.expectedDate, m.lastDate, m.errors)}\n\n———\n${reply}`;
        else if (m.provisional) reply = `${reply}\n\n${provisionalNote(m.lastDate, m.provisionalSymbols)}`;
        break;
      }
      case "/strategy": {
        const v = parseStrategyId(arg);
        if (!v) {
          reply = `Не распознал «${arg}». Используй /strategy B, D, F или F55`;
          break;
        }
        next = { ...state, strategy: v };
        reply = switchStrategyReply(v);
        break;
      }
      default:
        reply = `Не знаю команду «${cmd}». Подсказка: /help`;
    }
  } catch (e) {
    reply = `⚠️ Ошибка: ${(e as Error).message}`;
  }

  if (!next.chatId) next.chatId = String(chatId);
  await sendMessage(env.TELEGRAM_BOT_TOKEN, String(chatId), reply, messageId);
  await saveState(env.STATE, next);
  console.log(JSON.stringify({ event: "handled", chatId, cmd, strategy: next.strategy }));
}

// Дневной отчёт (cron 00:05 UTC). Сообщение приходит ВСЕГДА: либо свежий сигнал,
// либо явное предупреждение/ошибка — чтобы не гадать, почему отчёта нет.
export interface DailyRun {
  cron: string;
  at: string;
  attempt: number; // номер попытки (1 = 00:05 UTC)
  total: number;
  final: boolean; // последняя попытка — при неудаче шлём предупреждение
}

const DAY_MS = 86400000;

export async function sendDaily(env: Env, run?: DailyRun): Promise<void> {
  // Откуда пришёл запуск — видно в конце сообщения (диагностика расписания).
  const runLine = run
    ? `\n\n⏱ попытка ${run.attempt} из ${run.total}, запуск ${run.at.slice(11, 19)} UTC`
    : "";
  const final = run?.final ?? true;
  const state = await loadState(env.STATE, 30);
  const chatId = state.chatId ?? env.TELEGRAM_CHAT_ID ?? "";
  if (!chatId) throw new Error("Нет chat_id: напишите боту /start или задайте TELEGRAM_CHAT_ID");

  // Отчёт за вчерашнюю свечу уже отправлен (на одной из прошлых попыток) — ничего не делаем.
  const expected = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS - DAY_MS).toISOString().slice(0, 10);
  if (state.lastDailyDate === expected) {
    console.log(JSON.stringify({ event: "daily-skip", date: expected, attempt: run?.attempt }));
    return;
  }

  let m: MarketResult;
  try {
    m = await marketFor(env, state.strategy);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ event: "daily-error", error, strategy: state.strategy, attempt: run?.attempt }));
    if (final) await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, dailyErrorText(error) + runLine);
    return;
  }

  if (!m.fresh) {
    console.warn(
      JSON.stringify({ event: "daily-stale", expected: m.expectedDate, last: m.lastDate, errors: m.errors, attempt: run?.attempt, final }),
    );
    // Не последняя попытка — молчим (ни одного сообщения), следующая попытка через минуту из другого города.
    // Последняя — короткое предупреждение БЕЗ старого сигнала (он за позавчерашнюю свечу и бесполезен).
    if (final) {
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        dailyStaleText(m.expectedDate, m.lastDate, m.errors, run?.total ?? 1) + runLine,
      );
    }
    return;
  }

  const { signal, state: next } = evaluate(state.strategy, m.market, state);
  if (next.lastDailyDate === signal.date) {
    console.log(JSON.stringify({ event: "daily-skip", date: signal.date, strategy: state.strategy }));
    return;
  }
  const text = dailyText(state.strategy, signal);
  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    (m.provisional ? `${text}\n\n${provisionalNote(m.lastDate, m.provisionalSymbols)}` : text) + runLine,
  );
  next.lastDailyDate = signal.date;
  next.lastDaily = { date: signal.date, position: signal.position, provisional: m.provisional };
  await saveState(env.STATE, next);
  console.log(JSON.stringify({ event: "daily-sent", date: signal.date, position: signal.position, strategy: state.strategy, attempt: run?.attempt }));
}

// Сверка (cron 02:30 UTC): если отчёт ушёл по свече Bybit, пересчитываем по архиву
// Binance. Пишет в Telegram ТОЛЬКО если позиция изменилась; иначе молча.
export async function verifyDaily(env: Env): Promise<void> {
  const state = await loadState(env.STATE);
  const ld = state.lastDaily;
  const chatId = state.chatId ?? env.TELEGRAM_CHAT_ID ?? "";
  if (!ld || !ld.provisional || ld.checked || !chatId) {
    console.log(JSON.stringify({ event: "verify-skip", lastDaily: ld ?? null }));
    return;
  }
  const m = await marketFor(env, state.strategy);
  if (m.lastDate !== ld.date || m.provisional) {
    console.warn(JSON.stringify({ event: "verify-not-ready", date: ld.date, lastDate: m.lastDate, provisional: m.provisionalSymbols }));
    return;
  }
  const { signal, state: next } = evaluate(state.strategy, m.market, state);
  next.lastDaily = { ...ld, checked: true };
  if (signal.position !== ld.position) {
    // Без звука: ночью (05:30 Киев) не будим — сообщение просто будет в чате.
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, verifyChangedText(state.strategy, signal, ld.position), undefined, true);
    next.lastDaily.position = signal.position;
  }
  await saveState(env.STATE, next);
  console.log(JSON.stringify({ event: "verify-done", date: ld.date, bybit: ld.position, binance: signal.position }));
}
