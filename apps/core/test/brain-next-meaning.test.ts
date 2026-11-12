import { brainOf, recallBudgetMax } from "@grasp-os/brain-next/contract";
import type { Pack } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import {
  calls,
  int8Model,
  poisonWord,
  putTestModel,
} from "../../../packages/embed/test/test-models.ts";
import type {
  BreakableEmbedder,
  Breakage,
} from "../../../packages/embed/test/test-models.ts";
import {
  addSource,
  brainWorkOverview,
  recallAs,
  workBrain,
} from "../src/brain-next.ts";
import type {
  RecalledPack,
  SourceReaders,
  SourceRef,
} from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { soleReadersOf } from "./brain-next-sole-readers.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole } from "./sign-in.ts";

// Recall by meaning through core (GRA-1769), with the embed package's
// int8 test model as if it shipped and core's EMBEDDER bound to its
// breakable embedder (vite.brain-meaning.config.ts). Core embeds the
// question with its question embedder and hands the vector on with its
// build; however that embedder fails, every recall answers, exactly as
// recall by words and exact parts alone, and the log says why, with
// nothing of the question or the person.

const idp = mockIdp();

/** `value`, as the type its binding has in this project. */
const asBound = (value: unknown): never =>
  // SAFETY: vite.brain-meaning.config.ts binds EMBEDDER to
  // `BreakableEmbedder`, which core's `Embedder` type doesn't know.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  value as never;

/** Core's embedders, as this project binds them. */
const embedders = (): DurableObjectNamespace<BreakableEmbedder> =>
  asBound(env.EMBEDDER);

/** Core's question embedder: the object every question goes to. */
const questions = () => embedders().getByName("questions");

const store = () => brainOf(inJurisdiction(env, env.BRAIN_STORE));

const english =
  "The supplier sends the invoice on the first day of every month. Payment is due thirty days later.";

/** A question in Dutch sharing no word with the passage. */
const question = "Wanneer moeten wij de leverancier betalen?";

/** A second passage, in Dutch, sharing a word with `withWords` only. */
const dutch = "Pallets staan klaar in hal drie.";

/** A question the words way finds `dutch` for. */
const withWords = `${question} En de pallets?`;

/** Ticks of the Brain's work, an hour apart, until every passage is embedded. */
const embedEverything = async (): Promise<void> => {
  let at = Date.now();
  for (let tick = 0; tick < 50; tick += 1) {
    at += 60 * 60 * 1000;
    // oxlint-disable-next-line no-await-in-loop -- one tick at a time, as core's clock
    await workBrain(env, new Date(at));
    // oxlint-disable-next-line no-await-in-loop -- read after each tick
    const { embedding } = await brainWorkOverview(env);
    if (
      embedding.rebuilt &&
      embedding.embedded + embedding.unembeddable === embedding.chunks
    ) {
      return;
    }
  }
  throw new Error("Not every passage was embedded");
};

/** What core logged as warnings while `run` ran, and its answer. */
const warnedOf = async <T>(
  run: () => Promise<T>
): Promise<{ value: T; warned: unknown[] }> => {
  const warned: unknown[] = [];
  const spy = vi
    .spyOn(console, "warn")
    .mockImplementation((...args: unknown[]) => {
      warned.push(...args);
    });
  try {
    return { value: await run(), warned };
  } finally {
    spy.mockRestore();
  }
};

describe("recall by meaning, through core", () => {
  let personId = "";
  /** The team of the person alone their sources are for. */
  let readers: SourceReaders = { kind: "none" };
  /** The person's sources, by the Brain's key for each (core's brain-next.ts). */
  const sources = new Map<string, SourceRef>();

  /**
   * The pack the store gives the person by words and exact parts alone,
   * each item citing its source as core does.
   */
  const withoutMeaning = async (asked: string): Promise<RecalledPack> => {
    const pack: Pack = await store().recall({
      question: asked,
      reader: {
        person: personId,
        groups: readers.kind === "team" ? [`team:${readers.teamId}`] : [],
      },
      budget: { tokens: recallBudgetMax },
    });
    return {
      ...pack,
      items: pack.items.map((item) => ({
        ...item,
        source: sources.get(item.source) ?? { producer: "upload", id: "" },
      })),
    };
  };

  /** What core recalls for `asked`, as the person, and what it logged. */
  const recalled = async (asked: string) =>
    await warnedOf(
      async () =>
        await recallAs(env, personId, {
          personal: true,
          question: asked,
          budget: { tokens: recallBudgetMax },
        })
    );

  beforeAll(async () => {
    await putTestModel(env.MODEL_FILES, int8Model);
  });

  /**
   * The person and their passage, embedded, once for the file: inside the
   * first test, as the identity provider answers inside a test only.
   */
  const setUp = async (): Promise<void> => {
    if (personId !== "") {
      return;
    }
    ({ userId: personId } = await signedInWithRole(idp, "user"));
    // In the shared store, which core's clock embeds: a person's own store
    // does its own work (its alarm).
    readers = await soleReadersOf(personId);
    for (const text of [english, dutch]) {
      const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
      sources.set(`${source.producer}:${source.id}`, source);
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await addSource(env, {
        source,
        change: crypto.randomUUID(),
        text,
        readers,
      });
    }
    await embedEverything();
    // Loaded once, as core's clock warms it, so no question waits for it.
    await questions().embed("Warm-up.");
  };

  beforeEach(async () => {
    await questions().breakAs(null);
    await setUp();
  });

  it("finds a passage that shares no word with the question by meaning, and logs nothing", async () => {
    const { value, warned } = await recalled(question);
    const byWords = await withoutMeaning(question);

    expect({
      english: value.items
        .filter(({ text }) => text === english)
        .map(({ found }) => found),
      byWords: byWords.items,
      warned,
    }).toStrictEqual({
      english: ["meaning"],
      byWords: [],
      warned: [],
    });
  });

  it.for<{ breakage: Breakage; asked: string; reason: string }>([
    { breakage: "held", asked: withWords, reason: "timed_out" },
    { breakage: "crash", asked: withWords, reason: "failed" },
    {
      breakage: "trap",
      asked: `${withWords} ${poisonWord}`,
      reason: "refused",
    },
    { breakage: "nan", asked: withWords, reason: "unusable" },
    { breakage: "zeros", asked: withWords, reason: "unusable" },
  ])(
    "answers by words and exact parts alone when the question embedder is $breakage, logging $reason and nothing of the question or the person",
    async ({ breakage, asked, reason }) => {
      await questions().breakAs(breakage);

      const { value, warned } = await recalled(asked);
      await questions().breakAs(null);

      const byWords = await withoutMeaning(asked);
      const said = JSON.stringify(warned);
      expect({
        pack: value,
        byWords: byWords.items.map(({ text, found }) => ({ text, found })),
        warned,
        tellsQuestion: said.includes("leverancier"),
        tellsPerson: said.includes(personId),
      }).toStrictEqual({
        pack: byWords,
        byWords: [{ text: dutch, found: "words" }],
        warned: [{ event: "brain.recall.without_meaning", reason }],
        tellsQuestion: false,
        tellsPerson: false,
      });
    }
  );

  it("asks the question embedder nothing as of a moment, and logs nothing", async () => {
    // Held: a call would wait for the deadline and log it.
    await questions().breakAs("held");
    const before = calls.length;

    const { value, warned } = await warnedOf(
      async () =>
        await recallAs(env, personId, {
          personal: true,
          question: withWords,
          budget: { tokens: recallBudgetMax },
          asOf: new Date(),
        })
    );
    const asked = calls
      .slice(before)
      .filter(({ texts }) => texts.includes(withWords)).length;
    await questions().breakAs(null);

    expect({
      asked,
      warned,
      found: value.items.map(({ text, found }) => ({ text, found })),
    }).toStrictEqual({
      asked: 0,
      warned: [],
      found: [{ text: dutch, found: "words" }],
    });
  });
});
