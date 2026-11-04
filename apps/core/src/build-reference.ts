import { referenceFiles } from "@grasp-os/compiler";
import { env } from "cloudflare:workers";

// What a chat's agent reads to write an App that checks: the SDK's and the
// UI kit's sources exactly as App code is type-checked against them (the
// compiler's `reference.json`, cut from the kit's types), and the built-in
// blueprints' files (apps/core/blueprints/), complete Apps that pass every
// check, as examples. Read with `readFile` and `searchFiles` without an
// App (agent-tools.ts). Nothing here is written by hand, so it can't drift
// from what `env.build.check` holds code to.

/** Where the built-in blueprints' files are in the reference. */
const blueprintsFolder = "blueprints/";

/**
 * The reference, by path: `@grasp-os/sdk/src/app.ts`,
 * `@grasp-os/ui/src/components/card.tsx`, `blueprints/board-page/app.ts`.
 * The platform's own text, never anyone's data.
 */
export const buildReference = async (): Promise<
  Readonly<Record<string, string>>
> => {
  // Loaded only when read: a chat that never builds never loads them.
  const [sources, { default: blueprints }] = await Promise.all([
    referenceFiles(env.ASSETS),
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
