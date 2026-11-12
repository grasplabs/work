// The bulk embedders (src/pool.ts), through their Durable Objects, on the
// int8 test model: a batch comes back as one embedder alone would embed
// it; a text the model fails on is that text's answer alone; what a call
// deferred goes in the next call; and a call that breaks whole, or runs
// out of time, gives nothing and blames no text.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { maxTextsPerCall } from "../src/embedder.ts";
import { modelIdentity } from "../src/model-files.ts";
import { bulkEmbedders, embedWithPool } from "../src/pool.ts";
import {
  budgetTexts,
  calls,
  poisonWord,
  putTestModel,
  slowMs,
} from "./test-models.ts";
import type { Breakage } from "./test-models.ts";
import { floatModel, int8Model, trapWord } from "./worker.ts";

/** A batch of the most texts one call takes. */
const texts = Array.from(
  { length: maxTextsPerCall },
  (_, index) =>
    `Factuur ${index} van de leverancier, te betalen binnen dertig dagen.`
);

/** Breaks every bulk embedder as `breakage`, or mends them (null). */
const breakBulk = async (breakage: Breakage | null): Promise<void> => {
  await Promise.all(
    Array.from({ length: bulkEmbedders }, async (_, index) => {
      await env.BREAKABLE.getByName(`bulk-${index}`).breakAs(breakage);
    })
  );
};

/** What one embedder alone gives `batch`, one text after the other. */
const alone = async (batch: readonly string[] = texts): Promise<number[][]> => {
  const embedder = env.INT8.getByName("alone");
  const vectors: number[][] = [];
  for (const text of batch) {
    // oxlint-disable-next-line no-await-in-loop -- one object embeds one text at a time
    const { vector } = await embedder.embed(text);
    vectors.push([...vector]);
  }
  return vectors;
};

describe("the bulk embedders", () => {
  beforeAll(async () => {
    await putTestModel(env.MODEL_FILES, int8Model);
  });

  beforeEach(async () => {
    await breakBulk(null);
  });

  it("embeds a batch as one embedder alone would, in order, with the build that made it", async () => {
    const pooled = await embedWithPool(env.BREAKABLE, texts, {
      timeoutMs: 60_000,
    });

    expect(pooled).toStrictEqual({
      kind: "vectors",
      model: await modelIdentity(int8Model),
      results: await alone(),
    });
  });

  it("answers a text the model fails on as unembeddable, and embeds its neighbours in the same call", async () => {
    const trapped = 6;
    const batch = texts.map((text, index) =>
      index === trapped ? `${text} ${trapWord}` : text
    );

    const pooled = await embedWithPool(env.TRAPPING, batch, {
      timeoutMs: 60_000,
    });

    const expected: (number[] | "unembeddable")[] = await alone();
    expected[trapped] = "unembeddable";
    expect(pooled).toStrictEqual({
      kind: "vectors",
      model: await modelIdentity(int8Model),
      results: expected,
    });
  });

  it("embeds a text one object's module failed on when another object embeds it, and fails it only when both do", async () => {
    await breakBulk("trap-once");
    const trapped = `${texts[3] ?? ""} ${poisonWord}`;
    const once = texts.map((text, index) => (index === 3 ? trapped : text));
    calls.length = 0;

    const pooled = await embedWithPool(env.BREAKABLE, once, {
      timeoutMs: 60_000,
    });

    // The calls that held the text: the one that failed on it, then the
    // one that embedded it, each on an object of its own.
    const objects = calls
      .filter((call) => call.texts.includes(trapped))
      .map(({ object }) => object);
    expect({
      pooled,
      calls: objects.length,
      differ: new Set(objects).size === objects.length,
    }).toStrictEqual({
      pooled: {
        kind: "vectors",
        model: await modelIdentity(int8Model),
        results: await alone(once),
      },
      calls: 2,
      differ: true,
    });
  });

  it("says which build gave a verdict, so one of another build is never taken for the expected one's", async () => {
    await putTestModel(env.MODEL_FILES, floatModel);
    await Promise.all(
      Array.from({ length: bulkEmbedders }, async (_, index) => {
        await env.FLOAT.getByName(`bulk-${index}`).breakAs("trap");
      })
    );
    await breakBulk("trap");
    const refused = texts.slice(0, 2).map((text) => `${text} ${poisonWord}`);

    const byOther = await embedWithPool(env.FLOAT, refused, {
      timeoutMs: 60_000,
    });
    const byOwn = await embedWithPool(env.BREAKABLE, refused, {
      timeoutMs: 60_000,
    });
    await Promise.all(
      Array.from({ length: bulkEmbedders }, async (_, index) => {
        await env.FLOAT.getByName(`bulk-${index}`).breakAs(null);
      })
    );

    expect({ byOther, byOwn }).toStrictEqual({
      byOther: {
        kind: "vectors",
        model: await modelIdentity(floatModel),
        results: ["unembeddable", "unembeddable"],
      },
      byOwn: {
        kind: "vectors",
        model: await modelIdentity(int8Model),
        results: ["unembeddable", "unembeddable"],
      },
    });
  });

  it("sends what a call deferred in the next call, as no failure", async () => {
    await breakBulk("budget");

    const pooled = await embedWithPool(env.BREAKABLE, texts, {
      timeoutMs: 60_000,
    });

    expect({ budgetTexts, pooled }).toStrictEqual({
      budgetTexts: 2,
      pooled: {
        kind: "vectors",
        model: await modelIdentity(int8Model),
        results: await alone(),
      },
    });
  });

  it("gives nothing, blaming no text, when its call breaks whole", async () => {
    await breakBulk("crash");

    await expect(
      embedWithPool(env.BREAKABLE, texts, { timeoutMs: 60_000 })
    ).resolves.toStrictEqual({ kind: "unavailable" });
  });

  it("gives nothing once the batch's time is up", async () => {
    await breakBulk("slow");

    await expect(
      embedWithPool(env.BREAKABLE, texts, { timeoutMs: slowMs / 5 })
    ).resolves.toStrictEqual({ kind: "unavailable" });
  });
});
