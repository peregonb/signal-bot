export interface BotMinHold {
  lastChangeDate?: string;
  holding?: string;
}

export interface BotState {
  strategy: "B" | "D";
  chatId?: string;
  lastDailyDate?: string;
  minHold?: BotMinHold;
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