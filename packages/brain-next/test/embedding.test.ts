// Embedding through the work queue (src/embedding.ts), driven as core's
// clock drives the store (`work`, a tick at the clock's time), with the
// embed package's bulk embedders running its tiny test models as the
// host's embedders: each test in the shared store, from empty storage. What a reader finds
// by meaning is asked through the store's vector search, with the
// question embedded by the same model.
import type {
  Access,
  AskModel,
  EmbedModel,
  Embedders,
  EmbeddingOverview,
  HandOvers,
} from "@grasp-os/brain-next/contract";
import { questionEmbedder } from "@grasp-os/embed/embedder";
import type { Embedder } from "@grasp-os/embed/embedder";
import { modelIdentity } from "@grasp-os/embed/model-files";
import { bulkEmbedders, embedWithPool } from "@grasp-os/embed/pool";
import { reset, runInDurableObject } from "cloudflare:test";
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
  floatModel,
  int8Model,
  putTestModel,
  poisonWord,
} from "../../embed/test/test-models.ts";
import type {
  BreakableEmbedder,
  Breakage,
} from "../../embed/test/test-models.ts";
import { vectorModelNameOf } from "../src/contract.ts";
import { bucketCallMs, embedBatch } from "../src/embedding.ts";
import {
  fileGraceMs,
  hashOf,
  sweepDeleteMs,
  vectorKeyOf,
} from "../src/files.ts";
import { workAttemptsMax } from "../src/work.ts";

/** No hand-overs: these tests hand nothing over. */
const noHandOvers: HandOvers = {
  handOver: async () => {
    await Promise.resolve();
  },
};

/** The test models' identities, as their embedders give them. */
let int8: EmbedModel;
let float: EmbedModel;

/** This test's store: one of its own, so its counts are its own. */
const store = () => env.BRAIN_STORE.getByName("brain");

/** Every passage the host's embedders were asked to embed, in this test. */
const asked: string[] = [];

/** Breaks the bulk embedders of `namespace` as `breakage`, or mends them (null). */
const breakBulk = async (
  breakage: Breakage | null,
  namespace: DurableObjectNamespace<BreakableEmbedder> = env.EMBEDDER
): Promise<void> => {
  await Promise.all(
    Array.from({ length: bulkEmbedders }, async (_, index) => {
      await namespace.getByName(`bulk-${index}`).breakAs(breakage);
    })
  );
};

/** The host's model: it is never asked here, and answers nothing. */
const quietAsk: AskModel = async () => {
  await Promise.resolve();
  return { kind: "answer", text: "" };
};

/**
 * Embedders as core gives them: the bulk pool of `namespace`, running
 * `model`, every passage noted; each call first waits for `before`.
 */
const embeddersOf = (
  model: EmbedModel | null,
  namespace: DurableObjectNamespace<Embedder> = env.EMBEDDER,
  before?: () => Promise<void>
): Embedders => ({
  model,
  embed: async ({ texts, timeoutMs }) => {
    asked.push(...texts);
    await before?.();
    return await embedWithPool(namespace, texts, { timeoutMs });
  },
});

/** The queue's clock across the file: only forward, as core's clock goes. */
const clock = { at: Date.now() };
const tick = async (embedders: Embedders, aheadMs = 0): Promise<void> => {
  clock.at = Math.max(clock.at, Date.now()) + aheadMs;
  await store().work(quietAsk, new Date(clock.at), embedders, noHandOvers);
};

/** A paragraph of its own, about 800 characters: one chunk. */
const paragraph = (topic: string, index: number): string =>
  `${topic} ${index}: ${`${topic} paragraph ${index} talks about invoice ${index} and its supplier. `.repeat(15)}`.trimEnd();

/** A text of `count` chunks about `topic`. */
const textOf = (topic: string, count: number): string =>
  Array.from({ length: count }, (_, index) => paragraph(topic, index)).join(
    "\n\n"
  );

const ownedBy = (person: string): Access => ({ kind: "owner", person });

const add = async (
  source: string,
  text: string,
  access: Access
): Promise<number> => {
  const { version } = await store().addSource({
    source,
    change: crypto.randomUUID(),
    text,
    access,
  });
  return version;
};

/** What `person` finds by meaning for `text`, by `model`'s question embedder. */
const found = async (
  person: string,
  text: string,
  model: EmbedModel = int8,
  namespace: DurableObjectNamespace<Embedder> = env.EMBEDDER
) => {
  const { vector } = await questionEmbedder(namespace).embed(text);
  const { chunks } = await store().searchVectors({
    model: vectorModelNameOf(model),
    vector: [...vector],
    reader: { person, groups: [] },
    limit: 50,
  });
  return chunks;
};

/** Where what `person` finds by meaning for `text` is: source, version and position. */
const placesFound = async (
  person: string,
  text: string,
  model?: EmbedModel,
  namespace?: DurableObjectNamespace<Embedder>
): Promise<string[]> => {
  const chunks = await found(person, text, model, namespace);
  return chunks
    .map(({ source, version, position }) => `${source}@${version}#${position}`)
    .toSorted();
};

/** How far embedding has come in this test's store. */
const embeddingNow = async () => {
  const { embedding } = await store().workOverview();
  return embedding;
};

const placesOf = (source: string, version: number, count: number): string[] =>
  Array.from(
    { length: count },
    (_, position) => `${source}@${version}#${position}`
  ).toSorted();

/** Runs `run` with the clock `ms` ahead: the store's too, in this isolate. */
const withDateAhead = async (ms: number, run: () => Promise<void>) => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + ms });
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
};

const encoder = new TextEncoder();

/** How many of `texts` have a vector by `model` in the bucket. */
const vectorsKept = async (
  model: EmbedModel,
  texts: readonly string[]
): Promise<number> => {
  const kept = await Promise.all(
    texts.map(async (text) => {
      const key = vectorKeyOf(
        vectorModelNameOf(model),
        await hashOf(encoder.encode(text))
      );
      return (await env.BRAIN_OBJECTS.head(key)) !== null;
    })
  );
  return kept.filter(Boolean).length;
};

/** How often `until` looks, and how many times before it gives up: 10 s. */
const untilEveryMs = 20;
const untilLooks = 500;

/**
 * Waits until `open` says so, failing with `what` after 10 s. It waits by
 * the runtime's `scheduler.wait`, which faked timers leave real.
 */
const until = async (open: () => boolean, what: string): Promise<void> => {
  for (let look = 0; !open(); look += 1) {
    if (look === untilLooks) {
      throw new Error(`Waited 10 s for ${what}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- until released
    await scheduler.wait(untilEveryMs);
  }
};

/**
 * Runs `run` with the clock and the timers faked, from `ms` ahead: the
 * store's too, in this isolate. Only the store moves them on (`holding`):
 * workerd fires a Durable Object's timer only in that object's context.
 */
const withTimersFaked = async (ms: number, run: () => Promise<void>) => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout"],
    now: Date.now() + ms,
  });
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
};

/**
 * Has this test's store reach the bucket through one that holds what
 * `hold` names until released: deletes that never land, or writes of
 * vectors that never answer (they land once released). Each held call
 * first moves the faked clock and timers (`withTimersFaked`) on by the ms
 * `hold` gives it: the store's deadline for the call passes, as if the
 * bucket had kept it waiting that long. Notes every vector it writes.
 */
const holding = async (hold: { deletes?: number; puts?: number }) => {
  const puts: string[] = [];
  const release = {
    deletes: hold.deletes === undefined,
    puts: hold.puts === undefined,
  };
  /** Writes landed: a count, as no request may wait on another's promise. */
  const writes = { landed: 0 };
  const real = env.BRAIN_OBJECTS;
  const bucket = {
    get: async (key: string) => await real.get(key),
    head: async (key: string) => await real.head(key),
    list: async (options?: R2ListOptions) => await real.list(options),
    put: async (key: string, value: ArrayBuffer | string) => {
      if (!key.startsWith("vectors/")) {
        return await real.put(key, value);
      }
      puts.push(key);
      if (!release.puts) {
        await vi.advanceTimersByTimeAsync(hold.puts ?? 0);
      }
      await until(() => release.puts, "the test to release a vector write");
      const written = await real.put(key, value);
      writes.landed += 1;
      return written;
    },
    delete: async (keys: string | string[]) => {
      if (!release.deletes) {
        await vi.advanceTimersByTimeAsync(hold.deletes ?? 0);
      }
      await until(() => release.deletes, "the test to release a delete");
      await real.delete(keys);
    },
  };
  await runInDurableObject(store(), (instance) => {
    Reflect.set(instance, "env", { ...env, BRAIN_OBJECTS: bucket });
  });
  return {
    puts,
    releaseDeletes: () => {
      release.deletes = true;
    },
    releasePuts: () => {
      release.puts = true;
    },
    /** Every write asked for so far, landed. */
    landed: async () => {
      await until(
        () => writes.landed === puts.length,
        "every vector write asked to land"
      );
    },
  };
};

/** What a test of the rebuild compares of an overview. */
const counts = (overview: EmbeddingOverview) => ({
  embedded: overview.embedded,
  chunks: overview.chunks,
  parked: overview.parked,
  rebuilt: overview.rebuilt,
});

/** A promise the host's embedders wait on, and one that says they reached it. */
const gate = () => {
  const reached = Promise.withResolvers<true>();
  const open = Promise.withResolvers<true>();
  return {
    reached: reached.promise,
    open: () => {
      open.resolve(true);
    },
    before: async () => {
      reached.resolve(true);
      await open.promise;
    },
  };
};

/** A tick whose end is only noted: it resolves however the tick ends. */
const tickNoting = async (embedders: Embedders): Promise<string> => {
  try {
    await tick(embedders);
    return "ended";
  } catch {
    return "broken";
  }
};

describe("embedding through the queue", () => {
  beforeAll(async () => {
    [int8, float] = await Promise.all([
      modelIdentity(int8Model),
      modelIdentity(floatModel),
    ]);
  });

  // Each test from empty storage: the shared store, the bucket and the
  // embedders' model files.
  beforeEach(async () => {
    await reset();
    await Promise.all([
      putTestModel(env.MODEL_FILES, int8Model),
      putTestModel(env.MODEL_FILES, floatModel),
    ]);
    asked.length = 0;
    await breakBulk(null);
  });

  it("embeds a source's chunks in batches, every chunk once, found only by its readers", async () => {
    const chunks = embedBatch + 4;
    const text = textOf("Rotterdam", chunks);
    const version = await add("doc", text, ownedBy("anna"));

    await tick(embeddersOf(int8));
    // The rebuild a first model starts is marked done at the next tick.
    await tick(embeddersOf(int8));

    const { embedding } = await store().workOverview();
    const [nearest] = await found("anna", paragraph("Rotterdam", 3));
    expect({
      anna: await placesFound("anna", paragraph("Rotterdam", 3)),
      nearest: nearest?.position,
      bert: await placesFound("bert", paragraph("Rotterdam", 3)),
      passagesEmbedded: asked.length,
      embedding,
    }).toStrictEqual({
      anna: placesOf("doc", version, chunks),
      nearest: 3,
      bert: [],
      passagesEmbedded: chunks,
      embedding: {
        model: vectorModelNameOf(int8),
        chunks,
        embedded: chunks,
        unembeddable: 0,
        parked: 0,
        rebuilt: true,
      },
    });
  });

  it("runs the model once for a text, however many sources and versions hold it", async () => {
    const text = textOf("Utrecht", 3);
    await add("first", text, ownedBy("anna"));
    await tick(embeddersOf(int8));
    const once = asked.length;

    const version = await add("second", text, ownedBy("bert"));
    await tick(embeddersOf(int8));

    expect({
      once,
      after: asked.length,
      bert: await placesFound("bert", paragraph("Utrecht", 1)),
    }).toStrictEqual({
      once: 3,
      after: 3,
      bert: placesOf("second", version, 3),
    });
  });

  it("finds a source by meaning only for its new readers once its readers change, those taken off finding nothing from the moment of the change", async () => {
    const text = textOf("Delft", 2);
    await add("doc", text, ownedBy("anna"));
    await tick(embeddersOf(int8));
    const before = await placesFound("anna", paragraph("Delft", 0));

    const version = await add("doc", text, ownedBy("bert"));
    const rightAfter = {
      anna: await placesFound("anna", paragraph("Delft", 0)),
      bert: await placesFound("bert", paragraph("Delft", 0)),
    };
    await tick(embeddersOf(int8));

    expect({
      before: before.length,
      rightAfter,
      anna: await placesFound("anna", paragraph("Delft", 0)),
      bert: await placesFound("bert", paragraph("Delft", 0)),
      // The same text: its vectors are kept, the model isn't run again.
      passagesEmbedded: asked.length,
    }).toStrictEqual({
      before: 2,
      rightAfter: { anna: [], bert: [] },
      anna: [],
      bert: placesOf("doc", version, 2),
      passagesEmbedded: 2,
    });
  });

  it("embeds only the newest version when one arrives while a batch is under way", async () => {
    await add("doc", textOf("Gouda", 3), ownedBy("anna"));
    const held = gate();
    const embedders = embeddersOf(int8, env.EMBEDDER, held.before);
    const ticking = tickNoting(embedders);
    await held.reached;

    const version = await add("doc", textOf("Leiden", 2), ownedBy("anna"));
    held.open();
    const ticked = await ticking;
    await tick(embeddersOf(int8));
    const byOld = await found("anna", paragraph("Gouda", 0));

    expect({
      ticked,
      oldAtOne: byOld.some(({ score }) => score > 0.9999),
      anna: await placesFound("anna", paragraph("Leiden", 0)),
      embedding: await embeddingNow(),
    }).toStrictEqual({
      ticked: "ended",
      oldAtOne: false,
      anna: placesOf("doc", version, 2),
      embedding: {
        model: vectorModelNameOf(int8),
        chunks: 2,
        embedded: 2,
        unembeddable: 0,
        parked: 0,
        rebuilt: true,
      },
    });
  });

  it("embeds a batch again after the store was killed in the middle of it, each chunk once", async () => {
    const chunks = 5;
    const version = await add("doc", textOf("Breda", chunks), ownedBy("anna"));
    const held = gate();
    const ticking = tickNoting(embeddersOf(int8, env.EMBEDDER, held.before));
    await held.reached;

    // The abort breaks the call that made it too.
    await expect(
      runInDurableObject(store(), (_instance, state) => {
        state.abort("Killed by the test");
      })
    ).rejects.toThrow("Killed by the test");
    held.open();
    const killed = await ticking;
    await tick(embeddersOf(int8));
    await tick(embeddersOf(int8));

    const { embedding, parkedCount } = await store().workOverview();
    expect({
      killed,
      anna: await placesFound("anna", paragraph("Breda", 2)),
      embedding,
      parkedCount,
    }).toStrictEqual({
      killed: "broken",
      anna: placesOf("doc", version, chunks),
      embedding: {
        model: vectorModelNameOf(int8),
        chunks,
        embedded: chunks,
        unembeddable: 0,
        parked: 0,
        rebuilt: true,
      },
      parkedCount: 0,
    });
  });

  it("fails an item no embedder answers, writing nothing and saying nothing of its passages, and embeds it once they answer again", async () => {
    const marker = `marker${crypto.randomUUID().replaceAll("-", "")}`;
    const version = await add(
      "doc",
      `${paragraph("Zwolle", 0)} ${marker}`,
      ownedBy("anna")
    );
    await breakBulk("crash");

    await tick(embeddersOf(int8));
    const broken = await store().workOverview();
    await breakBulk(null);
    // Past the item's first backoff.
    await tick(embeddersOf(int8), 2 * 60_000);

    expect({
      brokenEmbedded: broken.embedding.embedded,
      brokenWaiting: broken.waiting.map(({ kind, count }) => ({
        kind,
        count,
      })),
      marked: JSON.stringify(broken).includes(marker),
      anna: await placesFound("anna", paragraph("Zwolle", 0)),
    }).toStrictEqual({
      brokenEmbedded: 0,
      brokenWaiting: [{ kind: "embed", count: 1 }],
      marked: false,
      anna: placesOf("doc", version, 1),
    });
  });

  it("writes nothing the embedders give that isn't the host's model's, and parks the item with its code", async () => {
    await add("doc", textOf("Hoorn", 2), ownedBy("anna"));
    // Embedders that say they run the int8 model but run the float one.
    const wrong = embeddersOf(int8, env.OTHER_EMBEDDER);

    for (let attempt = 0; attempt < workAttemptsMax; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- past each backoff, one tick at a time
      await tick(wrong, 60 * 60_000);
    }

    const { embedding, parked } = await store().workOverview();
    expect({
      embedded: embedding.embedded,
      parked: parked.map(({ kind, key, error, message }) => ({
        kind,
        key,
        error,
        message,
      })),
    }).toStrictEqual({
      embedded: 0,
      parked: [
        {
          kind: "embed",
          key: "doc",
          error: "embedder_unavailable",
          message: "The embedder gave no vectors for it.",
        },
      ],
    });
  });

  it("puts back what parked when staff re-embed, and embeds it", async () => {
    const version = await add("doc", textOf("Assen", 2), ownedBy("anna"));
    await breakBulk("crash");
    for (let attempt = 0; attempt < workAttemptsMax; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- past each backoff, one tick at a time
      await tick(embeddersOf(int8), 60 * 60_000);
    }
    const { parkedCount: parked } = await store().workOverview();
    await breakBulk(null);

    await store().reembed();
    await tick(embeddersOf(int8));

    const overview = await store().workOverview();
    expect({
      parked,
      parkedAfter: overview.parkedCount,
      anna: await placesFound("anna", paragraph("Assen", 1)),
    }).toStrictEqual({
      parked: 1,
      parkedAfter: 0,
      anna: placesOf("doc", version, 2),
    });
  });

  it("embeds nothing while the host runs no model, says so, and embeds everything once one arrives", async () => {
    const version = await add("doc", textOf("Emmen", 3), ownedBy("anna"));

    await tick(embeddersOf(null));
    const without = await store().workOverview();
    await tick(embeddersOf(int8));

    expect({
      without: without.embedding,
      waiting: without.waiting,
      asked: asked.length,
      anna: await placesFound("anna", paragraph("Emmen", 2)),
    }).toStrictEqual({
      without: {
        model: null,
        chunks: 3,
        embedded: 0,
        unembeddable: 0,
        parked: 0,
        rebuilt: false,
      },
      waiting: [],
      asked: 3,
      anna: placesOf("doc", version, 3),
    });
  });

  it("after a change of model, keeps recall by words answering, finds by the new build once the rebuild is over, and removes the old build's vectors", async () => {
    const haarlem = [0, 1, 2].map((index) => paragraph("Haarlem", index));
    const version = await add("doc", textOf("Haarlem", 3), ownedBy("anna"));
    await tick(embeddersOf(int8));
    const held = gate();
    const ticking = tickNoting(
      embeddersOf(float, env.OTHER_EMBEDDER, held.before)
    );
    await held.reached;

    const { items: byWords } = await store().recall({
      question: "Haarlem supplier",
      reader: { person: "anna", groups: [] },
      budget: { tokens: 4000 },
    });
    const during = {
      embedding: await embeddingNow(),
      words: byWords.length,
      newBuild: await placesFound(
        "anna",
        paragraph("Haarlem", 0),
        float,
        env.OTHER_EMBEDDER
      ),
    };
    held.open();
    const ticked = await ticking;
    // The rebuild marked done, and the old build's codes removed.
    await tick(embeddersOf(float, env.OTHER_EMBEDDER));
    const oldKept = await vectorsKept(int8, haarlem);
    // Its vectors, by the sweep, once the grace is over.
    await withDateAhead(fileGraceMs + 60_000, async () => {
      await tick(embeddersOf(float, env.OTHER_EMBEDDER));
    });
    expect({
      during,
      ticked,
      after: await embeddingNow(),
      newBuild: await placesFound(
        "anna",
        paragraph("Haarlem", 0),
        float,
        env.OTHER_EMBEDDER
      ),
      oldBuild: await placesFound("anna", paragraph("Haarlem", 0)),
      oldKept,
      oldVectors: await vectorsKept(int8, haarlem),
      newVectors: await vectorsKept(float, haarlem),
    }).toStrictEqual({
      during: {
        embedding: {
          model: vectorModelNameOf(float),
          chunks: 3,
          embedded: 0,
          unembeddable: 0,
          parked: 0,
          rebuilt: false,
        },
        words: 3,
        newBuild: [],
      },
      ticked: "ended",
      after: {
        model: vectorModelNameOf(float),
        chunks: 3,
        embedded: 3,
        unembeddable: 0,
        parked: 0,
        rebuilt: true,
      },
      newBuild: placesOf("doc", version, 3),
      oldBuild: [],
      oldKept: 3,
      oldVectors: 0,
      newVectors: 3,
    });
  });

  it("passes over at once a passage the model fails on, embedding its neighbours, counts it, and tries it again on a re-embed and on a new build", async () => {
    const chunks = 6;
    const trapped = 3;
    const text = Array.from({ length: chunks }, (_, index) =>
      index === trapped
        ? `${paragraph("Venlo", index)} ${poisonWord}`
        : paragraph("Venlo", index)
    ).join("\n\n");
    const version = await add("doc", text, ownedBy("anna"));
    await breakBulk("trap");
    const trapAsked = () =>
      asked.filter((passage) => passage.includes(poisonWord)).length;

    await tick(embeddersOf(int8));
    await tick(embeddersOf(int8));
    const passedOver = await embeddingNow();
    const askedBefore = trapAsked();
    const anna = await placesFound("anna", paragraph("Venlo", 0));
    await store().reembed();
    await tick(embeddersOf(int8));
    const askedOnReembed = trapAsked() - askedBefore;
    // Another build: the float model, which embeds it.
    await tick(embeddersOf(float, env.OTHER_EMBEDDER));
    await tick(embeddersOf(float, env.OTHER_EMBEDDER));

    expect({
      passedOver,
      anna,
      askedOnReembed,
      newBuild: await embeddingNow(),
    }).toStrictEqual({
      passedOver: {
        model: vectorModelNameOf(int8),
        chunks,
        embedded: chunks - 1,
        unembeddable: 1,
        parked: 0,
        rebuilt: true,
      },
      anna: placesOf("doc", version, chunks).filter(
        (place) => !place.endsWith(`#${trapped}`)
      ),
      askedOnReembed: 1,
      newBuild: {
        model: vectorModelNameOf(float),
        chunks,
        embedded: chunks,
        unembeddable: 0,
        parked: 0,
        rebuilt: true,
      },
    });
  });

  it("blames no passage when a call breaks whole: keeps what earlier runs wrote, fails the attempt and parks after the queue's attempts, while another source's item completes", async () => {
    // The second batch holds a passage that ends the object it reaches.
    const chunks = embedBatch + 4;
    const text = Array.from({ length: chunks }, (_, index) =>
      index === embedBatch + 2
        ? `${paragraph("Tiel", index)} ${poisonWord}`
        : paragraph("Tiel", index)
    ).join("\n\n");
    const version = await add("broken", text, ownedBy("anna"));
    const other = await add("other", textOf("Goes", 3), ownedBy("anna"));
    await breakBulk("poison");

    for (let attempt = 0; attempt < workAttemptsMax; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- past each backoff, one tick at a time
      await tick(embeddersOf(int8), 60 * 60_000);
    }

    const { embedded, unembeddable, parked } = await embeddingNow();
    expect({
      embedded,
      unembeddable,
      parked,
      broken: await placesFound("anna", paragraph("Tiel", 0)),
    }).toStrictEqual({
      embedded: embedBatch + 3,
      unembeddable: 0,
      parked: 1,
      broken: [
        ...placesOf("broken", version, embedBatch),
        ...placesOf("other", other, 3),
      ].toSorted(),
    });
  });

  it("embeds in the next call what a call deferred, passing over nothing", async () => {
    const chunks = embedBatch;
    const version = await add(
      "doc",
      textOf("Harderwijk", chunks),
      ownedBy("anna")
    );
    await breakBulk("budget");

    await tick(embeddersOf(int8));
    await tick(embeddersOf(int8));

    expect({
      embedding: await embeddingNow(),
      anna: await placesFound("anna", paragraph("Harderwijk", 0)),
    }).toStrictEqual({
      embedding: {
        model: vectorModelNameOf(int8),
        chunks,
        embedded: chunks,
        unembeddable: 0,
        parked: 0,
        rebuilt: true,
      },
      anna: placesOf("doc", version, chunks),
    });
  });

  it("embeds a passage a source holds three times as one text", async () => {
    const repeated = paragraph("Meppel", 0);
    const version = await add(
      "doc",
      [repeated, repeated, repeated, paragraph("Meppel", 1)].join("\n\n"),
      ownedBy("anna")
    );

    await tick(embeddersOf(int8));

    const { embedded, unembeddable } = await embeddingNow();
    expect({
      timesAsked: asked.filter((passage) => passage === repeated).length,
      embedded,
      unembeddable,
      anna: await placesFound("anna", repeated),
    }).toStrictEqual({
      timesAsked: 1,
      embedded: 4,
      unembeddable: 0,
      anna: placesOf("doc", version, 4),
    });
  });

  it("never keeps a vector for a place whose text changed while its call ran, and embeds the new text there", async () => {
    const old = paragraph("Elburg", 0);
    const fresh = paragraph("Elburg", 1);
    await add("doc", old, ownedBy("anna"));
    const held = gate();
    const ticking = tickNoting(embeddersOf(int8, env.EMBEDDER, held.before));
    await held.reached;
    // The source erased, as an erasure that lets its version numbers be
    // given out again would (GRA-1729): its rows deleted here to stand for
    // it; then added again with other text, as version 1, at the same
    // place.
    await runInDurableObject(store(), (_instance, state) => {
      const { sql } = state.storage;
      const versions = "SELECT row FROM source_versions WHERE source = 'doc'";
      sql.exec(`DELETE FROM chunks WHERE version_row IN (${versions})`);
      sql.exec("DELETE FROM source_changes WHERE source = 'doc'");
      sql.exec("DELETE FROM current_versions WHERE source = 'doc'");
      sql.exec("DELETE FROM source_versions WHERE source = 'doc'");
    });
    const version = await add("doc", fresh, ownedBy("anna"));
    held.open();
    await ticking;
    const late = await found("anna", old);
    await tick(embeddersOf(int8));

    const byFresh = await found("anna", fresh);
    expect({
      version,
      lateAtOne: late.some(({ score }) => score > 0.9999),
      freshAtOne: byFresh.some(
        ({ source, score }) => source === "doc" && score > 0.9999
      ),
    }).toStrictEqual({ version: 1, lateAtOne: false, freshAtOne: true });
  });

  it("keeps a vector write it stopped waiting for in the sweep's sight, so a late landing is swept, never left behind", async () => {
    const text = paragraph("Nunspeet", 0);
    const key = vectorKeyOf(
      vectorModelNameOf(int8),
      await hashOf(encoder.encode(text))
    );
    // Its writes answer only once released, past the run's wait for them.
    const held = await holding({ puts: bucketCallMs });
    const ticked: string[] = [];
    await withTimersFaked(0, async () => {
      await add("doc", text, ownedBy("anna"));
      // Its write never answers: the run stops waiting, and fails.
      ticked.push(await tickNoting(embeddersOf(int8)));
      await add("doc", paragraph("Nunspeet", 1), ownedBy("anna"));
      // A sweep a little less than the grace after the run stopped
      // waiting: the row is not due. That run's write never answers too.
      vi.setSystemTime(Date.now() + fileGraceMs - 5000);
      ticked.push(await tickNoting(embeddersOf(int8)));
      held.releasePuts();
      await held.landed();
      // Past the grace: the late object, and its row, go.
      vi.setSystemTime(Date.now() + fileGraceMs + 60_000);
      await tick(embeddersOf(int8));
    });

    expect({
      ticked,
      late: await env.BRAIN_OBJECTS.head(key),
    }).toStrictEqual({ ticked: ["ended", "ended"], late: null });
  });

  it("neither reads nor writes a vector object a sweep's late delete may still land on, embedding its passage with the model meanwhile", async () => {
    const text = paragraph("Kampen", 0);
    await add("doc", text, ownedBy("anna"));
    await tick(embeddersOf(int8));
    await add("doc", paragraph("Kampen", 1), ownedBy("anna"));
    await tick(embeddersOf(int8));
    const key = vectorKeyOf(
      vectorModelNameOf(int8),
      await hashOf(encoder.encode(text))
    );
    const held = await holding({ deletes: sweepDeleteMs });
    // The sweep takes the replaced passage's vector, and R2 never
    // answers its delete: the sweep gives up, the object is in doubt.
    await withTimersFaked(fileGraceMs + 60_000, async () => {
      await tick(embeddersOf(int8));
    });
    asked.length = 0;

    const version = await add("again", text, ownedBy("anna"));
    await tick(embeddersOf(int8));
    const stillThere = (await env.BRAIN_OBJECTS.head(key)) !== null;
    held.releaseDeletes();

    expect({
      stillThere,
      embeddedByTheModel: asked.includes(text),
      written: held.puts.includes(key),
      anna: await placesFound("anna", text),
    }).toStrictEqual({
      stillThere: true,
      embeddedByTheModel: true,
      written: false,
      anna: [...placesOf("again", version, 1), "doc@2#0"].toSorted(),
    });
  });

  it("stays rebuilt while new sources wait or park, and is not while what a rebuild put on the queue is parked", async () => {
    await add("first", textOf("Tiel", 1), ownedBy("anna"));
    await tick(embeddersOf(int8));
    await tick(embeddersOf(int8));
    await add("second", textOf("Oss", 1), ownedBy("anna"));
    const waiting = await embeddingNow();
    await breakBulk("crash");
    const failUntilParked = async () => {
      for (let attempt = 0; attempt < workAttemptsMax; attempt += 1) {
        // oxlint-disable-next-line no-await-in-loop -- past each backoff, one tick at a time
        await tick(embeddersOf(int8), 60 * 60_000);
      }
    };
    await failUntilParked();
    const newParked = await embeddingNow();
    await store().reembed();
    await failUntilParked();
    // A tick after it parked: the rebuild stays undone.
    await tick(embeddersOf(int8), 60 * 60_000);
    const rebuildParked = await embeddingNow();
    await breakBulk(null);
    await store().reembed();
    await tick(embeddersOf(int8));
    await tick(embeddersOf(int8));

    expect({
      waiting: counts(waiting),
      newParked: counts(newParked),
      rebuildParked: counts(rebuildParked),
      mended: counts(await embeddingNow()),
    }).toStrictEqual({
      waiting: { embedded: 1, chunks: 2, parked: 0, rebuilt: true },
      newParked: { embedded: 1, chunks: 2, parked: 1, rebuilt: true },
      rebuildParked: { embedded: 1, chunks: 2, parked: 1, rebuilt: false },
      mended: { embedded: 2, chunks: 2, parked: 0, rebuilt: true },
    });
  });

  it("deletes the vectors of a replaced version's passages once the grace is over, keeping those a current chunk holds", async () => {
    const kept = paragraph("Ede", 0);
    const replaced = paragraph("Ede", 1);
    const added = paragraph("Ede", 2);
    await add("doc", [kept, replaced].join("\n\n"), ownedBy("anna"));
    await tick(embeddersOf(int8));
    await add("doc", [kept, added].join("\n\n"), ownedBy("anna"));
    await tick(embeddersOf(int8));
    const beforeGrace = await vectorsKept(int8, [kept, replaced, added]);

    await withDateAhead(fileGraceMs + 60_000, async () => {
      await tick(embeddersOf(int8));
    });

    expect({
      beforeGrace,
      kept: await vectorsKept(int8, [kept, added]),
      replaced: await vectorsKept(int8, [replaced]),
    }).toStrictEqual({ beforeGrace: 3, kept: 2, replaced: 0 });
  });

  it("writes no vector for a chunk replaced while its batch ran", async () => {
    const gone = paragraph("Doetinchem", 0);
    const newer = paragraph("Doetinchem", 1);
    await add("doc", gone, ownedBy("anna"));
    const held = gate();
    const ticking = tickNoting(embeddersOf(int8, env.EMBEDDER, held.before));
    await held.reached;
    await add("doc", newer, ownedBy("anna"));
    held.open();
    await ticking;
    const written = await vectorsKept(int8, [gone]);

    await withDateAhead(fileGraceMs + 60_000, async () => {
      await tick(embeddersOf(int8));
    });

    expect({
      written,
      gone: await vectorsKept(int8, [gone]),
      newer: await vectorsKept(int8, [newer]),
    }).toStrictEqual({ written: 0, gone: 0, newer: 1 });
  });

  it("keeps nothing of a reply with a vector that isn't one, in the bucket or the store", async () => {
    const texts = [0, 1, 2].map((index) => paragraph("Maastricht", index));
    await add("doc", texts.join("\n\n"), ownedBy("anna"));
    const pool = embeddersOf(int8);
    const broken: Embedders = {
      model: int8,
      embed: async (request) => {
        const reply = await pool.embed(request);
        return reply.kind === "vectors"
          ? {
              ...reply,
              results: reply.results.map((result, index) =>
                index === 1 && Array.isArray(result) ? result.slice(1) : result
              ),
            }
          : reply;
      },
    };

    await tick(broken);

    const { embedded } = await embeddingNow();
    expect({
      kept: await vectorsKept(int8, texts),
      embedded,
    }).toStrictEqual({ kept: 0, embedded: 0 });
  });

  it("sends nothing to the embedders for chunks without a hash, and ends its tick", async () => {
    const version = await add("doc", textOf("Lelystad", 3), ownedBy("anna"));
    await tick(embeddersOf(null));
    // Eighteen chunks without a hash, as written before hashes were
    // (written in place here to stand for them).
    await runInDurableObject(store(), (_instance, state) => {
      for (let copy = 1; copy <= 6; copy += 1) {
        state.storage.sql.exec(
          `INSERT INTO chunks (version_row, position, text, hash)
          SELECT version_row, position + ?, text || ' copy ' || ?, NULL
          FROM chunks
          WHERE version_row = (SELECT version_row FROM current_versions WHERE source = 'doc')
            AND position < 100`,
          copy * 100,
          copy
        );
      }
    });

    await tick(embeddersOf(int8));

    const { embedding, waiting } = await store().workOverview();
    expect({
      asked: asked.length,
      embedded: embedding.embedded,
      waiting,
      anna: await placesFound("anna", paragraph("Lelystad", 0)),
    }).toStrictEqual({
      asked: 3,
      embedded: 3,
      waiting: [],
      anna: placesOf("doc", version, 3),
    });
  });

  it("fails as no_progress, never going round, a run whose every write was refused", async () => {
    await add("doc", textOf("Dronten", embedBatch), ownedBy("anna"));
    const held = gate();
    const ticking = tickNoting(embeddersOf(int8, env.EMBEDDER, held.before));
    await held.reached;
    // The version stops being current under the run (written in place).
    await runInDurableObject(store(), (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM current_versions WHERE source = 'doc'"
      );
    });
    held.open();
    await ticking;

    const lastError = await runInDurableObject(
      store(),
      (_instance, state) =>
        state.storage.sql
          .exec<{ last_error: string | null }>(
            "SELECT last_error FROM work_items WHERE key = 'doc'"
          )
          .toArray()
          .at(0)?.last_error
    );
    expect(lastError).toBe("no_progress");
  });

  it("embeds a passage the module failed on in one object when another object embeds it, marking nothing", async () => {
    const text = `${paragraph("Hattem", 0)} ${poisonWord}`;
    const version = await add("doc", text, ownedBy("anna"));
    await breakBulk("trap-once");

    await tick(embeddersOf(int8));

    const { embedded, unembeddable } = await embeddingNow();
    expect({
      embedded,
      unembeddable,
      anna: await placesFound("anna", text),
    }).toStrictEqual({
      embedded: 1,
      unembeddable: 0,
      anna: placesOf("doc", version, 1),
    });
  });

  it("forgets a passage passed over once no current version holds its text, so the text is tried again later", async () => {
    const trapped = `${paragraph("Steenwijk", 0)} ${poisonWord}`;
    await add("doc", trapped, ownedBy("anna"));
    await breakBulk("trap");
    await tick(embeddersOf(int8));
    const { unembeddable: passedOver } = await embeddingNow();
    await add("doc", paragraph("Steenwijk", 1), ownedBy("anna"));
    await tick(embeddersOf(int8));
    await breakBulk(null);

    const version = await add("doc", trapped, ownedBy("anna"));
    await tick(embeddersOf(int8));

    const { embedded, unembeddable } = await embeddingNow();
    expect({
      passedOver,
      embedded,
      unembeddable,
      anna: await placesFound("anna", trapped),
    }).toStrictEqual({
      passedOver: 1,
      embedded: 1,
      unembeddable: 0,
      anna: placesOf("doc", version, 1),
    });
  });

  it("writes what came back when a later call of the run breaks, marks nothing, and fails the attempt", async () => {
    const chunks = 6;
    const version = await add("doc", textOf("Ommen", chunks), ownedBy("anna"));
    const pool = embeddersOf(int8);
    // The first texts answered, then the embedders break.
    const breaking: Embedders = {
      model: int8,
      embed: async (request) => {
        const half = Math.ceil(request.texts.length / 2);
        const first = await pool.embed({
          ...request,
          texts: request.texts.slice(0, half),
        });
        return first.kind === "vectors"
          ? {
              ...first,
              results: [
                ...first.results,
                ...request.texts.slice(half).map(() => null),
              ],
            }
          : first;
      },
    };

    await tick(breaking);
    const broken = await store().workOverview();
    await tick(embeddersOf(int8), 3 * 60_000);

    expect({
      broken: {
        embedded: broken.embedding.embedded,
        unembeddable: broken.embedding.unembeddable,
        waiting: broken.waiting.map(({ kind, count }) => ({ kind, count })),
      },
      after: await embeddingNow().then(({ embedded, unembeddable }) => ({
        embedded,
        unembeddable,
      })),
      anna: await placesFound("anna", paragraph("Ommen", 0)),
    }).toStrictEqual({
      broken: {
        embedded: chunks / 2,
        unembeddable: 0,
        waiting: [{ kind: "embed", count: 1 }],
      },
      after: { embedded: chunks, unembeddable: 0 },
      anna: placesOf("doc", version, chunks),
    });
  });

  it("writes nothing of a run in flight for a source an erasure takes", async () => {
    const text = paragraph("Zwartsluis", 0);
    await add("erased", text, ownedBy("anna"));
    const held = gate();
    const ticking = tickNoting(embeddersOf(int8, env.EMBEDDER, held.before));
    await held.reached;

    await store().eraseSource({ source: "erased", reason: "deleted" });
    held.open();
    await ticking;

    const hash = await hashOf(encoder.encode(text));
    const rows = await runInDurableObject(store(), (_instance, state) =>
      state.storage.sql
        .exec("SELECT 1 FROM vector_files WHERE hash = ?", hash)
        .toArray()
    );
    const { waiting } = await store().workOverview();
    expect({
      rows: rows.length,
      object: await vectorsKept(int8, [text]),
      waiting,
    }).toStrictEqual({ rows: 0, object: 0, waiting: [] });
  });

  it("keeps no verdict of another build than the host's: a passage is passed over only on its own build's word", async () => {
    const text = `${paragraph("Blokker", 0)} ${poisonWord}`;
    await add("doc", text, ownedBy("anna"));
    // The embedders run the float build while the host expects the int8
    // one, and refuse the text.
    await breakBulk("trap", env.OTHER_EMBEDDER);
    await tick(embeddersOf(int8, env.OTHER_EMBEDDER));
    const byOther = await embeddingNow();
    await breakBulk(null, env.OTHER_EMBEDDER);
    // The expected build refuses it too: its own verdict.
    await breakBulk("trap");
    await tick(embeddersOf(int8), 3 * 60_000);
    const byOwn = await embeddingNow();

    expect({
      byOther: {
        embedded: byOther.embedded,
        unembeddable: byOther.unembeddable,
      },
      byOwn: { embedded: byOwn.embedded, unembeddable: byOwn.unembeddable },
    }).toStrictEqual({
      byOther: { embedded: 0, unembeddable: 0 },
      byOwn: { embedded: 0, unembeddable: 1 },
    });
  });

  it("counts as embedded only chunks of current versions, never those of a version hidden and not yet erased", async () => {
    await add("hidden", textOf("Vollenhove", 2), ownedBy("anna"));
    await add("shown", textOf("Blokzijl", 1), ownedBy("anna"));
    await tick(embeddersOf(int8));
    // An erasure hides a version at once and deletes it at a later tick:
    // its codes stay meanwhile (hidden here as it does, in place).
    await runInDurableObject(store(), (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM current_versions WHERE source = 'hidden'"
      );
    });

    const { chunks, embedded } = await embeddingNow();
    expect({ chunks, embedded }).toStrictEqual({ chunks: 1, embedded: 1 });
  });
});
