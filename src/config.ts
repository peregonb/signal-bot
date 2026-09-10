import "dotenv/config";

export interface Config {
  botToken: string;
  chatId: string;
  allowedIds: string[];
  dataApiBase: string;
  signalCandles: number;
  stateFile: string;
}

export function loadConfig(): Config {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID ?? "",
    allowedIds: (process.env.TELEGRAM_ALLOWED_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    dataApiBase: process.env.BINANCE_DATA_API ?? "https://data-api.binance.vision",
    signalCandles: Number(process.env.SIGNAL_CANDLES ?? 320),
    stateFile: process.env.STATE_FILE ?? "state/bot-state.json",
  };
}