import { brainOf, memoriesPerAddMax } from "@grasp-os/brain-next/contract";
import type {
  NewEntity,
  NewMemory,
  Reader,
} from "@grasp-os/brain-next/contract";
import type {
  BrainEntityListed,
  BrainMemoryPageNext,
  BrainMemoryShown,
  BrainStoreCursor,
} from "@grasp-os/shared/brain-memories";
import { roleErrors } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import { addSource, rememberAs } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { mockIdp } from "./idp.ts";
import { eventsOf } from "./model-rules.ts";
import { openRpc, signedIn, signedInApi, staffPerson } from "./sign-in.ts";

type Api = Awaited<ReturnType<typeof signedInApi>>["api"];

// The Brain's Memories page, through core's RPC (`session.brainMemories`)
// into the Brain's stores (GRA-1746): a person sees only the entities and
// memories they may read, each memory with its source, as a team-mate, an
// outsider and an admin, and an entity or memory they may not read
// answers as one there isn't, in lists, pages and whether more follow; a
// contested fact shows its sides to someone who can read them, who can
// confirm one; marking a memory wrong saves their own word, theirs alone,
// confirmed, and audited. The permission harness
// (brain-next-surfaces.ts) probes every method with markers.

const idp = mockIdp();

const shared = () => brainOf(inJurisdiction(env, env.BRAIN_STORE));

/** A new team with `members`; its id. */
const teamOf = async (...members: string[]): Promise<string> => {
  const teamId = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db.insert(teams).values({
    id: teamId,
    name: `Team ${teamId}`,
    organizationId,
    createdAt: new Date(),
  });
  for (const userId of members) {
    // oxlint-disable-next-line no-await-in-loop -- one member at a time
    await db.insert(teamMembers).values({
      id: crypto.randomUUID(),
      teamId,
      userId,
      createdAt: new Date(),
    });
  }
  return teamId;
};

/** A new upload readable by team `teamId`; its key and version as the store cites them. */
const sourceOf = async (teamId: string, text: string) => {
  const id = crypto.randomUUID();
  const { version } = await addSource(env, {
    source: { producer: "upload", id },
    change: crypto.randomUUID(),
    text,
    readers: { kind: "team", teamId },
  });
  return { id, cited: { source: `upload:${id}`, version } };
};

/** A customer's status, drawn from `cited` with `quote`, about entity key `about`. */
const statusFrom = (
  cited: { source: string; version: number },
  value: string
): NewMemory => ({
  about: "c",
  attribute: "status",
  value,
  type: "fact",
  statement: `The customer is ${value}`,
  speaker: { kind: "system" },
  basis: { kind: "source", ...cited, quote: value },
});

/** Adds `memories` about the customer `customer` (an entity), readable by team `teamId`; the ids. */
const remember = async (
  teamId: string,
  customer: Omit<NewEntity, "key">,
  memories: NewMemory[],
  reader?: Reader
) =>
  await shared().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group: `team:${teamId}` },
    entities: [{ key: "c", ...customer }],
    memories,
    ...(reader === undefined ? {} : { reader }),
  });

/** Every entity of `kind` `api`'s person may see, every page followed; and how many pages. */
const allEntities = async (api: Api) => {
  const entities: BrainEntityListed[] = [];
  let next: BrainMemoryPageNext | null = null;
  let pages = 0;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page after the last
    const page = await api.brainMemories.entities("customer", next);
    entities.push(...page.entities);
    ({ next } = page);
    pages += 1;
  } while (next !== null);
  return { entities, pages };
};

/** Every memory about `entity` `api`'s person may read, every page followed; and how many pages. */
const allMemories = async (
  api: Api,
  entity: { store: "own" | "shared"; id: string }
) => {
  const memories: BrainMemoryShown[] = [];
  let next: BrainStoreCursor | null = null;
  let pages = 0;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page after the last
    const page = await api.brainMemories.memories(entity, next);
    memories.push(...page.memories);
    ({ next } = page);
    pages += 1;
  } while (next !== null);
  return { memories, pages };
};

/** `count` customers, each named `prefix` and its number. */
const customers = (count: number, prefix: string): NewEntity[] =>
  Array.from({ length: count }, (_, index) => ({
    key: `c${index}`,
    kind: "customer",
    names: [`${prefix} ${index}`],
  }));

/** The names of `listed`. */
const names = (listed: readonly BrainEntityListed[]) =>
  listed.map(({ name }) => name);

/** Code unit order, as SQLite compares text. */
const byCodeUnits = (one: string | null, two: string | null): number => {
  if (one === two) {
    return 0;
  }
  return (one ?? "") < (two ?? "") ? -1 : 1;
};

/**
 * What the audit log holds of `userId`'s `action`s: each memory, outcome
 * and result, in no order (an outcome reaches the log through core's
 * outbox, after the attempt).
 */
const auditedOf = async (userId: string, action: string) => {
  const events = await eventsOf({ type: "person", userId });
  return events
    .filter((event) => event.action === action)
    .map(({ detail }) => ({
      memory: detail?.memory,
      outcome: detail?.outcome,
      result: detail?.result,
      saved: detail?.saved,
    }))
    .toSorted((one, two) =>
      byCodeUnits(JSON.stringify(one), JSON.stringify(two))
    );
};

/** `steps` in the order `auditedOf` gives them. */
const unordered = <T>(steps: readonly T[]): T[] =>
  steps.toSorted((one, two) =>
    byCodeUnits(JSON.stringify(one), JSON.stringify(two))
  );

/** Every memory about `entity` `api`'s person may read (`allMemories`). */
const memoriesAbout = async (
  api: Api,
  entity: { store: "own" | "shared"; id: string }
) => {
  const { memories } = await allMemories(api, entity);
  return memories;
};

/** An audit step of a memory, as `auditedOf` gives it. */
const step = (memory: string, outcome: string, result?: string) => ({
  memory,
  outcome,
  result,
  saved: undefined,
});

/** Of memories, what the page shows of where each came from and what it says. */
const shown = (memories: readonly BrainMemoryShown[]) =>
  memories.map(({ store, value, source, yours, endedAt, contested }) => ({
    store,
    value,
    source,
    yours,
    ended: endedAt !== null,
    contested,
  }));

describe("the Brain's memories, as a person reads them", () => {
  it("shows each person only what they may read, each memory with its source, and a hidden entity as one there isn't", async () => {
    const [anna, ben, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const sales = await teamOf(anna.userId);
    const { id, cited } = await sourceOf(sales, "Acme is renewing");
    const added = await remember(sales, { kind: "customer", names: ["Acme"] }, [
      statusFrom(cited, "Renewing"),
    ]);
    const entity = { store: "shared" as const, id: added.entities.c ?? "" };
    const nobody = { store: "shared" as const, id: crypto.randomUUID() };

    const { entities: listed } = await allEntities(anna.api);
    const { memories } = await allMemories(anna.api, entity);
    expect({
      listed,
      read: await anna.api.brainMemories.entity(entity),
      memories: shown(memories),
    }).toStrictEqual({
      listed: [{ entity, kind: "customer", name: "Acme" }],
      read: { entity, kind: "customer", name: "Acme" },
      memories: [
        {
          store: "shared",
          value: "Renewing",
          source: {
            source: { producer: "upload", id },
            version: cited.version,
          },
          yours: false,
          ended: false,
          contested: false,
        },
      ],
    });
    // A member outside the team and an admin get what an entity no one
    // added gets.
    const answersOf = async (api: Api) =>
      await Promise.all([
        allEntities(api),
        api.brainMemories.entity(entity),
        api.brainMemories.memories(entity),
        api.brainMemories.entity(nobody),
        api.brainMemories.memories(nobody),
      ]);
    const nothing = [
      { entities: [], pages: 1 },
      null,
      { memories: [], next: null },
      null,
      { memories: [], next: null },
    ];
    expect([
      await answersOf(ben.api),
      await answersOf(admin.api),
    ]).toStrictEqual([nothing, nothing]);
  });

  it("pages at the store with the reader's sets in the statement: what they may not read takes no place, and their own come first", async () => {
    const [anna, ben] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const [sales, finance] = await Promise.all([
      teamOf(anna.userId, ben.userId),
      teamOf(),
    ]);
    // A page of the store's and one more, hidden ones between them.
    const memoriesOf = (count: number): NewMemory[] =>
      Array.from({ length: count }, (_, index) => ({
        about: `c${index}`,
        type: "fact",
        statement: `Customer ${index}`,
        speaker: { kind: "system" },
        basis: { kind: "writer", writer: anna.userId },
      }));
    const addFor = async (teamId: string, count: number, prefix: string) =>
      await shared().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: `team:${teamId}` },
        entities: customers(count, prefix),
        memories: memoriesOf(count),
      });
    await addFor(sales, memoriesPerAddMax, "Seen");
    await addFor(finance, memoriesPerAddMax, "Hidden");
    await addFor(sales, 1, "Last seen");
    await addFor(finance, 1, "Last hidden");
    const own = await rememberAs(env, anna.userId, {
      change: crypto.randomUUID(),
      about: { kind: "customer", names: ["Mine"] },
      type: "fact",
      statement: "Mine",
      quote: "Mine",
    });

    const annaSees = await allEntities(anna.api);
    const benSees = await allEntities(ben.api);
    expect({
      first: annaSees.entities[0],
      count: annaSees.entities.length,
      distinct: new Set(annaSees.entities.map(({ entity }) => entity.id)).size,
      hidden: names(annaSees.entities).filter(
        (name) => name?.includes("idden") === true
      ),
      pages: annaSees.pages,
      // Ben, in the same team, sees the same shared ones, in the same
      // pages, and nothing of Anna's own.
      ben: {
        names: names(benSees.entities),
        pages: benSees.pages,
      },
    }).toStrictEqual({
      first: {
        entity: { store: "own", id: own.entity },
        kind: "customer",
        name: "Mine",
      },
      count: memoriesPerAddMax + 2,
      distinct: memoriesPerAddMax + 2,
      hidden: [],
      pages: 2,
      ben: {
        names: names(annaSees.entities.slice(1)),
        pages: 2,
      },
    });
  });

  it("pages through an entity's memories, history included", async () => {
    const anna = await signedInApi(idp, "user");
    const sales = await teamOf(anna.userId);
    const many = Array.from(
      { length: memoriesPerAddMax },
      (_, index): NewMemory => ({
        about: "c",
        type: "fact",
        statement: `Fact ${index}`,
        speaker: { kind: "system" },
        basis: { kind: "writer", writer: crypto.randomUUID() },
      })
    );
    const first = await remember(
      sales,
      { kind: "customer", names: ["Many"] },
      many
    );
    const id = first.entities.c ?? "";
    await shared().addMemories({
      change: crypto.randomUUID(),
      access: { kind: "audience", group: `team:${sales}` },
      entities: [{ key: "c", id, kind: "customer", names: ["Many"] }],
      memories: [many[0] ?? many[1]].flatMap((each) =>
        each === undefined ? [] : [{ ...each, statement: "One more" }]
      ),
    });
    const { memories, pages } = await allMemories(anna.api, {
      store: "shared",
      id,
    });
    expect({
      count: memories.length,
      distinct: new Set(memories.map(({ id: memory }) => memory)).size,
      pages,
    }).toStrictEqual({
      count: memoriesPerAddMax + 1,
      distinct: memoriesPerAddMax + 1,
      pages: 2,
    });
  });

  it("shows a contested fact to someone who can read both sides, who can confirm one; to someone who reads one side it isn't contested", async () => {
    const [anna, ben] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const [sales, finance] = await Promise.all([
      teamOf(anna.userId, ben.userId),
      teamOf(anna.userId),
    ]);
    const one = await sourceOf(sales, "Acme renews");
    const other = await sourceOf(finance, "Acme churned");
    const first = await remember(sales, { kind: "customer", names: ["Acme"] }, [
      statusFrom(one.cited, "Renewing"),
    ]);
    const id = first.entities.c ?? "";
    const second = await remember(
      finance,
      { kind: "customer", names: ["Acme"], id },
      [statusFrom(other.cited, "Churned")],
      // Made for someone who sees the entity, so its id is taken.
      { person: anna.userId, groups: [`team:${sales}`, `team:${finance}`] }
    );
    const entity = { store: "shared" as const, id };
    const [annaContested, benContested] = await Promise.all([
      anna.api.brainMemories.contested(),
      ben.api.brainMemories.contested(),
    ]);
    expect({
      anna: annaContested.facts.map(({ about, attribute, sides, more }) => ({
        about: about.entity,
        attribute,
        sides: sides.map(({ value }) => value).toSorted(byCodeUnits),
        more,
      })),
      ben: benContested,
      bensMemory: shown(await memoriesAbout(ben.api, entity)),
    }).toStrictEqual({
      anna: [
        {
          about: entity,
          attribute: "status",
          sides: ["Churned", "Renewing"],
          more: false,
        },
      ],
      ben: { facts: [], next: null },
      bensMemory: [
        {
          store: "shared",
          value: "Renewing",
          source: {
            source: { producer: "upload", id: one.id },
            version: one.cited.version,
          },
          yours: false,
          ended: false,
          contested: false,
        },
      ],
    });

    const churned = {
      store: "shared" as const,
      entity: id,
      memory: second.memories[0] ?? "",
    };
    const nobody = { ...churned, memory: crypto.randomUUID() };
    // Ben may not read that side: confirming it answers as one there isn't.
    expect([
      await ben.api.brainMemories.confirm(churned),
      await ben.api.brainMemories.confirm(nobody),
    ]).toStrictEqual(["nothing", "nothing"]);
    await expect(anna.api.brainMemories.confirm(churned)).resolves.toBe("done");
    const {
      facts: [fact],
    } = await anna.api.brainMemories.contested();
    expect(
      fact?.sides.map(({ value, confirmed }) => ({
        value,
        confirmed: confirmed?.byYou ?? null,
      }))
    ).toStrictEqual([
      { value: "Churned", confirmed: true },
      { value: "Renewing", confirmed: null },
    ]);
    expect({
      ben: await auditedOf(ben.userId, "brain.memory.confirmed"),
      anna: await auditedOf(anna.userId, "brain.memory.confirmed"),
    }).toStrictEqual({
      ben: unordered([
        step(churned.memory, "attempted"),
        step(churned.memory, "done", "nothing"),
        step(nobody.memory, "attempted"),
        step(nobody.memory, "done", "nothing"),
      ]),
      anna: unordered([
        step(churned.memory, "attempted"),
        step(churned.memory, "done", "done"),
      ]),
    });
  });

  it("saves a correction as the person's own word, theirs alone and confirmed, and answers a memory they may not read as one there isn't", async () => {
    const [anna, ben] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const sales = await teamOf(anna.userId);
    const { cited } = await sourceOf(sales, "Acme renews");
    const added = await remember(
      sales,
      {
        kind: "customer",
        names: ["Acme"],
        identifiers: [
          { type: "email", value: `acme-${crypto.randomUUID()}@example.test` },
        ],
      },
      [statusFrom(cited, "Renewing")]
    );
    const wrong = {
      store: "shared" as const,
      entity: added.entities.c ?? "",
      memory: added.memories[0] ?? "",
    };
    const change = crypto.randomUUID();
    // Ben may not read it: the same as a memory there isn't.
    expect([
      await ben.api.brainMemories.correct({ wrong, right: "Churned", change }),
      await ben.api.brainMemories.correct({
        wrong: { ...wrong, memory: crypto.randomUUID() },
        right: "Churned",
        change,
      }),
    ]).toStrictEqual([null, null]);

    const saved = await anna.api.brainMemories.correct({
      wrong,
      right: "Churned",
      change: crypto.randomUUID(),
    });
    if (saved === null) {
      throw new Error("Saved no correction");
    }
    const own = { store: "own" as const, id: saved.entity };
    const kept = await memoriesAbout(anna.api, own);
    expect({
      kept: kept.map(({ id, value, yours, confirmed, endedAt }) => ({
        id,
        value,
        yours,
        confirmed: confirmed?.byYou ?? null,
        ended: endedAt !== null,
      })),
      entity: await anna.api.brainMemories.entity(own),
      // The shared memory stays as it was.
      sharedStill: shown(
        await memoriesAbout(anna.api, { store: "shared", id: wrong.entity })
      ).map(({ value, ended }) => ({ value, ended })),
      // Nobody else sees her correction.
      bens: await ben.api.brainMemories.entity(own),
    }).toStrictEqual({
      kept: [
        {
          id: saved.memory,
          value: "Churned",
          yours: true,
          confirmed: true,
          ended: false,
        },
      ],
      entity: { entity: own, kind: "customer", name: "Acme" },
      sharedStill: [{ value: "Renewing", ended: false }],
      bens: null,
    });

    // Correcting her own word again replaces it, kept as history.
    const again = await anna.api.brainMemories.correct({
      wrong: { store: "own", entity: saved.entity, memory: saved.memory },
      right: "Paused",
      change: crypto.randomUUID(),
    });
    const history = await memoriesAbout(anna.api, own);
    expect(
      history.map(({ id, value, endedAt }) => ({
        id,
        value,
        ended: endedAt !== null,
      }))
    ).toStrictEqual([
      { id: again?.memory, value: "Paused", ended: false },
      { id: saved.memory, value: "Churned", ended: true },
    ]);
    await expect(
      auditedOf(anna.userId, "brain.memory.corrected")
    ).resolves.toStrictEqual(
      unordered([
        step(wrong.memory, "attempted"),
        { ...step(wrong.memory, "done", "done"), saved: saved.memory },
        step(saved.memory, "attempted"),
        { ...step(saved.memory, "done", "done"), saved: again?.memory },
      ])
    );
  });

  it("refuses a Grasp staff session", async () => {
    const staff = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    await expect(
      staff.core.authenticate().brainMemories.entities("customer")
    ).rejects.toThrow(roleErrors.create("role.forbidden").message);
  });
});
