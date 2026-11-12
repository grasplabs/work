// Recall by meaning (src/recall.ts, GRA-1769): the question's vector, as
// the host gives it, searched beside words and exact parts and fused with
// them by rank. Each test in the shared store, from empty storage, with
// vectors put for its chunks as the queue puts them, chosen so which is
// nearest is known.
import type {
  Access,
  AskModel,
  EmbedModel,
  HandOvers,
  Pack,
  Reader,
  RecallRequest,
} from "@grasp-os/brain-next/contract";
import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  packItemTokens,
  recallBudgetMax,
  vectorModelNameOf,
} from "../src/contract.ts";

/** The host's model calls: none are made here. */
const quietAsk: AskModel = async () => {
  await Promise.resolve();
  return { kind: "answer", text: "" };
};

/** The host's embedders, while no model runs. */
/** No hand-overs: these tests hand nothing over. */
const noHandOvers: HandOvers = {
  handOver: async () => {
    await Promise.resolve();
  },
};

const noEmbedders = {
  model: null,
  embed: async () => {
    await Promise.resolve();
    return { kind: "unavailable" as const };
  },
};

/** This test's store: one of its own. */
const store = () => env.BRAIN_STORE.getByName("brain");

/** The host's model, as its embedder names it. */
const model: EmbedModel = { name: "meaning-test", build: "1" };

/** Dimensions of the vectors here: few, each test's directions its own. */
const dimensions = 8;

/** A vector pointing along `axis`, a little along every other. */
const along = (axis: number): number[] =>
  Array.from({ length: dimensions }, (_, at) => (at === axis ? 1 : 0.05));

const reader: Reader = { person: "reader", groups: [] };
const own: Access = { kind: "owner", person: reader.person };
const whole = { tokens: recallBudgetMax };

/** Adds `text` to a source of its own as `access` says: its key and version. */
const added = async (
  text: string,
  access: Access = own,
  source = `meaning:${crypto.randomUUID()}`
): Promise<{ source: string; version: number }> =>
  await store().addSource({
    source,
    change: crypto.randomUUID(),
    text,
    access,
  });

/** Puts `vector` for the first chunk of `version`, as the queue would. */
const putFor = async (
  { source, version }: { source: string; version: number },
  vector: number[]
): Promise<void> => {
  await store().putVectors({
    model: {
      name: vectorModelNameOf(model),
      centre: Array.from({ length: dimensions }, () => 0),
    },
    vectors: [{ chunk: { source, version, position: 0 }, vector }],
  });
};

/** Recalls `question` as the reader, whole, by meaning with `vector` when given. */
const recall = async (
  question: string,
  vector?: number[],
  more: Partial<RecallRequest> = {}
): Promise<Pack> =>
  await store().recall({
    question,
    reader,
    budget: whole,
    ...(vector === undefined ? {} : { meaning: { model, vector } }),
    ...more,
  });

/** What a pack cites, each item as its source, version and how it was found. */
const cited = ({ items }: Pack) =>
  items.map(({ source, version, found }) => ({ source, version, found }));

describe("recall by meaning", () => {
  // Each test from empty storage: the shared store and the bucket.
  beforeEach(async () => {
    await reset();
  });

  it("finds a passage that shares no word with the question, quotes its opening, and counts none of the question's words as found", async () => {
    const opening = "The supplier sends the invoice on the first of the month.";
    const english = await added(
      `${opening} Payment is due within thirty days of that date.`
    );
    await putFor(english, along(0));
    const question = "Wanneer betalen wij de leverancier?";
    const byWords = await recall(question);
    const quoted = packItemTokens({
      ...english,
      position: 0,
      text: opening,
      whole: false,
      found: "meaning",
    });

    const byMeaning = await recall(question, along(0));
    const inPart = await recall(question, along(0), {
      budget: { tokens: quoted },
    });

    expect({
      byWords: byWords.items,
      byMeaning: cited(byMeaning),
      notFound: byMeaning.notFound,
      inPart: inPart.items.map(({ text, whole: all }) => ({ text, all })),
    }).toStrictEqual({
      byWords: [],
      byMeaning: [{ ...english, found: "meaning" }],
      notFound: byWords.notFound,
      inPart: [{ text: opening, all: false }],
    });
    expect(byWords.notFound).not.toStrictEqual([]);
  });

  it("ranks a passage found by words and by meaning above those either found alone, and says it was found by words", async () => {
    // The words way lists `short` first, then `both`; meaning lists
    // `meant` first, then `both`: `short` has no vector yet.
    const both = await added(
      "The pallet count for the new warehouse is checked twice every Monday morning."
    );
    const short = await added("The pallet count is low.");
    const meant = await added("Nothing here shares a word with the question.");
    await putFor(both, along(1));
    await putFor(meant, along(2));
    const nearMeantThenBoth = along(2).map((value, axis) =>
      axis === 1 ? 0.6 : value
    );

    const pack = await recall("pallet", nearMeantThenBoth);

    expect(cited(pack)).toStrictEqual([
      { ...both, found: "words" },
      { ...short, found: "words" },
      { ...meant, found: "meaning" },
    ]);
  });

  it("goes by words and exact parts alone, exactly as without a vector, for a build it holds no vectors of, a vector of other dimensions, or a question of no word", async () => {
    const invoice = await added("Invoice INV-2041 is paid in full.");
    // Near the vector asked, so any list by meaning would hold it.
    const pallets = await added("A pallet count, nothing else.");
    await putFor(invoice, along(3));
    await putFor(pallets, along(3));
    const question = "Is INV-2041 paid?";
    const without = await recall(question);

    const answers = {
      otherBuild: await recall(question, undefined, {
        meaning: { model: { ...model, build: "2" }, vector: along(3) },
      }),
      otherDimensions: await recall(question, [...along(3), 1]),
      noWord: await recall(" ?! ", along(3)),
    };

    expect(answers).toStrictEqual({
      otherBuild: without,
      otherDimensions: without,
      noWord: await recall(" ?! "),
    });
    expect(cited(without)).toStrictEqual([{ ...invoice, found: "exact" }]);
  });

  it("never finds by meaning what the reader may not read, and that changes nothing of what they find", async () => {
    const mine = await added("A note of the reader's own.");
    await putFor(mine, along(4));
    const question = "Wie mag dit lezen?";
    const before = await recall(question, along(6));

    const theirs = await added("Someone else's note.", {
      kind: "owner",
      person: "someone else",
    });
    await putFor(theirs, along(6));
    const after = await recall(question, along(6));

    expect({ before: cited(before), after }).toStrictEqual({
      before: [{ ...mine, found: "meaning" }],
      after: before,
    });
  });

  it("as of a moment, answers exactly as without a vector, by words and exact parts alone", async () => {
    // An older version near the question, and readable sources added since
    // nearer still: as of a moment between them, a scan by meaning would
    // find only the newer ones and keep none.
    const source = `meaning:${crypto.randomUUID()}`;
    const older = await added(
      "Het eerste concept van de afspraak.",
      own,
      source
    );
    await putFor(older, along(7));
    await scheduler.wait(5);
    const between = new Date();
    await scheduler.wait(5);
    const current = await added("The agreement as signed.", own, source);
    await putFor(current, along(7));
    const newer = await added("A note added since, nearest of all.");
    await putFor(newer, along(7));
    const question = "Welke versie van de afspraak geldt?";

    const unbounded = await recall(question, along(7));
    const answers = {
      between: await recall(question, along(7), { asOf: between }),
      now: await recall(question, along(7), { asOf: new Date() }),
      byMeaningNow: unbounded.items
        .filter(({ found }) => found === "meaning")
        .map((item) => item.source)
        .toSorted(),
    };

    expect(answers).toStrictEqual({
      between: await recall(question, undefined, { asOf: between }),
      now: await recall(question, undefined, { asOf: new Date() }),
      byMeaningNow: [current.source, newer.source].toSorted(),
    });
  });

  it("never cites an erased source or an erased person's own content by meaning", async () => {
    const erased = await added("A source erased for good.");
    const person = `person-${crypto.randomUUID()}`;
    const theirs = await added("Their own note, erased with them.", {
      kind: "owner",
      person,
    });
    await putFor(erased, along(0));
    await putFor(theirs, along(1));

    await store().eraseSource({ source: erased.source, reason: "deleted" });
    await store().erasePerson({ person, reason: "person_erased" });

    const asReader = await recall("Wat is er nog?", along(0));
    const asPerson = await store().recall({
      question: "Wat is er nog?",
      reader: { person, groups: [] },
      budget: whole,
      meaning: { model, vector: along(1) },
    });
    expect({
      asReader: asReader.items,
      asPerson: asPerson.items,
    }).toStrictEqual({ asReader: [], asPerson: [] });
  });

  it("never lets hidden passages crowd a live one out of meaning, from the moment an erasure hides them", async () => {
    // 300 chunks of the asking's own (more than the scan re-scores) at the
    // question itself, and a passage their team reads one bit farther off.
    const team = `team-${crypto.randomUUID()}`;
    const asking: Reader = {
      person: `person-${crypto.randomUUID()}`,
      groups: [team],
    };
    const live = await added("The live passage.", {
      kind: "audience",
      group: team,
    });
    const crowd = await added(
      Array.from({ length: 300 }, (_, at) =>
        `Hidden ${at} `.padEnd(650, "x")
      ).join("\n\n"),
      { kind: "owner", person: asking.person }
    );
    const question = Array.from({ length: dimensions }, () => 1);
    const centre = Array.from({ length: dimensions }, () => 0);
    for (let start = 0; start < 300; start += 150) {
      // oxlint-disable-next-line no-await-in-loop -- one put at a time
      await store().putVectors({
        model: { name: vectorModelNameOf(model), centre },
        vectors: Array.from({ length: 150 }, (_, at) => ({
          chunk: { ...crowd, position: start + at },
          vector: question,
        })),
      });
    }
    await putFor(
      live,
      question.map((value, at) => (at === 0 ? -0.5 : value))
    );
    const found = async (): Promise<string[]> => {
      const { items } = await store().recall({
        question: "Unheardof",
        reader: asking,
        budget: whole,
        meaning: { model, vector: question },
      });
      return [...new Set(items.map(({ source }) => source))];
    };
    const before = await found();
    // The ledger write fails: the erasure has hidden them, and fails.
    const switched = { failing: true };
    await runInDurableObject(store(), (instance) => {
      const objectEnv: unknown = Reflect.get(instance, "env");
      if (typeof objectEnv !== "object" || objectEnv === null) {
        throw new TypeError("The store has no env");
      }
      const bucket = env.BRAIN_OBJECTS;
      Reflect.set(instance, "env", {
        ...objectEnv,
        BRAIN_OBJECTS: {
          get: async (key: string) => await bucket.get(key),
          head: async (key: string) => await bucket.head(key),
          list: async (options: R2ListOptions) => await bucket.list(options),
          delete: async (keys: string | string[]) => {
            await bucket.delete(keys);
          },
          put: async (
            key: string,
            value: ArrayBufferView | string,
            options?: R2PutOptions
          ) => {
            if (switched.failing && key.startsWith("erasures/")) {
              throw new Error("R2 failed, by the test");
            }
            return await bucket.put(key, value, options);
          },
        },
      });
    });

    let failed = false;
    try {
      await store().eraseSource({ source: crowd.source, reason: "deleted" });
    } catch {
      failed = true;
    }
    const hiddenFound = await found();
    const overview = await store().workOverview();
    const hidden = { found: hiddenFound, erasing: overview.erasing };
    switched.failing = false;
    await store().eraseSource({ source: crowd.source, reason: "deleted" });
    const erased = await found();
    await store().work(quietAsk, new Date(), noEmbedders, noHandOvers);
    const ticked = await found();

    expect({ before, failed, hidden, erased, ticked }).toStrictEqual({
      before: [crowd.source],
      failed: true,
      hidden: { found: [live.source], erasing: 1 },
      erased: [live.source],
      ticked: [live.source],
    });
  });
});
