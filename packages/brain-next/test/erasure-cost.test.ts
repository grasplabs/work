import type { Access } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { countRowsRead } from "./rows-read.ts";

// What erasing a group costs the store (GRA-1812; the threat model and
// the numbers are on the issue). A group's erasure (a chat deleted, a
// connection disconnected) hides every source in it in one transaction,
// in the call, so no reader sees a source owed an erasure, and nothing
// is half hidden if the call is cut off. That call has a Durable Object
// request's 30 s of CPU, every retry alike: a cost that grows faster than
// the group would leave a large group visible for good.
//
// Measured in local workerd on a laptop, one call erasing 50,000
// one-chunk sources with no vectors, its first delete batch included:
// - nothing queued: 2.2 s;
// - an item queued for each source (an add queues one), before the queue
//   was indexed by key: 56 s, every item read again for each source; with
//   the index, 3.0 s.
// No answer shows the difference, so this file holds it by cost: the
// rows the store's SQL reads (rows-read.ts), a source at a time, for a
// group four times the size.

/** How many sources an add call waits on at once. */
const addingAtOnce = 50;

/**
 * The rows read, a source at a time, by erasing a group of `sources`
 * turns, each just added, so each still has its queued item.
 */
const rowsPerSourceErased = async (sources: number): Promise<number> => {
  const person = `person-${crypto.randomUUID()}`;
  const access: Access = { kind: "owner", person };
  const group = `chat:${crypto.randomUUID()}`;
  const store = env.BRAIN_STORE.getByName(`person:${person}`);
  const rowsReadBy = await countRowsRead(store);
  for (let at = 0; at < sources; at += addingAtOnce) {
    // oxlint-disable-next-line no-await-in-loop -- a few at a time
    await Promise.all(
      Array.from(
        { length: Math.min(addingAtOnce, sources - at) },
        async (_, index) =>
          await store.addSource({
            source: `${group}/${at + index}`,
            change: "1",
            group,
            text: `Bilby turn ${at + index}`,
            access,
          })
      )
    );
  }
  const rows = await rowsReadBy(
    async () => await store.eraseSource({ source: group, reason: "deleted" })
  );
  return rows / sources;
};

describe("erasing a group", () => {
  // Threat 3 of GRA-1812: a call that can't finish fails every retry alike.
  it(
    "reads rows in proportion to its sources, not its sources times the store's queued work",
    { timeout: 120_000 },
    async () => {
      const small = await rowsPerSourceErased(50);
      const large = await rowsPerSourceErased(200);

      // A cost per source that grows with the group is one that can pass
      // the call's CPU for a group large enough. Before the queue was
      // indexed by key, a source of the larger group read 1.8 times the
      // rows of one of the smaller; with it, the same (65 rows).
      expect(large / small).toBeLessThan(1.25);
    }
  );
});
