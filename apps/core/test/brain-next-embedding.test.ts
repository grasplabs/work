import { shippedModel } from "@grasp-os/embed/model-files";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  addSource,
  brainWorkOverview,
  actOnBrainForStaff,
  workBrain,
} from "../src/brain-next.ts";

// The new Brain's embedding as core drives it (GRA-1768): core's clock
// ticks the store with core's bulk embedders. No model ships yet
// (GRA-1767), so core's ticks embed nothing, and the overview says so;
// with a model, the store's own tests embed through the queue
// (packages/brain-next/test/embedding.test.ts) and the bulk embedders'
// own embed passages (packages/embed/test/pool.test.ts).

/** The queue's clock across the file: only forward, as core's clock goes. */
const clock = { at: Date.now() };
const tick = async (): Promise<void> => {
  clock.at = Math.max(clock.at + 1000, Date.now());
  await workBrain(env, new Date(clock.at));
};

describe("embedding the Brain's content through core", () => {
  it("embeds nothing while no model ships, says so, and leaves nothing waiting, re-embed or not", async () => {
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text: "De factuur van de leverancier in Rotterdam.\n\nTe betalen binnen dertig dagen.",
      readers: { kind: "owner", personId: crypto.randomUUID() },
    });

    await tick();
    const ticked = await brainWorkOverview(env);
    const reembed = await actOnBrainForStaff(env, { type: "reembed" });
    await tick();
    const reembedded = await brainWorkOverview(env);

    expect({
      shippedModel,
      reembed,
      ticked: { embedding: ticked.embedding, waiting: ticked.waiting },
      reembedded: {
        embedding: reembedded.embedding,
        waiting: reembedded.waiting,
      },
    }).toStrictEqual({
      shippedModel: null,
      // No model seen: nothing to embed with.
      reembed: "nothing",
      ticked: {
        embedding: {
          model: null,
          chunks: 1,
          embedded: 0,
          unembeddable: 0,
          parked: 0,
          rebuilt: false,
        },
        waiting: [],
      },
      reembedded: {
        embedding: {
          model: null,
          chunks: 1,
          embedded: 0,
          unembeddable: 0,
          parked: 0,
          rebuilt: false,
        },
        waiting: [],
      },
    });
  });
});
