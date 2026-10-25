import type { AttachmentType } from "@theopenbee/channel-sdk";

import type { FileRef, Message } from "./types.js";

export const TELEGRAM_MESSAGE_LIMIT = 4096;

export function chunkText(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const newline = window.lastIndexOf("\n");
    let cut = newline > 0 ? newline + 1 : limit;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export function topicThreadId(m: Pick<Message, "is_topic_message" | "message_thread_id">): number | undefined {
  return m.is_topic_message && m.message_thread_id ? m.message_thread_id : undefined;
}

export function sessionScope(senderId: number, threadId: number | undefined): string {
  return threadId ? `${threadId}:${senderId}` : String(senderId);
}

export interface Target {
  chatId: number | string;
  threadId?: number;
  replyTo?: number;
}

export function parseChatId(chatId: string): number | string {
  return /^-?\d+$/.test(chatId) ? Number(chatId) : chatId;
}

export function targetFromSession(chatId: string, scope: string): Target {
  const parts = scope.split(":");
  const target: Target = { chatId: parseChatId(chatId) };
  if (parts.length === 2 && /^\d+$/.test(parts[0])) target.threadId = Number(parts[0]);
  return target;
}

interface RawMessage {
  message_id?: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  chat?: { id?: number };
}

export function encodeRaw(updateId: number, m: Message): string {
  const message: RawMessage = { message_id: m.message_id, chat: { id: m.chat.id } };
  if (m.message_thread_id) message.message_thread_id = m.message_thread_id;
  if (m.is_topic_message) message.is_topic_message = true;
  return JSON.stringify({ update_id: updateId, message });
}

export function targetFromRaw(raw: string | undefined): Target | undefined {
  if (!raw) return undefined;
  let parsed: { message?: RawMessage };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const m = parsed?.message;
  if (typeof m?.chat?.id !== "number" || typeof m.message_id !== "number") return undefined;
  const target: Target = { chatId: m.chat.id, replyTo: m.message_id };
  const threadId = topicThreadId(m);
  if (threadId) target.threadId = threadId;
  return target;
}

export interface IncomingFile {
  type: AttachmentType;
  file: FileRef;
  name?: string;
}

export function incomingFile(m: Message): IncomingFile | undefined {
  if (m.photo && m.photo.length > 0) return { type: "image", file: m.photo[m.photo.length - 1], name: "photo.jpg" };
  if (m.document) return { type: "document", file: m.document, name: m.document.file_name };
  if (m.audio) return { type: "audio", file: m.audio, name: m.audio.file_name };
  if (m.voice) return { type: "audio", file: m.voice, name: "voice.ogg" };
  if (m.video) return { type: "video", file: m.video, name: m.video.file_name ?? "video.mp4" };
  if (m.video_note) return { type: "video", file: m.video_note, name: "video_note.mp4" };
  if (m.sticker) return { type: "sticker", file: m.sticker };
  return undefined;
}

export function extension(...names: (string | undefined)[]): string {
  for (const name of names) {
    if (!name) continue;
    const base = name.slice(name.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    if (dot > 0) return base.slice(dot);
  }
  return "";
}

export type SendMethod = "sendPhoto" | "sendVideo" | "sendAudio" | "sendVoice" | "sendDocument";

const methodByExtension: Record<string, SendMethod> = {
  ".jpg": "sendPhoto",
  ".jpeg": "sendPhoto",
  ".png": "sendPhoto",
  ".gif": "sendPhoto",
  ".webp": "sendPhoto",
  ".mp4": "sendVideo",
  ".mov": "sendVideo",
  ".avi": "sendVideo",
  ".mp3": "sendAudio",
  ".wav": "sendAudio",
  ".flac": "sendAudio",
  ".m4a": "sendAudio",
  ".aac": "sendAudio",
  ".ogg": "sendVoice",
  ".opus": "sendVoice",
};

export const uploadField: Record<SendMethod, string> = {
  sendPhoto: "photo",
  sendVideo: "video",
  sendAudio: "audio",
  sendVoice: "voice",
  sendDocument: "document",
};

export function sendMethodFor(name: string): SendMethod {
  return methodByExtension[extension(name).toLowerCase()] ?? "sendDocument";
}

export function parseAuthCommand(text: string | undefined): { code?: string } | undefined {
  const parts = (text ?? "").trim().split(/\s+/);
  if (parts[0] !== "/auth" && !parts[0].startsWith("/auth@")) return undefined;
  return parts.length > 1 ? { code: parts[1] } : {};
}

export function senderName(m: Message): string {
  return [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ");
}
