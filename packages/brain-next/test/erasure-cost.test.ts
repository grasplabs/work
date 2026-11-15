import type {
  Access,
  AskModel,
  EmbedModel,
  Embedders,
  HandOvers,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { BrainStore } from "../src/store.ts";
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

// What a version letting go of its texts costs (files.ts `releaseVectors`,
// as a version stops being current or is erased): the passages a model
// couldn't embed are forgotten by their texts, every model's at once, so
// the store's `unembeddable` is read by text, not walked whole for each
// version. Filled through the store's own embedding, by host embedders
// whose model refuses every passage: the outside system faked, as the
// embedders are the host's.

/** A model that can't embed any passage, as the host's embedders say of it. */
const refusingModel: EmbedModel = { name: "refusing", build: "1" };

/** The host's embedders, running `refusingModel`. */
const refusing: Embedders = {
  model: refusingModel,
  embed: async ({ texts }) => {
    await Promise.resolve();
    return {
      kind: "vectors",
      model: refusingModel,
      results: texts.map(() => "unembeddable" as const),
    };
  },
};

/** A model that answers nothing: no work here asks one. */
const quietAsk: AskModel = async () => {
  await Promise.resolve();
  return { kind: "answer", text: "" };
};

/** No side of hand-overs: a person's own store queues none. */
const noHandOvers: HandOvers = {
  handOver: async () => {
    await Promise.resolve();
    return { kind: "nothing" };
  },
};

/**
 * Rows an index seek may read more as the indexes grow deeper: a walk of
 * the table would read a row or more for each passage kept.
 */
const seekMargin = 3;

/** Most ticks a store is given to embed what it was given. */
const ticksMax = 200;

/** How many passages `store` keeps as ones its model couldn't embed. */
const unembeddableIn = async (
  store: DurableObjectStub<BrainStore>
): Promise<number> =>
  await runInDurableObject(
    store,
    (_instance, state) =>
      state.storage.sql
        .exec<{ kept: number }>("SELECT count(*) AS kept FROM unembeddable")
        .one().kept
  );

/**
 * The rows read by a new version of a source, and by its erasure, in a
 * store that keeps `unrelated` other passages its model couldn't embed.
 */
const rowsLettingGo = async (
  unrelated: number
): Promise<{ replaced: number; erased: number }> => {
  const person = `person-${crypto.randomUUID()}`;
  const access: Access = { kind: "owner", person };
  const store = env.BRAIN_STORE.getByName(`person:${person}`);
  for (let at = 0; at < unrelated; at += addingAtOnce) {
    // oxlint-disable-next-line no-await-in-loop -- a few at a time
    await Promise.all(
      Array.from(
        { length: Math.min(addingAtOnce, unrelated - at) },
        async (_, index) =>
          await store.addSource({
            source: `test:unrelated-${at + index}`,
            change: "1",
            text: `Numbat note ${at + index}`,
            access,
          })
      )
    );
  }
  const source = `test:${crypto.randomUUID()}`;
  await store.addSource({ source, change: "1", text: "Quoll first", access });
  // Ticked until every passage was refused, one tick after the other.
  for (let tick = 0; ; tick += 1) {
    // oxlint-disable-next-line no-await-in-loop -- read after each tick
    if ((await unembeddableIn(store)) > unrelated) {
      break;
    }
    if (tick >= ticksMax) {
      throw new Error(
        `The store didn't take its passages in ${ticksMax} ticks`
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- one tick after the other
    await store.work({
      ask: quietAsk,
      at: new Date(),
      embedders: refusing,
      handOvers: noHandOvers,
      contextTokens: null,
    });
  }
  const rowsReadBy = await countRowsRead(store);
  const replaced = await rowsReadBy(
    async () =>
      await store.addSource({
        source,
        change: "2",
        text: "Quoll second",
        access,
      })
  );
  const erased = await rowsReadBy(
    async () => await store.eraseSource({ source, reason: "deleted" })
  );
  return { replaced, erased };
};

describe("a version letting go of its texts", () => {
  it(
    "reads no more rows however many other passages its store couldn't embed",
    { timeout: 120_000 },
    async () => {
      const few = await rowsLettingGo(20);
      const many = await rowsLettingGo(200);

      // Within what an index seek touches more as its tree grows deeper.
      // Before `unembeddable` was indexed by text, the store holding 180
      // more such passages read 179 more rows for the new version and 359
      // for the erasure (it lets go of both versions); with it, the same,
      // give or take a row as the sources' random keys sort.
      expect(
        Math.max(many.replaced - few.replaced, many.erased - few.erased)
      ).toBeLessThanOrEqual(seekMargin);
    }
  );
});
