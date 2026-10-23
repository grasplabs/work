import type { Lock, QueueEntry, StateAdapter } from "chat";
/**
 * Chat SDK's state on Durable Objects. The SDK keeps what outlives a request
 * in a `StateAdapter`: a lock per thread so two handlers never answer the
 * same conversation at once, the threads a bot follows, messages queued
 * while a handler runs, and keys with a lifetime (resent webhooks it
 * already took, caches, history). Its own adapters are Redis and Postgres;
 * here each key and each thread is one SQLite object, which answers one call
 * at a time, so taking a lock or setting a key only once needs no more than
 * reading before writing.
 *
 * Values cross the objects' boundary as JSON, as the SDK's Postgres adapter
 * stores them: what the SDK keeps is plain data, and it revives its own
 * messages from it.
 *
 * Nothing here knows Grasp's domain. A Worker exports `ChatState`, binds it,
 * and passes the namespace, in the EU (`jurisdiction("eu")`) where it
 * deploys to Cloudflare, to `durableObjectState`.
 */
import { DurableObject } from "cloudflare:workers";

/** A lock as an object hands it out: the thread it guards is the object's own. */
interface HeldLock {
  token: string;
  expiresAt: number;
}

/** When something kept for `ttlMs` expires, or null when it doesn't. */
const expiryOf = (ttlMs: number | undefined, now: number): number | null =>
  ttlMs === undefined || ttlMs <= 0 ? null : now + ttlMs;

/**
 * One key's value or list, or one thread's lock, queue and subscription,
 * whichever the object's name says it holds (`durableObjectState`). Both
 * kinds share the class so a Worker binds one namespace.
 */
export class ChatState extends DurableObject {
  /** Whether this object's tables exist: not yet, or not since it was cleared. */
  private hasTables = false;

  /**
   * The object's storage, its tables made first: a key's value or list, with
   * its expiry; a thread's lock, its queue in order, and whether it is
   * followed. Each table holds at most one row but the queue.
   */
  private get sql(): SqlStorage {
    if (!this.hasTables) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS entry (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          json TEXT NOT NULL,
          expires_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS lock (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          token TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS queue (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS subscribed (
          id INTEGER PRIMARY KEY CHECK (id = 1)
        );
      `);
      this.hasTables = true;
    }
    return this.ctx.storage.sql;
  }

  /** The key's value as JSON, or null when it has none or it expired. */
  get(): string | null {
    const [row] = this.sql
      .exec<{ json: string; expires_at: number | null }>(
        "SELECT json, expires_at FROM entry WHERE id = 1"
      )
      .toArray();
    if (row === undefined) {
      return null;
    }
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.sql.exec("DELETE FROM entry WHERE id = 1");
      return null;
    }
    return row.json;
  }

  /** Keeps `json` as the key's value, for `ttlMs` or for good. */
  async set(json: string, ttlMs?: number): Promise<void> {
    const expiresAt = expiryOf(ttlMs, Date.now());
    this.sql.exec(
      "INSERT OR REPLACE INTO entry (id, json, expires_at) VALUES (1, ?, ?)",
      json,
      expiresAt
    );
    await this.expireAt(expiresAt);
  }

  /** Keeps `json` only when the key has no live value; whether it did. */
  async setIfNotExists(json: string, ttlMs?: number): Promise<boolean> {
    if (this.get() !== null) {
      return false;
    }
    await this.set(json, ttlMs);
    return true;
  }

  /** Forgets the key. */
  delete(): void {
    this.sql.exec("DELETE FROM entry WHERE id = 1");
  }

  /**
   * Adds `json` to the end of the key's list, keeping only the newest
   * `maxLength`, and starts the list's lifetime again.
   */
  async append(
    json: string,
    maxLength?: number,
    ttlMs?: number
  ): Promise<void> {
    const kept = this.get();
    const parsed: unknown = kept === null ? [] : JSON.parse(kept);
    const item: unknown = JSON.parse(json);
    // A key that held a value, not a list, starts a new list.
    const earlier: unknown[] = Array.isArray(parsed) ? parsed : [];
    const list = [...earlier, item];
    const trimmed =
      maxLength !== undefined && maxLength > 0 && list.length > maxLength
        ? list.slice(list.length - maxLength)
        : list;
    await this.set(JSON.stringify(trimmed), ttlMs);
  }

  /** The key's list as JSON values, oldest first; empty when it has none. */
  list(): string[] {
    const kept = this.get();
    const parsed: unknown = kept === null ? [] : JSON.parse(kept);
    const values: unknown[] = Array.isArray(parsed) ? parsed : [];
    return values.map((value) => JSON.stringify(value));
  }

  /** The thread's lock for `ttlMs`, or null while someone else holds it. */
  async acquireLock(ttlMs: number): Promise<HeldLock | null> {
    const now = Date.now();
    const [held] = this.sql
      .exec<{ expires_at: number }>("SELECT expires_at FROM lock WHERE id = 1")
      .toArray();
    if (held !== undefined && held.expires_at > now) {
      return null;
    }
    const lock = { token: crypto.randomUUID(), expiresAt: now + ttlMs };
    this.sql.exec(
      "INSERT OR REPLACE INTO lock (id, token, expires_at) VALUES (1, ?, ?)",
      lock.token,
      lock.expiresAt
    );
    await this.expireAt(lock.expiresAt);
    return lock;
  }

  /**
   * Holds the lock `token` names for `ttlMs` more, if it is still held with
   * it; never takes one that expired, was released or was taken over.
   */
  async extendLock(token: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const extended = this.sql.exec(
      "UPDATE lock SET expires_at = ? WHERE id = 1 AND token = ? AND expires_at > ?",
      expiresAt,
      token,
      now
    ).rowsWritten;
    if (extended === 0) {
      return false;
    }
    await this.expireAt(expiresAt);
    return true;
  }

  /** Lets the lock go, if `token` still holds it. */
  releaseLock(token: string): void {
    this.sql.exec("DELETE FROM lock WHERE id = 1 AND token = ?", token);
  }

  /** Lets the lock go whoever holds it; their release then does nothing. */
  forceReleaseLock(): void {
    this.sql.exec("DELETE FROM lock WHERE id = 1");
  }

  /** Adds `json` to the thread's queue, keeping the newest `maxSize`; the queue's depth. */
  enqueue(json: string, maxSize: number): number {
    this.sql.exec("INSERT INTO queue (json) VALUES (?)", json);
    this.sql.exec(
      "DELETE FROM queue WHERE seq NOT IN (SELECT seq FROM queue ORDER BY seq DESC LIMIT ?)",
      Math.max(maxSize, 0)
    );
    return this.queueDepth();
  }

  /** Takes the oldest entry off the thread's queue, or null when it's empty. */
  dequeue(): string | null {
    const [row] = this.sql
      .exec<{
        seq: number;
        json: string;
      }>("SELECT seq, json FROM queue ORDER BY seq LIMIT 1")
      .toArray();
    if (row === undefined) {
      return null;
    }
    this.sql.exec("DELETE FROM queue WHERE seq = ?", row.seq);
    return row.json;
  }

  /** How many entries wait in the thread's queue. */
  queueDepth(): number {
    return this.sql
      .exec<{ depth: number }>("SELECT count(*) AS depth FROM queue")
      .one().depth;
  }

  /** Follows the thread. */
  subscribe(): void {
    this.sql.exec("INSERT OR IGNORE INTO subscribed (id) VALUES (1)");
  }

  /** Stops following the thread. */
  unsubscribe(): void {
    this.sql.exec("DELETE FROM subscribed WHERE id = 1");
  }

  /** Whether the thread is followed. */
  isSubscribed(): boolean {
    return (
      this.sql.exec("SELECT 1 FROM subscribed WHERE id = 1").toArray().length >
      0
    );
  }

  /**
   * Clears what expired, and the whole object once it holds nothing, so
   * keys and locks that are never read again don't stay stored.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      "DELETE FROM entry WHERE expires_at IS NOT NULL AND expires_at <= ?",
      now
    );
    this.sql.exec("DELETE FROM lock WHERE expires_at <= ?", now);
    const next = this.sql
      .exec<{ at: number | null }>(
        "SELECT min(at) AS at FROM (SELECT expires_at AS at FROM entry UNION ALL SELECT expires_at FROM lock)"
      )
      .one().at;
    if (next !== null) {
      await this.ctx.storage.setAlarm(next);
      return;
    }
    const holds = this.sql
      .exec<{ rows: number }>(
        "SELECT (SELECT count(*) FROM entry) + (SELECT count(*) FROM queue) + (SELECT count(*) FROM subscribed) AS rows"
      )
      .one().rows;
    if (holds === 0) {
      // Drops the tables too: the next call makes them again.
      await this.ctx.storage.deleteAll();
      this.hasTables = false;
    }
  }

  /** Wakes the object when something expires, if nothing wakes it sooner. */
  private async expireAt(at: number | null): Promise<void> {
    if (at === null) {
      return;
    }
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > at) {
      await this.ctx.storage.setAlarm(at);
    }
  }
}

/**
 * Chat SDK's state on `namespace`: each key and each thread its own object,
 * so one busy conversation never waits on another.
 */
export const durableObjectState = (
  namespace: DurableObjectNamespace<ChatState>
): StateAdapter => {
  const key = (name: string) => namespace.getByName(`key:${name}`);
  const thread = (id: string) => namespace.getByName(`thread:${id}`);
  return {
    // The objects need no connection: each call reaches its own.
    connect: async () => {
      await Promise.resolve();
    },
    disconnect: async () => {
      await Promise.resolve();
    },
    get: async <T = unknown>(name: string): Promise<T | null> => {
      const json = await key(name).get();
      if (json === null) {
        return null;
      }
      // SAFETY: a key or queue holds only what the SDK wrote there through
      // this adapter, as JSON, and the SDK reads it back as the type it
      // wrote (its Postgres adapter does the same).
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return JSON.parse(json) as T;
    },
    set: async (name, value, ttlMs) => {
      await key(name).set(JSON.stringify(value), ttlMs);
    },
    setIfNotExists: async (name, value, ttlMs) =>
      await key(name).setIfNotExists(JSON.stringify(value), ttlMs),
    delete: async (name) => {
      await key(name).delete();
    },
    appendToList: async (name, value, options) => {
      await key(name).append(
        JSON.stringify(value),
        options?.maxLength,
        options?.ttlMs
      );
    },
    getList: async <T = unknown>(name: string): Promise<T[]> => {
      const list = await key(name).list();
      return list.map(
        (json) =>
          // SAFETY: a key or queue holds only what the SDK wrote there through
          // this adapter, as JSON, and the SDK reads it back as the type it
          // wrote (its Postgres adapter does the same).
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          JSON.parse(json) as T
      );
    },
    acquireLock: async (threadId, ttlMs): Promise<Lock | null> => {
      const held = await thread(threadId).acquireLock(ttlMs);
      return held === null ? null : { threadId, ...held };
    },
    extendLock: async (lock, ttlMs) =>
      await thread(lock.threadId).extendLock(lock.token, ttlMs),
    releaseLock: async (lock) => {
      await thread(lock.threadId).releaseLock(lock.token);
    },
    forceReleaseLock: async (threadId) => {
      await thread(threadId).forceReleaseLock();
    },
    enqueue: async (threadId, entry: QueueEntry, maxSize) =>
      await thread(threadId).enqueue(JSON.stringify(entry), maxSize),
    dequeue: async (threadId): Promise<QueueEntry | null> => {
      const json = await thread(threadId).dequeue();
      if (json === null) {
        return null;
      }
      // SAFETY: a key or queue holds only what the SDK wrote there through
      // this adapter, as JSON, and the SDK reads it back as the type it
      // wrote (its Postgres adapter does the same).
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return JSON.parse(json) as QueueEntry;
    },
    queueDepth: async (threadId) => await thread(threadId).queueDepth(),
    subscribe: async (threadId) => {
      await thread(threadId).subscribe();
    },
    unsubscribe: async (threadId) => {
      await thread(threadId).unsubscribe();
    },
    isSubscribed: async (threadId) => await thread(threadId).isSubscribed(),
  };
};
