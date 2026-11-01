import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { createBrain } from "../src/brain.ts";
import { writeVersion } from "../src/documents.ts";
import { d1BrainStore } from "../src/recall-store.ts";
import { recall } from "../src/recall.ts";
import type { Caller } from "./host.ts";
import { newCollection, testHost, writerOf } from "./host.ts";

// A recall kept for a moment (GRA-304, recall-cache.ts). What could go
// wrong, tried here: an answer served from before a write that changed
// what the question finds; one served to a reader who may no longer read
// what it cites; a kept answer skipping the read's record and provenance;
// a degraded read kept as if it were whole; a different question, bound
// or rerank served another's answer; a reranked answer paying the model
// again, or not at all, when it should.

const host = testHost();

/** Letters only: digits would make it an identifier, for the exact lane. */
const rareWord = (): string =>
  `zq${[...crypto.getRandomValues(new Uint8Array(12))]
    .map((byte) => String.fromCodePoint(97 + (byte % 26)))
    .join("")}`;

/** A collection of notes on a rare word, and a saver of more. */
const notes = async () => {
  const collection = await newCollection(host.brain, "Notes");
  const word = rareWord();
  const save = async (path: string, text: string) =>
    await writeVersion(host.brain, writerOf("writer"), {
      collection,
      path,
      text,
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
  const first = await save("a.md", `# ${word}\nThe ${word} rules.`);
  const second = await save("b.md", `# Notes\nA ${word} note.`);
  return { collection, word, save, ids: [first.id, second.id] };
};

/** The documents a pack cites, in order. */
const documentsOf = (pack: Awaited<ReturnType<typeof recall>>) =>
  pack.items.flatMap(({ sourceRefs }) =>
    sourceRefs.flatMap((ref) =>
      ref.kind === "document" ? [ref.documentId] : []
    )
  );

/** The recall reads `caller` recorded since `from`, as their cache said. */
const recallReadsSince = (from: number, caller: string) =>
  host.reads
    .slice(from)
    .filter(
      ({ caller: who, record }) =>
        who === caller &&
        record.action === "knowledge.search" &&
        record.detail.via === "recall"
    )
    .map(({ record }) => ({
      cache: record.detail.cache ?? "read",
      documents: record.documentIds?.length ?? 0,
    }));

describe("a recall kept for a moment", () => {
  it("answers the same question again from what it kept, recording and noting the read as before", async () => {
    const { collection, word } = await notes();
    const reader: Caller = { userId: `ann-${word}`, reads: [collection.id] };
    const from = host.reads.length;

    const first = await recall(host.brain, reader, { query: word });
    const again = await recall(host.brain, reader, { query: word });

    expect({
      same: documentsOf(again),
      pack: [
        again.id === first.id,
        again.accessRevision === first.accessRevision,
      ],
      reads: recallReadsSince(from, reader.userId),
    }).toStrictEqual({
      same: documentsOf(first),
      // A new pack, of the same access.
      pack: [false, true],
      reads: [
        // The first read (one lane reads), then the kept answer's own record.
        { cache: "read", documents: 2 },
        { cache: "hit", documents: 2 },
      ],
    });
  });

  it("reads again once a write changed what the question finds", async () => {
    const { collection, word, save } = await notes();
    const reader: Caller = { userId: "ann", reads: [collection.id] };
    await recall(host.brain, reader, { query: word });
    const added = await save("c.md", `# ${word}\nA new ${word}.`);

    const after = await recall(host.brain, reader, { query: word });

    expect(documentsOf(after)).toContain(added.id);
  });

  it("answers a reader who may no longer read what it cites by reading again", async () => {
    const { collection, word } = await notes();
    const access = [collection.id];
    // The host's key for this reader stays the same: only the recheck of
    // what the kept answer cites stands between it and them.
    const reader: Caller = { userId: "bob", reads: access };
    const kept = await recall(host.brain, reader, { query: word });
    access.length = 0;

    const after = await recall(host.brain, reader, { query: word });

    expect({
      before: kept.items.length,
      after: after.items.length,
    }).toStrictEqual({ before: 2, after: 0 });
  });

  it("keeps each question, bound and rerank apart, and pays a reranker once for an answer it kept", async () => {
    const { collection, word } = await notes();
    const reader: Caller = { userId: "cas", reads: [collection.id] };
    let reranked = 0;
    const brain = createBrain(env.BRAIN, {
      ...host.brain.ports,
      rerank: async (_reader, { candidates }) => {
        reranked += 1;
        await Promise.resolve();
        return candidates.map(({ id }) => id).toReversed();
      },
    });

    const plain = await recall(brain, reader, { query: word });
    const asked = await recall(brain, reader, {
      query: word,
      budget: { rerank: true },
    });
    const askedAgain = await recall(brain, reader, {
      query: word,
      budget: { rerank: true },
    });
    const fewer = await recall(brain, reader, {
      query: word,
      budget: { maxItems: 1 },
    });

    expect({
      plain: plain.retrievalPolicyVersion,
      asked: [asked.retrievalPolicyVersion, documentsOf(asked)],
      askedAgain: documentsOf(askedAgain),
      reranked,
      fewer: fewer.items.length,
    }).toStrictEqual({
      plain: "hybrid@1",
      asked: ["hybrid@1+rerank@1", documentsOf(plain).toReversed()],
      askedAgain: documentsOf(plain).toReversed(),
      reranked: 1,
      fewer: 1,
    });
  });

  it("never keeps an answer whose rerank was asked for and didn't happen", async () => {
    const { collection, word } = await notes();
    const reader: Caller = { userId: `eve-${word}`, reads: [collection.id] };
    let tries = 0;
    const brain = createBrain(env.BRAIN, {
      ...host.brain.ports,
      rerank: async () => {
        tries += 1;
        await Promise.resolve();
        throw new Error("The model is down");
      },
    });

    await recall(brain, reader, { query: word, budget: { rerank: true } });
    await recall(brain, reader, { query: word, budget: { rerank: true } });

    expect(tries).toBe(2);
  });

  it("never keeps a degraded read", async () => {
    const { collection, word } = await notes();
    const reader: Caller = { userId: `dee-${word}`, reads: [collection.id] };
    const store = d1BrainStore(host.brain);
    const slow = {
      ...store,
      // A vector index, the outside system here, slower than the deadline.
      findSimilar: async () => {
        await scheduler.wait(500);
        return {
          sections: [],
          provenance: {
            collectionIds: [],
            sensitive: false,
            restricted: false,
          },
        };
      },
    };
    const from = host.reads.length;

    const first = await recall(
      host.brain,
      reader,
      { query: word, budget: { deadlineMs: 200 } },
      undefined,
      slow
    );
    await recall(
      host.brain,
      reader,
      { query: word, budget: { deadlineMs: 200 } },
      undefined,
      slow
    );

    expect({
      state: first.coverage.state,
      reads: recallReadsSince(from, reader.userId).map(({ cache }) => cache),
    }).toStrictEqual({ state: "degraded", reads: ["read", "read"] });
  });
});
