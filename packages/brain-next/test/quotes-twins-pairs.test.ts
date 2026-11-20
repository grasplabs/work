// Out memories against twins and the oracle with two groups: every order
// of up to three versions after the first, wide or narrow, with the line
// or without, ticked or not. The rules and why: quotes-twins.test.ts.
import { describe, expect, it } from "vite-plus/test";

import { run, unique } from "./quote-twins.ts";
import type { Event } from "./quote-twins.ts";

describe("out memories against twins and the oracle, two groups", () => {
  it("answers each reader as their twin and the oracle, in every order of up to three versions, ticked or not", async () => {
    const groups = [unique("wide"), unique("narrow")];
    const steps: Event[][] = [false, true].flatMap((narrow) =>
      [false, true].flatMap((line) =>
        [false, true].map((ticked): Event[] => [
          { kind: "version", group: narrow ? 1 : 0, line },
          ...(ticked ? [{ kind: "tick" } as const] : []),
        ])
      )
    );
    let sequences: Event[][] = [[{ kind: "version", group: 0, line: true }]];
    const all: Event[][] = [];
    for (let length = 1; length <= 3; length += 1) {
      sequences = sequences.flatMap((sequence) =>
        steps.map((step) => [...sequence, ...step])
      );
      all.push(...sequences);
    }
    const differ: string[] = [];
    for (const events of all) {
      // A reader of the narrow group alone never reads the wide memory.
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      const found = await run(groups, events, {
        every: false,
        checkAt: "last",
        readers: [[0], [0, 1]],
      });
      differ.push(...found);
    }

    expect({ cases: all.length, differ }).toStrictEqual({
      cases: 584,
      differ: [],
    });
  }, 300_000);
});
