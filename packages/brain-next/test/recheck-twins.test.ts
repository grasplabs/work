// The re-check's rule against twins (GRA-1752; the threat model is on the
// issue): a reader's answers about a memory drawn from a source equal
// those of a store without the versions of that source they may not read.
// Generated: every sequence of up to three versions after the first, each
// for the wide group or the narrow one, with the memory's line or
// without, and the queue ticked after it or not (a re-check finished, or
// still waiting). The source is added twice in the shared store: as it
// is, and as its twin without the narrow versions, the queue ticked at
// the same points; a reader of the wide group alone reads both, and must read
// them alike. A reader of both groups reads every version, so the store
// as it is is their twin. Each source has its own names, so the cases
// never see each other's memories.
import type {
  Access,
  Embedders,
  HandOvers,
  PersonReader,
} from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { BrainStore } from "../src/store.ts";

type Store = DurableObjectStub<BrainStore>;

const shared = (): Store => env.BRAIN_STORE.getByName("brain");

const unique = (name: string): string =>
  `${name}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

const audience = (group: string): Access => ({ kind: "audience", group });

const noModel: Embedders = {
  model: null,
  embed: async () => {
    await Promise.resolve();
    return { kind: "unavailable" };
  },
};

const noHandOvers: HandOvers = {
  handOver: async () => {
    await Promise.resolve();
    return { kind: "nothing" };
  },
};

/** The queue's clock: a minute on per tick. */
let clock = Date.now();
const tick = async (): Promise<void> => {
  clock = Math.max(clock + 60_000, Date.now());
  await shared().work({
    ask: async () => {
      await Promise.resolve();
      return { kind: "refused" };
    },
    at: new Date(clock),
    embedders: noModel,
    handOvers: noHandOvers,
    contextTokens: null,
  });
};

/** A version after the first: who reads it, whether it says the line, and whether the queue ticks after it. */
interface Step {
  narrow: boolean;
  line: boolean;
  tick: boolean;
}

/** Every step there is. */
const stepKinds: Step[] = [false, true].flatMap((narrow) =>
  [false, true].flatMap((line) =>
    [false, true].map((ticked) => ({ narrow, line, tick: ticked }))
  )
);

/** Every sequence of one to `most` steps. */
const sequences = (most: number): Step[][] => {
  let last: Step[][] = [[]];
  const all: Step[][] = [];
  for (let length = 1; length <= most; length += 1) {
    last = last.flatMap((sequence) =>
      stepKinds.map((step) => [...sequence, step])
    );
    all.push(...last);
  }
  return all;
};

/** The groups of the file. */
const wide = unique("wide");
const narrow = unique("narrow");

/** A source with a first version for `wide` that says the line, and its memory. */
const first = async () => {
  const name = unique("Twin");
  const source = unique("doc");
  const line = `${name} pays by card`;
  const ref = await shared().addSource({
    source,
    change: crypto.randomUUID(),
    text: `${line}.`,
    access: audience(wide),
  });
  const added = await shared().addMemories({
    change: crypto.randomUUID(),
    access: audience(wide),
    entities: [{ key: "c", kind: "customer", names: [`${name} Group`] }],
    memories: [
      {
        about: "c",
        type: "fact",
        statement: `${line}.`,
        speaker: { kind: "outside" },
        basis: { kind: "source", ...ref, quote: line },
      },
    ],
  });
  return {
    name,
    source,
    line,
    memory: added.memories[0] ?? "",
    entity: added.entities.c ?? "",
  };
};

type Made = Awaited<ReturnType<typeof first>>;

/** Version `step` of `made`'s source. */
const versionOf = async (made: Made, step: Step): Promise<void> => {
  await shared().addSource({
    source: made.source,
    change: crypto.randomUUID(),
    text: step.line
      ? `${made.line}. ${unique("x")}`
      : `Without. ${unique("x")}`,
    access: audience(step.narrow ? narrow : wide),
  });
};

/**
 * The source as `steps` make it, and its twin without the narrow
 * versions, side by side: each step's version added to both (the twin
 * only when it is wide), then the queue ticked when the step says so, so
 * both are worked at the same points.
 */
const twins = async (steps: readonly Step[]) => {
  const real = await first();
  const twin = await first();
  for (const step of steps) {
    // oxlint-disable-next-line no-await-in-loop -- one version at a time
    await versionOf(real, step);
    if (!step.narrow) {
      // oxlint-disable-next-line no-await-in-loop -- one version at a time
      await versionOf(twin, step);
    }
    if (step.tick) {
      // oxlint-disable-next-line no-await-in-loop -- one version at a time
      await tick();
    }
  }
  return { real, twin };
};

/** What `reader` reads of the memory: its state, whether readable, whether its entity is found. */
const seen = async ({ name, memory, entity }: Made, reader: PersonReader) => {
  const { memories } = await shared().readMemories({
    entity,
    reader,
    history: true,
  });
  const read = memories.find(({ id }) => id === memory);
  const readable = await shared().readableMemories({
    memories: [memory],
    reader,
  });
  const found = await shared().findEntities({
    reader,
    name: `${name} Group`,
  });
  let state = "unread";
  if (read !== undefined) {
    state = read.endedAt === null ? "current" : "ended";
  }
  return {
    state,
    readable: readable.length,
    found: found.entities.length,
  };
};

const label = (steps: readonly Step[]): string =>
  steps
    .map(
      ({ narrow: isNarrow, line, tick: ticked }) =>
        `${isNarrow ? "N" : "W"}${line ? "+" : "-"}${ticked ? "t" : "w"}`
    )
    .join(" ");

describe("the re-check against twins", () => {
  it("answers a reader of the wide group as a store without the narrow versions, in every order of versions, finished or waiting", async () => {
    const wideOnly: PersonReader = { person: unique("p"), groups: [wide] };
    const differ: string[] = [];
    for (const steps of sequences(3)) {
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      const { real, twin } = await twins(steps);
      // The store's version is current only when the reader may read it:
      // a narrow current version hides the memory, as narrowing does.
      const hidden = steps.at(-1)?.narrow === true;
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      const got = await seen(real, wideOnly);
      const want = hidden
        ? { state: "unread", readable: 0, found: 0 }
        : // oxlint-disable-next-line no-await-in-loop -- one case at a time
          await seen(twin, wideOnly);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        differ.push(
          `${label(steps)}: ${JSON.stringify(got)} against ${JSON.stringify(want)}`
        );
      }
    }

    expect(differ).toStrictEqual([]);
  }, 120_000);
});
