import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUTTONS_FILE, ButtonStore, MAX_STORED_AGE, MAX_STORED_MESSAGES, buttonIndex, inlineKeyboard, scopeUser } from "../dist/buttons.js";
import { botCommands, stripCommandTarget } from "../dist/commands.js";

test("short labels share rows of three, long labels get a row each", () => {
  const short = ["A", "B", "C", "D"].map((label) => ({ label, text: label }));
  assert.deepEqual(
    inlineKeyboard(short).map((row) => row.map((b) => b.callback_data)),
    [["ob:0", "ob:1", "ob:2"], ["ob:3"]],
  );
  const long = [{ label: "先合并再部署到测试环境", text: "x" }, { label: "No", text: "y" }];
  assert.deepEqual(
    inlineKeyboard(long).map((row) => row.length),
    [1, 1],
  );
});

test("button data and scopes are parsed", () => {
  assert.equal(buttonIndex("ob:2"), 2);
  for (const data of [undefined, "", "ob:", "ob:x", "other:1"]) assert.equal(buttonIndex(data), undefined);
  assert.equal(scopeUser("789"), "789");
  assert.equal(scopeUser("5:789"), "789");
});

test("the store drops old and surplus messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-buttons-"));
  const { store } = await ButtonStore.open(dir);
  const now = Date.now();
  await store.add(1, 1, "1", [{ label: "a", text: "a" }], now - MAX_STORED_AGE - 1);
  await store.add(1, 2, "1", [{ label: "b", text: "b" }], now);
  assert.equal(store.get(1, 1), undefined);
  assert.equal(store.get(1, 2).texts[0], "b");
  for (let i = 0; i < MAX_STORED_MESSAGES; i++) store.add(2, i, "2", [{ label: "c", text: "c" }], now);
  await store.add(2, MAX_STORED_MESSAGES, "2", [{ label: "c", text: "c" }], now);
  assert.equal(store.size, MAX_STORED_MESSAGES);
  assert.equal(store.get(1, 2), undefined);
  const saved = JSON.parse(readFileSync(join(dir, BUTTONS_FILE), "utf8"));
  assert.equal(Object.keys(saved).length, MAX_STORED_MESSAGES);
});

test("a broken store file is reported and ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-buttons-"));
  writeFileSync(join(dir, BUTTONS_FILE), "{not json");
  const { store, problem } = await ButtonStore.open(dir);
  assert.ok(problem);
  assert.equal(store.size, 0);
});

test("commands addressed to the bot are normalised", () => {
  assert.equal(stripCommandTarget("/status@Test_Bot", "test_bot"), "/status");
  assert.equal(stripCommandTarget("/clear@test_bot tester", "test_bot"), "/clear tester");
  assert.equal(stripCommandTarget("/clear@other_bot", "test_bot"), "/clear@other_bot");
  assert.equal(stripCommandTarget("hi @test_bot", "test_bot"), "hi @test_bot");
  assert.equal(stripCommandTarget("/status@test_bot", ""), "/status@test_bot");
});

test("the command menu lists auth only when an access code is set", () => {
  assert.equal(botCommands("en", false).some((c) => c.command === "auth"), false);
  assert.equal(botCommands("zh", true).at(-1).description, "用授权码授权");
});
