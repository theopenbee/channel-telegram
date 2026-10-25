import { test } from "node:test";
import assert from "node:assert/strict";

import { BotApi, TelegramError } from "../dist/api.js";
import { TOKEN, startFakeTelegram } from "./fake-telegram.mjs";

test("call posts JSON and returns the result", async (t) => {
  const tg = await startFakeTelegram();
  t.after(() => tg.close());
  const api = new BotApi(TOKEN, tg.url + "/");
  const me = await api.call("getMe");
  assert.equal(me.username, "test_bot");
  await api.call("sendMessage", { chat_id: 1, text: "hi", message_thread_id: undefined });
  const sent = tg.calls.find((c) => c.method === "sendMessage");
  assert.deepEqual(sent.body, { chat_id: 1, text: "hi" });
});

test("errors carry code and parameters", async (t) => {
  const tg = await startFakeTelegram({
    sendMessage: () => ({ ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -100999 } }),
  });
  t.after(() => tg.close());
  const api = new BotApi(TOKEN, tg.url);
  const err = await api.call("sendMessage", { chat_id: -1, text: "x" }).catch((e) => e);
  assert.ok(err instanceof TelegramError);
  assert.equal(err.code, 400);
  assert.equal(err.parameters.migrate_to_chat_id, -100999);
  assert.doesNotMatch(err.message, new RegExp(TOKEN));

  const bad = await new BotApi("wrong", tg.url).call("getMe").catch((e) => e);
  assert.equal(bad.code, 401);
});

test("rate limits are retried after retry_after", async (t) => {
  let attempts = 0;
  const tg = await startFakeTelegram({
    sendMessage: () => (++attempts === 1 ? { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0 } } : undefined),
  });
  t.after(() => tg.close());
  const res = await new BotApi(TOKEN, tg.url).call("sendMessage", { chat_id: 1, text: "x" });
  assert.equal(attempts, 2);
  assert.ok(res.message_id > 0);
});

test("upload sends multipart with the file", async (t) => {
  const tg = await startFakeTelegram();
  t.after(() => tg.close());
  await new BotApi(TOKEN, tg.url).upload(
    "sendDocument",
    { chat_id: 5, message_thread_id: undefined, reply_parameters: { message_id: 3 } },
    { field: "document", name: "report.pdf", data: Buffer.from("PDFDATA") },
  );
  const call = tg.calls.find((c) => c.method === "sendDocument");
  assert.match(call.contentType, /multipart\/form-data/);
  assert.match(call.body, /name="chat_id"\r\n\r\n5\r\n/);
  assert.match(call.body, /name="reply_parameters"\r\n\r\n\{"message_id":3\}\r\n/);
  assert.match(call.body, /name="document"; filename="report.pdf"/);
  assert.match(call.body, /PDFDATA/);
  assert.doesNotMatch(call.body, /message_thread_id/);
});

test("download enforces the size limit", async (t) => {
  const tg = await startFakeTelegram();
  t.after(() => tg.close());
  tg.files.set("files/a", Buffer.from("0123456789"));
  const api = new BotApi(TOKEN, tg.url);
  assert.equal(Buffer.from(await api.download("files/a", 10)).toString(), "0123456789");
  await assert.rejects(api.download("files/a", 9), /larger than 9 bytes/);
  await assert.rejects(api.download("files/missing", 10), /HTTP 404/);
});
