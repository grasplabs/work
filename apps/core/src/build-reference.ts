import { referenceFiles } from "@grasp-os/compiler";

// What a chat's agent reads to write an App that checks: the SDK's and the
// UI kit's sources (the compiler's `reference.json`, built from the very
// sources the check's type chunks are rolled up from, in the same
// release), and the built-in blueprints' files (apps/core/blueprints/),
// complete Apps that pass every check, as examples. Read with `readFile` and `searchFiles` without an
// App (agent-tools.ts). Nothing here is written by hand, so it can't drift
// from what every `env.build.write` holds code to.

/** Where the built-in blueprints' files are in the reference. */
const blueprintsFolder = "blueprints/";

/**
 * The reference, by path: `@grasp-os/sdk/src/server.ts`,
 * `@grasp-os/ui/src/components/card.tsx`,
 * `blueprints/board-page/definition.json`.
 * The platform's own text, never anyone's data.
 */
export const buildReference = async (
  /** Core's static assets, where the compiler's release is. */
  assets: Fetcher
): Promise<Readonly<Record<string, string>>> => {
  // Loaded only when read: a chat that never builds never loads them.
  const [sources, { default: blueprints }] = await Promise.all([
    referenceFiles(assets),
    import("#blueprints"),
  ]);
  return {
    ...sources,
    ...Object.fromEntries(
      blueprints.flatMap(({ id, files }) =>
        Object.entries(files).map(([path, text]) => [
          `${blueprintsFolder}${id}/${path}`,
          text,
        ])
      )
    ),
  };
};
