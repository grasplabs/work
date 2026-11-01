import { describe, expect, it } from "vite-plus/test";

import { quietLoader } from "../src/quiet-loader.ts";
import type { QuietableCode, QuietableStub } from "../src/quiet-loader.ts";

// What the quiet Loader hands back of a call the runtime itself ended: the
// runtime's own error, untouched. Only what the isolate's code threw
// crosses rebuilt and bounded; a Worker stopped for its CPU time or memory
// rejects the call from outside the isolate, and core's platform sandbox
// tells the two limits apart by exactly that message (platform-sandbox.ts).

const code: QuietableCode = {
  mainModule: "main.js",
  modules: { "main.js": "export class Run {}" },
  compatibilityDate: "2026-09-15",
};

/** A call the runtime ends with `error`, as it ends one past a limit. */
const endedCall = async (ended: Error): Promise<never> => {
  await Promise.resolve();
  throw ended;
};

/** A Loader whose every call is ended by the runtime with `ended`. */
const endedWith = (ended: Error) => ({
  get: (): QuietableStub => ({
    getEntrypoint: () => ({
      run: async (): Promise<never> => await endedCall(ended),
    }),
    getDurableObjectClass: () => {},
  }),
  load: (): QuietableStub => ({
    getEntrypoint: () => ({}),
    getDurableObjectClass: () => {},
  }),
});

describe("a call the runtime ended, through the quiet Loader", () => {
  it.each(["Worker exceeded CPU time limit.", "Worker exceeded memory limit."])(
    "rejects with the runtime's own error: %s",
    async (message) => {
      const limit = new Error(message);
      const entry = quietLoader(endedWith(limit))
        .get(null, () => code)
        .getEntrypoint("Run");
      const run: unknown =
        typeof entry === "object" && entry !== null
          ? Reflect.get(entry, "run")
          : undefined;
      let thrown: unknown;
      try {
        if (typeof run !== "function") {
          throw new TypeError("No run to call");
        }
        await Reflect.apply(run, entry, []);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(limit);
    }
  );
});
