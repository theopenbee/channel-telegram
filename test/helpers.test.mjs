import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chunkText,
  encodeRaw,
  extension,
  incomingFile,
  parseAuthCommand,
  parseChatId,
  sendMethodFor,
  sessionScope,
  targetFromRaw,
  targetFromSession,
  topicThreadId,
} from "../dist/helpers.js";

test("chunkText splits at 4096 and prefers newlines", () => {
  const text = "a".repeat(9000);
  const chunks = chunkText(text);
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.length <= 4096);
  assert.equal(chunks.join(""), text);

  const first = "x".repeat(4000) + "\n";
  assert.deepEqual(chunkText(first + "y".repeat(500)), [first, "y".repeat(500)]);
  assert.deepEqual(chunkText(""), []);
});

test("chunkText never splits a surrogate pair", () => {
  const text = "a".repeat(4095) + "😀" + "b";
  const chunks = chunkText(text);
  assert.equal(chunks.join(""), text);
  for (const c of chunks) assert.doesNotMatch(c, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
});

test("session scope keeps the built-in key layout", () => {
  assert.equal(sessionScope(789, undefined), "789");
  assert.equal(sessionScope(789, 5), "5:789");
});

test("topicThreadId only counts forum topics", () => {
  assert.equal(topicThreadId({ is_topic_message: true, message_thread_id: 5 }), 5);
  assert.equal(topicThreadId({ message_thread_id: 5 }), undefined);
  assert.equal(topicThreadId({}), undefined);
});

test("targetFromSession reads chat and topic", () => {
  assert.deepEqual(targetFromSession("-100123", "42"), { chatId: -100123 });
  assert.deepEqual(targetFromSession("-100123", "5:42"), { chatId: -100123, threadId: 5 });
  assert.deepEqual(targetFromSession("@channel", "42"), { chatId: "@channel" });
  assert.equal(parseChatId("123"), 123);
});

test("raw round-trips into a reply target", () => {
  const message = { message_id: 9, message_thread_id: 5, is_topic_message: true, date: 1, chat: { id: -100456, type: "supergroup" } };
  const raw = encodeRaw(77, message);
  assert.deepEqual(JSON.parse(raw), { update_id: 77, message: { message_id: 9, message_thread_id: 5, is_topic_message: true, chat: { id: -100456 } } });
  assert.deepEqual(targetFromRaw(raw), { chatId: -100456, replyTo: 9, threadId: 5 });

  const plain = encodeRaw(78, { message_id: 3, message_thread_id: 2, date: 1, chat: { id: 10, type: "group" } });
  assert.deepEqual(targetFromRaw(plain), { chatId: 10, replyTo: 3 });
});

test("targetFromRaw accepts updates stored by the built-in channel", () => {
  const legacy = JSON.stringify({
    update_id: 1,
    message: { message_id: 4, message_thread_id: 7, is_topic_message: true, from: { id: 1 }, chat: { id: -100, type: "supergroup" }, date: 1, text: "hi" },
  });
  assert.deepEqual(targetFromRaw(legacy), { chatId: -100, replyTo: 4, threadId: 7 });
  assert.equal(targetFromRaw("not json"), undefined);
  assert.equal(targetFromRaw('{"message":{}}'), undefined);
  assert.equal(targetFromRaw(undefined), undefined);
});

test("incomingFile picks the attachment", () => {
  const base = { message_id: 1, date: 1, chat: { id: 1, type: "private" } };
  const photo = incomingFile({ ...base, photo: [{ file_id: "s", width: 1, height: 1 }, { file_id: "l", width: 9, height: 9 }] });
  assert.deepEqual(photo, { type: "image", file: { file_id: "l", width: 9, height: 9 }, name: "photo.jpg" });
  assert.equal(incomingFile({ ...base, document: { file_id: "d", file_name: "a.pdf" } }).name, "a.pdf");
  assert.equal(incomingFile({ ...base, voice: { file_id: "v" } }).type, "audio");
  assert.equal(incomingFile({ ...base, video: { file_id: "v" } }).name, "video.mp4");
  assert.equal(incomingFile({ ...base, video_note: { file_id: "v" } }).type, "video");
  assert.deepEqual(incomingFile({ ...base, sticker: { file_id: "s" } }), { type: "sticker", file: { file_id: "s" } });
  assert.equal(incomingFile({ ...base, text: "hi" }), undefined);
});

test("extension falls back across names", () => {
  assert.equal(extension("a.pdf", "documents/file_1.bin"), ".pdf");
  assert.equal(extension(undefined, "stickers/file_2.webp"), ".webp");
  assert.equal(extension("noext", "dir.v2/file"), "");
});

test("sendMethodFor maps extensions", () => {
  assert.equal(sendMethodFor("a.PNG"), "sendPhoto");
  assert.equal(sendMethodFor("clip.mp4"), "sendVideo");
  assert.equal(sendMethodFor("song.mp3"), "sendAudio");
  assert.equal(sendMethodFor("note.ogg"), "sendVoice");
  assert.equal(sendMethodFor("report.pdf"), "sendDocument");
  assert.equal(sendMethodFor("README"), "sendDocument");
});

test("parseAuthCommand", () => {
  assert.deepEqual(parseAuthCommand("/auth abc"), { code: "abc" });
  assert.deepEqual(parseAuthCommand("  /auth@test_bot   abc  "), { code: "abc" });
  assert.deepEqual(parseAuthCommand("/auth"), {});
  assert.equal(parseAuthCommand("/authx abc"), undefined);
  assert.equal(parseAuthCommand("hello"), undefined);
  assert.equal(parseAuthCommand(undefined), undefined);
});
