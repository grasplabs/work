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
import { runInDurableObject } from "cloudflare:test";
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

// Three overlapping groups, a reader in each non-empty subset of them,
// and every surface a reader has compared after every event: a version
// for one group, with or without the line; a late add citing the first
// version; or a version before the current one held part-way through an
// erasure (its record rows, as an erasure is between hiding and
// deleting), the queue ticked after it or not. A seeded series, so a
// failure names the same case again.

/** The three groups of the series. */
const three = [unique("ga"), unique("gb"), unique("gc")] as const;

/** Every non-empty subset of the three groups, by their places. */
const subsets: number[][] = [[0], [1], [2], [0, 1], [0, 2], [1, 2], [0, 1, 2]];

/** The series' generator (Park–Miller's MINSTD), from a fixed seed. */
const modulus = 2_147_483_647;
const multiplier = 48_271;
// 4242 (like 99 and 7) makes a series that fails when the latest
// finished re-check is taken before the reader's access is checked: a
// seed changed must still do so.
let state = 4242;
const random = (): number => {
  state = (state * multiplier) % modulus;
  return state / modulus;
};

/** An event after the first version. */
type Event =
  | { kind: "version"; to: number; line: boolean; tick: boolean }
  | { kind: "late"; tick: boolean }
  | { kind: "hold"; which: number; tick: boolean };

/** A source of the series: its first version's group, and every memory drawn from it. */
interface Grown {
  name: string;
  source: string;
  line: string;
  group: number;
  ref: { source: string; version: number };
  memories: string[];
  entity: string;
}

/** A source with a first version for group `group` that says the line, and its memory. */
const grown = async (group: number): Promise<Grown> => {
  const name = unique("Twin");
  const source = unique("doc");
  const line = `${name} pays by card`;
  const access = audience(three[group] ?? "");
  const ref = await shared().addSource({
    source,
    change: crypto.randomUUID(),
    text: `${line}.`,
    access,
  });
  const added = await shared().addMemories({
    change: crypto.randomUUID(),
    access,
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
    group,
    ref,
    memories: [added.memories[0] ?? ""],
    entity: added.entities.c ?? "",
  };
};

/** A memory added late, citing the first version, as its first was. */
const lateAdd = async (source: Grown): Promise<void> => {
  const added = await shared().addMemories({
    change: crypto.randomUUID(),
    access: audience(three[source.group] ?? ""),
    entities: [{ key: "c", id: source.entity, kind: "customer" }],
    memories: [
      {
        about: "c",
        type: "fact",
        statement: `${source.name} Group renews in May.`,
        speaker: { kind: "outside" },
        basis: { kind: "source", ...source.ref, quote: source.line },
      },
    ],
  });
  source.memories.push(added.memories[0] ?? "");
};

/** A version of `source` for group `to`: its number. */
const grownVersion = async (
  source: Grown,
  to: number,
  line: boolean
): Promise<number> => {
  const added = await shared().addSource({
    source: source.source,
    change: crypto.randomUUID(),
    text: line ? `${source.line}. ${unique("x")}` : `Without. ${unique("x")}`,
    access: audience(three[to] ?? ""),
  });
  return added.version;
};

/** Version `version` of `source` held part-way through an erasure. */
const held = async (source: string, version: number): Promise<void> => {
  await runInDurableObject(shared(), (_instance, store) => {
    const { sql } = store.storage;
    const key = `held-${crypto.randomUUID()}`;
    sql.exec(
      `INSERT INTO erasures (key, kind, subject, reason, erased_at, confirmed)
      VALUES (?, 'person', ?, 'withdrawn', ?, 1)`,
      key,
      crypto.randomUUID(),
      Date.now()
    );
    sql.exec(
      `INSERT OR IGNORE INTO erasing_versions (version_row, erasure)
      SELECT row, ? FROM source_versions WHERE source = ? AND version = ?`,
      key,
      source,
      version
    );
  });
};

/** What `reader` reads of `source`'s memories through every surface. */
const surfaces = async (source: Grown, reader: PersonReader) => {
  const { memories } = await shared().readMemories({
    entity: source.entity,
    reader,
    history: true,
  });
  const current = await shared().readMemories({
    entity: source.entity,
    reader,
  });
  const paged = await shared().readMemories({
    entity: source.entity,
    reader,
    history: true,
    limit: 1,
  });
  const readable = await shared().readableMemories({
    memories: source.memories,
    reader,
  });
  const found = await shared().findEntities({
    reader,
    name: `${source.name} Group`,
  });
  const pack = await shared().recall({
    question: `${source.name} Group pays`,
    reader,
    budget: { tokens: 20_000 },
  });
  const card = await shared().readCard({ entity: source.entity, reader });
  const cardText = JSON.stringify(card);
  return {
    states: source.memories.map((id) => {
      const read = memories.find((memory) => memory.id === id);
      if (read === undefined) {
        return "unread";
      }
      return read.endedAt === null ? "current" : "ended";
    }),
    current: source.memories.map((id) =>
      current.memories.some((memory) => memory.id === id)
    ),
    readable: source.memories.map((id) => readable.includes(id)),
    found: found.entities.length,
    recalled: source.memories.map((id) =>
      pack.memories.some(({ memory }) => memory === id)
    ),
    card:
      card === null
        ? "none"
        : source.memories.map((id) => cardText.includes(id)),
    nextPage: paged.next !== undefined,
  };
};

/** What a reader who may not read a source's current version reads of it: nothing. */
const nothingOf = (source: Grown) => ({
  states: source.memories.map(() => "unread"),
  current: source.memories.map(() => false),
  readable: source.memories.map(() => false),
  found: 0,
  recalled: source.memories.map(() => false),
  card: "none",
  nextPage: false,
});

/** A sequence of three to five events after a first version. */
const series = (): { group: number; events: Event[] } => {
  const group = Math.floor(random() * 3);
  const length = 3 + Math.floor(random() * 3);
  const events: Event[] = [];
  let versions = 1;
  for (let index = 0; index < length; index += 1) {
    const roll = random();
    const ticked = random() < 0.5;
    if (roll < 0.12) {
      events.push({ kind: "late", tick: ticked });
    } else if (roll < 0.27 && versions >= 3) {
      // A version before the current one, never the first (its erasure
      // takes the memory).
      events.push({
        kind: "hold",
        which: 1 + Math.floor(random() * (versions - 2)),
        tick: ticked,
      });
    } else {
      events.push({
        kind: "version",
        to: Math.floor(random() * 3),
        line: random() < 0.5,
        tick: ticked,
      });
      versions += 1;
    }
  }
  return { group, events };
};

/** A version of the store as it is, and the twin's number for it in each twin that has it. */
interface Versioned {
  version: number;
  twins: Map<number, number>;
}

/** Applies `event` to `real` and to each twin that reads what it adds: whether the current group changed, and to which. */
const applied = async (
  event: Event,
  real: Grown,
  twinOf: ReadonlyMap<number, Grown>,
  versions: Versioned[],
  currentGroup: number
): Promise<number> => {
  if (event.kind === "version") {
    const version = await grownVersion(real, event.to, event.line);
    const inTwins = new Map<number, number>();
    for (const [index, twin] of twinOf) {
      if (subsets[index]?.includes(event.to) === true) {
        // oxlint-disable-next-line no-await-in-loop -- one twin at a time
        inTwins.set(index, await grownVersion(twin, event.to, event.line));
      }
    }
    versions.push({ version, twins: inTwins });
    return event.to;
  }
  if (event.kind === "late") {
    // A late add's readers are the first version's: only while it is
    // theirs is the source current for them.
    if (currentGroup === real.group) {
      await lateAdd(real);
      for (const twin of twinOf.values()) {
        // oxlint-disable-next-line no-await-in-loop -- one twin at a time
        await lateAdd(twin);
      }
    }
    return currentGroup;
  }
  const version = versions[event.which];
  if (version !== undefined) {
    await held(real.source, version.version);
    for (const [index, number] of version.twins) {
      const twin = twinOf.get(index);
      if (twin !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- one twin at a time
        await held(twin.source, number);
      }
    }
  }
  return currentGroup;
};

describe("the re-check against twins, three groups", () => {
  it("answers every subset of three groups as its twin after every event, late adds and erasures under way among them", async () => {
    const readers = subsets.map((places) => ({
      places,
      reader: {
        person: unique("p"),
        groups: places.map((place) => three[place] ?? ""),
      },
    }));
    const differ: string[] = [];
    for (let count = 0; count < 25; count += 1) {
      const { group, events } = series();
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      const real = await grown(group);
      const twinOf = new Map<number, Grown>();
      for (const [index, { places }] of readers.entries()) {
        if (places.includes(group)) {
          // oxlint-disable-next-line no-await-in-loop -- one case at a time
          twinOf.set(index, await grown(group));
        }
      }
      const versions: Versioned[] = [
        {
          version: real.ref.version,
          twins: new Map(
            [...twinOf].map(([index, twin]) => [index, twin.ref.version])
          ),
        },
      ];
      let currentGroup = group;
      for (const [at, event] of events.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- one event at a time
        currentGroup = await applied(
          event,
          real,
          twinOf,
          versions,
          currentGroup
        );
        if (event.tick) {
          // oxlint-disable-next-line no-await-in-loop -- one event at a time
          await tick();
        }
        for (const [index, { places, reader }] of readers.entries()) {
          const twin = twinOf.get(index);
          // oxlint-disable-next-line no-await-in-loop -- one reader at a time
          const got = await surfaces(real, reader);
          const want =
            twin === undefined || !places.includes(currentGroup)
              ? nothingOf(real)
              : // oxlint-disable-next-line no-await-in-loop -- one reader at a time
                await surfaces(twin, reader);
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            differ.push(
              `${JSON.stringify({ group, events })} @${at} {${places.join(",")}}: ${JSON.stringify(got)} against ${JSON.stringify(want)}`
            );
          }
        }
      }
    }

    expect(differ).toStrictEqual([]);
  }, 120_000);
});
