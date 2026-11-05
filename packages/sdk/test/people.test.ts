import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { GraspClient } from "../src/client-core.ts";
import { contractFingerprint } from "../src/generate.ts";
import {
  peopleFingerprints,
  peopleOperations,
  peopleReferences,
} from "../src/people.ts";
import type { PeopleDirectory } from "../src/people.ts";
import { GraspProvider, usePeople } from "../src/react.ts";

// The reads a screen makes through `useUser` and `usePeople` name their
// contract by a fingerprint fixed in the SDK, which core compares with the
// one its own SDK makes: they must be the contracts' own. And the
// directory a screen holds is one per client, so an effect that depends on
// it doesn't run again on every render.

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

describe(usePeople, () => {
  it("answers the same directory on every render of a client, and another for another client", () => {
    const transport = {
      call: async () => await Promise.reject(new Error("No calls here")),
      watch: async () => await Promise.reject(new Error("No follows here")),
    };
    const client = new GraspClient(transport);
    const other = new GraspClient(transport);
    const seen: PeopleDirectory[] = [];
    const Probe = (): null => {
      seen.push(usePeople());
      return null;
    };
    for (const each of [client, client, other]) {
      renderToString(
        createElement(GraspProvider, { client: each }, createElement(Probe))
      );
    }
    const [first, again, another] = seen;

    expect({
      same: first === again,
      shared: first === another,
    }).toStrictEqual({ same: true, shared: false });
  });
});
