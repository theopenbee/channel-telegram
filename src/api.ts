import { Blob } from "node:buffer";
import { EnvHttpProxyAgent, FormData, fetch, type Dispatcher } from "undici";

import type { ResponseParameters } from "./types.js";

export const DEFAULT_API_BASE_URL = "https://api.telegram.org";

const REQUEST_TIMEOUT = 120_000;
const UPLOAD_TIMEOUT = 300_000;
const MAX_RETRY_AFTER = 30;
const MAX_RATE_LIMIT_RETRIES = 2;

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly parameters: ResponseParameters = {},
  ) {
    super(`telegram ${method} failed: ${code} ${description}`);
    this.name = "TelegramError";
  }
}

export interface UploadFile {
  field: string;
  name: string;
  data: Uint8Array;
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: ResponseParameters;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class BotApi {
  private readonly base: string;
  private readonly dispatcher: Dispatcher;

  constructor(
    private readonly token: string,
    baseUrl = DEFAULT_API_BASE_URL,
    dispatcher?: Dispatcher,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.dispatcher = dispatcher ?? new EnvHttpProxyAgent();
  }

  call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal, timeout = REQUEST_TIMEOUT): Promise<T> {
    return this.request<T>(method, signal, timeout, () => ({
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    }));
  }

  upload<T>(method: string, params: Record<string, unknown>, file: UploadFile, signal?: AbortSignal): Promise<T> {
    return this.request<T>(method, signal, UPLOAD_TIMEOUT, () => {
      const form = new FormData();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
      form.append(file.field, new Blob([file.data]), file.name);
      return { body: form };
    });
  }

  async download(filePath: string, maxSize: number, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await fetch(`${this.base}/file/bot${this.token}/${filePath}`, {
      dispatcher: this.dispatcher,
      signal: withTimeout(signal, REQUEST_TIMEOUT),
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new Error(`download failed: HTTP ${res.status}`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > maxSize) {
        await res.body.cancel().catch(() => undefined);
        throw new Error(`file larger than ${maxSize} bytes`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  private async request<T>(
    method: string,
    signal: AbortSignal | undefined,
    timeout: number,
    init: () => { headers?: Record<string, string>; body: string | FormData },
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const { headers, body } = init();
      const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
        method: "POST",
        headers,
        body,
        dispatcher: this.dispatcher,
        signal: withTimeout(signal, timeout),
      });
      let data: ApiResponse<T>;
      try {
        data = (await res.json()) as ApiResponse<T>;
      } catch {
        throw new TelegramError(method, res.status, "invalid response from Telegram");
      }
      if (data.ok) return data.result as T;
      const err = new TelegramError(method, data.error_code ?? res.status, data.description ?? "unknown error", data.parameters);
      const retryAfter = err.parameters.retry_after;
      if (err.code === 429 && retryAfter !== undefined && retryAfter <= MAX_RETRY_AFTER && attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleep(retryAfter * 1000, signal);
        continue;
      }
      throw err;
    }
  }
}
