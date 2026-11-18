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
//   can compute: so the host can erase their events (`eraseEvents`).
//   One person's tags in two teams differ, but one call makes an event in
//   each of their teams at the same step and hour, so with raw access to
//   this table they can be lined up by co-occurring.
// - One call pinned by its time: each is kept to the hour, rounded down.
// - A late write after an erasure: the erasure closes the person's tags in
//   the transaction that deletes their events, and an add under a closed
//   tag keeps nothing (`eraseEvents`, `addEvents`).
// - Tags no erasure can compute: the host names the key it made them
//   with, and a call under another key deletes every event and closed tag
//   first (`underKey`).
// - Kept for good: every event older than `eventsKeptMs` is deleted
//   (`expireEvents`, on the host's clock), and one dated later than when
//   it is kept is kept as of then, so none outlives the window.

/** An hour, in milliseconds: what an event's time is kept to. */
const hourMs = 60 * 60 * 1000;

/**
 * `change` run under the host's key `keyId`, in one transaction with it:
 * when the store last saw another, every event and closed tag is deleted
 * first, as no erasure could compute their tags again, and `keyId` kept.
 * So a rotation of the host's key drops what was kept under the old one
 * (at most `eventsKeptMs` of it) and leaves nothing an erasure can't find.
 */
const underKey = (
  storage: DurableObjectStorage,
  keyId: string,
  change: () => void
): void => {
  storage.transactionSync(() => {
    const { sql } = storage;
    const [kept] = sql
      .exec<{ id: string }>("SELECT id FROM event_key WHERE row = 1")
      .toArray();
    if (kept?.id !== keyId) {
      if (kept !== undefined) {
        sql.exec("DELETE FROM events");
        sql.exec("DELETE FROM closed_event_tags");
      }
      sql.exec(
        "INSERT INTO event_key (row, id) VALUES (1, ?) ON CONFLICT (row) DO UPDATE SET id = excluded.id",
        keyId
      );
    }
    change();
  });
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
  underKey(storage, keyId, () => {
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
 * of `now`, in one transaction under the host's key `keyId`: a person's
 * erasure, which no later add can undo.
 */
export const eraseEvents = (
  storage: DurableObjectStorage,
  keyId: string,
  who: readonly string[],
  now: number
): void => {
  underKey(storage, keyId, () => {
    const listed = JSON.stringify(who);
    storage.sql.exec(
      "DELETE FROM events WHERE who IN (SELECT value FROM json_each(?))",
      listed
    );
    storage.sql.exec(
      `INSERT INTO closed_event_tags (who, at)
      SELECT value, ? FROM json_each(?)
      WHERE true
      ON CONFLICT (who) DO UPDATE SET at = excluded.at`,
      now,
      listed
    );
  });
};
