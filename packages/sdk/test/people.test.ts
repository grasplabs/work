import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { GraspClient } from "../src/client-core.ts";
import { peopleOperations, peopleReferences } from "../src/people.ts";
import type { PeopleDirectory } from "../src/people.ts";
import { GraspProvider, usePeople } from "../src/react.ts";

// The reads a page makes through `useUser` and `usePeople` name their
// read, and core checks what they take. And the directory a page holds
// is one per client, so an effect that depends on it doesn't run again on
// every render.

describe("the people reads' references", () => {
  it("name each read and nothing more: core checks what it takes", () => {
    expect(
      Object.fromEntries(
        Object.entries(peopleReferences).map(([read, reference]) => [
          read,
          reference,
        ])
      )
    ).toStrictEqual(
      Object.fromEntries(
        Object.entries(peopleOperations).map(([read, operation]) => [
          read,
          { name: operation.path },
        ])
      )
    );
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
