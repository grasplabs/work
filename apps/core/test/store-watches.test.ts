import { querySubscriptionLimits } from "@grasp-os/shared/screens";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";

import { storeMaxWatches } from "../src/store-watches.ts";
import {
  fill,
  newStore,
  objectOf,
  pendingStore,
  v1,
  consumer,
} from "./pending-stores.ts";

// The live queries a business store's object keeps (store-watches.ts),
// through its RPC surface as core calls it: told of every write that
// moves a table's generation, a backfill's batch as much as a commit;
// and its bounds, which watches whose screens are gone must not fill for
// everyone.

/**
 * A watcher as core passes one, and what it was told. One whose screen
 * is gone (`answers` false) never answers, as a connection that died
 * without a word doesn't.
 */
const watcherOf = (answers = true) => {
  const told: string[][] = [];
  // The store waits for what its call of a watcher answers: a dead one's
  // never comes, which is the point.
  // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- see above
  const watcher: (tables: string[]) => void = async (tables) => {
    told.push(tables);
    if (!answers) {
      await Promise.withResolvers<never>().promise;
    }
  };
  return { told, watcher };
};

/** The store's current generation of `notes`. */
const notesGeneration = async (
  store: Awaited<ReturnType<typeof newStore>>
): Promise<number> => {
  const generations = await objectOf(store).generations(store.id, ["notes"]);
  return generations.notes ?? 0;
};

describe("a store's live queries", { timeout: 120_000 }, () => {
  it("tells a watch of a backfill's batch, not only of commits", async () => {
    const { store, second } = await pendingStore(3);
    const { told, watcher } = watcherOf();
    await objectOf(store).watch(
      store.id,
      "ada",
      { notes: await notesGeneration(store) },
      watcher
    );

    await fill(store, second.contract.hash, 1);

    await vi.waitFor(() => {
      expect(told).toContainEqual(["notes"]);
    });
  });

  it("answers that a write moved past a new watch's read with its ID, not through a watcher core can't match yet", async () => {
    const { store } = await pendingStore(1);
    const { told, watcher } = watcherOf();
    const generation = await notesGeneration(store);

    const made = await objectOf(store).watch(
      store.id,
      "ada",
      { notes: generation - 1 },
      watcher
    );
    await scheduler.wait(100);

    expect({ moved: made.moved, told }).toStrictEqual({
      moved: true,
      told: [],
    });
  });

  it("lets go of everyone's dead watches when the store is full, so a newcomer still gets one", async () => {
    const store = await newStore();
    await store.defineTables(v1, consumer(1));
    const people = Math.ceil(
      storeMaxWatches / querySubscriptionLimits.perPerson
    );
    const dead = watcherOf(false).watcher;
    for (let person = 0; person < people; person += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one person's at a time
      await Promise.all(
        Array.from(
          { length: querySubscriptionLimits.perPerson },
          async () =>
            await objectOf(store).watch(store.id, `gone-${person}`, {}, dead)
        )
      );
    }

    await expect(
      objectOf(store).watch(store.id, "newcomer", {}, watcherOf().watcher)
    ).resolves.toHaveProperty("id");
  });

  it("brings a later alarm forward so it sweeps soon after a watch", async () => {
    const store = await newStore();
    await store.defineTables(v1, consumer(1));
    const hour = 60 * 60 * 1000;
    await runInDurableObject(objectOf(store), async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + hour);
    });

    await objectOf(store).watch(store.id, "ada", {}, watcherOf().watcher);

    const alarm = await runInDurableObject(
      objectOf(store),
      async (_instance, state) => await state.storage.getAlarm()
    );
    expect((alarm ?? Number.POSITIVE_INFINITY) - Date.now()).toBeLessThan(
      10 * 60 * 1000
    );
  });

  it("sweeps the watches whose screens are gone from its alarm", async () => {
    const store = await newStore();
    await store.defineTables(v1, consumer(1));
    const gone = watcherOf(false);
    await objectOf(store).watch(store.id, "ada", {}, gone.watcher);

    await runDurableObjectAlarm(objectOf(store));

    // Asked whether it is still there (with no tables), and let go of.
    expect(gone.told).toStrictEqual([[]]);
  });
});
