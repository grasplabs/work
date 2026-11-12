// A question's vector for recall (src/question.ts), through the question
// embedder's Durable Object, on the int8 test model: the vector one
// embedder alone gives the text, with its build; and when the embedder
// breaks, can't load its model, refuses the text or answers late, no
// vector and why, in time, never an error; and the embedder skips a
// text whose caller gave up before it got to it.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { modelIdentity } from "../src/model-files.ts";
import { embedQuestion } from "../src/question.ts";
import { poisonWord, putTestModel } from "./test-models.ts";
import { int8Model } from "./worker.ts";

const question = "Wanneer moet de factuur van de leverancier betaald zijn?";

/** A deadline far past what the test model takes. */
const ample = { timeoutMs: 60_000 };

const embedder = () => env.BREAKABLE.getByName("questions");

describe("a question's vector", () => {
  beforeAll(async () => {
    await putTestModel(env.MODEL_FILES, int8Model);
  });

  beforeEach(async () => {
    await embedder().breakAs(null);
  });

  it("is the vector one embedder alone gives the question, with the build that made it", async () => {
    const { vector } = await env.INT8.getByName("alone").embed(question);

    await expect(
      embedQuestion(embedder(), question, ample)
    ).resolves.toStrictEqual({
      kind: "vector",
      model: await modelIdentity(int8Model),
      vector: [...vector],
    });
  });

  it("is none, as failed, when the embedder breaks", async () => {
    await embedder().breakAs("crash");

    await expect(
      embedQuestion(embedder(), question, ample)
    ).resolves.toStrictEqual({ kind: "none", reason: "failed" });
  });

  it("is none, as failed, when the embedder can't load its model", async () => {
    const missing = env.CUSTOM.getByName(crypto.randomUUID());
    await missing.use({
      ...int8Model,
      tokens: { sha256: "0".repeat(64), size: 1 },
    });

    await expect(
      embedQuestion(missing, question, ample)
    ).resolves.toStrictEqual({ kind: "none", reason: "failed" });
  });

  it("is none, as refused, for a text the model fails on", async () => {
    await embedder().breakAs("trap");

    await expect(
      embedQuestion(embedder(), `${question} ${poisonWord}`, ample)
    ).resolves.toStrictEqual({ kind: "none", reason: "refused" });
  });

  it("is none, as timed out, once the deadline passes, without waiting for the embedder", async () => {
    // Held until the test opens the gate: it answers only after.
    await embedder().breakAs("held");

    const answered = await embedQuestion(embedder(), question, {
      timeoutMs: 100,
    });
    await embedder().breakAs(null);

    expect(answered).toStrictEqual({ kind: "none", reason: "timed_out" });
  });

  it("skips a text the embedder gets to once its caller gave up, and embeds one whose caller still waits", async () => {
    await embedder().breakAs("held");
    const giveUpAt = Date.now() + 50;
    const late = embedder().embedMany([question], giveUpAt);
    const waiting = embedder().embedMany([question], Date.now() + 60_000);
    while (Date.now() <= giveUpAt) {
      // oxlint-disable-next-line no-await-in-loop -- until the caller has given up
      await scheduler.wait(10);
    }

    await embedder().breakAs(null);

    const embedded = await waiting;
    expect({
      late: await late,
      waiting: embedded.map(({ kind }) => kind),
    }).toStrictEqual({ late: [{ kind: "deferred" }], waiting: ["embedded"] });
  });
});
