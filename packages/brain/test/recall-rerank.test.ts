import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { createBrain } from "../src/brain.ts";
import type { RerankRequest } from "../src/brain.ts";
import { writeVersion } from "../src/documents.ts";
import { d1BrainStore } from "../src/recall-store.ts";
import { recall } from "../src/recall.ts";
import type { Caller } from "./host.ts";
import { newCollection, testHost, writerOf } from "./host.ts";

// Reranking a recall (GRA-304, rerank@1): only when its budget asks, the
// best of what the lanes found ordered again by the host's model. The
// model is the one outside system here, stood in for. What could go
// wrong, tried here: text reaching the model that its reader may no
// longer read; the model's answer adding, dropping or repeating
// evidence; a model that fails or is slow losing the recall; a recall
// that didn't ask spending a model call.

const host = testHost();

/** The Brain of `host`, with `rerank` as its reranker; what it was asked, in order. */
const withReranker = (rerank: (request: RerankRequest) => Promise<unknown>) => {
  const asked: RerankRequest[] = [];
  const brain = createBrain(env.BRAIN, {
    ...host.brain.ports,
    rerank: async (_reader, request) => {
      asked.push(request);
      return await rerank(request);
    },
  });
  return { brain, asked };
};

/** Three notes on leave, in a collection of their own, and who reads them. */
const notes = async () => {
  const collection = await newCollection(host.brain, "Leave");
  // Letters only: a word with digits would be an identifier, for the exact lane.
  const marker = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => String.fromCodePoint(97 + (byte % 26)))
    .join("");
  const word = `zqleave${marker}`;
  const save = async (path: string, text: string) =>
    await writeVersion(host.brain, writerOf("writer"), {
      collection,
      path,
      text,
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
  const first = await save(
    "a.md",
    `# ${word} days\nThe ${word} days and ${word} rules.`
  );
  const second = await save("b.md", `# ${word}\nWho approves ${word}.`);
  const third = await save("c.md", `# Notes\nA ${word} note.`);
  return {
    query: `How many ${word} days?`,
    reads: [collection.id],
    ids: { first: first.id, second: second.id, third: third.id },
  };
};

/** The documents a pack cites, in order. */
const documentsOf = (pack: Awaited<ReturnType<typeof recall>>) =>
  pack.items.flatMap(({ sourceRefs }) =>
    sourceRefs.flatMap((ref) =>
      ref.kind === "document" ? [ref.documentId] : []
    )
  );

describe("reranking a recall", () => {
  it("orders the best of what was found as the model answers, ignoring what it adds or repeats, and keeps what it leaves out after", async () => {
    const { query, reads, ids } = await notes();
    const reader: Caller = { userId: "ann", reads };
    const plain = await recall(host.brain, reader, { query });
    const fusedOrder = documentsOf(plain);
    const last = plain.items.at(-1)?.id ?? "";
    const { brain, asked } = withReranker(async () => {
      await Promise.resolve();
      return ["invented", last, last];
    });

    const pack = await recall(brain, reader, {
      query,
      budget: { rerank: true },
    });

    expect({
      asked: asked.map(({ question, candidates }) => [
        question,
        candidates.length,
      ]),
      order: documentsOf(pack),
      policy: pack.retrievalPolicyVersion,
      routes: pack.coverage.queriedRoutes,
      fused: new Set(fusedOrder),
    }).toStrictEqual({
      asked: [[query, 3]],
      order: [fusedOrder.at(-1), ...fusedOrder.slice(0, -1)],
      policy: "hybrid@1+rerank@1",
      routes: ["fulltext", "rerank"],
      fused: new Set([ids.first, ids.second, ids.third]),
    });
  });

  it("spends no model call on a recall that doesn't ask, and says why one that asked kept the fused order", async () => {
    const { query, reads } = await notes();
    const reader: Caller = { userId: "ann", reads };
    const order = documentsOf(await recall(host.brain, reader, { query }));
    const quiet = withReranker(async () => {
      await Promise.resolve();
      return [];
    });
    const failing = withReranker(async () => {
      await Promise.resolve();
      throw new Error("The model is down");
    });
    const slow = withReranker(async () => {
      await scheduler.wait(1000);
      return [];
    });
    const malformed = withReranker(async () => {
      await Promise.resolve();
      return { ranking: "not a list" };
    });

    const notAsked = await recall(quiet.brain, reader, { query });
    const cases: [typeof host.brain, number][] = [
      [failing.brain, 5000],
      [slow.brain, 300],
      [malformed.brain, 5000],
      [host.brain, 5000],
    ];
    const outcomes = await Promise.all(
      cases.map(async ([brain, deadlineMs]) => {
        const pack = await recall(brain, reader, {
          query,
          budget: { rerank: true, deadlineMs },
        });
        return {
          order: documentsOf(pack),
          omitted: pack.coverage.omittedRoutes.filter(
            ({ route }) => route === "rerank"
          ),
          state: pack.coverage.state,
          policy: pack.retrievalPolicyVersion,
        };
      })
    );

    const kept = (reason: string) => ({
      order,
      omitted: [{ route: "rerank", reason }],
      state: "complete",
      policy: "hybrid@1",
    });
    expect({
      notAsked: [quiet.asked.length, notAsked.retrievalPolicyVersion],
      outcomes,
    }).toStrictEqual({
      notAsked: [0, "hybrid@1"],
      outcomes: [
        kept("failed"),
        kept("deadline"),
        kept("failed"),
        // A host without a reranker.
        kept("not_enabled"),
      ],
    });
  });

  it("hands the model nothing once its reader may no longer read what was found", async () => {
    const { query, reads } = await notes();
    const access = [...reads];
    const reader: Caller = { userId: "ann", reads: access };
    const store = d1BrainStore(host.brain);
    const { brain, asked } = withReranker(async () => {
      await Promise.resolve();
      return [];
    });

    const pack = await recall(
      brain,
      reader,
      { query, budget: { rerank: true } },
      undefined,
      {
        ...store,
        // The vector index, outside: while it answers, the reader's access
        // to the collection is taken away.
        findSimilar: async () => {
          // Once the full text has read.
          await scheduler.wait(100);
          access.length = 0;
          return {
            sections: [],
            provenance: {
              collectionIds: [],
              sensitive: false,
              restricted: false,
            },
          };
        },
      }
    );

    expect({
      asked: asked.length,
      omitted: pack.coverage.omittedRoutes.filter(
        ({ route }) => route === "rerank"
      ),
    }).toStrictEqual({
      asked: 0,
      omitted: [{ route: "rerank", reason: "access_changed" }],
    });
  });
});
