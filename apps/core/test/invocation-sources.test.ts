import { describe, expect, it } from "vite-plus/test";

import {
  invocationSources,
  provenanceMaxResources,
} from "../src/resource-adapter.ts";

// What an invocation read through its resources, as it goes back to the
// caller (pure logic): bounded, and saying when it is.

describe("an invocation's sources", () => {
  it("name every connection read, and say when resources were left out", () => {
    const sources = invocationSources();
    const many = Array.from(
      { length: provenanceMaxResources + 1 },
      (_, index) => `message-${String(index).padStart(5, "0")}`
    );
    sources.noteConnection("connection-a", many.slice(0, 10));
    const before = sources.snapshot().truncated;
    sources.noteConnection("connection-b", many);
    const after = sources.snapshot();
    expect({
      before,
      truncated: after.truncated,
      connections: after.connections.map(({ connectionId }) => connectionId),
      kept: after.connections.reduce(
        (total, { resources }) => total + resources.length,
        0
      ),
    }).toStrictEqual({
      before: false,
      truncated: true,
      connections: ["connection-a", "connection-b"],
      kept: provenanceMaxResources,
    });
  });
});
