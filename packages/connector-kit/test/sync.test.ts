import { describe, expect, it } from "vite-plus/test";

import { ToolError } from "../src/connector.ts";
import { fillPage, syncRoom } from "../src/sync.ts";

// How a sync page is filled (pure logic): a page that can take nothing
// must never answer as if it had moved on.

const gone = (id: string) => ({ gone: true, id, kind: "file" }) as const;

describe("filling a sync page", () => {
  it("passes over a first entry whose own request ran late, and moves on", async () => {
    const room = syncRoom(Date.now() + 60_000);
    const filled = await fillPage({
      room,
      entries: ["slow", "next"],
      after: null,
      keyOf: (entry) => entry,
      itemsFor: async (entry) =>
        await Promise.resolve(entry === "slow" ? ("late" as const) : "full"),
      passOver: (entry) => [gone(entry)],
    });
    expect(filled).toStrictEqual({
      items: [gone("slow")],
      last: "slow",
      done: false,
    });
  });

  it("fails as throttled when it can take not even its first entry", async () => {
    // Its time ran out reading the provider's page.
    const room = syncRoom(Date.now() - 1);
    const filled = fillPage({
      room,
      entries: ["a", "b"],
      after: null,
      keyOf: (entry) => entry,
      itemsFor: async () => await Promise.resolve("full" as const),
      passOver: () => [],
    });
    await expect(filled).rejects.toBeInstanceOf(ToolError);
    await expect(filled).rejects.toMatchObject({
      details: { code: "throttled" },
    });
  });

  it("stops before an entry that doesn't fit once it holds one", async () => {
    const room = syncRoom(Date.now() + 60_000);
    const taken: string[] = [];
    const filled = await fillPage({
      room,
      entries: ["a", "b"],
      after: null,
      keyOf: (entry) => entry,
      itemsFor: async (entry) => {
        if (taken.length > 0) {
          return await Promise.resolve("full" as const);
        }
        taken.push(entry);
        return [];
      },
      passOver: () => [],
    });
    expect(filled).toStrictEqual({ items: [], last: "a", done: false });
  });
});
