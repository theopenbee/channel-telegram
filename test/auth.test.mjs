import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStore, UNAUTHORIZED_REPLY_COOLDOWN, codeMatches } from "../dist/auth.js";

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

test("codeMatches compares codes", () => {
  assert.equal(codeMatches("abc", "abc"), true);
  assert.equal(codeMatches("abd", "abc"), false);
  assert.equal(codeMatches("ab", "abc"), false);
});

test("authorize persists to the data dir", async () => {
  const dataDir = tmp("auth-");
  const { store, imported } = await AuthStore.open(dataDir, join(tmp("legacy-"), "missing.json"));
  assert.equal(imported, false);
  assert.equal(store.isAuthorized("1"), false);
  await store.authorize("2");
  await store.authorize("1");
  const file = join(dataDir, "authorized_users.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), ["1", "2"]);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const reopened = await AuthStore.open(dataDir, join(tmp("legacy-"), "missing.json"));
  assert.equal(reopened.store.isAuthorized("1"), true);
});

test("imports users authorized by the built-in channel once", async () => {
  const legacyDir = tmp("legacy-");
  const legacy = join(legacyDir, "authorized_users.json");
  writeFileSync(legacy, JSON.stringify(["7", "8"]));
  const dataDir = tmp("auth-");
  const first = await AuthStore.open(dataDir, legacy);
  assert.equal(first.imported, true);
  assert.equal(first.store.size, 2);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "authorized_users.json"), "utf8")), ["7", "8"]);

  writeFileSync(legacy, JSON.stringify(["9"]));
  const second = await AuthStore.open(dataDir, legacy);
  assert.equal(second.imported, false);
  assert.equal(second.store.isAuthorized("9"), false);
});

test("a corrupt auth file authorizes nobody", async () => {
  const dataDir = tmp("auth-");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "authorized_users.json"), "{}");
  const { store, problem } = await AuthStore.open(dataDir, join(tmp("legacy-"), "missing.json"));
  assert.match(problem, /JSON array/);
  assert.equal(store.size, 0);
});

test("unauthorized hints are rate limited per sender", async () => {
  const { store } = await AuthStore.open(tmp("auth-"), join(tmp("legacy-"), "missing.json"));
  assert.equal(store.shouldHint("1", 1000), true);
  assert.equal(store.shouldHint("1", 2000), false);
  assert.equal(store.shouldHint("2", 2000), true);
  assert.equal(store.shouldHint("1", 1000 + UNAUTHORIZED_REPLY_COOLDOWN), true);
});
