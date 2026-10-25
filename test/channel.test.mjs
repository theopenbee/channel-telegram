import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { TOKEN, startFakeTelegram } from "./fake-telegram.mjs";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function startPlugin(home) {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const waiters = [];
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  let nextId = 1;
  return {
    child,
    exited,
    stderr: () => stderr,
    waitFor(match, ms = 5000) {
      const found = messages.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; stderr: ${stderr}`)), ms);
        waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
    request(method, params) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return this.waitFor((m) => m.id === id);
    },
  };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "tg-home-"));
  const dataDir = mkdtempSync(join(tmpdir(), "tg-data-"));
  const mediaDir = mkdtempSync(join(tmpdir(), "tg-media-"));
  return { home, dataDir, mediaDir };
}

async function initialized(t, tg, config = {}, dirs = setup()) {
  const p = startPlugin(dirs.home);
  t.after(async () => {
    p.child.stdin.end();
    await p.exited;
  });
  const res = await p.request("initialize", {
    protocol_version: 1,
    openbee_version: "test",
    channel_id: "telegram",
    language: "en",
    bot_name: "Bot",
    config: { token: TOKEN, api_base_url: tg.url, max_media_size: 1024, ...config },
    data_dir: dirs.dataDir,
    media_dir: dirs.mediaDir,
  });
  return { p, res, dirs };
}

const user = { id: 789, is_bot: false, first_name: "Ada", last_name: "L", username: "ada" };
const group = { id: -100456, type: "supergroup", title: "Team" };

test("rejected token is a config error", async (t) => {
  const tg = await startFakeTelegram();
  t.after(() => tg.close());
  const { p, res } = await initialized(t, tg, { token: "999:bad" });
  assert.equal(res.error.code, -32001);
  assert.match(res.error.message, /rejected the bot token/);
  assert.equal(await p.exited, 1);
});

test("startup registers commands and dispatches topic messages", async (t) => {
  const tg = await startFakeTelegram();
  t.after(() => tg.close());
  const { p, res, dirs } = await initialized(t, tg);
  assert.deepEqual(res.result, { protocol_version: 1 });
  const commands = await tg.waitFor((c) => c.method === "setMyCommands");
  assert.deepEqual(commands.body.commands, [{ command: "clear", description: "Clear conversation history" }]);

  tg.files.set("files/big", Buffer.alloc(10));
  tg.push({
    update_id: 10,
    message: { message_id: 3, message_thread_id: 5, is_topic_message: true, date: 1700000000, chat: group, from: user, text: "hello" },
  });
  tg.push({
    update_id: 11,
    message: { message_id: 4, date: 1700000001, chat: group, from: user, caption: "see file", document: { file_id: "big", file_name: "a.txt" } },
  });
  tg.push({
    update_id: 12,
    message: { message_id: 5, date: 1700000002, chat: group, from: user, document: { file_id: "huge", file_name: "b.zip", file_size: 4096 } },
  });

  const first = await p.waitFor((m) => m.method === "inbound" && m.params.message_id === "10:3");
  assert.deepEqual(first.params, {
    chat_id: "-100456",
    sender_id: "789",
    session_scope: "5:789",
    message_id: "10:3",
    text: "hello",
    attachments: [],
    raw: JSON.stringify({ update_id: 10, message: { message_id: 3, chat: { id: -100456 }, message_thread_id: 5, is_topic_message: true } }),
    context: { chat_type: "supergroup", sender_name: "Ada L", chat_title: "Team", sender_username: "ada", message_thread_id: 5 },
    time: 1700000000000,
  });
  const typing = await tg.waitFor((c) => c.method === "sendChatAction");
  assert.deepEqual(typing.body, { chat_id: -100456, message_thread_id: 5, action: "typing" });

  const withFile = await p.waitFor((m) => m.method === "inbound" && m.params.message_id === "11:4");
  assert.equal(withFile.params.session_scope, "789");
  assert.equal(withFile.params.text, "see file");
  const [att] = withFile.params.attachments;
  assert.equal(att.type, "document");
  assert.equal(att.name, "a.txt");
  assert.equal(dirname(att.path), dirs.mediaDir);
  assert.match(att.path, /\.txt$/);
  assert.equal(readFileSync(att.path).length, 10);

  const tooBig = await p.waitFor((m) => m.method === "inbound" && m.params.message_id === "12:5");
  assert.deepEqual(tooBig.params.attachments, [{ type: "document", path: "", name: "b.zip" }]);
  assert.equal(tooBig.params.text, "");
});

test("group upgrades emit migrate_chat", async (t) => {
  const tg = await startFakeTelegram();
  t.after(() => tg.close());
  const { p } = await initialized(t, tg);
  tg.push({ update_id: 20, message: { message_id: 1, date: 1, chat: { id: -123, type: "group" }, from: user, migrate_to_chat_id: -100999 } });
  tg.push({ update_id: 21, message: { message_id: 1, date: 1, chat: { id: -100999, type: "supergroup" }, from: user, migrate_from_chat_id: -123 } });
  const first = await p.waitFor((m) => m.method === "migrate_chat");
  const second = await p.waitFor((m) => m.method === "migrate_chat" && m !== first);
  assert.deepEqual(first.params, { from_chat_id: "-123", to_chat_id: "-100999" });
  assert.deepEqual(second.params, { from_chat_id: "-123", to_chat_id: "-100999" });
});

test("auth code gates users and imports the built-in list", async (t) => {
  const tg = await startFakeTelegram();
  t.after(() => tg.close());
  const dirs = setup();
  const legacyDir = join(dirs.home, ".openbee", "telegram");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "authorized_users.json"), JSON.stringify(["111"]));
  const { p } = await initialized(t, tg, { auth_code: "s3cret" }, dirs);
  const chat = { id: 222, type: "private" };
  const stranger = { id: 222, is_bot: false, first_name: "Bob" };

  tg.push({ update_id: 30, message: { message_id: 1, date: 1, chat, from: stranger, text: "hi" } });
  tg.push({ update_id: 31, message: { message_id: 2, date: 1, chat, from: stranger, text: "hi again" } });
  tg.push({ update_id: 32, message: { message_id: 3, date: 1, chat, from: stranger, text: "/auth nope" } });
  tg.push({ update_id: 33, message: { message_id: 4, date: 1, chat, from: stranger, text: "/auth s3cret" } });
  tg.push({ update_id: 34, message: { message_id: 5, date: 1, chat, from: stranger, text: "now ok" } });
  tg.push({ update_id: 35, message: { message_id: 6, date: 1, chat: { id: 111, type: "private" }, from: { id: 111, is_bot: false, first_name: "Old" }, text: "legacy" } });

  await p.waitFor((m) => m.method === "inbound" && m.params.text === "now ok");
  await p.waitFor((m) => m.method === "inbound" && m.params.text === "legacy");
  const replies = tg.calls.filter((c) => c.method === "sendMessage").map((c) => c.body.text);
  assert.deepEqual(replies, ["🔒 Unauthorized. Please use /auth <code> to authenticate.", "❌ Invalid authorization code.", "✅ Authorization successful."]);
  assert.deepEqual(JSON.parse(readFileSync(join(dirs.dataDir, "authorized_users.json"), "utf8")), ["111", "222"]);
});

test("send replies in topic, splits long text and uploads media", async (t) => {
  const tg = await startFakeTelegram();
  t.after(() => tg.close());
  const { p, dirs } = await initialized(t, tg);
  const file = join(dirs.mediaDir, "chart.png");
  writeFileSync(file, Buffer.from("PNG"));
  const raw = JSON.stringify({ update_id: 10, message: { message_id: 3, chat: { id: -100456 }, message_thread_id: 5, is_topic_message: true } });

  const res = await p.request("send", {
    session_key: "telegram:-100456:5:789",
    chat_id: "-100456",
    session_scope: "5:789",
    proactive: false,
    reply_to: { message_id: "10:3", raw },
    content: "a".repeat(5000),
    media: { path: file, name: "chart.png" },
  });
  assert.ok(res.result.platform_message_id);
  const texts = tg.calls.filter((c) => c.method === "sendMessage");
  assert.equal(texts.length, 2);
  assert.deepEqual(texts[0].body.reply_parameters, { message_id: 3, allow_sending_without_reply: true });
  assert.equal(texts[0].body.message_thread_id, 5);
  assert.equal(texts[1].body.reply_parameters, undefined);
  const photo = tg.calls.find((c) => c.method === "sendPhoto");
  assert.match(photo.body, /name="message_thread_id"\r\n\r\n5\r\n/);
  assert.doesNotMatch(photo.body, /reply_parameters/);
});

test("proactive send targets the session topic without quoting", async (t) => {
  const tg = await startFakeTelegram();
  t.after(() => tg.close());
  const { p } = await initialized(t, tg);
  await p.request("send", {
    session_key: "telegram:-100456:5:789",
    chat_id: "-100456",
    session_scope: "5:789",
    proactive: true,
    reply_to: { raw: JSON.stringify({ update_id: 1, message: { message_id: 9, chat: { id: -100456 } } }) },
    content: "scheduled result",
  });
  const sent = tg.calls.find((c) => c.method === "sendMessage");
  assert.deepEqual(sent.body, { chat_id: -100456, message_thread_id: 5, text: "scheduled result" });
});

test("send follows a group migrated to a supergroup", async (t) => {
  let first = true;
  const tg = await startFakeTelegram({
    sendMessage: (call) => {
      if (call.body.chat_id === -123 && first) {
        first = false;
        return { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -100999 } };
      }
      return undefined;
    },
  });
  t.after(() => tg.close());
  const { p } = await initialized(t, tg);
  const res = await p.request("send", { session_key: "telegram:-123:789", chat_id: "-123", session_scope: "789", proactive: true, content: "hi" });
  assert.ok(res.result);
  const note = await p.waitFor((m) => m.method === "migrate_chat");
  assert.deepEqual(note.params, { from_chat_id: "-123", to_chat_id: "-100999" });
  const sends = tg.calls.filter((c) => c.method === "sendMessage").map((c) => c.body.chat_id);
  assert.deepEqual(sends, [-123, -100999]);
});

test("photos Telegram rejects are sent as documents", async (t) => {
  const tg = await startFakeTelegram({ sendPhoto: () => ({ ok: false, error_code: 400, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" }) });
  t.after(() => tg.close());
  const { p, dirs } = await initialized(t, tg);
  const file = join(dirs.mediaDir, "wide.png");
  writeFileSync(file, Buffer.from("PNG"));
  const res = await p.request("send", { session_key: "telegram:1:1", chat_id: "1", session_scope: "1", proactive: true, media: { path: file, name: "wide.png" } });
  assert.ok(res.result.platform_message_id);
  assert.ok(tg.calls.find((c) => c.method === "sendDocument"));
});

test("oversized outbound media fails the send", async (t) => {
  const tg = await startFakeTelegram();
  t.after(() => tg.close());
  const { p, dirs } = await initialized(t, tg);
  const file = join(dirs.mediaDir, "big.bin");
  writeFileSync(file, Buffer.alloc(2048));
  const res = await p.request("send", { session_key: "telegram:1:1", chat_id: "1", session_scope: "1", proactive: true, media: { path: file, name: "big.bin" } });
  assert.match(res.error.message, /file too large/);
});
