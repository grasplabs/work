// What quotes-twins.test.ts and quotes-twins-pairs.test.ts share: see
// quotes-twins.test.ts.
import type { Access, PersonReader } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import type { BrainStore } from "../src/store.ts";
import { sequenceOf } from "../src/words.ts";

type Store = DurableObjectStub<BrainStore>;

export const shared = (): Store => env.BRAIN_STORE.getByName("brain");

export const unique = (name: string): string =>
  `${name}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

const audience = (group: string): Access => ({ kind: "audience", group });

/** The queue's clock: a minute on per tick. */
let clock = Date.now();
export const tick = async (): Promise<void> => {
  clock = Math.max(clock + 60_000, Date.now());
  await shared().work({
    ask: async () => {
      await Promise.resolve();
      return { kind: "refused" };
    },
    at: new Date(clock),
    embedders: {
      model: null,
      embed: async () => {
        await Promise.resolve();
        return { kind: "unavailable" };
      },
    },
    handOvers: {
      handOver: async () => {
        await Promise.resolve();
        return { kind: "nothing" };
      },
    },
    contextTokens: null,
  });
};

/** Whether the store's clock is past every stamp it gave a write of memories. */
const pastStamps = async (): Promise<boolean> =>
  await runInDurableObject(shared(), (_instance, state) => {
    const latest =
      state.storage.sql
        .exec<{ latest: number }>(
          "SELECT latest FROM memory_stamps WHERE id = 1"
        )
        .toArray()
        .at(0)?.latest ?? 0;
    return Date.now() > latest;
  });

/**
 * Waits until a version added to `side` now is at a later moment than
 * anything written to it before: its last version, and, after a memory,
 * every stamp (a stamp runs ahead of the clock within a millisecond:
 * memories.ts `stampWrite`). So an end names one event alone. Bounded.
 */
const afterEverything = async (side: Side): Promise<void> => {
  for (let tries = 0; tries < 200; tries += 1) {
    const past =
      Date.now() > side.lastVersion &&
      // oxlint-disable-next-line no-await-in-loop -- until the clock is past
      (!side.stamped || (await pastStamps()));
    if (past) {
      side.stamped = false;
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- until the clock is past
    await scheduler.wait(1);
  }
  throw new Error("The store's clock never passed its last write");
};

/** An event of a sequence. The first is a version, and a memory on it. */
export type Event =
  | { kind: "version"; group: number; line: boolean }
  | { kind: "late"; on: number }
  | { kind: "hold"; on: number }
  | { kind: "tick" };

/** A version a side holds: its number, its text and group, whether held. */
interface Held {
  number: number;
  text: string;
  group: number;
  held: boolean;
}

/** A memory a side holds: its id, the event of its version, its quote and group. */
interface Kept {
  id: string;
  on: number;
  quote: string;
  group: number;
}

/** A source as a sequence makes it: the store as it is, or a twin. */
export interface Side {
  source: string;
  name: string;
  /**
   * The entity each memory is about, by the event that made it: one each,
   * named after that event. An add links a name only through memories
   * whose source's current version its readers may read (entities.ts
   * `coveredSql`), so a shared entity would be linked in one store and
   * made anew in its twin: main's own channel, kept out of these cases.
   */
  entities: Map<number, string>;
  versions: Map<number, Held>;
  memories: Map<number, Kept>;
  /** The event of its current version. */
  current: number | undefined;
  /** When its last version's add returned, by the clock. */
  lastVersion: number;
  /** Whether a memory was written to it since its last version. */
  stamped: boolean;
}

export const sideOf = (): Side => ({
  source: unique("doc"),
  name: unique("Twin"),
  entities: new Map(),
  versions: new Map(),
  memories: new Map(),
  current: undefined,
  lastVersion: 0,
  stamped: false,
});

/** The name of the entity of the memory of event `at`. */
const nameAt = (side: Side, at: number): string => `${side.name} Group ${at}`;

/** The line each sequence's memories quote. */
const lineOf = (side: Side): string => `${side.name} Group pays by card`;

/** Adds the version of event `at` to `side`. */
const addVersion = async (
  side: Side,
  at: number,
  groups: readonly string[],
  { group, line }: { group: number; line: boolean }
): Promise<void> => {
  await afterEverything(side);
  // Unique, so no version is ever the current one again (above).
  const text = line
    ? `${lineOf(side)}. ${unique("x")}`
    : `Without. ${unique("x")}`;
  const { version } = await shared().addSource({
    source: side.source,
    change: crypto.randomUUID(),
    text,
    access: audience(groups[group] ?? ""),
  });
  side.lastVersion = Date.now();
  side.versions.set(at, { number: version, text, group, held: false });
  side.current = at;
};

/** Adds a memory of event `at` to `side`, resting on the version of event `on`, readable by its group. */
const addMemory = async (
  side: Side,
  at: number,
  on: number,
  groups: readonly string[]
): Promise<void> => {
  const version = side.versions.get(on);
  if (version === undefined || version.held) {
    return;
  }
  const quote = lineOf(side);
  const added = await shared().addMemories({
    change: crypto.randomUUID(),
    access: audience(groups[version.group] ?? ""),
    entities: [{ key: "c", kind: "customer", names: [nameAt(side, at)] }],
    memories: [
      {
        about: "c",
        type: "fact",
        statement: `${side.name} Group pays, ${at}.`,
        speaker: { kind: "outside" },
        basis: {
          kind: "source",
          source: side.source,
          version: version.number,
          quote,
        },
      },
    ],
  });
  side.entities.set(at, added.entities.c ?? "");
  side.stamped = true;
  side.memories.set(at, {
    id: added.memories[0] ?? "",
    on,
    quote,
    group: version.group,
  });
};

/**
 * Holds the version of event `on` of `side` part-way through an erasure:
 * in the store as it is never its current one (`series`), in a twin
 * possibly, as the same version is held in every store that holds it.
 */
const holdVersion = async (side: Side, on: number): Promise<void> => {
  const version = side.versions.get(on);
  if (version === undefined || version.held) {
    return;
  }
  version.held = true;
  await runInDurableObject(shared(), (_instance, state) => {
    const { sql } = state.storage;
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
      side.source,
      version.number
    );
  });
};

/** Applies event `at` to `side`, which holds the versions of `groups` in `places`. */
export const apply = async (
  side: Side,
  at: number,
  event: Event,
  places: readonly number[] | "all",
  groups: readonly string[]
): Promise<void> => {
  const holds = (group: number): boolean =>
    places === "all" || places.includes(group);
  if (event.kind === "version") {
    if (holds(event.group)) {
      await addVersion(side, at, groups, event);
      if (at === 0) {
        await addMemory(side, at, 0, groups);
      }
    }
    return;
  }
  if (event.kind === "late") {
    await addMemory(side, at, event.on, groups);
    return;
  }
  if (event.kind === "hold") {
    await holdVersion(side, event.on);
  }
};

/** What a reader reads of one memory: "unread", "current", or what it ended at (`nameOf`). */
type Seen = string;

/** When each version of `side` was added, by its number. */
const timesOf = async (side: Side): Promise<Map<number, number>> =>
  await runInDurableObject(
    shared(),
    (_instance, state) =>
      new Map(
        state.storage.sql
          .exec<{ version: number; added_at: number }>(
            "SELECT version, added_at FROM source_versions WHERE source = ?",
            side.source
          )
          .toArray()
          .map(({ version, added_at: at }) => [version, at])
      )
  );

/** `endedAt` as what it names on `side`: the memory's learning or a version's add, by its event. */
const nameOf = (
  side: Side,
  times: ReadonlyMap<number, number>,
  endedAt: number,
  learnedAt: number
): string => {
  if (endedAt === learnedAt) {
    return "learned";
  }
  for (const [at, version] of side.versions) {
    if (times.get(version.number) === endedAt) {
      return `version ${at}`;
    }
  }
  return `moment ${endedAt}`;
};

/** The memories `reader` reads about each of `side`'s entities, by `asked`, in the order of the groups. */
const readAll = async (
  side: Side,
  reader: PersonReader,
  asked: { history?: boolean; limit?: number }
) =>
  await Promise.all(
    [...side.entities]
      .toSorted(([one], [other]) => one - other)
      .map(
        async ([, entity]) =>
          await shared().readMemories({ entity, reader, ...asked })
      )
  );

/** What `reader` reads of `side` through every surface, each memory by the event that made it. */
export const surfaces = async (
  side: Side,
  events: number,
  reader: PersonReader,
  every: boolean
) => {
  const ids = Array.from(
    { length: events },
    (_, at) => side.memories.get(at)?.id
  );
  const known = ids.filter((id) => id !== undefined);
  const history = await readAll(side, reader, { history: true });
  const memories = history.flatMap((read) => read.memories);
  const times = await timesOf(side);
  const states = ids.map((id): Seen => {
    const read = memories.find((memory) => memory.id === id);
    if (id === undefined || read === undefined) {
      return "unread";
    }
    return read.endedAt === null
      ? "current"
      : nameOf(side, times, read.endedAt.getTime(), read.learnedAt.getTime());
  });
  const readable = await shared().readableMemories({
    memories: known,
    reader,
  });
  const found = await Promise.all(
    ids.map(async (id, at) => {
      if (id === undefined) {
        return 0;
      }
      const page = await shared().findEntities({
        reader,
        name: nameAt(side, at),
      });
      return page.entities.length;
    })
  );
  const base = {
    states,
    readable: ids.map((id) => id !== undefined && readable.includes(id)),
    found,
  };
  if (!every) {
    return base;
  }
  const now = await readAll(side, reader, {});
  const current = now.flatMap((read) => read.memories);
  const paged = await readAll(side, reader, { history: true, limit: 1 });
  const pack = await shared().recall({
    question: `${side.name} Group pays`,
    reader,
    budget: { tokens: 20_000 },
  });
  const cards = await Promise.all(
    [...side.entities]
      .toSorted(([one], [other]) => one - other)
      .map(async ([, entity]) => await shared().readCard({ entity, reader }))
  );
  const cardText = JSON.stringify(cards);
  return {
    ...base,
    current: ids.map((id) => current.some((memory) => memory.id === id)),
    recalled: ids.map((id) =>
      pack.memories.some(({ memory }) => memory === id)
    ),
    cards: cards.filter((card) => card !== null).length,
    carded: ids.map((id) => id !== undefined && cardText.includes(id)),
    nextPages: paged.filter(({ next }) => next !== undefined).length,
  };
};

type Surfaces = Awaited<ReturnType<typeof surfaces>>;

/** What a reader who may not read the current version reads of a source: nothing. */
const nothingOf = (events: number, every: boolean): Surfaces => {
  const base = {
    states: Array.from({ length: events }, (): Seen => "unread"),
    readable: Array.from({ length: events }, () => false),
    found: Array.from({ length: events }, () => 0),
  };
  return every
    ? {
        ...base,
        current: Array.from({ length: events }, () => false),
        recalled: Array.from({ length: events }, () => false),
        cards: 0,
        carded: Array.from({ length: events }, () => false),
        nextPages: 0,
      }
    : base;
};

/** Whether `text` holds `quote` as a run of words, as search folds them. */
const holdsRun = (text: string, quote: string): boolean => {
  const run = sequenceOf(quote).join(" ");
  return run !== "" && ` ${sequenceOf(text).join(" ")} `.includes(` ${run} `);
};

/**
 * The oracle: each memory's state for a reader in `places`, from scratch,
 * by main's rule of who may see a memory and the rule of out, `endedAt`
 * named as `nameOf` names it.
 */
export const oracle = (
  side: Side,
  events: number,
  places: readonly number[],
  learned: ReadonlyMap<number, "before" | "after">
): Seen[] => {
  const current =
    side.current === undefined ? undefined : side.versions.get(side.current);
  return Array.from({ length: events }, (_, at): Seen => {
    const memory = side.memories.get(at);
    const on = memory === undefined ? undefined : side.versions.get(memory.on);
    if (
      memory === undefined ||
      on === undefined ||
      current === undefined ||
      on.held ||
      !places.includes(memory.group) ||
      !places.includes(on.group) ||
      !places.includes(current.group)
    ) {
      return "unread";
    }
    const out =
      on.number < current.number && !holdsRun(current.text, memory.quote);
    if (!out) {
      return "current";
    }
    // The later of its learning and the current version's add.
    return learned.get(at) === "after" ? "learned" : `version ${side.current}`;
  });
};

/** Whether each memory of `side` was learned after its current version's add, by event order. */
export const learnedOrder = (side: Side): Map<number, "before" | "after"> =>
  new Map(
    [...side.memories.keys()].map((at) => [
      at,
      side.current !== undefined && at > side.current ? "after" : "before",
    ])
  );

/** The series' generator (Park–Miller's MINSTD), from a seed. */
export const generator = (seed: number) => {
  let state = seed;
  return (): number => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
};

/** Every non-empty subset of `count` groups, by their places. */
const subsetsOf = (count: number): number[][] => {
  const all: number[][] = [[]];
  for (let place = 0; place < count; place += 1) {
    for (const subset of all.map((before) => [...before, place])) {
      all.push(subset);
    }
  }
  return all.filter((subset) => subset.length > 0);
};

/** `seen`, read before an event, as it reads with one more event: its lists longer, the new places empty. */
const stretched = (seen: Surfaces, count: number): Surfaces => {
  const longer = <T>(list: readonly T[], empty: T): T[] => [
    ...list,
    ...Array.from({ length: count - list.length }, () => empty),
  ];
  const base = {
    ...seen,
    states: longer(seen.states, "unread"),
    readable: longer(seen.readable, false),
    found: longer(seen.found, 0),
  };
  if (!("current" in seen)) {
    return base;
  }
  return {
    ...base,
    current: longer(seen.current, false),
    recalled: longer(seen.recalled, false),
    carded: longer(seen.carded, false),
  };
};

/**
 * A reader of a run: the groups they are in, by place, and their twin:
 * none for a reader of every group, whose twin is the store as it is.
 */
export interface Reading {
  places: number[];
  reader: PersonReader;
  twin: Side | undefined;
}

/**
 * How `reading` reads `real` after `count` events against their twin, the
 * oracle, and, after a tick, `before` (what they read before it): each
 * difference found.
 */
const differencesOf = async (
  real: Side,
  { places, reader, twin }: Reading,
  {
    count,
    every,
    before,
    label,
    withOracle = true,
  }: {
    count: number;
    every: boolean;
    before: Surfaces | undefined;
    label: string;
    withOracle?: boolean;
  }
): Promise<string[]> => {
  const got = await surfaces(real, count, reader, every);
  const currentGroup =
    real.current === undefined
      ? undefined
      : real.versions.get(real.current)?.group;
  let want = got;
  if (currentGroup === undefined || !places.includes(currentGroup)) {
    want = nothingOf(count, every);
  } else if (twin !== undefined) {
    want = await surfaces(twin, count, reader, every);
  }
  const expected = oracle(real, count, places, learnedOrder(real));
  const who = `${label} {${places.join(",")}}`;
  return [
    ...(JSON.stringify(got) === JSON.stringify(want)
      ? []
      : [
          `${who} twin: ${JSON.stringify(got)} against ${JSON.stringify(want)}`,
        ]),
    ...(!withOracle || JSON.stringify(got.states) === JSON.stringify(expected)
      ? []
      : [
          `${who} oracle: ${JSON.stringify(got.states)} against ${JSON.stringify(expected)}`,
        ]),
    ...(before === undefined ||
    JSON.stringify(got) === JSON.stringify(stretched(before, count))
      ? []
      : [
          `${who} tick: ${JSON.stringify(got)} against ${JSON.stringify(before)}`,
        ]),
  ];
};

/** Applies event `at` to `real` and to each twin, then ticks the queue if it is a tick. */
const applyAll = async (
  real: Side,
  readings: readonly Reading[],
  at: number,
  event: Event,
  groups: readonly string[]
): Promise<void> => {
  await apply(real, at, event, "all", groups);
  for (const { twin, places } of readings) {
    if (twin !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one twin at a time
      await apply(twin, at, event, places, groups);
    }
  }
  if (event.kind === "tick") {
    await tick();
  }
};

/**
 * Runs `events` against the store as it is and a twin for each subset of
 * `groups`' readers, comparing every reader's surfaces with their twin's,
 * with the oracle, and after a tick (while no erasure is held, whose tick
 * finishes it) with what they read before it: after every event, or the
 * last alone (`checkAt`). Answers each difference found.
 */
export const run = async (
  groups: readonly string[],
  events: readonly Event[],
  {
    every,
    checkAt,
    readers = subsetsOf(groups.length),
  }: {
    every: boolean;
    checkAt: "each" | "last";
    readers?: number[][];
  }
): Promise<string[]> => {
  const readings: Reading[] = readers.map((places) => ({
    places,
    reader: {
      person: unique("p"),
      groups: places.map((place) => groups[place] ?? ""),
    },
    twin: places.length === groups.length ? undefined : sideOf(),
  }));
  const real = sideOf();
  const differ: string[] = [];
  let heldAny = false;
  for (const [at, event] of events.entries()) {
    const checked = checkAt === "each" || at === events.length - 1;
    const ticked = event.kind === "tick" && !heldAny && checked;
    // oxlint-disable-next-line no-await-in-loop -- one event at a time
    const before = await Promise.all(
      readings.map(async ({ reader }) =>
        ticked ? await surfaces(real, at, reader, every) : undefined
      )
    );
    // oxlint-disable-next-line no-await-in-loop -- one event at a time
    await applyAll(real, readings, at, event, groups);
    heldAny ||= event.kind === "hold";
    if (checked) {
      for (const [index, reading] of readings.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- one reader at a time
        const found = await differencesOf(real, reading, {
          count: at + 1,
          every,
          before: before[index],
          label: `${JSON.stringify(events)} @${at}`,
        });
        differ.push(...found);
      }
    }
  }
  return differ;
};

/** A generated sequence of three to six events after a first version, by `random`. */
export const series = (random: () => number): Event[] => {
  const events: Event[] = [
    { kind: "version", group: Math.floor(random() * 3), line: true },
  ];
  const length = 3 + Math.floor(random() * 4);
  for (let index = 0; index < length; index += 1) {
    const versions = events.flatMap((event, at) =>
      event.kind === "version" ? [at] : []
    );
    const roll = random();
    if (roll < 0.3) {
      // A late add citing any version before now, for its group.
      events.push({
        kind: "late",
        on: versions[Math.floor(random() * versions.length)] ?? 0,
      });
    } else if (roll < 0.4 && versions.length >= 3) {
      // A version before the current one, never the first (its erasure
      // takes the first memory).
      events.push({
        kind: "hold",
        on: versions[1 + Math.floor(random() * (versions.length - 2))] ?? 0,
      });
    } else if (roll < 0.5) {
      events.push({ kind: "tick" });
    } else {
      events.push({
        kind: "version",
        group: Math.floor(random() * 3),
        line: random() < 0.5,
      });
    }
  }
  return events;
};

/**
 * Runs `events` against the store as it is and a twin for each subset of
 * `groups`' readers, then `disrupt` (a change to the whole store, as a
 * restore or a release rolled back makes; it answers how many events the
 * sides now hold), then compares every reader with their twin (`before`:
 * until a source is judged, what a reader reads of it depends on nothing
 * they can't read either), then `settle` (the catch-up), then compares
 * every reader with their twin and the oracle (`after`).
 */
export const runAround = async (
  groups: readonly string[],
  events: readonly Event[],
  {
    disrupt,
    settle,
    compareBefore = true,
  }: {
    disrupt: (
      real: Side,
      readings: readonly Reading[],
      at: number
    ) => Promise<number>;
    settle: () => Promise<void>;
    compareBefore?: boolean;
  }
): Promise<{ before: string[]; after: string[] }> => {
  const readings: Reading[] = subsetsOf(groups.length).map((places) => ({
    places,
    reader: {
      person: unique("p"),
      groups: places.map((place) => groups[place] ?? ""),
    },
    twin: places.length === groups.length ? undefined : sideOf(),
  }));
  const real = sideOf();
  for (const [at, event] of events.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- one event at a time
    await applyAll(real, readings, at, event, groups);
  }
  const count = await disrupt(real, readings, events.length);
  const label = JSON.stringify(events);
  const compare = async (withOracle: boolean, when: string) => {
    const found: string[] = [];
    for (const reading of readings) {
      // oxlint-disable-next-line no-await-in-loop -- one reader at a time
      const differ = await differencesOf(real, reading, {
        count,
        every: true,
        before: undefined,
        label: `${label} ${when}`,
        withOracle,
      });
      found.push(...differ);
    }
    return found;
  };
  const before = compareBefore ? await compare(false, "before") : [];
  await settle();
  return { before, after: await compare(true, "after") };
};
