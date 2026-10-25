import { createServer } from "node:http";

export const TOKEN = "123:abc";

export async function startFakeTelegram(handlers = {}) {
  const calls = [];
  const waiters = [];
  const files = new Map();
  const updates = [];
  const pollers = [];

  const flushPollers = () => {
    for (const poller of [...pollers]) {
      const ready = updates.filter((u) => u.update_id >= poller.offset);
      if (ready.length > 0) poller.respond(ready);
    }
  };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const fileMatch = req.url.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (fileMatch) {
      const data = files.get(fileMatch[2]);
      if (!data) return send(404, { ok: false });
      res.writeHead(200);
      return res.end(data);
    }
    const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!m) return send(404, { ok: false, error_code: 404, description: "Not Found" });
    const [, token, method] = m;
    if (token !== TOKEN) return send(401, { ok: false, error_code: 401, description: "Unauthorized" });
    const type = req.headers["content-type"] ?? "";
    const call = { method, contentType: type, body: type.includes("json") ? JSON.parse(body.toString() || "{}") : body.toString("latin1") };
    calls.push(call);
    for (const w of [...waiters]) {
      if (w.match(call)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(call);
      }
    }
    if (handlers[method]) {
      const out = await handlers[method](call);
      if (out !== undefined) return send(out.ok === false ? out.error_code ?? 400 : 200, out.ok === false ? out : { ok: true, result: out });
    }
    switch (method) {
      case "getMe":
        return send(200, { ok: true, result: { id: 42, is_bot: true, first_name: "Bot", username: "test_bot" } });
      case "getWebhookInfo":
        return send(200, { ok: true, result: { url: "" } });
      case "getUpdates": {
        const offset = call.body.offset ?? 0;
        const ready = updates.filter((u) => u.update_id >= offset);
        if (ready.length > 0) return send(200, { ok: true, result: ready });
        const poller = {
          offset,
          respond: (result) => {
            clearTimeout(poller.timer);
            const i = pollers.indexOf(poller);
            if (i >= 0) pollers.splice(i, 1);
            send(200, { ok: true, result });
          },
        };
        poller.timer = setTimeout(() => poller.respond([]), 300);
        pollers.push(poller);
        return;
      }
      case "getFile":
        return send(200, { ok: true, result: { file_id: call.body.file_id, file_path: `files/${call.body.file_id}` } });
      default:
        return send(200, { ok: true, result: method.startsWith("send") && method !== "sendChatAction" ? { message_id: calls.length } : true });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    files,
    push(update) {
      updates.push(update);
      flushPollers();
    },
    waitFor(match, ms = 5000) {
      const found = calls.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for telegram call")), ms);
        waiters.push({ match, resolve: (c) => (clearTimeout(timer), resolve(c)) });
      });
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
