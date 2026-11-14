import type { BotCommand } from "./types.js";

type Language = "en" | "zh";

const DESCRIPTIONS: Record<Language, Record<string, string>> = {
  en: {
    stop: "Stop the current reply, or a worker's tasks",
    clear: "Reset this chat's context",
    status: "Show contexts and running tasks",
    list: "List workers",
    engine: "Show or switch the default engine",
    cancel: "List or cancel scheduled tasks",
    auth: "Authorize with the access code",
  },
  zh: {
    stop: "停止当前回复，或某个员工的任务",
    clear: "重置这个对话的上下文",
    status: "查看上下文和运行中的任务",
    list: "列出员工",
    engine: "查看或切换默认引擎",
    cancel: "查看或取消定时任务",
    auth: "用授权码授权",
  },
};

const COMMANDS = ["stop", "clear", "status", "list", "engine", "cancel"];

export const COMMAND_LANGUAGES: Language[] = ["en", "zh"];

export function botCommands(language: Language, withAuth: boolean): BotCommand[] {
  const names = withAuth ? [...COMMANDS, "auth"] : COMMANDS;
  return names.map((command) => ({ command, description: DESCRIPTIONS[language][command] }));
}

export function stripCommandTarget(text: string, username: string): string {
  if (!username || !text.startsWith("/")) return text;
  const match = /^(\/\w+)@(\w+)(?=\s|$)/.exec(text);
  if (!match || match[2].toLowerCase() !== username.toLowerCase()) return text;
  return match[1] + text.slice(match[0].length);
}
