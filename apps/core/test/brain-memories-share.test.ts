import { brainOf, personalBrainOf } from "@grasp-os/brain-next/contract";
import type {
  BrainEntityListed,
  BrainMemoryPageNext,
  BrainMemoryShown,
  BrainShare,
  BrainStoreCursor,
} from "@grasp-os/shared/brain-memories";
import { brainMemoryErrors } from "@grasp-os/shared/brain-memories";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import { recallAs, rememberAs } from "../src/brain-next.ts";
import type { Remembered } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { mockIdp } from "./idp.ts";
import { eventsOf } from "./model-rules.ts";
import { signedInApi, signedInWithRole } from "./sign-in.ts";

type Api = Awaited<ReturnType<typeof signedInApi>>["api"];

// Sharing a memory (GRA-1815), through core's RPC (`session.brainMemories`)
// into the Brain's stores: a person shares a fact of their own store with
// a team they are in or the company, as a new memory in their own word in
// the shared store. Its group reads it, nobody else does, and their own
// memory stays theirs alone. What isn't theirs to share, or no longer says
// what they were shown, answers alike; nothing about a person, or about
// what has no name, is shared; a time-bound fact ends for its readers when
// it ends for them; a share is audited with ids alone, and its writer can
// list it and take it back, also once out of its team, which keeps it as
// history for those who may read it. The permission harness
// (brain-next-surfaces.ts, brain-next-leaks.test.ts) probes every method
// with markers.

const idp = mockIdp();

let fillerOnce: Promise<string> | undefined;

/** A member who only fills teams, the same for the file. */
const filler = async (): Promise<string> => {
  fillerOnce ??= (async () => {
    const { userId } = await signedInWithRole(idp, "user");
    return userId;
  })();
  return await fillerOnce;
};

/** A new team with exactly `members`; its id. */
const exactTeamOf = async (...members: string[]): Promise<string> => {
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

/**
 * A new team with `members` and one more (`filler`), large enough to
 * share with when two are given; its id.
 */
const teamOf = async (...members: string[]): Promise<string> =>
  await exactTeamOf(...members, await filler());

/** Every entity of `kind` `api`'s person may see, every page followed. */
const allEntities = async (
  api: Api,
  kind: "customer" | "person" = "customer"
) => {
  const entities: BrainEntityListed[] = [];
  let next: BrainMemoryPageNext | null = null;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page after the last
    const page = await api.brainMemories.entities(kind, next);
    entities.push(...page.entities);
    ({ next } = page);
  } while (next !== null);
  return entities;
};

/** Every memory about `entity` `api`'s person may read, history included. */
const memoriesAbout = async (
  api: Api,
  entity: { store: "own" | "shared"; id: string }
) => {
  const memories: BrainMemoryShown[] = [];
  let next: BrainStoreCursor | null = null;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page after the last
    const page = await api.brainMemories.memories(entity, next);
    memories.push(...page.memories);
    ({ next } = page);
  } while (next !== null);
  return memories;
};

/** The entities named `name` of those `api`'s person may see, by store. */
const named = async (api: Api, name: string) => {
  const entities = await allEntities(api);
  return entities.filter((entity) => entity.name === name);
};

/** Of the memories about `entity` `api`'s person may read, each id and whether it ended. */
const endedOf = async (
  api: Api,
  entity: { store: "own" | "shared"; id: string }
) => {
  const memories = await memoriesAbout(api, entity);
  return memories.map(({ id, endedAt }) => ({ id, ended: endedAt !== null }));
};

/** A name nothing else holds: two words, as a link by name takes. */
const nameOf = (prefix: string): string =>
  `${prefix} ${crypto.randomUUID().slice(0, 8)}`;

/**
 * Saves `remembered` as `personId`'s own word, in their own store, and
 * what the page shows of it there: the memory, the entity and its name.
 */
const ownMemory = async (
  api: Api,
  personId: string,
  remembered: Omit<Remembered, "change">
) => {
  const saved = await rememberAs(env, personId, {
    change: crypto.randomUUID(),
    ...remembered,
  });
  const entity = { store: "own" as const, id: saved.entity };
  const memories = await memoriesAbout(api, entity);
  const shown = memories.find(({ id }) => id === saved.memory);
  if (shown === undefined) {
    throw new Error("The page shows no memory saved");
  }
  return { saved, entity, shown };
};

/** A share of `shown`, about `about`, with `audience`, as the page sends it. */
const shareOf = (
  shown: BrainMemoryShown,
  about: string,
  audience: BrainShare["audience"]
): BrainShare => ({
  memory: { entity: shown.about, memory: shown.id },
  shown: {
    about,
    value: shown.value,
    statement: shown.statement,
    validFrom: shown.validFrom,
    validUntil: shown.validUntil,
  },
  audience,
  change: crypto.randomUUID(),
});

/** Takes `userId` out of team `teamId`. */
const leave = async (teamId: string, userId: string): Promise<void> => {
  await drizzle(env.DB)
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
};

/** Whether `userId`'s recall as their teams hands over memory `memory` for `question`. */
const recalls = async (
  userId: string,
  question: string,
  memory: string
): Promise<boolean> => {
  const { memories } = await recallAs(env, userId, {
    personal: false,
    question,
    budget: { tokens: 4000 },
  });
  return memories.some((each) => each.memory === memory);
};

/** A customer's renewal the person says, with the words they said it in. */
const renewal = (name: string, quote: string) => ({
  about: { kind: "customer" as const, names: [name] },
  attribute: "status" as const,
  value: "Renewing",
  type: "fact" as const,
  statement: `${name} renews in March`,
  quote,
});

/** What the audit log holds of `userId`'s `action`s, each event's detail, in no order. */
const auditedOf = async (userId: string, action: string) => {
  const events = await eventsOf({ type: "person", userId });
  return events
    .filter((event) => event.action === action)
    .map(({ detail }) => detail)
    .toSorted((one, two) =>
      String(one?.outcome).localeCompare(String(two?.outcome))
    );
};

describe("sharing a memory of a person's own", () => {
  it("shares it with a team of theirs as a new memory in their word: the team reads it, nobody else does, and theirs stays theirs alone", async () => {
    const [anna, ben, carl] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const sales = await teamOf(anna.userId, ben.userId);
    const name = nameOf("Acme");
    const quote = `what Anna said in her chat ${crypto.randomUUID()}`;
    const { entity, shown } = await ownMemory(
      anna.api,
      anna.userId,
      renewal(name, quote)
    );
    const carlBefore = await allEntities(carl.api);
    const share = shareOf(shown, name, { team: sales });

    const shared = await anna.api.brainMemories.publish(share);
    if (shared === null) {
      throw new Error("Shared nothing");
    }
    const copy = { store: "shared" as const, id: shared.entity };
    const bens = await memoriesAbout(ben.api, copy);
    const [annaSees, annasCopy, annasOwn] = await Promise.all([
      named(anna.api, name),
      memoriesAbout(anna.api, copy),
      memoriesAbout(anna.api, entity),
    ]);
    expect({
      // Ben, in the team, sees the shared entity and its one memory.
      benSees: await named(ben.api, name),
      bens: bens.map(
        ({ id, statement, value, quote: said, source, yours, endedAt }) => ({
          id,
          statement,
          value,
          said,
          source,
          yours,
          ended: endedAt !== null,
        })
      ),
      // Anna sees hers as her own word; her own memory is unchanged.
      annaSees: annaSees.map((each) => each.entity),
      annasCopy: annasCopy.map(({ id, yours }) => ({ id, yours })),
      annasOwn: annasOwn.map(({ id, quote: said, endedAt }) => ({
        id,
        said,
        ended: endedAt !== null,
      })),
      // Nobody else reads her own memory, and Carl, outside the team,
      // reads what he read before.
      benOwn: await ben.api.brainMemories.memories(entity),
      carlAfter: await allEntities(carl.api),
      carlCopy: await carl.api.brainMemories.memories(copy),
    }).toStrictEqual({
      benSees: [{ entity: copy, kind: "customer", name, unreadable: false }],
      bens: [
        {
          id: shared.memory,
          statement: shown.statement,
          value: "Renewing",
          // Her quote, her chat's words, is never copied.
          said: null,
          source: null,
          yours: false,
          ended: false,
        },
      ],
      annaSees: [entity, copy],
      annasCopy: [{ id: shared.memory, yours: true }],
      annasOwn: [{ id: shown.id, said: quote, ended: false }],
      benOwn: { entity: null, memories: [], next: null },
      carlAfter: carlBefore,
      carlCopy: { entity: null, memories: [], next: null },
    });
    await expect(
      auditedOf(anna.userId, "brain.memory.published")
    ).resolves.toStrictEqual([
      {
        onBehalfOf: anna.userId,
        memory: shown.id,
        change: share.change,
        audience: "team",
        outcome: "attempted",
      },
      {
        onBehalfOf: anna.userId,
        memory: shown.id,
        change: share.change,
        audience: "team",
        team: sales,
        outcome: "done",
        result: "done",
        published: shared.memory,
        entity: shared.entity,
      },
    ]);
  });

  it("shares it with everyone in the company, and answers a retry with what it shared", async () => {
    const [anna, dora] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("Globex");
    const { shown } = await ownMemory(
      anna.api,
      anna.userId,
      renewal(name, "Globex is renewing, I heard")
    );
    const share = shareOf(shown, name, "company");
    const shared = await anna.api.brainMemories.publish(share);
    const again = await anna.api.brainMemories.publish(share);
    const doras = await named(dora.api, name);
    expect({
      again,
      doras: doras.map(({ entity }) => entity),
    }).toStrictEqual({
      again: shared,
      doras: [{ store: "shared", id: shared?.entity }],
    });
    // The same share's id with another audience is another share's.
    const sales = await teamOf(anna.userId, dora.userId);
    await expect(
      anna.api.brainMemories.publish({ ...share, audience: { team: sales } })
    ).rejects.toThrow(brainMemoryErrors.create("brain.share_reused").message);
    // Repeated, it is one share: one outcome in the audit log.
    const published = await auditedOf(anna.userId, "brain.memory.published");
    const outcomes = published.filter(
      ({ change, outcome }) => change === share.change && outcome === "done"
    );
    expect(outcomes).toHaveLength(1);
  });

  it("shares only what the person was shown, of their own, a fact or a decision, alike for what isn't theirs", async () => {
    const [anna, ben] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const sales = await teamOf(anna.userId, ben.userId);
    const name = nameOf("Initech");
    const { shown } = await ownMemory(
      anna.api,
      anna.userId,
      renewal(name, "Initech renews")
    );
    const preference = await ownMemory(anna.api, anna.userId, {
      about: { kind: "customer", names: [name] },
      type: "preference",
      statement: "I like to call Initech on Mondays",
      quote: "I like to call Initech on Mondays",
    });
    const instruction = await ownMemory(anna.api, anna.userId, {
      about: { kind: "customer", names: [name] },
      type: "instruction",
      statement: "Always copy me on Initech mail",
      quote: "Always copy me on Initech mail",
    });
    const forgotten = await ownMemory(anna.api, anna.userId, {
      about: { kind: "customer", names: [name] },
      type: "decision",
      statement: "We drop the Initech discount",
      quote: "We drop the Initech discount",
    });
    await anna.api.brainMemories.forget(forgotten.shown.id);
    // About a person (a colleague), and about something with no name.
    const colleague = await ownMemory(anna.api, anna.userId, {
      about: { kind: "person", names: ["Ben Jansen"] },
      type: "fact",
      statement: "Ben Jansen is leaving in May",
      quote: "Ben Jansen is leaving in May",
    });
    const nameless = await ownMemory(anna.api, anna.userId, {
      about: { kind: "customer" },
      type: "fact",
      statement: "The new customer pays late",
      quote: "The new customer pays late",
    });
    const team = { team: sales };
    const share = shareOf(shown, name, team);
    const answers = await Promise.all([
      // What she was shown differs from what it says now.
      anna.api.brainMemories.publish({
        ...share,
        shown: { ...share.shown, statement: `${name} renews in April` },
      }),
      anna.api.brainMemories.publish({
        ...share,
        shown: { ...share.shown, value: "Churned" },
      }),
      anna.api.brainMemories.publish({
        ...share,
        shown: { ...share.shown, about: "Someone else" },
      }),
      // Of a kind never shared, or no longer current.
      anna.api.brainMemories.publish(shareOf(preference.shown, name, team)),
      anna.api.brainMemories.publish(shareOf(instruction.shown, name, team)),
      anna.api.brainMemories.publish(shareOf(forgotten.shown, name, team)),
      anna.api.brainMemories.publish(
        shareOf(colleague.shown, "Ben Jansen", team)
      ),
      anna.api.brainMemories.publish(shareOf(nameless.shown, "", team)),
      // Hers, asked by Ben, and one nobody saved.
      ben.api.brainMemories.publish(share),
      anna.api.brainMemories.publish({
        ...share,
        memory: { ...share.memory, memory: crypto.randomUUID() },
      }),
    ]);
    expect({
      answers,
      // Nothing reached the team.
      bens: await named(ben.api, name),
    }).toStrictEqual({ answers: answers.map(() => null), bens: [] });
  });

  it("ends the copy when the original ends, and shares a time-bound fact only as shown with its dates", async () => {
    const [anna, ben] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const sales = await teamOf(anna.userId, ben.userId);
    const name = nameOf("Stark");
    const until = new Date(Date.now() + 86_400_000);
    // Drawn as a chat's extraction draws it: true until a day from now.
    const own = await personalBrainOf(
      inJurisdiction(env, env.BRAIN_STORE),
      anna.userId
    ).addMemories({
      change: crypto.randomUUID(),
      access: { kind: "owner", person: anna.userId },
      entities: [{ key: "c", kind: "customer", names: [name] }],
      memories: [
        {
          about: "c",
          attribute: "status",
          value: "Paused",
          type: "fact",
          statement: `${name} is paused until tomorrow`,
          validUntil: until,
          speaker: { kind: "internal", person: anna.userId },
          basis: { kind: "writer", writer: anna.userId },
        },
      ],
    });
    const entity = { store: "own" as const, id: own.entities.c ?? "" };
    const [shown] = await memoriesAbout(anna.api, entity);
    if (shown === undefined) {
      throw new Error("The page shows no memory");
    }
    const share = shareOf(shown, name, { team: sales });
    const withoutEnd = await anna.api.brainMemories.publish({
      ...share,
      shown: { ...share.shown, validUntil: null },
    });
    // A start date shown that it doesn't have is not what it says.
    const withStart = await anna.api.brainMemories.publish({
      ...share,
      shown: { ...share.shown, validFrom: new Date(0).toISOString() },
    });
    const shared = await anna.api.brainMemories.publish(share);
    if (shared === null) {
      throw new Error("Shared nothing");
    }
    const bensReader = {
      person: ben.userId,
      groups: [`team:${sales}`, "company"],
    };
    const store = brainOf(inJurisdiction(env, env.BRAIN_STORE));
    const currentAt = async (asOf?: Date) => {
      const { memories } = await store.readMemories({
        entity: shared.entity,
        reader: bensReader,
        ...(asOf === undefined ? {} : { asOf }),
      });
      return memories.map(({ id }) => id);
    };
    expect({
      shownUntil: shown.validUntil,
      withoutEnd,
      withStart,
      now: await currentAt(),
      afterTheEnd: await currentAt(new Date(until.getTime() + 1)),
    }).toStrictEqual({
      shownUntil: until.toISOString(),
      withoutEnd: null,
      withStart: null,
      now: [shared.memory],
      afterTheEnd: [],
    });
  });

  it("lets the person list and take back what they shared once out of its team, showing them nothing of what it says; nobody else can take it back", async () => {
    const [anna, ben, carl] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const sales = await teamOf(anna.userId, ben.userId);
    const name = nameOf("Wayne");
    const { shown } = await ownMemory(
      anna.api,
      anna.userId,
      renewal(name, "Wayne renews")
    );
    const shared = await anna.api.brainMemories.publish(
      shareOf(shown, name, { team: sales })
    );
    if (shared === null) {
      throw new Error("Shared nothing");
    }
    const listedIn = await anna.api.brainMemories.shared();
    const [bensList, carlsList] = await Promise.all([
      ben.api.brainMemories.shared(),
      carl.api.brainMemories.shared(),
    ]);
    const benRecalledIn = await recalls(ben.userId, name, shared.memory);
    await leave(sales, anna.userId);
    const listedOut = await anna.api.brainMemories.shared();
    const others = await Promise.all([
      ben.api.brainMemories.unpublish(shared.memory),
      carl.api.brainMemories.unpublish(shared.memory),
    ]);
    const taken = await anna.api.brainMemories.unpublish(shared.memory);
    const listedAfter = await anna.api.brainMemories.shared();
    const theirs = (page: typeof listedIn) =>
      page.memories.filter(({ id }) => id === shared.memory);
    expect({
      listedIn: theirs(listedIn).map(({ audience, memory }) => ({
        audience,
        statement: memory?.statement,
      })),
      // Nobody else's list holds what she shared.
      othersList: [...theirs(bensList), ...theirs(carlsList)],
      benRecalledIn,
      // Out of the team: its id, audience and time, nothing it says.
      listedOut: theirs(listedOut).map(({ audience, memory }) => ({
        audience,
        memory,
      })),
      saysNothing: JSON.stringify(listedOut).includes(name),
      others,
      taken,
      listedAfter: theirs(listedAfter),
      benRecalledAfter: await recalls(ben.userId, name, shared.memory),
    }).toStrictEqual({
      listedIn: [{ audience: { team: sales }, statement: shown.statement }],
      othersList: [],
      benRecalledIn: true,
      listedOut: [{ audience: { team: sales }, memory: null }],
      saysNothing: false,
      others: ["nothing", "nothing"],
      taken: "done",
      listedAfter: [],
      benRecalledAfter: false,
    });
  });

  it("answers a replay of a share taken back since as taken back, never as shared", async () => {
    const anna = await signedInApi(idp, "user");
    const name = nameOf("Tyrell");
    const { shown } = await ownMemory(
      anna.api,
      anna.userId,
      renewal(name, "Tyrell renews")
    );
    const share = shareOf(shown, name, "company");
    const shared = await anna.api.brainMemories.publish(share);
    await anna.api.brainMemories.unpublish(shared?.memory ?? "");
    await expect(anna.api.brainMemories.publish(share)).rejects.toThrow(
      brainMemoryErrors.create("brain.share_taken_back").message
    );
  });

  it("refuses a team the person isn't in, alike whether it exists", async () => {
    const anna = await signedInApi(idp, "user");
    const theirs = await teamOf();
    const name = nameOf("Hooli");
    const { shown } = await ownMemory(
      anna.api,
      anna.userId,
      renewal(name, "Hooli renews")
    );
    const refused = brainMemoryErrors.create("brain.audience_not_yours");
    await expect(
      anna.api.brainMemories.publish(shareOf(shown, name, { team: theirs }))
    ).rejects.toThrow(refused.message);
    await expect(
      anna.api.brainMemories.publish(
        shareOf(shown, name, { team: crypto.randomUUID() })
      )
    ).rejects.toThrow(refused.message);
    // The log names no team she isn't in.
    const kept = await auditedOf(anna.userId, "brain.memory.published");
    expect(kept.map((detail) => detail?.team)).toStrictEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("takes a shared memory back: current for nobody, kept as history for its team, and only by the one who shared it", async () => {
    const [anna, ben, carl] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const sales = await teamOf(anna.userId, ben.userId);
    const name = nameOf("Umbrella");
    const { entity, shown } = await ownMemory(
      anna.api,
      anna.userId,
      renewal(name, "Umbrella renews")
    );
    const shared = await anna.api.brainMemories.publish(
      shareOf(shown, name, { team: sales })
    );
    if (shared === null) {
      throw new Error("Shared nothing");
    }
    const copy = { store: "shared" as const, id: shared.entity };
    const others = await Promise.all([
      ben.api.brainMemories.unpublish(shared.memory),
      carl.api.brainMemories.unpublish(shared.memory),
      anna.api.brainMemories.unpublish(crypto.randomUUID()),
      // Her own memory is never one she shared.
      anna.api.brainMemories.unpublish(shown.id),
    ]);
    const taken = await anna.api.brainMemories.unpublish(shared.memory);
    const again = await anna.api.brainMemories.unpublish(shared.memory);
    const unpublished = await auditedOf(
      anna.userId,
      "brain.memory.unpublished"
    );
    expect({
      others,
      taken,
      again,
      bens: await endedOf(ben.api, copy),
      annasOwn: await endedOf(anna.api, entity),
      unpublished: unpublished
        .filter((detail) => detail?.memory === shared.memory)
        .map((detail) => [detail?.outcome, detail?.result]),
    }).toStrictEqual({
      others: ["nothing", "nothing", "nothing", "nothing"],
      taken: "done",
      again: "done",
      bens: [{ id: shared.memory, ended: true }],
      annasOwn: [{ id: shown.id, ended: false }],
      // Her take-back and its retry: each an attempt, and one outcome.
      unpublished: [
        ["attempted", undefined],
        ["attempted", undefined],
        ["done", "done"],
      ],
    });
  });

  it("takes back the older copies a newer share of the same fact ended, so taking back the newer brings none back", async () => {
    const [anna, dora] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("Soylent");
    const renewing = await ownMemory(
      anna.api,
      anna.userId,
      renewal(name, "Soylent renews")
    );
    // The same memory shared twice (two tabs), then a changed one.
    const first = await anna.api.brainMemories.publish(
      shareOf(renewing.shown, name, "company")
    );
    const twice = await anna.api.brainMemories.publish(
      shareOf(renewing.shown, name, "company")
    );
    const churned = await ownMemory(anna.api, anna.userId, {
      ...renewal(name, "Soylent churned"),
      value: "Churned",
      statement: `${name} churned`,
    });
    const newest = await anna.api.brainMemories.publish(
      shareOf(churned.shown, name, "company")
    );
    const listed = await anna.api.brainMemories.shared();
    const ids = new Set([first?.memory, twice?.memory, newest?.memory]);
    const taken = await anna.api.brainMemories.unpublish(newest?.memory ?? "");
    const after = await anna.api.brainMemories.shared();
    const found = await Promise.all(
      [`${name} renews`, `${name} churned`].map(async (question) => {
        const { memories } = await recallAs(env, dora.userId, {
          personal: false,
          question,
          budget: { tokens: 4000 },
        });
        return memories.filter(({ memory }) => ids.has(memory));
      })
    );
    expect({
      // Only the current copy is listed: the ones it ended are history.
      listed: listed.memories
        .filter(({ id }) => ids.has(id))
        .map(({ id }) => id),
      taken,
      found,
      listedAfter: after.memories.filter(({ id }) => ids.has(id)),
    }).toStrictEqual({
      listed: [newest?.memory],
      taken: "done",
      found: [[], []],
      listedAfter: [],
    });
  });

  it("answers both of two shares of one memory made at once as shared, and audits each as done", async () => {
    const anna = await signedInApi(idp, "user");
    const name = nameOf("Cyberdyne");
    const { shown } = await ownMemory(
      anna.api,
      anna.userId,
      renewal(name, "Cyberdyne renews")
    );
    const shares = [
      shareOf(shown, name, "company"),
      shareOf(shown, name, "company"),
    ];
    const answers = await Promise.all(
      shares.map(async (share) => await anna.api.brainMemories.publish(share))
    );
    const events = await auditedOf(anna.userId, "brain.memory.published");
    const outcomes = events
      .filter(({ outcome }) => outcome !== "attempted")
      .map(({ outcome, result }) => [outcome, result]);
    expect({
      shared: answers.map((answer) => answer !== null),
      outcomes,
    }).toStrictEqual({
      shared: [true, true],
      outcomes: [
        ["done", "done"],
        ["done", "done"],
      ],
    });
  });

  it("shares with no team of two, where the other would know who shared it, and offers only larger teams", async () => {
    const [anna, ben] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const pair = await exactTeamOf(anna.userId, ben.userId);
    const larger = await teamOf(anna.userId, ben.userId);
    const name = nameOf("Gringotts");
    const { shown } = await ownMemory(
      anna.api,
      anna.userId,
      renewal(name, "Gringotts renews")
    );
    const offered = await anna.api.brainMemories.shareTeams();
    await expect(
      anna.api.brainMemories.publish(shareOf(shown, name, { team: pair }))
    ).rejects.toThrow(
      brainMemoryErrors.create("brain.audience_not_yours").message
    );
    expect({
      offered: offered
        .map(({ id }) => id)
        .filter((id) => id === pair || id === larger),
      larger:
        (await anna.api.brainMemories.publish(
          shareOf(shown, name, { team: larger })
        )) !== null,
    }).toStrictEqual({ offered: [larger], larger: true });
  });

  it("shares a correction named by a team's entity only with an audience that may read that entity", async () => {
    const [anna, ben] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const sales = await teamOf(anna.userId, ben.userId);
    const name = nameOf("Initrode Secret");
    // A team-only memory about a customer only the team's memories name.
    const added = await brainOf(
      inJurisdiction(env, env.BRAIN_STORE)
    ).addMemories({
      change: crypto.randomUUID(),
      access: { kind: "audience", group: `team:${sales}` },
      entities: [{ key: "c", kind: "customer", names: [name] }],
      memories: [
        {
          about: "c",
          attribute: "status",
          value: "Renewing",
          type: "fact",
          statement: `${name} is renewing`,
          speaker: { kind: "system" },
          basis: { kind: "writer", writer: `crm-${crypto.randomUUID()}` },
        },
      ],
    });
    // Her correction: her own entity stands for the team's, named by it.
    const corrected = await anna.api.brainMemories.correct({
      wrong: {
        store: "shared",
        entity: added.entities.c ?? "",
        memory: added.memories[0] ?? "",
      },
      right: "Churned",
      change: crypto.randomUUID(),
    });
    const [shown] = await memoriesAbout(anna.api, {
      store: "own",
      id: corrected?.entity ?? "",
    });
    if (shown === undefined) {
      throw new Error("The page shows no correction");
    }
    const everyone = await anna.api.brainMemories.publish(
      shareOf(shown, name, "company")
    );
    const team = await anna.api.brainMemories.publish(
      shareOf(shown, name, { team: sales })
    );
    expect({ everyone, team: team !== null }).toStrictEqual({
      everyone: null,
      team: true,
    });
  });
});
