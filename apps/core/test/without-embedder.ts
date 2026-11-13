/**
 * Core's env with a question embedder that never answers: core's recall
 * then goes by words and exact parts alone, as it does whenever its
 * embedder fails (brain-next-meaning.test.ts tries that against a broken
 * embedder of the test model). For a test or a measurement whose recall
 * must not search by meaning: core's tests ship the embed package's
 * untrained test model, and a recall naming it also wakes the asker's own
 * store (packages/brain-next `#wakeForModel`), which then embeds its
 * passages with that model on its own alarm.
 */

/** `value`, as the binding it stands in for. */
const asBinding = (value: unknown): never =>
  // SAFETY: core reaches its question embedder by `jurisdiction` (unless
  // the env turns jurisdictions off) and `getByName`, and calls
  // `embedMany` alone (@grasp-os/embed/question), which this one refuses.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  value as never;

/** A namespace whose every object refuses every text, in any jurisdiction. */
const refusing = {
  jurisdiction: () => refusing,
  getByName: () => ({
    embedMany: async () => {
      await Promise.resolve();
      throw new Error("No question embedder here");
    },
  }),
};

/** `env`, its question embedder refusing every question. */
export const withoutEmbedder = <T extends { EMBEDDER: unknown }>(
  env: T
): T => ({
  ...env,
  EMBEDDER: asBinding(refusing),
});
