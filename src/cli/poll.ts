import { loadConfig } from "../config";
import { buildMarket } from "../binance";
import { loadState, saveState } from "../state";
import { SYMBOLS } from "../strategy";
import { evaluate } from "../signalService";
import {
  helpText,
  signalText,
  statusText,
  lastText,
  switchStrategyReply,
} from "../messages";
import { getUpdates, sendMessage } from "../telegram";

interface ParsedCommand {
  cmd: string;
  arg: string;
}

function parseCommand(text: string): ParsedCommand {
  const t = text.trim().toLowerCase();
  if (!t.startsWith("/")) return { cmd: "message", arg: "" };
  const parts = t.split(/\s+/);
  return { cmd: parts[0].split("@")[0], arg: parts.slice(1).join(" ") };
}

function isAllowed(chatId: number, allowedIds: string[]): boolean {
  return allowedIds.length === 0 || allowedIds.includes(String(chatId));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.botToken) throw new Error("TELEGRAM_BOT_TOKEN не задан");

  let state = loadState(cfg.stateFile);
  const updates = await getUpdates(cfg.botToken, state.offset);
  if (updates.length === 0) {
    console.log("Новых апдейтов нет.");
    return;
  }

  const maxId = Math.max(...updates.map((u) => u.update_id));
  const market = await buildMarket(cfg.dataApiBase, cfg.signalCandles, SYMBOLS.D);

  for (const u of updates) {
    const msg = u.message;
    if (!msg || typeof msg.text !== "string") continue;
    const chatId = msg.chat.id;
    if (!isAllowed(chatId, cfg.allowedIds)) continue;

    let reply: string;
    try {
      const { cmd, arg } = parseCommand(msg.text);
      switch (cmd) {
        case "/start":
        case "/help":
          reply = helpText();
          break;
        case "/signal": {
          const { signal, state: next } = evaluate(state.strategy, market, state);
          state = next;
          reply = signalText(state.strategy, signal);
          break;
        }
        case "/status": {
          const { signal, state: next } = evaluate(state.strategy, market, state);
          state = next;
          reply = statusText(state.strategy, signal, state);
          break;
        }
        case "/last": {
          const { signal, state: next } = evaluate(state.strategy, market, state);
          state = next;
          reply = lastText(state.strategy, next.history, signal);
          break;
        }
        case "/strategy": {
          const v = arg.trim().toUpperCase();
          if (v !== "B" && v !== "D") {
            reply = `Не распознал «${arg}». Используй /strategy B или /strategy D`;
            break;
          }
          state.strategy = v;
          reply = switchStrategyReply(v);
          break;
        }
        default:
          reply = `Не знаю команду «${cmd}». Подсказка: /help`;
      }
    } catch (e) {
      reply = `⚠️ Ошибка: ${(e as Error).message}`;
    }

    if (!state.chatId) state.chatId = String(chatId);
    await sendMessage(cfg.botToken, String(chatId), reply, msg.message_id);
  }

  state.offset = maxId;
  saveState(cfg.stateFile, state);
  console.log(`Обработано апдейтов: ${updates.length}, offset=${maxId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});