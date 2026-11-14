// What staff see of recall (src/recall-counts.ts, GRA-1800): per way, how
// many recalls searched by it and how many it failed, and how many
// recalls the host made without the question's vector, by why; since the
// store started. Each test in the shared store from empty storage
// (`reset`), a new instance, so the counts start from nothing.
import type {
  Access,
  EmbedModel,
  Reader,
  RecallRequest,
  WorkOverview,
} from "@grasp-os/brain-next/contract";
import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { recallBudgetMax, vectorModelNameOf } from "../src/contract.ts";

/** This test's store: one of its own. */
const store = () => env.BRAIN_STORE.getByName("brain");

/** The host's model, as its embedder names it. */
const model: EmbedModel = { name: "counts-test", build: "1" };

const dimensions = 4;
const vector = [1, 0.1, 0.1, 0.1];

const reader: Reader & { person: string } = { person: "reader", groups: [] };
const own: Access = { kind: "owner", person: reader.person };

/** Adds `text` to a source of its own, with a vector for its first chunk. */
const addWithVector = async (text: string): Promise<void> => {
  const { source, version } = await store().addSource({
    source: `counts:${crypto.randomUUID()}`,
    change: crypto.randomUUID(),
    text,
    access: own,
  });
  await store().putVectors({
    model: {
      name: vectorModelNameOf(model),
      centre: Array.from({ length: dimensions }, () => 0),
    },
    vectors: [{ chunk: { source, version, position: 0 }, vector }],
  });
};

/** Recalls `question` as the reader, whole, with `more`. */
const recall = async (question: string, more: Partial<RecallRequest> = {}) =>
  await store().recall({
    question,
    reader,
    budget: { tokens: recallBudgetMax },
    ...more,
  });

/** The overview's recall counts. */
const countsOf = ({ recall: { ways, withoutMeaning } }: WorkOverview) => ({
  ways,
  withoutMeaning,
});

const counts = async () => countsOf(await store().workOverview());

/** A way's counts. */
const way = (recalls: number, failed = 0) => ({ recalls, failed });

/** `value` as a type it isn't: what a caller outside TypeScript could send. */
const unchecked = (value: unknown): never =>
  // SAFETY: the store checks what it is given; this hands it what the
  // type rules out, as a caller outside TypeScript could.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  value as never;

const noneWithout = { timed_out: 0, failed: 0, refused: 0, unusable: 0 };

describe("recall's counts, as staff see them", () => {
  beforeEach(async () => {
    await reset();
  });

  it("counts each recall by the ways its question had something for, as of a moment never by meaning", async () => {
    await addWithVector("The invoice INV-2026-17 is paid by the supplier.");
    const meaning = { model, vector };
    const before = await counts();

    // Words alone; words and exact; words, exact and meaning; meaning as
    // of a moment is never searched; an empty question runs no way.
    await recall("supplier invoice");
    await recall("INV-2026-17 paid");
    await recall('"paid by the supplier"', { meaning });
    await recall("supplier", { meaning, asOf: new Date() });
    await recall("", { meaning });
    const after = await counts();

    expect({ before, after }).toStrictEqual({
      before: {
        ways: {
          words: way(0),
          exact: way(0),
          entities: way(0),
          meaning: way(0),
        },
        withoutMeaning: noneWithout,
      },
      // The entities way looks for names in every question of some word.
      after: {
        ways: {
          words: way(4),
          exact: way(2),
          entities: way(4),
          meaning: way(1),
        },
        withoutMeaning: noneWithout,
      },
    });
  });

  it("counts a way whose search failed as failed, and the recall fails", async () => {
    await addWithVector("The pallets wait in hall three.");
    const meaning = { model, vector };
    // The vector way's codes can't be read: the store holds a vector of
    // the model, but its scan fails.
    await runInDurableObject(store(), (_instance, state) => {
      state.storage.sql.exec("ALTER TABLE vector_codes RENAME TO codes_away");
    });

    await expect(recall("pallets", { meaning })).rejects.toThrow(
      "no such table: vector_codes"
    );
    const afterMeaning = await counts();
    await runInDurableObject(store(), (_instance, state) => {
      state.storage.sql.exec("ALTER TABLE chunk_words RENAME TO words_away");
    });
    await expect(recall("pallets")).rejects.toThrow(
      "no such table: chunk_words"
    );
    const afterWords = await counts();

    expect({ afterMeaning, afterWords }).toStrictEqual({
      afterMeaning: {
        // Meaning failed before the entities way ran.
        ways: {
          words: way(1),
          exact: way(0),
          entities: way(0),
          meaning: way(1, 1),
        },
        withoutMeaning: noneWithout,
      },
      // Words failed first: no other way ran.
      afterWords: {
        ways: {
          words: way(2, 1),
          exact: way(0),
          entities: way(0),
          meaning: way(1, 1),
        },
        withoutMeaning: noneWithout,
      },
    });
  });

  it("counts the recalls the host made without meaning by why, and refuses a reason with a vector or one it doesn't know", async () => {
    await addWithVector("The pallets wait in hall three.");

    await recall("pallets", { withoutMeaning: "timed_out" });
    await recall("pallets", { withoutMeaning: "timed_out" });
    await recall("pallets", { withoutMeaning: "unusable" });
    // A question of no word still went without meaning.
    await recall(" ", { withoutMeaning: "refused" });
    await expect(
      recall("pallets", {
        withoutMeaning: "failed",
        meaning: { model, vector },
      })
    ).rejects.toThrow("Gives a vector and why it has none");
    await expect(
      recall("pallets", { withoutMeaning: "failed", asOf: new Date() })
    ).rejects.toThrow(
      "Gives why it has no vector for a moment that takes none"
    );
    await expect(
      recall("pallets", { withoutMeaning: unchecked("slow") })
    ).rejects.toThrow("The Brain refused it");

    await expect(counts()).resolves.toStrictEqual({
      ways: {
        words: way(3),
        exact: way(0),
        entities: way(3),
        meaning: way(0),
      },
      withoutMeaning: { timed_out: 2, failed: 0, refused: 1, unusable: 1 },
    });
  });

  it("starts from nothing again, with a later start, once the store restarted", async () => {
    await addWithVector("The pallets wait in hall three.");
    await recall("pallets", { withoutMeaning: "failed" });
    const { recall: before } = await store().workOverview();
    // So the next instance starts a moment later.
    await scheduler.wait(5);

    // The abort breaks the call that made it too.
    await expect(
      runInDurableObject(store(), (_instance, state) => {
        state.abort("Killed by the test");
      })
    ).rejects.toThrow("Killed by the test");
    const after = await store().workOverview();

    expect({
      before: before.ways.words.recalls,
      later: after.recall.since.getTime() > before.since.getTime(),
      after: countsOf(after),
    }).toStrictEqual({
      before: 1,
      later: true,
      after: {
        ways: {
          words: way(0),
          exact: way(0),
          entities: way(0),
          meaning: way(0),
        },
        withoutMeaning: noneWithout,
      },
    });
  });
});
