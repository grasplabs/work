import type { ChunkRef, Reader } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

// How fast the Brain's store scans vector codes (GRA-1766), on request
// only: vite.brain-vectors.config.ts says how to run it. It fills one
// store with codes of 384 dimensions, all readable by one group, and times
// searches across the store's own boundary, where workerd's clock moves
// (in whole milliseconds, so it times a run of searches and divides):
// the 1-bit scan of every code and, apart, the re-scoring of the
// candidates, at each size. It reports what it measured on the run's
// output, as JSON lines, and asserts no time: only that each search found
// what it asked for.

const dimensions = 384;

/** The sizes measured, in codes the reader may read. */
const sizes = [10_000, 100_000, 300_000];

/** Chunks per source: each paragraph a chunk of its own. */
const perSource = 1100;

/** Most vectors a put takes. */
const perPut = 256;

/** Searches timed per size, after one to warm up. */
const runs = 30;

/** How many codes the store re-scores (vectors.ts `rescoreCandidates`). */
const candidates = 256;

const store = () => env.BRAIN_STORE.getByName("brain");

const model = {
  name: "timings@1",
  centre: Array.from({ length: dimensions }, () => 0),
};

const group = `group-${crypto.randomUUID()}`;

const randomVector = (): number[] =>
  Array.from({ length: dimensions }, () => Math.random() * 2 - 1);

/** Adds a source of `count` chunks the group reads, and their codes. */
const addCoded = async (count: number): Promise<void> => {
  const source = `timings:${crypto.randomUUID()}`;
  const { version } = await store().addSource({
    source,
    change: crypto.randomUUID(),
    text: Array.from(
      { length: count },
      (_, index) =>
        `Passage ${index}. ${"Lorem ipsum dolor sit amet. ".repeat(25)}`
    ).join("\n\n"),
    access: { kind: "audience", group },
  });
  const chunks: ChunkRef[] = Array.from({ length: count }, (_, position) => ({
    source,
    version,
    position,
  }));
  for (let start = 0; start < count; start += perPut) {
    // oxlint-disable-next-line no-await-in-loop -- one put at a time
    await store().putVectors({
      model,
      vectors: chunks
        .slice(start, start + perPut)
        .map((chunk) => ({ chunk, vector: randomVector() })),
    });
  }
};

/** Grows the group's codes by `count`. */
const grow = async (count: number): Promise<void> => {
  for (let added = 0; added < count; added += perSource) {
    // oxlint-disable-next-line no-await-in-loop -- one source at a time
    await addCoded(Math.min(perSource, count - added));
  }
};

/**
 * The mean time of a search as `reader`, in ms, timed across the RPC over
 * `runs` searches after one to warm up, and the fewest chunks one found.
 */
const timeSearch = async (
  reader: Reader
): Promise<{ ms: number; found: number }> => {
  let found = Number.POSITIVE_INFINITY;
  let started = 0;
  for (let run = 0; run <= runs; run += 1) {
    if (run === 1) {
      started = performance.now();
    }
    // oxlint-disable-next-line no-await-in-loop -- one search at a time
    const { chunks } = await store().searchVectors({
      model: model.name,
      vector: randomVector(),
      reader,
      limit: 10,
    });
    found = Math.min(found, chunks.length);
  }
  return { ms: (performance.now() - started) / runs, found };
};

describe("the Brain's vector scan, timed", () => {
  it("scans every code a reader may read, at each size", async () => {
    // A reader of exactly the candidates: the scan is next to nothing,
    // so the time is the re-scoring, and the round trip.
    const few = `person-${crypto.randomUUID()}`;
    const source = `timings:${crypto.randomUUID()}`;
    const { version } = await store().addSource({
      source,
      change: crypto.randomUUID(),
      text: Array.from(
        { length: candidates },
        (_, index) =>
          `Own ${index}. ${"Lorem ipsum dolor sit amet. ".repeat(25)}`
      ).join("\n\n"),
      access: { kind: "owner", person: few },
    });
    await store().putVectors({
      model,
      vectors: Array.from({ length: candidates }, (_, position) => ({
        chunk: { source, version, position },
        vector: randomVector(),
      })),
    });
    const { ms: rescoring, found: rescored } = await timeSearch({
      person: few,
      groups: [],
    });
    expect(rescored).toBe(10);
    console.info(
      `BRAIN_VECTOR_TIMING ${JSON.stringify({ codes: candidates, meanMs: rescoring, rescoredPerMs: candidates / rescoring })}`
    );
    let held = 0;
    for (const size of sizes) {
      // oxlint-disable-next-line no-await-in-loop -- one size at a time
      await grow(size - held);
      held = size;
      // oxlint-disable-next-line no-await-in-loop -- one size at a time
      const { ms: took, found } = await timeSearch({
        person: `person-${crypto.randomUUID()}`,
        groups: [group],
      });
      expect(found).toBe(10);
      console.info(
        `BRAIN_VECTOR_TIMING ${JSON.stringify({
          codes: size,
          meanMs: took,
          scannedPerMs: size / Math.max(took - rescoring, Number.EPSILON),
        })}`
      );
    }
  });
});
