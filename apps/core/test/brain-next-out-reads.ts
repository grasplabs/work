/**
 * "Out of use" in the leak harness (brain-next-leaks.test.ts, GRA-1915).
 * A memory is out once its source's current version no longer says its
 * quote, and back when a later one says it again. An out memory may stay
 * as history; it must reach no reader as current through any surface.
 *
 * So the harness plants markers only in what memories state, never in a
 * source's text: a marker that shows anywhere but under an ended memory
 * is a memory reaching someone as current. Each world here is a customer
 * (`Depot <word>`), a source whose versions hold or drop two quotes, and
 * memories resting on them, each stating a marker of its own; the reads
 * are every surface a person reaches the Brain's memories and sources
 * through, filtered to the world, as text a twin world's can be compared
 * with once each world's own names are replaced by roles.
 */
import { recallBudgetMax } from "@grasp-os/brain-next/contract";
import type { Reader } from "@grasp-os/brain-next/contract";
import { appIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import {
  codeCardAs,
  codeEntitiesAs,
  contestedAs,
  listVersionsAs,
  memoriesAs,
  readableMemoriesAs,
  readSourceVersionAs,
  recallAs,
  recallOwnedAs,
  recallPassagesAs,
  workBrain,
} from "../src/brain-next.ts";
import type {
  ContestedCursor,
  SourceRef,
  StorePlace,
} from "../src/brain-next.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import {
  memoriesAs as memoriesRpcAs,
  sourcesAs as sourcesRpcAs,
  textOf,
} from "./brain-next-surfaces.ts";
import { noProducers } from "./no-producers.ts";

/** A word nothing else holds. */
export const outWord = (prefix: string): string =>
  `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

/** The two quotes a world's versions hold or drop. */
export type QuoteName = "out" | "keep";

/** The words of quote `name` of the customer named by `depot`. */
const quoteOf = (depot: string, name: QuoteName): string =>
  name === "out"
    ? `the ${depot} contract renews every April`
    : `the ${depot} office opens on weekdays`;

/** A version's text that says the quotes `held`, and nothing marked. */
export const textHolding = (depot: string, ...held: QuoteName[]): string =>
  [`Depot ${depot} notes`, ...held.map((name) => quoteOf(depot, name))]
    .join(". ")
    .concat(".");

/** The store a world's memories are in, as core names it. */
export type Place = "shared" | "own";

/** A world: a customer, the source its memories rest on, and those memories. */
export interface OutWorld {
  /** `shared`, or `own`: the reader's own store. */
  place: Place;
  /** The store's name (`brain`, or `person:<id>`). */
  storeName: string;
  source: SourceRef;
  /** The source as the store keys it. */
  key: string;
  /** The plain word naming the customer. */
  depot: string;
  /** The customer's entity, once a memory made it. */
  entity: string;
  /** Every memory's marker by name, those of a twin never planted included. */
  markers: Record<string, string>;
  /** The memories planted, by name. */
  memories: Record<string, string>;
  /** The groups its memories were planted for, which see its customer. */
  groups: string[];
}

/** A store of the Brain by name, as core reaches it. */
const storeNamed = (name: string) =>
  inJurisdiction(env, env.BRAIN_STORE).getByName(name);

/**
 * A new world on `source` (core added none of it yet): its markers by
 * name, every one `names` lists, planted or not.
 */
export const newWorld = (
  place: Place,
  source: SourceRef,
  names: readonly string[],
  person?: string
): OutWorld => ({
  place,
  storeName: place === "shared" ? "brain" : `person:${person ?? ""}`,
  source,
  key: `${source.producer}:${source.id}`,
  depot: outWord("d"),
  entity: "",
  markers: Object.fromEntries(names.map((name) => [name, outWord("m")])),
  memories: {},
  groups: [],
});

/**
 * Memories resting on `version` of `world`'s source, each by name with the
 * quote it cites, for `group` (`team:<id>`, `company`) or, in a person's
 * own store, its person alone. Each states its marker and nothing else
 * worth a question but the customer.
 */
export const remember = async (
  world: OutWorld,
  group: string,
  version: number,
  cited: Readonly<Record<string, QuoteName>>
): Promise<void> => {
  const person = world.storeName.replace(/^person:/u, "");
  const added = await storeNamed(world.storeName).addMemories({
    change: crypto.randomUUID(),
    access:
      world.place === "shared"
        ? { kind: "audience", group }
        : { kind: "owner", person },
    // A customer's id is taken only as someone who sees it.
    ...(world.entity === "" || world.place === "own"
      ? {}
      : {
          reader: {
            person: `writer-${crypto.randomUUID()}`,
            groups: [...new Set([...world.groups, group])],
          },
        }),
    entities: [
      world.entity === ""
        ? { key: "c", kind: "customer", names: [`Depot ${world.depot}`] }
        : { key: "c", id: world.entity, kind: "customer", names: [] },
    ],
    memories: Object.entries(cited).map(([name, quote]) => ({
      about: "c",
      type: "fact" as const,
      statement: `Depot ${world.depot} ${world.markers[name] ?? ""}`,
      speaker: { kind: "system" as const },
      basis: {
        kind: "source" as const,
        source: world.key,
        version,
        quote: quoteOf(world.depot, quote),
      },
    })),
  });
  world.entity ||= added.entities.c ?? "";
  world.groups.push(group);
  for (const [index, name] of Object.keys(cited).entries()) {
    world.memories[name] = added.memories[index] ?? "";
  }
};

/** Runs `run` on `world`'s store's SQL, as a release or a test of it would. */
export const inStoreOf = async <T>(
  storeName: string,
  run: (sql: SqlStorage) => T
): Promise<T> =>
  await runInDurableObject(storeNamed(storeName), (_store, state) =>
    run(state.storage.sql)
  );

/** Whether every source of `worlds` is judged against its current version. */
export const judged = async (
  ...worlds: readonly OutWorld[]
): Promise<boolean[]> =>
  await inStoreOf("brain", (sql) =>
    worlds.map(
      ({ key }) =>
        sql
          .exec<{ unjudged: number }>(
            "SELECT count(*) AS unjudged FROM current_versions WHERE source = ? AND judged_row IS NOT version_row",
            key
          )
          .one().unjudged === 0
    )
  );

/** A tick of the shared store's work, as core's clock runs it. */
export const tick = async (): Promise<void> => {
  await workBrain(env, new Date(), noProducers);
};

/** Ticks until every source of `worlds` is judged: at most 30 ticks. */
export const caughtUp = async (...worlds: readonly OutWorld[]) => {
  for (let ticks = 0; ticks < 30; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    const all = await judged(...worlds);
    if (all.every(Boolean)) {
      return ticks;
    }
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await tick();
  }
  throw new Error("The catch-up didn't judge the worlds in 30 ticks");
};

/** Whether `value` names `world` (its source, entity or customer). */
const ofWorld = (world: OutWorld, value: unknown): boolean => {
  const text = textOf(value);
  return [world.source.id, world.entity, world.depot].some(
    (name) => name !== "" && text.includes(name)
  );
};

/** What a pack holds of `world`, and what it says wasn't found. */
const packOf = (
  world: OutWorld,
  pack: { items: unknown[]; memories?: unknown[]; notFound: unknown }
) => ({
  items: pack.items.filter((item) => ofWorld(world, item)),
  memories: (pack.memories ?? []).filter((memory) => ofWorld(world, memory)),
  notFound: pack.notFound,
});

/** What a read answered: its value, or its error's message. */
const settled = async (read: () => Promise<unknown>): Promise<unknown> => {
  try {
    return await read();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

/** Every contested fact `personId` may read about `world`'s customer, every page. */
const contestedOf = async (personId: string, world: OutWorld) => {
  const facts: unknown[] = [];
  let from: StorePlace<ContestedCursor> | undefined;
  for (let pages = 0; pages < 50; pages += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page after the last
    const page = await contestedAs(
      env,
      personId,
      from === undefined ? {} : { from }
    );
    facts.push(...page.items.filter((fact) => ofWorld(world, fact)));
    if (page.next === null) {
      return facts;
    }
    from = page.next;
  }
  throw new Error("Contested facts past 50 pages");
};

/**
 * Marks `world`'s memories used by `personId` now, as their chat does once
 * a recall handed them over (workspace.ts `memory_uses`), so their own
 * recall ranks by that use.
 */
const usedBy = async (personId: string, world: OutWorld): Promise<void> => {
  const uses = Object.values(world.memories).map((memory) => [
    world.place,
    memory,
  ]);
  await runInDurableObject(
    workspace(env, personalWorkspaceId(personId)),
    (_workspace, state) => {
      state.storage.sql.exec(
        `INSERT INTO memory_uses (store, memory, used_at)
        SELECT value ->> 0, value ->> 1, ?2 FROM json_each(?1) WHERE true
        ON CONFLICT (store, memory) DO UPDATE SET used_at = excluded.used_at`,
        JSON.stringify(uses),
        Date.now()
      );
    }
  );
};

/** What each surface answered, by its name. */
export type Reads = Record<string, unknown>;

/**
 * Every surface `personId` (read by the Brain as `reader`) reaches
 * `world` through, each filtered to the world where it lists more: recall
 * before a question (in their own chat, as their teams, with which store
 * found it, ranked by their use), code's recall, the Brain page's search,
 * memories and versions, readable memories, code's entities and card (an
 * App's read among them), the store's card, contested facts, and each
 * version of the source.
 */
export const outReadsOf = async (
  personId: string,
  reader: Reader,
  world: OutWorld,
  versions: number
): Promise<Reads> => {
  const question = `Depot ${world.depot} ${Object.values(world.markers).join(" ")}`;
  const budget = { tokens: recallBudgetMax };
  const entity = { store: world.place, id: world.entity };
  const ref = world.source;
  const reads: Reads = {
    "recall in their own chat": packOf(
      world,
      await recallAs(env, personId, { personal: true, question, budget })
    ),
    "recall as their teams": packOf(
      world,
      await recallAs(env, personId, { personal: false, question, budget })
    ),
    "recall with the stores it found in": await (async () => {
      const { pack, fromOwn } = await recallOwnedAs(env, personId, {
        personal: true,
        question,
        budget,
      });
      return { pack: packOf(world, pack), fromOwn };
    })(),
    "recall of passages, as code's": packOf(
      world,
      await recallPassagesAs(env, personId, {
        personal: false,
        question,
        budget,
      })
    ),
    "the Brain page's search": packOf(
      world,
      await sourcesRpcAs(personId).search(question)
    ),
    memories: await settled(
      async () => await memoriesAs(env, personId, { entity })
    ),
    "the Brain page's memories": await settled(
      async () => await memoriesRpcAs(personId).memories(entity)
    ),
    readable: await readableMemoriesAs(
      env,
      personId,
      Object.values(world.memories).map((memory) => ({
        store: world.place,
        memory,
      }))
    ),
    "code's entities": await settled(
      async () =>
        await codeEntitiesAs(env, personId, "teams", {
          name: `Depot ${world.depot}`,
        })
    ),
    "code's card": await settled(
      async () =>
        await codeCardAs(env, personId, "teams", { entity: world.entity })
    ),
    "an App's card": await settled(
      async () =>
        await codeCardAs(
          env,
          personId,
          "company",
          { entity: world.entity },
          appIdSchema.parse(crypto.randomUUID())
        )
    ),
    "the store's card": await settled(
      async () =>
        await storeNamed(world.storeName).readCard({
          entity: world.entity,
          reader,
        })
    ),
    contested: await contestedOf(personId, world),
    versions: await settled(
      async () => await listVersionsAs(env, personId, { source: ref })
    ),
    "the Brain page's versions": await settled(
      async () => await sourcesRpcAs(personId).versions(ref)
    ),
  };
  for (let version = 1; version <= versions; version += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one version at a time
    reads[`version ${version}`] = await settled(
      async () =>
        await readSourceVersionAs(env, personId, { source: ref, version })
    );
    // oxlint-disable-next-line no-await-in-loop -- one version at a time
    reads[`the Brain page's version ${version}`] = await settled(
      async () => await sourcesRpcAs(personId).read(ref, version)
    );
  }
  await usedBy(personId, world);
  reads["recall ranked by their use"] = packOf(
    world,
    await recallAs(env, personId, {
      personal: true,
      question: `Depot ${world.depot}`,
      budget,
    })
  );
  return reads;
};

/** Whether `value` holds `marker` other than under an ended memory. */
const holdsCurrent = (
  value: unknown,
  marker: string,
  ended: boolean
): boolean => {
  if (typeof value === "string") {
    return !ended && value.toLowerCase().includes(marker);
  }
  if (Array.isArray(value)) {
    return value.some((each) => holdsCurrent(each, marker, ended));
  }
  if (typeof value === "object" && value !== null) {
    const endedHere =
      ended ||
      ("endedAt" in value &&
        value.endedAt !== null &&
        value.endedAt !== undefined);
    // What a recall says it didn't find is the question's words, which
    // hold every marker asked of: never a memory.
    return Object.entries(value).some(
      ([key, each]) =>
        key !== "notFound" && holdsCurrent(each, marker, endedHere)
    );
  }
  return false;
};

/** The surfaces of `reads` that give `marker` as current. */
export const currentIn = (reads: Reads, marker: string): string[] =>
  Object.entries(reads)
    .filter(([, read]) => holdsCurrent(read, marker, false))
    .map(([name]) => name);

/** `value` without what recall says it didn't find (`holdsCurrent`), at any depth. */
const withoutNotFound = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((each) => withoutNotFound(each));
  }
  if (typeof value === "object" && value !== null && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "notFound")
        .map(([key, each]) => [key, withoutNotFound(each)])
    );
  }
  return value;
};

/** The surfaces of `reads` that give `marker` at all, current or ended. */
export const shownIn = (reads: Reads, marker: string): string[] =>
  Object.entries(reads)
    .filter(([, read]) =>
      textOf(withoutNotFound(read)).toLowerCase().includes(marker)
    )
    .map(([name]) => name);

/**
 * The surfaces that give a current memory of a team's, in the shared
 * store, to a reader in the team: every one but those of passages,
 * versions, places and entities alone, and an App's, which reads as the
 * company.
 */
export const memorySurfaces = [
  "recall in their own chat",
  "recall as their teams",
  "recall with the stores it found in",
  "the Brain page's search",
  "memories",
  "the Brain page's memories",
  "code's card",
  "the store's card",
  "recall ranked by their use",
];

/** The surfaces that give a current memory the whole company may read: an App's too. */
export const companyMemorySurfaces = [
  ...memorySurfaces.slice(0, -2),
  "an App's card",
  ...memorySurfaces.slice(-2),
];

/** The surfaces that give a current memory of a person's own store: core's that read it. */
export const ownMemorySurfaces = [
  "recall in their own chat",
  "recall with the stores it found in",
  "the Brain page's search",
  "memories",
  "the Brain page's memories",
  "the store's card",
  "recall ranked by their use",
];

/**
 * Times, which differ between twins built a moment apart: ISO 8601, a
 * date as text, and epoch milliseconds.
 */
const times =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z|[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4} \([^)]*\)|(?<![\d.])1\d{12}(?![\d.])/gu;

/**
 * `value` with each string of it in roles (`role`), and every list in
 * the order of its items' text: a twin's memories tie with one another as
 * the world's do, but break the tie by ids of their own.
 */
const inRoles = (value: unknown, role: (text: string) => string): unknown => {
  if (typeof value === "string") {
    return role(value);
  }
  if (value instanceof Date) {
    return "<time>";
  }
  if (Array.isArray(value)) {
    return value
      .map((each) => inRoles(each, role))
      .toSorted((one, other) => textOf(one).localeCompare(textOf(other)));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [key, inRoles(each, role)])
    );
  }
  return value;
};

/** `reads` as text, each of `world`'s own names replaced by its role. */
const asRoles = (world: OutWorld, reads: Reads): Record<string, string> => {
  const names: [string, string][] = [
    [world.source.id, "<source>"],
    [world.entity, "<entity>"],
    [world.depot, "<depot>"],
    ...Object.entries(world.markers).map(([name, marker]): [string, string] => [
      marker,
      `<${name}>`,
    ]),
    ...Object.entries(world.memories).map(([name, id]): [string, string] => [
      id,
      `<${name} memory>`,
    ]),
  ];
  const role = (text: string): string => {
    let roled = text.replaceAll(times, "<time>");
    for (const [name, each] of names) {
      if (name !== "") {
        roled = roled.replaceAll(name, each);
      }
    }
    return roled;
  };
  return Object.fromEntries(
    Object.entries(reads).map(([surface, read]) => [
      surface,
      textOf(inRoles(read, role)),
    ])
  );
};

/**
 * Where `world`'s reads differ from its twin's, once each world's names
 * are replaced by roles: each surface with both texts. None when the
 * twin, lacking what the reader may not read, answers alike.
 */
export const unlikeTwin = (
  world: OutWorld,
  reads: Reads,
  twin: OutWorld,
  twinReads: Reads
): { surface: string; world: string; twin: string }[] => {
  const ours = asRoles(world, reads);
  const theirs = asRoles(twin, twinReads);
  return Object.keys({ ...ours, ...theirs }).flatMap((surface) =>
    ours[surface] === theirs[surface]
      ? []
      : [
          {
            surface,
            world: ours[surface] ?? "",
            twin: theirs[surface] ?? "",
          },
        ]
  );
};

/** The row of `world`'s `version` and of its memory `name`, in the shared store. */
export const rowsOf = async (
  world: OutWorld,
  version: number,
  name: string
): Promise<{ version: number; memory: number }> =>
  await inStoreOf("brain", (sql) => ({
    version: sql
      .exec<{ row: number }>(
        "SELECT row FROM source_versions WHERE source = ? AND version = ?",
        world.key,
        version
      )
      .one().row,
    memory: sql
      .exec<{ row: number }>(
        "SELECT row FROM memories WHERE id = ?",
        world.memories[name] ?? ""
      )
      .one().row,
  }));

/** Every table of the shared store that holds `key` in a column of text. */
export const tablesHolding = async (key: string): Promise<string[]> =>
  await inStoreOf("brain", (sql) =>
    sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '%_fts%'"
      )
      .toArray()
      .filter(({ name }) =>
        sql
          .exec<{ name: string; type: string }>(`PRAGMA table_info("${name}")`)
          .toArray()
          .filter(({ type }) => type.toUpperCase().includes("TEXT"))
          .some(
            (column) =>
              sql
                .exec<{ found: number }>(
                  `SELECT count(*) AS found FROM "${name}" WHERE "${column.name}" = ?`,
                  key
                )
                .one().found > 0
          )
      )
      .map(({ name }) => name)
  );

/** A WebVTT file of one cue saying `text`, as an upload of a transcript is. */
export const transcriptOf = (text: string) => ({
  name: "Minutes.vtt",
  bytes: new TextEncoder().encode(
    `WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n${text}\n`
  ),
});

/**
 * Makes `world`'s current version one an older release added: the
 * pointer moved past `judgedVersion`, nothing judged against it, no in
 * or out row of the source's.
 */
export const asIfOlderVersion = async (
  world: OutWorld,
  judgedVersion: number
) => {
  const { version } = await rowsOf(world, judgedVersion, "keep");
  await inStoreOf("brain", (sql) => {
    sql.exec("DELETE FROM memory_ins WHERE source = ?", world.key);
    sql.exec("DELETE FROM memory_outs WHERE source = ?", world.key);
    sql.exec(
      "UPDATE current_versions SET judged_row = ? WHERE source = ?",
      version,
      world.key
    );
  });
};

/** Makes `world`'s memory `name` one an older release added late: no in or out row, the mark not past it. */
export const asIfOlderLate = async (world: OutWorld, name: string) => {
  const { memory } = await rowsOf(world, 1, name);
  await inStoreOf("brain", (sql) => {
    sql.exec("DELETE FROM memory_ins WHERE memory = ?", memory);
    sql.exec("DELETE FROM memory_outs WHERE memory = ?", memory);
    sql.exec(
      "UPDATE memory_judging SET through = min(through, ?) WHERE id = 1",
      memory - 1
    );
  });
};

/**
 * Leaves `world`'s source as a pass of the catch-up under way past
 * memory `name` would: unjudged, its place after that memory.
 */
export const midPass = async (
  world: OutWorld,
  name: string,
  version: number
) => {
  const { memory } = await rowsOf(world, version, name);
  const current = await inStoreOf("brain", (sql) =>
    sql
      .exec<{ version_row: number }>(
        "SELECT version_row FROM current_versions WHERE source = ?",
        world.key
      )
      .one()
  );
  await inStoreOf("brain", (sql) => {
    sql.exec(
      "UPDATE current_versions SET judged_row = NULL WHERE source = ?",
      world.key
    );
    sql.exec(
      `INSERT INTO memory_judging_places (source, version_row, after_version, after_row)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT (source) DO UPDATE SET version_row = ?2, after_version = ?3, after_row = ?4`,
      world.key,
      current.version_row,
      version,
      memory
    );
  });
};

/** The word rules the shared store's word indexes are built to, once a rebuild is done. */
export const wordRulesOf = async (): Promise<number> =>
  await inStoreOf(
    "brain",
    (sql) =>
      sql
        .exec<{ version: number }>(
          "SELECT version FROM word_index WHERE id = 1"
        )
        .one().version
  );
