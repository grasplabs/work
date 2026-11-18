import type { SyncItem } from "@grasp-os/shared/sync";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { ToolError } from "../src/connector.ts";
import type { InPage } from "../src/sync.ts";
import {
  defineSync,
  fillPage,
  fitItem,
  startOfPage,
  syncRoom,
} from "../src/sync.ts";

// How a sync page is filled (pure logic): a page that can take nothing
// must never answer as if it had moved on.

const goneItem = (id: string) => ({ gone: true, id, kind: "file" }) as const;

describe("filling a sync page", () => {
  it("passes over a first entry only when it runs late twice in a row, and moves on", async () => {
    const fill = async (at: InPage) =>
      await fillPage({
        room: syncRoom(Date.now() + 60_000),
        entries: ["slow", "next"],
        at,
        keyOf: (entry) => entry,
        itemsFor: async (entry) =>
          await Promise.resolve(entry === "slow" ? ("late" as const) : "full"),
        passOver: (entry) => [goneItem(entry)],
      });
    // One slow answer costs nothing: the page marks it and answers nothing.
    const once = await fill(startOfPage);
    expect(once).toStrictEqual({
      items: [],
      at: { after: null, late: "slow" },
      done: false,
    });
    // Late again on the next read: passed over, its content left out.
    const twice = await fill(once.at);
    expect(twice).toStrictEqual({
      items: [goneItem("slow")],
      at: { after: "slow", late: null },
      done: false,
    });
  });

  it("fails as throttled when it can take not even its first entry", async () => {
    // Its time ran out reading the provider's page.
    const room = syncRoom(Date.now() - 1);
    const filled = fillPage({
      room,
      entries: ["a", "b"],
      at: startOfPage,
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
      at: startOfPage,
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
    expect(filled).toStrictEqual({
      items: [],
      at: { after: "a", late: null },
      done: false,
    });
  });
});

const good = {
  gone: false,
  id: "file-1",
  kind: "file",
  version: "7",
  changedAt: "2026-11-17T09:00:00.000Z",
  title: "Price list",
  content: { type: "text", text: "Coffee 3.20" },
  readers: [{ kind: "account", id: "owner@acme.test" }],
  changedBy: "owner@acme.test",
  partOf: null,
} as const;

const tooLong = "x".repeat(1025);

describe("fitting a sync's item to the shared shape", () => {
  it("cuts a title too long on a character's boundary", () => {
    // 1,023 characters, then one of two UTF-16 units: it can't fit.
    const title = `${"a".repeat(1023)}😀 and more`;
    expect(fitItem({ ...good, title }, "file")).toStrictEqual({
      ...good,
      title: "a".repeat(1023),
    });
  });

  it("leaves out a part that doesn't fit, never adding a reader", () => {
    expect(
      fitItem(
        {
          ...good,
          content: { type: "file", contentType: tooLong, base64: "AA==" },
          readers: [
            { kind: "account", id: tooLong },
            { kind: "group", id: "sales@acme.test" },
          ],
          changedBy: tooLong,
          partOf: tooLong,
        },
        "file"
      )
    ).toStrictEqual({
      ...good,
      content: null,
      readers: [{ kind: "group", id: "sales@acme.test" }],
      changedBy: null,
      partOf: null,
    });
  });

  it("answers an item whose version or time doesn't fit as gone, and leaves out one it can't name", () => {
    const gone = { gone: true, id: "file-1", kind: "file" };
    expect([
      fitItem({ ...good, version: tooLong }, "file"),
      fitItem({ ...good, changedAt: "yesterday" }, "file"),
      fitItem({ ...good, id: tooLong }, "file"),
    ]).toStrictEqual([gone, gone, null]);
  });

  it("never fails a page for one item that doesn't fit", async () => {
    const sync = defineSync({
      name: "files",
      kind: "file",
      routes: [{ method: "GET", host: "api.example.test", path: "/v1/items" }],
      read: async () =>
        await Promise.resolve({
          // As a connector might pass a vendor's values on.
          items: z
            .array(z.custom<SyncItem>())
            .parse([good, { ...good, id: "file-2", title: tooLong }]),
          cursor: "2",
          more: false,
        }),
    });
    const answer = await sync.call({
      name: "files",
      place: "own",
      cursor: null,
    });
    expect(answer).toStrictEqual({
      page: {
        items: [good, { ...good, id: "file-2", title: "x".repeat(1024) }],
        cursor: "2",
        more: false,
      },
    });
  });
});
