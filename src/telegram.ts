import { readFile, stat } from "node:fs/promises";

import { ConfigError, type Attachment, type ChannelContext, type ChannelDefinition, type SendRequest } from "@theopenbee/channel-sdk";

import { BotApi, DEFAULT_API_BASE_URL, TelegramError, isRetryableDownload, retryWithBackoff, sleep } from "./api.js";
import { AuthStore, codeMatches } from "./auth.js";
import { ButtonStore, buttonIndex, expiredText, inlineKeyboard, notOwnerText, scopeUser, selectedNote } from "./buttons.js";
import { COMMAND_LANGUAGES, botCommands, stripCommandTarget } from "./commands.js";
import {
  TELEGRAM_MESSAGE_LIMIT,
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
import type { CallbackQuery, Message, TelegramFile, Update, User, WebhookInfo } from "./types.js";

const DEFAULT_MAX_MEDIA_SIZE = 50 * 1024 * 1024;
const POLL_TIMEOUT_SECONDS = 50;
const POLL_REQUEST_TIMEOUT = (POLL_TIMEOUT_SECONDS + 20) * 1000;
const MIN_POLL_BACKOFF = 1000;
const MAX_POLL_BACKOFF = 30_000;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY = 500;

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
  let buttons: ButtonStore | undefined;
  let username = "";

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

  const fetchFile = async (fileId: string, signal: AbortSignal): Promise<{ data: Uint8Array; filePath: string }> => {
    const info = await api!.call<TelegramFile>("getFile", { file_id: fileId }, signal);
    if (!info.file_path) throw new Error("telegram returned no file path");
    return { data: await api!.download(info.file_path, cfg.maxMediaSize, signal), filePath: info.file_path };
  };

  const downloadAttachment = async (ctx: ChannelContext, m: Message, signal: AbortSignal): Promise<Attachment[]> => {
    const incoming = incomingFile(m);
    if (!incoming) return [];
    const { type, file, name } = incoming;
    try {
      if (file.file_size !== undefined && file.file_size > cfg.maxMediaSize) {
        throw new Error(`file larger than ${cfg.maxMediaSize} bytes`);
      }
      const { data, filePath } = await retryWithBackoff(() => fetchFile(file.file_id, signal), {
        attempts: DOWNLOAD_ATTEMPTS,
        delay: DOWNLOAD_RETRY_DELAY,
        signal,
        shouldRetry: (err) => {
          if (!isRetryableDownload(err)) return false;
          ctx.log.warn("attachment download failed, retrying", { name: name ?? "", error: errorText(err) });
          return true;
        },
      });
      const path = await ctx.saveMedia(data, extension(name, filePath));
      return [{ type, path, name }];
    } catch (err) {
      ctx.log.warn("attachment download failed", { name: name ?? "", error: errorText(err) });
      return [{ type, path: "", name }];
    }
  };

  const handleMessage = async (ctx: ChannelContext, update: Update, m: Message, signal: AbortSignal) => {
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

    const text = stripCommandTarget(m.text ?? m.caption ?? "", username);
    const attachments = await downloadAttachment(ctx, m, signal);
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

  const answerCallback = (ctx: ChannelContext, cq: CallbackQuery, text?: string) =>
    api!.call("answerCallbackQuery", text ? { callback_query_id: cq.id, text } : { callback_query_id: cq.id }).catch((err) => {
      ctx.log.warn("answer callback query failed", { error: errorText(err) });
    });

  const closeButtons = async (ctx: ChannelContext, m: Message, note?: string) => {
    const text = note && m.text ? `${m.text}\n\n${note}` : undefined;
    try {
      if (text && text.length <= TELEGRAM_MESSAGE_LIMIT) {
        await api!.call("editMessageText", { chat_id: m.chat.id, message_id: m.message_id, text });
      } else {
        await api!.call("editMessageReplyMarkup", { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: [] } });
      }
    } catch (err) {
      ctx.log.warn("remove buttons failed", { message_id: m.message_id, error: errorText(err) });
    }
  };

  const handleCallback = async (ctx: ChannelContext, update: Update, cq: CallbackQuery) => {
    const m = cq.message;
    const index = buttonIndex(cq.data);
    if (!m || !m.date || index === undefined) {
      await answerCallback(ctx, cq);
      return;
    }
    const entry = buttons?.get(m.chat.id, m.message_id);
    const text = entry?.texts[index];
    if (!entry || !text) {
      await answerCallback(ctx, cq, expiredText(ctx.language));
      await closeButtons(ctx, m);
      return;
    }
    const senderId = String(cq.from.id);
    if (scopeUser(entry.scope) !== senderId || (auth && !auth.isAuthorized(senderId))) {
      await answerCallback(ctx, cq, notOwnerText(ctx.language));
      return;
    }
    await buttons!.remove(m.chat.id, m.message_id);
    await answerCallback(ctx, cq);

    const threadId = topicThreadId(m);
    api!.call("sendChatAction", { chat_id: m.chat.id, message_thread_id: threadId, action: "typing" }).catch((err) => {
      ctx.log.debug("send typing action failed", { error: errorText(err) });
    });
    const context: Record<string, unknown> = { chat_type: m.chat.type, sender_name: [cq.from.first_name, cq.from.last_name].filter(Boolean).join(" ") };
    if (m.chat.title) context.chat_title = m.chat.title;
    if (cq.from.username) context.sender_username = cq.from.username;
    if (threadId) context.message_thread_id = threadId;
    ctx.dispatch({
      chat_id: String(m.chat.id),
      sender_id: senderId,
      session_scope: entry.scope,
      message_id: `button:${m.chat.id}:${m.message_id}`,
      text,
      raw: encodeRaw(update.update_id, m),
      context,
      time: Date.now(),
    });
    await closeButtons(ctx, m, selectedNote(ctx.language, entry.labels[index] ?? text));
  };

  const poll = async (ctx: ChannelContext, signal: AbortSignal) => {
    let offset = 0;
    let backoff = MIN_POLL_BACKOFF;
    while (!signal.aborted) {
      let updates: Update[];
      try {
        updates = await api!.call<Update[]>(
          "getUpdates",
          { offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ["message", "callback_query"] },
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
        try {
          if (update.message) await handleMessage(ctx, update, update.message, signal);
          else if (update.callback_query) await handleCallback(ctx, update, update.callback_query);
        } catch (err) {
          ctx.log.error("handle update failed", { error: errorText(err) });
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

  const deliver = async (ctx: ChannelContext, msg: SendRequest, target: Target, signal: AbortSignal): Promise<Message | undefined> => {
    let replyTo = target.replyTo;
    let last: Message | undefined;
    const chunks = chunkText(msg.content ?? "");
    const withButtons = msg.buttons?.length && buttons ? msg.buttons : undefined;
    for (const [i, chunk] of chunks.entries()) {
      if (signal.aborted) throw new Error("send cancelled");
      const keyboard = withButtons && i === chunks.length - 1 ? { inline_keyboard: inlineKeyboard(withButtons) } : undefined;
      last = await api!.call<Message>(
        "sendMessage",
        {
          chat_id: target.chatId,
          message_thread_id: target.threadId,
          text: chunk,
          reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
          reply_markup: keyboard,
        },
        signal,
      );
      replyTo = undefined;
      if (keyboard) {
        await buttons!.add(last.chat.id, last.message_id, msg.session_scope, withButtons!).catch((err) => {
          ctx.log.error("store buttons failed", { message_id: last!.message_id, error: errorText(err) });
        });
      }
    }
    if (msg.media) {
      if (signal.aborted) throw new Error("send cancelled");
      last = await sendMedia({ ...target, replyTo }, msg.media, signal);
    }
    return last;
  };

  return {
    capabilities: { buttons: true },
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
      username = me.username ?? "";
      const openedButtons = await ButtonStore.open(ctx.dataDir);
      buttons = openedButtons.store;
      if (openedButtons.problem) ctx.log.error("cannot read stored buttons, starting with none", { error: openedButtons.problem });
      if (cfg.authCode) {
        const opened = await AuthStore.open(ctx.dataDir);
        auth = opened.store;
        if (opened.problem) ctx.log.error("cannot read authorized users, starting with none", { error: opened.problem });
        if (opened.imported) ctx.log.info("imported authorized users from the built-in channel", { count: auth.size });
      }
      for (const language of COMMAND_LANGUAGES) {
        const params = { commands: botCommands(language, Boolean(cfg.authCode)), ...(language === "en" ? {} : { language_code: language }) };
        try {
          await api.call("setMyCommands", params);
        } catch (err) {
          ctx.log.error("failed to set bot commands", { language, error: errorText(err) });
        }
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
        sent = await deliver(ctx, msg, target, signal);
      } catch (err) {
        const to = err instanceof TelegramError ? err.parameters.migrate_to_chat_id : undefined;
        if (to === undefined) throw err;
        ctx.migrateChat(String(target.chatId), String(to));
        sent = await deliver(ctx, msg, { chatId: to }, signal);
      }
      return sent ? { platform_message_id: String(sent.message_id) } : {};
    },
  };
}
