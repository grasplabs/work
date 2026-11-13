import { waitUntil } from "cloudflare:workers";

import {
  connectOutbox,
  coreOutbox,
  databaseOutbox,
  drainLogged,
  drainMaxBatches,
} from "./audit-outbox.ts";
import type { Outbox } from "./audit-outbox.ts";
import { eraseCapturesOfDisconnects } from "./capture-erasures.ts";

// The drains that reach connect's outbox (audit-outbox.ts), each with
// what must be done with connect's events before they leave it: the
// captures of every connection a disconnect stopped erased
// (capture-erasures.ts, GRA-1827). Apart from audit-outbox.ts, which
// core's Brain module depends on through its own imports, so that module
// never imports the Brain's.

/** Connect's outbox, with what must be done before its events leave it. */
const connectOf = (env: Env, besides?: Outbox["appended"]): Outbox =>
  connectOutbox(
    env,
    async (events) => {
      await eraseCapturesOfDisconnects(env, events);
    },
    besides
  );

/**
 * Drains every outbox: the core and Knowledge databases' and connect's,
 * each on its own, so one that fails (connect unreachable, say) is logged
 * and leaves the others to drain. Returns how many events it appended.
 * The clock calls it, with what connect's events are to tell people
 * (connector-source-notices.ts).
 */
export const drainAuditOutboxes = async (
  env: Env,
  /** What is done with connect's events besides (`Outbox.appended`). */
  connectAppended?: Outbox["appended"]
): Promise<number> => {
  const counts = await Promise.all(
    [
      coreOutbox(env),
      databaseOutbox("knowledge", env.KNOWLEDGE),
      connectOf(env, connectAppended),
    ].map(async (outbox) => await drainLogged(env, outbox, drainMaxBatches))
  );
  return counts.reduce((total, count) => total + count, 0);
};

/**
 * Drains connect's outbox soon, one batch, in the background: after a
 * change connect recorded in its own outbox (an AI provider's key), so its
 * event reaches the log a moment later rather than at the clock's next
 * drain. A drain that fails is logged; the clock drains it later.
 */
export const drainConnectOutboxSoon = (env: Env): void => {
  waitUntil(drainLogged(env, connectOf(env), 1));
};
