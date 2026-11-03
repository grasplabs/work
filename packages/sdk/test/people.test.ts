import { describe, expect, it } from "vite-plus/test";

import { contractFingerprint } from "../src/generate.ts";
import {
  peopleFingerprints,
  peopleOperations,
  peopleReferences,
} from "../src/people.ts";

// The reads a screen makes through `useCaller` and `usePeople` name their
// contract by a fingerprint fixed in the SDK, which core compares with the
// one its own SDK makes: they must be the contracts' own.

describe("the people reads' references", () => {
  it("name each read's own contract fingerprint", async () => {
    const made = Object.fromEntries(
      await Promise.all(
        Object.entries(peopleOperations).map(
          async ([read, operation]) =>
            [read, await contractFingerprint(operation)] as const
        )
      )
    );
    const named = Object.fromEntries(
      Object.entries(peopleReferences).map(([read, reference]) => [
        read,
        reference.fingerprint,
      ])
    );

    expect({ made, named }).toStrictEqual({
      made: peopleFingerprints,
      named: peopleFingerprints,
    });
  });
});
