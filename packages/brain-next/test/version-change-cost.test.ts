// What reading a version's change costs the store, against the source's
// history (version-change.ts): it reads what the version touched, never
// the source's whole history. Held by cost, as memories-cost.test.ts holds
// the reads of memories: the rows the store's SQL reads for one page, as
// workerd counts them, must stay flat as earlier versions are added that
// the version did not touch. A source re-synced again and again that
// restates the same facts each time still costs more with its length: each
// restatement is judged against its chain (memories.ts `newerSql`, as
// every read of memories judges it), measured at 1,728, 3,948 and 8,748
// rows for 3, 40 and 120 versions (before the bound: 2,338, 252,347 and
// 2,196,907).
import type { NewMemory } from "@grasp-os/brain-next/contract";
import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { audience, readerOf } from "./entity-helpers.ts";
import { countRowsRead } from "./rows-read.ts";

/** Facts each version holds. */
const perVersion = 10;

/**
 * Rows a page may read more as the history grows: what index seeks touch
 * more as the trees grow deeper (a scan of the history would read a row or
 * more for each of its memories: hundreds here).
 */
const seekMargin = 8;

/**
 * Rows one page of the latest version's change reads, after `versions`
 * versions of one source, each with `perVersion` facts of its own drawn
 * from it and marked fully extracted, as extraction marks its last piece.
 */
const rowsOfLatest = async (versions: number): Promise<number> => {
  await reset();
  const stub = env.BRAIN_STORE.getByName("brain");
  const rowsReadBy = await countRowsRead(stub);
  const group = "finance";
  const reader = readerOf("reader", group);
  let entity: string | undefined;
  let latest = { source: "doc", version: 1 };
  for (let version = 1; version <= versions; version += 1) {
    const lines = Array.from(
      { length: perVersion },
      (_, index) => `Item ${index} is fine in ${version}`
    );
    // oxlint-disable-next-line no-await-in-loop -- one version after another
    latest = await stub.addSource({
      source: "doc",
      change: crypto.randomUUID(),
      text: `${lines.join(". ")}. Version ${version}.`,
      access: audience(group),
    });
    const doc = latest;
    // oxlint-disable-next-line no-await-in-loop -- one version after another
    const added = await stub.addMemories({
      change: crypto.randomUUID(),
      access: audience(group),
      entities: [
        entity === undefined
          ? { key: "c", kind: "customer", names: ["Acme"] }
          : { key: "c", id: entity, kind: "customer", names: [] },
      ],
      memories: lines.map((line): NewMemory => ({
        about: "c",
        type: "fact",
        statement: line,
        speaker: { kind: "system" },
        basis: { kind: "source", ...doc, quote: line },
      })),
      extracted: doc,
    });
    entity ??= added.entities.c;
  }
  return await rowsReadBy(
    async () => await stub.readVersionChange({ ...latest, reader })
  );
};

describe("the cost of a version's change", () => {
  // Measured: 1,299 rows at 3, 40 and 120 earlier versions (before the
  // bound: 1,827, 112,827 and 914,427).
  it("reads no more for one page however many earlier versions the version did not touch", async () => {
    const few = await rowsOfLatest(3);
    const many = await rowsOfLatest(40);

    expect(many).toBeLessThanOrEqual(few + seekMargin);
  }, 120_000);
});
