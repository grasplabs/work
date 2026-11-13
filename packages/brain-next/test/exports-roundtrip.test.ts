// A round trip of the company's export (exports.ts, restore.ts, GRA-1840),
// generative: small stores of memories, made by a seeded random series of
// adds, confirmations, retirements, new versions and erasures, exported,
// restored into an empty store, and every public read compared for three
// readers. The seeds are fixed, chosen so that together they make every
// feature below at least once, which the test checks: a generator changed
// so that a seed no longer makes one fails here, not silently.
import type {
  Access,
  NewEntity,
  NewMemory,
  Reader,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  differences,
  everyRead,
  exportSettled,
  restoredAfterLoss,
  tick,
} from "./export-reads.ts";
import type { Store } from "./export-reads.ts";
import { copyOf, restore } from "./store-copy.ts";
import type { Copy } from "./store-copy.ts";

const shared = (): Store => env.BRAIN_STORE.getByName("brain");

/**
 * The seeds the test runs: together they make every feature. Seeds 1 to
 * 40 were each run once when these were chosen, and all passed.
 */
const seeds = [9, 25];

/** What a store a seed makes may hold, each checked to be made by some seed. */
const features = [
  "a one-value attribute",
  "a many-value attribute",
  "a relation",
  "a memory with no attribute",
  "a memory drawn from a source",
  "three writers",
  "a lineage's newer memory ending an older one",
  "a contested fact",
  "a confirmation",
  "a retirement",
  "an extraction mark",
  "an entity linked by its id",
  "an entity linked by its email",
  "more names for one entity from one memory than one entity of an add takes",
  "a source narrowed after its memories",
  "an erased source",
] as const;
type Feature = (typeof features)[number];

/** The Park–Miller generator's modulus and multiplier (MINSTD). */
const modulus = 2_147_483_647;
const multiplier = 48_271;

/** A seeded series of numbers in [0, 1): MINSTD, plain arithmetic. */
const seriesOf = (seed: number): (() => number) => {
  let state = (seed % (modulus - 1)) + 1;
  return (): number => {
    state = (state * multiplier) % modulus;
    return (state - 1) / (modulus - 1);
  };
};

const names = ["Acme", "Acme BV", "Beta", "Gamma"];

/** What a seed's series of operations works with, and what it made so far. */
interface Series {
  seed: number;
  random: () => number;
  pick: <T>(items: readonly T[]) => T;
  tag: string;
  people: string[];
  readers: Reader[];
  accesses: Access[];
  emails: string[];
  sources: { source: string; versions: number }[];
  known: string[];
  memories: { id: string; writer: string | null }[];
  made: Set<Feature>;
}

/** The series of seed `seed`, before any operation. */
const seriesFor = (seed: number): Series => {
  const random = seriesOf(seed);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(random() * items.length)];
    if (item === undefined) {
      throw new Error("Picked from nothing");
    }
    return item;
  };
  const tag = `${seed}-${crypto.randomUUID().slice(0, 8)}`;
  const groups = [`team:one-${tag}`, `team:two-${tag}`];
  const [one = "", two = ""] = groups;
  const people = ["p1", "p2", "p3"].map((person) => `${person}-${tag}`);
  return {
    seed,
    random,
    pick,
    tag,
    people,
    readers: people.map((person, index) => ({
      person,
      groups: [[one], [one, two], [two]][index] ?? [],
    })),
    accesses: groups.map((group) => ({ kind: "audience", group })),
    emails: [`a@${tag}.test`, `b@${tag}.test`],
    sources: Array.from({ length: 3 }, (_, index) => ({
      source: `test:${tag}-${index}`,
      versions: 1,
    })),
    known: [],
    memories: [],
    made: new Set(),
  };
};

/** An entity of an add: a name, perhaps an email, perhaps a known id. */
const entityOf = (
  { random, pick, emails, known }: Series,
  key: string,
  kind: "customer" | "person"
): NewEntity => ({
  key,
  kind,
  names: [pick(names)],
  identifiers: random() < 0.6 ? [{ type: "email", value: pick(emails) }] : [],
  ...(known.length > 0 && random() < 0.3 ? { id: pick(known) } : {}),
});

/** A memory of shape `shape` resting on `basis` by `speaker`. */
const memoryOf = (
  series: Series,
  shape: number,
  basis: NewMemory["basis"],
  speaker: NewMemory["speaker"]
): { entities: NewEntity[]; memory: NewMemory } => {
  const { pick, tag } = series;
  const about = entityOf(series, "c", "customer");
  if (shape < 0.35) {
    const value = pick(["active", "churned", "trial"]);
    return {
      entities: [about],
      memory: {
        about: "c",
        attribute: "status",
        value,
        type: "fact",
        statement: `status ${value} ${tag}`,
        speaker,
        basis,
      },
    };
  }
  if (shape < 0.55) {
    const value = pick(["sso", "audit"]);
    return {
      entities: [about],
      memory: {
        about: "c",
        attribute: "requirement",
        value,
        type: "fact",
        statement: `requires ${value} ${tag}`,
        speaker,
        basis,
      },
    };
  }
  if (shape < 0.75) {
    return {
      entities: [about, entityOf(series, "p", "person")],
      memory: {
        about: "c",
        attribute: "contact",
        object: "p",
        type: "fact",
        statement: `contact ${tag}`,
        speaker,
        basis,
      },
    };
  }
  if (shape < 0.85) {
    // Two people of the add sharing an email: one entity, which the
    // memory names twice, with all their names.
    const email = { type: "email" as const, value: `boss@${tag}.test` };
    const many = (key: string): NewEntity => ({
      key,
      kind: "person",
      names: Array.from({ length: 20 }, (_, index) => `${key} ${index}`),
      identifiers: [email],
    });
    return {
      entities: [many("m"), many("n")],
      memory: {
        about: "m",
        attribute: "manager",
        object: "n",
        type: "fact",
        statement: `manages ${tag}`,
        speaker,
        basis,
      },
    };
  }
  return {
    entities: [about],
    memory: {
      about: "c",
      type: "decision",
      statement: `decided ${pick(names)} ${tag}`,
      speaker,
      basis,
    },
  };
};

/** Operation `operation` of the series: an add of a memory. */
const addOne = async (series: Series, operation: number): Promise<void> => {
  const { random, pick, people, sources, tag, accesses, readers } = series;
  const writer = random() < 0.5 ? pick(people) : null;
  const drawnFrom = pick(sources);
  const basis: NewMemory["basis"] =
    writer === null
      ? {
          kind: "source",
          source: drawnFrom.source,
          version: 1 + Math.floor(random() * drawnFrom.versions),
          quote: "words",
        }
      : { kind: "writer", writer };
  const { entities, memory } = memoryOf(
    series,
    random(),
    basis,
    writer === null ? { kind: "system" } : { kind: "internal", person: writer }
  );
  const extracted =
    basis.kind === "source" && random() < 0.3
      ? { source: basis.source, version: basis.version }
      : undefined;
  const added = await shared().addMemories({
    change: `m${operation}-${tag}`,
    access: pick(accesses),
    entities,
    memories: [memory],
    ...(extracted === undefined ? {} : { extracted }),
    reader: pick(readers),
  });
  for (const id of Object.values(added.entities)) {
    if (!series.known.includes(id)) {
      series.known.push(id);
    }
  }
  if (entities.some(({ id }) => id !== undefined)) {
    series.made.add("an entity linked by its id");
  }
  series.memories.push(...added.memories.map((id) => ({ id, writer })));
};

/** A writer retiring one of their own memories, if any. */
const retireOne = async ({
  pick,
  memories,
  readers,
}: Series): Promise<void> => {
  const theirs = memories.filter(({ writer }) => writer !== null);
  if (theirs.length === 0) {
    return;
  }
  const { id, writer } = pick(theirs);
  const reader = readers.find(({ person }) => person === writer);
  if (reader !== undefined) {
    await shared().retireMemory({ memory: id, reader });
  }
};

/** A new version of a source, sometimes no one known reads. */
const newVersion = async ({ random, pick, sources, accesses }: Series) => {
  const narrowed = pick(sources);
  narrowed.versions += 1;
  await shared().addSource({
    source: narrowed.source,
    change: `${narrowed.versions}`,
    text: `words of ${narrowed.source}, ${narrowed.versions}`,
    access: random() < 0.4 ? { kind: "none" } : pick(accesses),
  });
};

/**
 * Operation `operation` of the series: an add, a confirmation, a
 * retirement, a new version or an erasure. What the store refuses (an id
 * the reader may not name, a version erased) is part of the series;
 * anything else fails, naming the seed.
 */
const operate = async (series: Series, operation: number): Promise<void> => {
  const { random, pick, memories, readers, sources } = series;
  const chance = random();
  try {
    if (chance < 0.6) {
      await addOne(series, operation);
    } else if (chance < 0.75 && memories.length > 0) {
      await shared().confirmMemory({
        memory: pick(memories).id,
        reader: pick(readers),
      });
    } else if (chance < 0.88) {
      await retireOne(series);
    } else if (chance < 0.95) {
      await newVersion(series);
    } else {
      await shared().eraseSource({
        source: pick(sources).source,
        reason: "deleted",
      });
      // Counted here: the store's record of erasures also holds those its
      // ledger in the bucket replays, other seeds' among them.
      series.made.add("an erased source");
    }
  } catch (error) {
    if (!String(error).includes("efused")) {
      throw new Error(
        `Seed ${series.seed}, operation ${operation}: ${String(error)}`,
        { cause: error }
      );
    }
  }
};

/** How many of each feature the store holds now. */
const featuresHeld = async (): Promise<Record<string, number>> =>
  await runInDurableObject(shared(), (_instance, state) => {
    const count = (query: string): number =>
      state.storage.sql.exec<{ count: number }>(query).one().count;
    return {
      "a one-value attribute": count(
        "SELECT count(*) AS count FROM memories WHERE attribute = 'status'"
      ),
      "a many-value attribute": count(
        "SELECT count(*) AS count FROM memories WHERE attribute = 'requirement'"
      ),
      "a relation": count(
        "SELECT count(*) AS count FROM memories WHERE object IS NOT NULL"
      ),
      "a memory with no attribute": count(
        "SELECT count(*) AS count FROM memories WHERE attribute IS NULL"
      ),
      "a memory drawn from a source": count(
        "SELECT count(*) AS count FROM memories WHERE source IS NOT NULL"
      ),
      "three writers": Math.max(
        0,
        count(
          "SELECT count(DISTINCT writer) AS count FROM memories WHERE writer IS NOT NULL"
        ) - 2
      ),
      "a lineage's newer memory ending an older one": count(
        `SELECT count(*) AS count FROM memories AS older JOIN memories AS newer
      ON newer.entity = older.entity AND newer.attribute = older.attribute
        AND newer.lineage = older.lineage AND newer.row > older.row
        AND older.one_value = 1`
      ),
      "a contested fact": count(
        `SELECT count(*) AS count FROM memories AS first JOIN memories AS other
      ON other.entity = first.entity AND other.attribute = first.attribute
        AND other.lineage != first.lineage
        AND other.value_key != first.value_key AND first.one_value = 1`
      ),
      "a confirmation": count(
        "SELECT count(*) AS count FROM memory_confirmations"
      ),
      "a retirement": count(
        "SELECT count(*) AS count FROM memories WHERE retired_at IS NOT NULL"
      ),
      "an extraction mark": count(
        "SELECT count(*) AS count FROM memory_extractions"
      ),
      "an entity linked by its email": count(
        `SELECT count(*) AS count FROM (
        SELECT 1 FROM entity_names WHERE type = 'email'
        GROUP BY entity HAVING count(DISTINCT memory) > 1
      )`
      ),
      "more names for one entity from one memory than one entity of an add takes":
        count(
          `SELECT count(*) AS count FROM (
        SELECT 1 FROM entity_names WHERE type = 'name'
        GROUP BY entity, memory HAVING count(*) > 20
      )`
        ),
      "a source narrowed after its memories": count(
        `SELECT count(*) AS count FROM memories
      JOIN current_versions ON current_versions.source = memories.source
      JOIN source_versions ON source_versions.row = current_versions.version_row
      WHERE source_versions.version > memories.version`
      ),
    };
  });

/** A store as seed `seed` makes it, and what it holds of `features`. */
const madeBy = async (seed: number) => {
  const series = seriesFor(seed);
  const { random, pick, sources, made, readers, known, emails, tag } = series;
  for (const { source } of sources) {
    // oxlint-disable-next-line no-await-in-loop -- one source at a time
    await shared().addSource({
      source,
      change: "1",
      text: `words of ${source}`,
      access: pick(series.accesses),
    });
  }
  const operations = 12 + Math.floor(random() * 10);
  for (let operation = 0; operation < operations; operation += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one operation at a time
    await operate(series, operation);
  }
  for (let ticks = 0; ticks < 3; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await tick(shared());
  }
  const held = await featuresHeld();
  for (const feature of features) {
    if ((held[feature] ?? 0) > 0) {
      made.add(feature);
    }
  }
  return {
    made,
    asked: {
      readers,
      entities: known,
      names,
      emails,
      questions: [`status ${tag}`, "words of", "requires sso"],
      asOf: new Date(Date.now() + 60_000),
    },
  };
};

describe("a company's export, round trip", () => {
  /** The shared store before any test added to it: empty. */
  let empty: Copy = { tables: [], others: [] };

  beforeAll(async () => {
    empty = await copyOf(shared());
  });

  it(
    "answers every reader alike after an export restored into an empty store, for stores made by a fixed set of seeds",
    { timeout: 60_000 },
    async () => {
      const outcomes: string[] = [];
      const made = new Set<Feature>();
      for (const seed of seeds) {
        // oxlint-disable-next-line no-await-in-loop -- one store at a time
        await restore(shared(), empty);
        // oxlint-disable-next-line no-await-in-loop -- one store at a time
        const store = await madeBy(seed);
        for (const feature of store.made) {
          made.add(feature);
        }
        // oxlint-disable-next-line no-await-in-loop -- one store at a time
        const before = await everyRead(shared(), store.asked);
        // oxlint-disable-next-line no-await-in-loop -- one store at a time
        const { id } = await shared().startExport("test");
        // oxlint-disable-next-line no-await-in-loop -- one store at a time
        const exported = await exportSettled(shared, id);
        const restored =
          exported === "done"
            ? // oxlint-disable-next-line no-await-in-loop -- one store at a time
              await restoredAfterLoss(shared, id, empty)
            : undefined;
        // oxlint-disable-next-line no-await-in-loop -- one store at a time
        const after = await everyRead(shared(), store.asked);
        const differ = differences(before, after);
        if (exported !== "done" || restored !== "done" || differ.length > 0) {
          outcomes.push(
            `seed ${seed}: export ${exported}, restore ${restored}, reads that differ: ${differ.join("; ")}`
          );
        }
      }

      expect({
        outcomes,
        unmade: features.filter((feature) => !made.has(feature)),
      }).toStrictEqual({ outcomes: [], unmade: [] });
    }
  );
});
