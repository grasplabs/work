import { eventsKeptMs } from "./contract.ts";
import type { NewEvent } from "./contract.ts";

// Events: what happened, as small records, used only to find routines.
// Each names a team, a kind of step, the item it was on (by a hash) and
// when: never a person. The ways they could hurt someone, and how each is
// closed:
//
// - A trail of one person read back: only routines-observed.ts reads this
//   table, and it answers what at least `minTeamShown` distinct people of
//   a team did, never an event. No member of the contract answers an
//   event, so no recall, export or figure about one person holds one.
// - A person in a row: the host names a team's group, never a person
//   (contract.ts `newEventSchema`), an item only by a MAC of its ID, and
//   who took it only by a MAC of them and the team, which only the host
//   can compute: so the host can erase their events (`eraseEvents`).
//   One person's tags in two teams differ, but one call makes an event in
//   each of their teams at the same step and hour, so with raw access to
//   this table they can be lined up by co-occurring.
// - One call pinned by its time: each is kept to the hour, rounded down.
// - Kept for good: every event older than `eventsKeptMs` is deleted
//   (`expireEvents`, on the host's clock), and one dated later than when
//   it is kept is kept as of then, so none outlives the window.

/** An hour, in milliseconds: what an event's time is kept to. */
const hourMs = 60 * 60 * 1000;

/**
 * Keeps `events`, each once by its key and team, as of `now`: one dated
 * later is kept as of `now`, its time rounded down to the hour, and one
 * already past `eventsKeptMs` is not kept at all. One statement each, in
 * one transaction.
 */
export const addEvents = (
  storage: DurableObjectStorage,
  events: readonly NewEvent[],
  now: number
): void => {
  const oldest = now - eventsKeptMs;
  storage.transactionSync(() => {
    for (const { key, team, step, system, writes, item, who, at } of events) {
      const happened =
        Math.floor(Math.min(Date.parse(at), now) / hourMs) * hourMs;
      if (happened >= oldest) {
        storage.sql.exec(
          "INSERT INTO events (key, team, step, system, writes, item, who, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key, team) DO NOTHING",
          key,
          team,
          step,
          system,
          writes ? 1 : 0,
          item,
          who,
          happened
        );
      }
    }
  });
};

/** Deletes every event older than `eventsKeptMs` as of `now`. */
export const expireEvents = (sql: SqlStorage, now: number): void => {
  sql.exec("DELETE FROM events WHERE at < ?", now - eventsKeptMs);
};

/** Deletes every event whose tag is one of `who`: a person's erasure. */
export const eraseEvents = (sql: SqlStorage, who: readonly string[]): void => {
  sql.exec(
    "DELETE FROM events WHERE who IN (SELECT value FROM json_each(?))",
    JSON.stringify(who)
  );
};
