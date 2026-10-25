import { readFile, stat } from "node:fs/promises";

import { ConfigError, type Attachment, type ChannelContext, type ChannelDefinition, type SendRequest } from "@theopenbee/channel-sdk";

import { BotApi, DEFAULT_API_BASE_URL, TelegramError, sleep } from "./api.js";
import { AuthStore, codeMatches } from "./auth.js";
import {
  chunkText,
  encodeRaw,
  extension,
  incomingFile,
  parseAuthCommand,
  sendMethodFor,
  senderName,
  sessionScope,
  targetFromRaw,
  targetFromSession,
  topicThreadId,
  uploadField,
  type Target,
} from "./helpers.js";
import type { Message, TelegramFile, Update, User, WebhookInfo } from "./types.js";

const DEFAULT_MAX_MEDIA_SIZE = 50 * 1024 * 1024;
const POLL_TIMEOUT_SECONDS = 50;
const POLL_REQUEST_TIMEOUT = (POLL_TIMEOUT_SECONDS + 20) * 1000;
const MIN_POLL_BACKOFF = 1000;
const MAX_POLL_BACKOFF = 30_000;

const BOT_COMMANDS = [{ command: "clear", description: "Clear conversation history" }];

interface TelegramConfig {
  token: string;
  authCode: string;
  maxMediaSize: number;
  apiBaseUrl: string;
}

function readConfig(raw: Record<string, unknown>): TelegramConfig {
  const token = typeof raw.token === "string" ? raw.token.trim() : "";
  if (!token) throw new ConfigError("token is required");
  const authCode = typeof raw.auth_code === "string" ? raw.auth_code.trim() : "";
  const maxMediaSize = typeof raw.max_media_size === "number" && raw.max_media_size > 0 ? raw.max_media_size : DEFAULT_MAX_MEDIA_SIZE;
  const apiBaseUrl = typeof raw.api_base_url === "string" && raw.api_base_url.trim() ? raw.api_base_url.trim() : DEFAULT_API_BASE_URL;
  return { token, authCode, maxMediaSize, apiBaseUrl };
}

function isTokenRejected(err: unknown): boolean {
  return err instanceof TelegramError && (err.code === 401 || err.code === 404);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createTelegramChannel(): ChannelDefinition {
  let api: BotApi | undefined;
  let cfg: TelegramConfig;
  let auth: AuthStore | undefined;

  const reply = async (ctx: ChannelContext, m: Message, text: string) => {
    try {
      await api!.call("sendMessage", {
        chat_id: m.chat.id,
        message_thread_id: topicThreadId(m),
        text,
        reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true },
      });
    } catch (err) {
      ctx.log.warn("send auth reply failed", { error: errorText(err) });
    }
  };

  const handleAuth = async (ctx: ChannelContext, m: Message, from: User): Promise<boolean> => {
    if (!auth) return false;
    const senderId = String(from.id);
    const command = parseAuthCommand(m.text);
    if (command) {
      if (command.code === undefined) {
        await reply(ctx, m, "Usage: /auth <code>");
      } else if (codeMatches(command.code, cfg.authCode)) {
        await auth.authorize(senderId);
        ctx.log.info("user authorized", { sender_id: senderId });
        await reply(ctx, m, "✅ Authorization successful.");
      } else {
        ctx.log.warn("auth failed: invalid code", { sender_id: senderId });
        await reply(ctx, m, "❌ Invalid authorization code.");
      }
      return true;
    }
    if (auth.isAuthorized(senderId)) return false;
    if (auth.shouldHint(senderId)) await reply(ctx, m, "🔒 Unauthorized. Please use /auth <code> to authenticate.");
    return true;
  };

  const downloadAttachment = async (ctx: ChannelContext, m: Message): Promise<Attachment[]> => {
    const incoming = incomingFile(m);
    if (!incoming) return [];
    const { type, file, name } = incoming;
    try {
      if (file.file_size !== undefined && file.file_size > cfg.maxMediaSize) {
        throw new Error(`file larger than ${cfg.maxMediaSize} bytes`);
      }
      const info = await api!.call<TelegramFile>("getFile", { file_id: file.file_id });
      if (!info.file_path) throw new Error("telegram returned no file path");
      const data = await api!.download(info.file_path, cfg.maxMediaSize);
      const path = await ctx.saveMedia(data, extension(name, info.file_path));
      return [{ type, path, name }];
    } catch (err) {
      ctx.log.warn("attachment download failed", { name: name ?? "", error: errorText(err) });
      return [{ type, path: "", name }];
    }
  };

  const handleMessage = async (ctx: ChannelContext, update: Update, m: Message) => {
    if (m.migrate_to_chat_id) {
      ctx.migrateChat(String(m.chat.id), String(m.migrate_to_chat_id));
      return;
    }
    if (m.migrate_from_chat_id) {
      ctx.migrateChat(String(m.migrate_from_chat_id), String(m.chat.id));
      return;
    }
    const from = m.from;
    if (!from) return;
    if (await handleAuth(ctx, m, from)) return;

    const threadId = topicThreadId(m);
    api!.call("sendChatAction", { chat_id: m.chat.id, message_thread_id: threadId, action: "typing" }).catch((err) => {
      ctx.log.debug("send typing action failed", { error: errorText(err) });
    });

    const text = m.text ?? m.caption ?? "";
    const attachments = await downloadAttachment(ctx, m);
    if (!text && attachments.length === 0) return;

    const context: Record<string, unknown> = { chat_type: m.chat.type, sender_name: senderName(m) };
    if (m.chat.title) context.chat_title = m.chat.title;
    if (from.username) context.sender_username = from.username;
    if (threadId) context.message_thread_id = threadId;

    ctx.dispatch({
      chat_id: String(m.chat.id),
      sender_id: String(from.id),
      session_scope: sessionScope(from.id, threadId),
      message_id: `${update.update_id}:${m.message_id}`,
      text,
      attachments,
      raw: encodeRaw(update.update_id, m),
      context,
      time: m.date * 1000,
    });
  };

  const poll = async (ctx: ChannelContext, signal: AbortSignal) => {
    let offset = 0;
    let backoff = MIN_POLL_BACKOFF;
    while (!signal.aborted) {
      let updates: Update[];
      try {
        updates = await api!.call<Update[]>(
          "getUpdates",
          { offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ["message"] },
          signal,
          POLL_REQUEST_TIMEOUT,
        );
        backoff = MIN_POLL_BACKOFF;
      } catch (err) {
        if (signal.aborted) return;
        if (isTokenRejected(err)) throw new Error("Telegram rejected the bot token");
        ctx.log.warn("get updates failed", { error: errorText(err), retry_in_ms: backoff });
        await sleep(backoff, signal).catch(() => undefined);
        backoff = Math.min(backoff * 2, MAX_POLL_BACKOFF);
        continue;
      }
      for (const update of updates) {
        offset = update.update_id + 1;
        if (!update.message) continue;
        try {
          await handleMessage(ctx, update, update.message);
        } catch (err) {
          ctx.log.error("handle message failed", { error: errorText(err) });
        }
      }
    }
  };

  const sendMedia = async (target: Target, media: NonNullable<SendRequest["media"]>, signal: AbortSignal): Promise<Message> => {
    const info = await stat(media.path);
    if (info.size > cfg.maxMediaSize) throw new Error(`file too large: ${info.size} bytes (max ${cfg.maxMediaSize})`);
    const data = await readFile(media.path);
    const params = {
      chat_id: target.chatId,
      message_thread_id: target.threadId,
      reply_parameters: target.replyTo ? { message_id: target.replyTo, allow_sending_without_reply: true } : undefined,
    };
    const method = sendMethodFor(media.name);
    try {
      return await api!.upload<Message>(method, params, { field: uploadField[method], name: media.name, data }, signal);
    } catch (err) {
      if (method !== "sendPhoto" || !(err instanceof TelegramError) || err.code !== 400) throw err;
      return api!.upload<Message>("sendDocument", params, { field: "document", name: media.name, data }, signal);
    }
  };

  const deliver = async (msg: SendRequest, target: Target, signal: AbortSignal): Promise<Message | undefined> => {
    let replyTo = target.replyTo;
    let last: Message | undefined;
    for (const chunk of chunkText(msg.content ?? "")) {
      if (signal.aborted) throw new Error("send cancelled");
      last = await api!.call<Message>(
        "sendMessage",
        {
          chat_id: target.chatId,
          message_thread_id: target.threadId,
          text: chunk,
          reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
        },
        signal,
      );
      replyTo = undefined;
    }
    if (msg.media) {
      if (signal.aborted) throw new Error("send cancelled");
      last = await sendMedia({ ...target, replyTo }, msg.media, signal);
    }
    return last;
  };

  return {
    async start(ctx) {
      cfg = readConfig(ctx.config);
      api = new BotApi(cfg.token, cfg.apiBaseUrl);
      let me: User;
      try {
        me = await api.call<User>("getMe");
      } catch (err) {
        if (isTokenRejected(err)) throw new ConfigError("Telegram rejected the bot token");
        throw err;
      }
      if (cfg.authCode) {
        const opened = await AuthStore.open(ctx.dataDir);
        auth = opened.store;
        if (opened.problem) ctx.log.error("cannot read authorized users, starting with none", { error: opened.problem });
        if (opened.imported) ctx.log.info("imported authorized users from the built-in channel", { count: auth.size });
      }
      try {
        await api.call("setMyCommands", { commands: BOT_COMMANDS });
      } catch (err) {
        ctx.log.error("failed to set bot commands", { error: errorText(err) });
      }
      const webhook = await api.call<WebhookInfo>("getWebhookInfo");
      if (webhook.url) {
        ctx.log.warn("removing webhook so long polling can receive updates");
        await api.call("deleteWebhook");
      }

      const controller = new AbortController();
      const polling = poll(ctx, controller.signal);
      polling.catch((err) => {
        process.stderr.write(`fatal: ${errorText(err)}\n`);
        process.exit(1);
      });
      ctx.log.info("telegram bot connected", { username: me.username ?? "", id: me.id });
      return {
        stop: async () => {
          controller.abort();
          await polling.catch(() => undefined);
        },
      };
    },

    async send(msg: SendRequest, ctx, signal) {
      if (!api) throw new Error("telegram bot is not started");
      const target = (!msg.proactive && targetFromRaw(msg.reply_to?.raw)) || targetFromSession(msg.chat_id, msg.session_scope);
      let sent: Message | undefined;
      try {
        sent = await deliver(msg, target, signal);
      } catch (err) {
        const to = err instanceof TelegramError ? err.parameters.migrate_to_chat_id : undefined;
        if (to === undefined) throw err;
        ctx.migrateChat(String(target.chatId), String(to));
        sent = await deliver(msg, { chatId: to }, signal);
      }
      return sent ? { platform_message_id: String(sent.message_id) } : {};
    },
  };
}
