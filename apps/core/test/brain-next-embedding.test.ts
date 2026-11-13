import { vectorModelNameOf } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  addSource,
  brainWorkOverview,
  actOnBrainForStaff,
  workBrain,
} from "../src/brain-next.ts";
import { embedderModel } from "../src/embedder.ts";
import { noProducers } from "./no-producers.ts";

// The new Brain's embedding as core drives it (GRA-1768): core's clock
// ticks the store with core's bulk embedders, running the model core
// ships from MODEL_FILES (in tests, the embed package's test model). The
// store's own tests try the queue's every turn
// (packages/brain-next/test/embedding.test.ts) and the bulk embedders'
// own embed passages (packages/embed/test/pool.test.ts).

/** The queue's clock across the file: only forward, as core's clock goes. */
const clock = { at: Date.now() };
const tick = async (): Promise<void> => {
  clock.at = Math.max(clock.at + 1000, Date.now());
  await workBrain(env, new Date(clock.at), noProducers);
};

/** Most ticks a rebuild of one source may take. */
const ticksMost = 10;

/** Ticks until the store's rebuild for its model is over: its overview then. */
const tickUntilRebuilt = async () => {
  for (let ticks = 0; ticks < ticksMost; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one tick after another, as core's clock
    await tick();
    // oxlint-disable-next-line no-await-in-loop -- read after each tick
    const overview = await brainWorkOverview(env);
    if (overview.embedding.rebuilt) {
      return overview;
    }
  }
  throw new Error(`The rebuild wasn't over after ${ticksMost} ticks`);
};

describe("embedding the Brain's content through core", () => {
  it("embeds every passage with the model core ships, says so, and embeds them again once staff re-embed", async () => {
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text: "De factuur van de leverancier in Rotterdam.\n\nTe betalen binnen dertig dagen.",
      readers: { kind: "none" },
    });

    const ticked = await tickUntilRebuilt();
    const reembed = await actOnBrainForStaff(env, { type: "reembed" });
    const asked = await brainWorkOverview(env);
    const reembedded = await tickUntilRebuilt();

    const embedded = {
      model: vectorModelNameOf(await embedderModel()),
      chunks: 1,
      embedded: 1,
      unembeddable: 0,
      parked: 0,
      rebuilt: true,
    };
    expect({
      reembed,
      ticked: { embedding: ticked.embedding, waiting: ticked.waiting },
      asked: asked.embedding.rebuilt,
      reembedded: {
        embedding: reembedded.embedding,
        waiting: reembedded.waiting,
      },
    }).toStrictEqual({
      reembed: "done",
      ticked: { embedding: embedded, waiting: [] },
      // A re-embed is a rebuild of the same build.
      asked: false,
      reembedded: { embedding: embedded, waiting: [] },
    });
  });
});
