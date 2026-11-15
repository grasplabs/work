// The change that retired a memory (memories.ts `retireMemory`), through
// the store's own methods: kept with the retirement, and answered to every
// repeat, whoever makes it, so a caller can tell whether its own call
// retired the memory (core's audit of a forget, GRA-1883). The export test
// restores the store from empty.
import type { Reader } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import type { BrainStore } from "../src/store.ts";
import { exportSettled, restoredAfterLoss } from "./export-reads.ts";
import { copyOf, kill } from "./store-copy.ts";
import type { Copy } from "./store-copy.ts";

type Store = DurableObjectStub<BrainStore>;

const shared = (): Store => env.BRAIN_STORE.getByName("brain");
const unique = (name: string): string => `${name}-${crypto.randomUUID()}`;

/** A memory an App (`writer`) wrote for `group`, and the App's code as its reader. */
const written = async (): Promise<{
  memory: string;
  entity: string;
  writer: string;
  reader: Reader;
}> => {
  const group = unique("g");
  const writer = `app:${crypto.randomUUID()}`;
  const added = await shared().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group },
    entities: [{ key: "c", kind: "customer", names: ["Acme"] }],
    memories: [
      {
        about: "c",
        type: "fact",
        statement: "Acme renews in March",
        speaker: { kind: "system" },
        basis: { kind: "writer", writer },
      },
    ],
  });
  return {
    memory: added.memories[0] ?? "",
    entity: added.entities.c ?? "",
    writer,
    reader: { person: null, groups: [group] },
  };
};

describe("the change that retired a memory", () => {
  /** The shared store before any test of this file added to it: empty. */
  let empty: Copy = { tables: [], others: [] };
  beforeAll(async () => {
    empty = await copyOf(shared());
  });

  it("answers every repeat, by the same change or another, also after a restart, with the change and time that retired it, changing nothing", async () => {
    const { memory, entity, writer, reader } = await written();
    const retire = async (change: string) =>
      await shared().retireMemory({ memory, reader, writer, change });

    const bob = await retire("forget:bob");
    const repeats = [await retire("forget:bob"), await retire("forget:cara")];
    await kill(shared());
    repeats.push(await retire("forget:cara"), await retire("forget:bob"));
    // Retired once, at Bob's time: the history says so.
    const { memories } = await shared().readMemories({
      entity,
      reader,
      history: true,
    });
    expect({
      change: bob?.change,
      repeats,
      ended: memories.map(({ endedAt }) => endedAt),
    }).toStrictEqual({
      change: "forget:bob",
      repeats: [bob, bob, bob, bob],
      ended: [bob?.retiredAt],
    });
  });

  it("answers another writer's call with nothing, whatever its change", async () => {
    const { memory, writer, reader } = await written();
    await shared().retireMemory({ memory, reader, writer, change: "first" });
    await expect(
      shared().retireMemory({
        memory,
        reader,
        writer: `app:${crypto.randomUUID()}`,
        change: "first",
      })
    ).resolves.toBeNull();
  });

  describe("through an export", () => {
    it("is restored with the memory", async () => {
      const { memory, writer, reader } = await written();
      const retired = await shared().retireMemory({
        memory,
        reader,
        writer,
        change: "forget:bob",
      });
      const { id } = await shared().startExport("test");
      await expect(exportSettled(shared, id)).resolves.toBe("done");

      await expect(restoredAfterLoss(shared, id, empty)).resolves.toBe("done");
      await expect(
        shared().retireMemory({ memory, reader, writer, change: "forget:cara" })
      ).resolves.toStrictEqual(retired);
    });
  });
});
