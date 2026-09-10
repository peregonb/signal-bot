import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

export interface BotMinHold {
  lastChangeDate?: string;
  holding?: string;
}

export interface BotState {
  strategy: "B" | "D";
  offset: number;
  chatId?: string;
  lastDailyDate?: string;
  minHold?: BotMinHold;
  history: { date: string; position: string }[];
}

export function emptyState(): BotState {
  return { strategy: "D", offset: 0, history: [] };
}

export function loadState(file: string): BotState {
  try {
    return { ...emptyState(), ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return emptyState();
  }
}

export function saveState(file: string, state: BotState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}