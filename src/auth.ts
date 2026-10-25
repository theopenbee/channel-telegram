import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AUTH_FILE = "authorized_users.json";
export const UNAUTHORIZED_REPLY_COOLDOWN = 60_000;

export function legacyAuthFile(): string {
  return join(homedir(), ".openbee", "telegram", AUTH_FILE);
}

export function codeMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

async function readIds(path: string): Promise<string[] | undefined> {
  let data: string;
  try {
    data = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const ids = JSON.parse(data);
  if (!Array.isArray(ids)) throw new Error(`${path} must contain a JSON array`);
  return ids.filter((id): id is string => typeof id === "string");
}

export class AuthStore {
  private readonly users = new Set<string>();
  private readonly lastHint = new Map<string, number>();

  private constructor(private readonly path: string) {}

  static async open(dataDir: string, legacyPath = legacyAuthFile()): Promise<{ store: AuthStore; imported: boolean; problem?: string }> {
    const store = new AuthStore(join(dataDir, AUTH_FILE));
    let ids: string[] | undefined;
    let imported = false;
    try {
      ids = await readIds(store.path);
      if (ids === undefined) {
        ids = await readIds(legacyPath);
        imported = ids !== undefined;
      }
    } catch (err) {
      return { store, imported: false, problem: err instanceof Error ? err.message : String(err) };
    }
    for (const id of ids ?? []) store.users.add(id);
    if (imported) await store.save();
    return { store, imported };
  }

  get size(): number {
    return this.users.size;
  }

  isAuthorized(userId: string): boolean {
    return this.users.has(userId);
  }

  async authorize(userId: string): Promise<void> {
    this.users.add(userId);
    await this.save();
  }

  shouldHint(userId: string, now = Date.now()): boolean {
    const last = this.lastHint.get(userId);
    if (last !== undefined && now - last < UNAUTHORIZED_REPLY_COOLDOWN) return false;
    this.lastHint.set(userId, now);
    return true;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const ids = [...this.users].sort();
    await writeFile(this.path, JSON.stringify(ids, null, 2), { mode: 0o600 });
  }
}
