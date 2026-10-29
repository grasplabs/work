import { describe, expect, it } from "vite-plus/test";

import { writeVersion } from "../src/documents.ts";
import { exactTermsOf } from "../src/exact.ts";
import { fused } from "../src/fusion.ts";
import { d1BrainStore } from "../src/recall-store.ts";
import type { BrainStore } from "../src/recall-store.ts";
import { recall } from "../src/recall.ts";
import type { Caller } from "./host.ts";
import { newCollection, testHost, writerOf } from "./host.ts";

// The Brain's hybrid recall (GRA-304, policy hybrid@1): lanes read in
// parallel, each only what its reader may read, fused by rank. What could
// go wrong, tried here: an identifier the question names exactly buried
// under sections that merely share its words; a near identifier taken for
// it; the exact lane reaching a collection the reader can't read; one
// source counted twice because two lanes found it; a lane that is slow or
// down passed off as a complete read; a lane's score taken for truth.

const { brain } = testHost();

/** Saves `text` at `path` in `collection`. */
const saved = async (
  collection: Awaited<ReturnType<typeof newCollection>>,
  path: string,
  text: string
) =>
  await writeVersion(brain, writerOf("writer"), {
    collection,
    path,
    text,
    ifVersion: 0,
    message: null,
    restoredFrom: null,
  });

/** The documents a pack cites, in order. */
const documentsOf = (pack: Awaited<ReturnType<typeof recall>>) =>
  pack.items.flatMap(({ sourceRefs }) =>
    sourceRefs.flatMap((ref) =>
      ref.kind === "document" ? [ref.documentId] : []
    )
  );

/** A collection with an invoice named exactly, one named almost, and one that shares only the question's words. */
const invoices = async () => {
  const mine = await newCollection(brain, "Invoices");
  const marker = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
  const id = `INV-${marker}-0042`;
  const near = `INV-${marker}-0043`;
  const named = await saved(mine, "named.md", `# ${id}\nSettled.`);
  const almost = await saved(mine, "almost.md", `# ${near}\nSettled.`);
  const wordy = await saved(
    mine,
    "wordy.md",
    `# Invoice payment status\nThe payment status of a customer's invoice: overdue invoices get a reminder, ${marker} included.`
  );
  return { mine, id, marker, named, almost, wordy };
};

describe("the Brain's hybrid recall", () => {
  it("puts what the question names exactly first, once, and says which lanes found it", async () => {
    const { mine, id, named, almost, wordy } = await invoices();
    const reader: Caller = { userId: "ann", reads: [mine.id] };

    const pack = await recall(brain, reader, {
      query: `What is the payment status of invoice ${id} for the customer?`,
    });
    const found = documentsOf(pack);
    const applicability = new Map(
      pack.items.map((item, index) => [found[index], item.applicability])
    );

    expect({
      policy: pack.retrievalPolicyVersion,
      first: found[0],
      once: found.filter((each) => each === named.id).length,
      named: applicability.get(named.id),
      // The near one shares the question's words, never its identifier.
      almost: applicability.get(almost.id)?.includes("exactly") ?? false,
      wordy: found.includes(wordy.id),
      coverage: pack.coverage,
    }).toStrictEqual({
      policy: "hybrid@1",
      first: named.id,
      once: 1,
      named:
        "It holds what the question names exactly. Its words match the question's (full text).",
      almost: false,
      wordy: true,
      coverage: {
        state: "complete",
        queriedRoutes: ["exact", "fulltext"],
        omittedRoutes: [{ route: "semantic", reason: "not_enabled" }],
      },
    });
  });

  it("never finds by the exact lane what its reader may not read", async () => {
    const { id } = await invoices();
    const elsewhere = await newCollection(brain, "Elsewhere");
    await saved(elsewhere, "note.md", "# Notes\nThe garden needs water.");
    const reader: Caller = { userId: "bob", reads: [elsewhere.id] };

    const pack = await recall(brain, reader, { query: id });

    expect({
      items: pack.items.length,
      gaps: pack.gaps.length,
      routes: pack.coverage.queriedRoutes,
    }).toStrictEqual({ items: 0, gaps: 1, routes: ["exact", "fulltext"] });
  });

  it("reads full text alone when the question names nothing exactly", async () => {
    const { mine } = await invoices();
    const reader: Caller = { userId: "ann", reads: [mine.id] };

    const pack = await recall(brain, reader, {
      query: "Which invoices are overdue?",
    });

    expect(pack.coverage).toStrictEqual({
      state: "complete",
      queriedRoutes: ["fulltext"],
      omittedRoutes: [{ route: "semantic", reason: "not_enabled" }],
    });
  });

  it("fuses a vector index's finds with the others, each source once, and says when it is slow or down", async () => {
    const { mine, wordy } = await invoices();
    const reader: Caller = { userId: "ann", reads: [mine.id] };
    const query = "Which invoices are overdue?";
    const store = d1BrainStore(brain);
    // A vector index, the one outside system here: it finds the wordy
    // invoice, as the full text does.
    const { sections, provenance } = await store.findEvidence(reader, {
      query,
      limit: 5,
    });
    const indexed = sections.filter(({ hit }) => hit.documentId === wordy.id);
    const withIndex = (
      findSimilar: NonNullable<BrainStore<Caller>["findSimilar"]>
    ): BrainStore<Caller> => ({ ...store, findSimilar });

    const fusedPack = await recall(
      brain,
      reader,
      { query },
      undefined,
      withIndex(async () => {
        await Promise.resolve();
        return { sections: indexed, provenance };
      })
    );
    const down = await recall(
      brain,
      { ...reader, userId: "ann-down" },
      { query },
      undefined,
      withIndex(async () => {
        await Promise.resolve();
        throw new Error("The index is down");
      })
    );
    const slow = await recall(
      brain,
      { ...reader, userId: "ann-slow" },
      { query, budget: { deadlineMs: 200 } },
      undefined,
      withIndex(async () => {
        await scheduler.wait(1000);
        return { sections: indexed, provenance };
      })
    );
    const wordyItem = fusedPack.items.find((item) =>
      item.sourceRefs.some(
        (ref) => ref.kind === "document" && ref.documentId === wordy.id
      )
    );

    expect({
      fused: {
        once: documentsOf(fusedPack).filter((each) => each === wordy.id).length,
        applicability: wordyItem?.applicability,
        coverage: fusedPack.coverage,
      },
      down: {
        coverage: down.coverage,
        gaps: down.gaps,
        items: down.items.length > 0,
      },
      slow: {
        coverage: slow.coverage,
        items: slow.items.length > 0,
      },
    }).toStrictEqual({
      fused: {
        once: 1,
        applicability:
          "Its words match the question's (full text). Its meaning is close to the question's (vectors).",
        coverage: {
          state: "complete",
          queriedRoutes: ["fulltext", "semantic"],
          omittedRoutes: [],
        },
      },
      // What the other lanes found still answers; that the index was down
      // is said, and nothing missing is a gap.
      down: {
        coverage: {
          state: "degraded",
          queriedRoutes: ["fulltext"],
          omittedRoutes: [{ route: "semantic", reason: "failed" }],
        },
        gaps: [],
        items: true,
      },
      slow: {
        coverage: {
          state: "degraded",
          queriedRoutes: ["fulltext"],
          omittedRoutes: [{ route: "semantic", reason: "deadline" }],
        },
        items: true,
      },
    });
  });
});

describe("exact terms of a question", () => {
  it("are identifiers, dates and quoted phrases, each its words in order", () => {
    expect(
      exactTermsOf(
        `Is INV-2026-0042 from 27-10-2026 or "the old plan", and what of order 48213, step 5 or GRA-304?`
      )
    ).toStrictEqual([
      ["the", "old", "plan"],
      ["inv", "2026", "0042"],
      ["27", "10", "2026"],
      ["48213"],
      ["gra", "304"],
    ]);
  });
});

describe("the fusion", () => {
  it("ranks by the lanes' ranks, an exact find twice as much, each source once, ties as met", () => {
    const ranked = fused([
      {
        lane: "fulltext",
        candidates: [
          { key: "a", value: 1 },
          { key: "b", value: 2 },
        ],
      },
      { lane: "exact", candidates: [{ key: "b", value: 2 }] },
      { lane: "fulltext", candidates: [{ key: "m", value: 3 }] },
    ]);
    expect(ranked.map(({ key, lanes }) => [key, lanes])).toStrictEqual([
      ["b", ["fulltext", "exact"]],
      ["a", ["fulltext"]],
      ["m", ["fulltext"]],
    ]);
  });
});
