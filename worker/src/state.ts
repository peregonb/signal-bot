export interface BotMinHold {
  lastChangeDate?: string;
  holding?: string;
}

export interface BotState {
  strategy: "B" | "D" | "F";
  chatId?: string;
  lastDailyDate?: string;
  // Что ушло в последнем дневном отчёте — для сверки Bybit → Binance (cron 02:30 UTC).
  lastDaily?: { date: string; position: string; provisional: boolean; checked?: boolean };
  minHold?: BotMinHold;
  // min_hold ДО первого расчёта за дату: повторный расчёт той же даты (например, когда
  // свеча Bybit заменилась архивом Binance) идёт от него, а не от уже обновлённого.
  minHoldBase?: { date: string; minHold?: BotMinHold };
  history: { date: string; position: string }[];
}

export function emptyState(): BotState {
  return { strategy: "D", history: [] };
}

const STATE_KEY = "state";

export async function loadState(kv: KVNamespace): Promise<BotState> {
  try {
    const raw = await kv.get(STATE_KEY);
    if (raw) return { ...emptyState(), ...(JSON.parse(raw) as BotState) };
  } catch {
    // повреждённые данные → чистый старт
  }
  return emptyState();
}

export async function saveState(kv: KVNamespace, state: BotState): Promise<void> {
  await kv.put(STATE_KEY, JSON.stringify(state));
}