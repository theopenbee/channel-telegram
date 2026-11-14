import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Button } from "@theopenbee/channel-sdk";

import type { InlineKeyboardButton } from "./types.js";

export const BUTTONS_FILE = "buttons.json";
export const MAX_STORED_MESSAGES = 1000;
export const MAX_STORED_AGE = 90 * 24 * 60 * 60 * 1000;
const DATA_PREFIX = "ob:";
const SHORT_LABEL = 10;
const SHORT_ROW = 3;

export interface StoredButtons {
  scope: string;
  labels: string[];
  texts: string[];
  at: number;
}

function isStored(value: unknown): value is StoredButtons {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.scope === "string" &&
    typeof v.at === "number" &&
    Array.isArray(v.labels) &&
    Array.isArray(v.texts) &&
    v.labels.every((l) => typeof l === "string") &&
    v.texts.every((t) => typeof t === "string")
  );
}

export class ButtonStore {
  private readonly entries = new Map<string, StoredButtons>();
  private writing: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string) {}

  static async open(dataDir: string): Promise<{ store: ButtonStore; problem?: string }> {
    const store = new ButtonStore(join(dataDir, BUTTONS_FILE));
    let data: string;
    try {
      data = await readFile(store.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { store };
      return { store, problem: err instanceof Error ? err.message : String(err) };
    }
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed !== "object" || parsed === null) throw new Error(`${store.path} must contain a JSON object`);
      for (const [key, value] of Object.entries(parsed)) if (isStored(value)) store.entries.set(key, value);
    } catch (err) {
      return { store, problem: err instanceof Error ? err.message : String(err) };
    }
    return { store };
  }

  get size(): number {
    return this.entries.size;
  }

  get(chatId: number | string, messageId: number): StoredButtons | undefined {
    return this.entries.get(`${chatId}:${messageId}`);
  }

  add(chatId: number | string, messageId: number, scope: string, buttons: Button[], now = Date.now()): Promise<void> {
    this.entries.set(`${chatId}:${messageId}`, {
      scope,
      labels: buttons.map((b) => b.label),
      texts: buttons.map((b) => b.text),
      at: now,
    });
    this.prune(now);
    return this.save();
  }

  remove(chatId: number | string, messageId: number): Promise<void> {
    if (!this.entries.delete(`${chatId}:${messageId}`)) return Promise.resolve();
    return this.save();
  }

  private prune(now: number) {
    for (const [key, entry] of this.entries) {
      if (now - entry.at > MAX_STORED_AGE) this.entries.delete(key);
    }
    while (this.entries.size > MAX_STORED_MESSAGES) this.entries.delete(this.entries.keys().next().value!);
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(Object.fromEntries(this.entries));
    const tmp = `${this.path}.tmp`;
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(join(this.path, ".."), { recursive: true });
        await writeFile(tmp, snapshot, { mode: 0o600 });
        await rename(tmp, this.path);
      });
    return this.writing;
  }
}

export function inlineKeyboard(buttons: Button[]): InlineKeyboardButton[][] {
  const keys = buttons.map((b, i) => ({ text: b.label, callback_data: DATA_PREFIX + i }));
  const perRow = buttons.every((b) => [...b.label].length <= SHORT_LABEL) ? SHORT_ROW : 1;
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < keys.length; i += perRow) rows.push(keys.slice(i, i + perRow));
  return rows;
}

export function buttonIndex(data: string | undefined): number | undefined {
  if (!data?.startsWith(DATA_PREFIX)) return undefined;
  const rest = data.slice(DATA_PREFIX.length);
  return /^\d+$/.test(rest) ? Number(rest) : undefined;
}

export function scopeUser(scope: string): string {
  return scope.slice(scope.lastIndexOf(":") + 1);
}

export function selectedNote(language: string, label: string): string {
  return language === "zh" ? `✓ 已选择：${label}` : `✓ Selected: ${label}`;
}

export function notOwnerText(language: string): string {
  return language === "zh" ? "只有发起人可以选择" : "Only the person who asked can choose";
}

export function expiredText(language: string): string {
  return language === "zh" ? "这个按钮已失效" : "This button has expired";
}
