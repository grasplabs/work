import { eventsKeptMs } from "./contract.ts";
import type { NewEvent } from "./contract.ts";

// Events: what happened, as small records, used only to find routines.
// Each names a team, a kind of step, the item it was on (by a hash) and
// when: never a person. The ways they could hurt someone, and how each is
// closed:
//
// - A trail of one person read back: nothing reads this table. No member
//   of the contract answers an event, so no recall, page, export or
//   figure holds one; whatever is drawn from them later is drawn here and
//   held to the five-person floor where it is drawn.
// - A person in a row: the host names a team's group, never a person
//   (contract.ts `newEventSchema`), an item only by a MAC of its ID, and
//   who took it only by a MAC of them and the team, which only the host
//   can compute: so the host can erase their events (`eraseEventsIn`).
//   One person's tags in two teams differ, but one call makes an event in
//   each of their teams at the same step and hour, so with raw access to
//   this table they can be lined up by co-occurring.
// - One call pinned by its time: each is kept to the hour, rounded down.
// - A late write after an erasure: the erasure closes the person's tags in
//   the transaction that deletes their events, and an add under a closed
//   tag keeps nothing (`eraseEventsIn`, `addEvents`).
// - An erasure undone by a restore of the store's storage: it is part of
//   the person's erasure in the shared store, whose ledger entry names
//   the tags and the key they were made under (erasure.ts
//   `erasePersonShared`); a replay applies it again, as the erasure
//   itself did.
// - Tags no erasure can compute: the host names the key it made them
//   with, and a call under another key deletes every event and closed tag
//   first (`underKey`).
// - Brought back by a restore: an export holds neither events nor closed
//   tags (exports.ts reads neither), since events are short-lived activity
//   and an old export could hold an erased person's; and a restore of an
//   export clears neither, so the tags an erasure closed still hold.
// - Kept for good: every event older than `eventsKeptMs` is deleted
//   (`expireEvents`, on the host's clock), and one dated later than when
//   it is kept is kept as of then, so none outlives the window.

/**
 * The most bytes a string bound to one of Durable Object SQLite's
 * statements may hold: 2 MB, its limit on a string, BLOB or row
 * (developers.cloudflare.com/durable-objects/platform/limits/).
 */
const sqliteStringMaxBytes = 2_000_000;

/**
 * Most tags one statement binds as a JSON list: each is 64 hex digits, and
 * 67 bytes in the list with its quotes and comma, so this many stay well
 * inside `sqliteStringMaxBytes`. A longer list is written a slice at a
 * time, in the same transaction: no erasure is refused for its size.
 */
export const tagsPerStatement = Math.floor(sqliteStringMaxBytes / 128);

/** `tags` in slices of `tagsPerStatement`, each as one JSON list. */
export const tagSlices = (tags: readonly string[]): string[] => {
  const slices: string[] = [];
  for (let start = 0; start < tags.length; start += tagsPerStatement) {
    slices.push(JSON.stringify(tags.slice(start, start + tagsPerStatement)));
  }
  return slices;
};

/** An hour, in milliseconds: what an event's time is kept to. */
const hourMs = 60 * 60 * 1000;

/**
 * The store under the host's key `keyId`, in the caller's transaction:
 * when it last saw another, every event and closed tag is deleted first,
 * as no erasure could compute their tags again, and `keyId` kept. So a
 * rotation of the host's key drops what was kept under the old one (at
 * most `eventsKeptMs` of it) and leaves nothing an erasure can't find; and
 * a replay of an erasure made under another key than a restored copy's
 * drops that copy's events, which no later erasure could find either.
 */
const underKey = (sql: SqlStorage, keyId: string): void => {
  const [kept] = sql
    .exec<{ id: string }>("SELECT id FROM event_key WHERE row = 1")
    .toArray();
  if (kept?.id === keyId) {
    return;
  }
  if (kept !== undefined) {
    sql.exec("DELETE FROM events");
    sql.exec("DELETE FROM closed_event_tags");
  }
  sql.exec(
    "INSERT INTO event_key (row, id) VALUES (1, ?) ON CONFLICT (row) DO UPDATE SET id = excluded.id",
    keyId
  );
};

/**
 * Keeps `events` under the host's key `keyId` (`underKey`), each once by
 * its key and team, as of `now`: one dated later is kept as of `now`, its
 * time rounded down to the hour; one already past `eventsKeptMs`, or
 * whose tag an erasure closed, is not kept at all. One statement each, in
 * one transaction.
 */
export const addEvents = (
  storage: DurableObjectStorage,
  keyId: string,
  events: readonly NewEvent[],
  now: number
): void => {
  const oldest = now - eventsKeptMs;
  storage.transactionSync(() => {
    underKey(storage.sql, keyId);
    for (const { key, team, step, item, who, at } of events) {
      const happened =
        Math.floor(Math.min(Date.parse(at), now) / hourMs) * hourMs;
      if (happened >= oldest) {
        storage.sql.exec(
          `INSERT INTO events (key, team, step, item, who, at)
          SELECT ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM closed_event_tags WHERE who = ?)
          ON CONFLICT (key, team) DO NOTHING`,
          key,
          team,
          step,
          item,
          who,
          happened,
          who
        );
      }
    }
  });
};

/**
 * Deletes every event older than `eventsKeptMs` as of `now`, and every
 * closed tag as old: no event under it can arrive later than that.
 */
export const expireEvents = (sql: SqlStorage, now: number): void => {
  sql.exec("DELETE FROM events WHERE at < ?", now - eventsKeptMs);
  sql.exec("DELETE FROM closed_event_tags WHERE at < ?", now - eventsKeptMs);
};

/**
 * Deletes every event whose tag is one of `who`, and closes those tags as
 * of `at`, under the host's key `keyId` (`underKey`), in the caller's
 * transaction: a person's erasure (erasure.ts `erasePersonShared`, and
 * its replay), which no later add can undo while an event could still
 * arrive.
 */
export const eraseEventsIn = (
  sql: SqlStorage,
  { keyId, who }: { keyId: string; who: readonly string[] },
  at: number
): void => {
  underKey(sql, keyId);
  for (const listed of tagSlices(who)) {
    sql.exec(
      "DELETE FROM events WHERE who IN (SELECT value FROM json_each(?))",
      listed
    );
    sql.exec(
      `INSERT INTO closed_event_tags (who, at)
      SELECT value, ? FROM json_each(?)
      WHERE true
      ON CONFLICT (who) DO UPDATE SET at = max(at, excluded.at)`,
      at,
      listed
    );
  }
};
