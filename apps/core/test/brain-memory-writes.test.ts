import { brainErrors } from "@grasp-os/brain/contract";
import { memoriesPublish, turnMemoryLimits } from "@grasp-os/brain/memories";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { keepAudience } from "../src/knowledge/access.ts";
import { forContext } from "../src/knowledge/memory.ts";
import { brainOf } from "../src/knowledge/ports.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { callAuth, signedInApi, unique } from "./sign-in.ts";

// Writing the Brain's shared memory, and correcting a person's own
// (GRA-298, slice 2; the threat model is on the issue). It starts from the
// ways it can fail: someone writing into a scope that isn't theirs,
// private or sensitive material laundered into a wider scope through
// what a record cites, someone correcting another person's record or
// overwriting a newer revision, a correction losing what it corrected,
// and a retry writing twice.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

const key = () => `key-${unique()}`;

/** A refused call's code, or `ok`. */
const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
    return "ok";
  } catch (error) {
    return brainErrors.codeOf(error) ?? String(error);
  }
};

/** A document holding `text` in a new collection of `owner`'s. */
const documentIn = async (
  owner: Person,
  collection: Parameters<Person["api"]["knowledge"]["createCollection"]>[0]
) => {
  const { id: collectionId } =
    await owner.api.knowledge.createCollection(collection);
  const { id: documentId } = await owner.api.knowledge.saveDocument({
    collectionId,
    path: "note.md",
    text: "# Note\nFloor 3 is quiet.",
    ifVersion: 0,
  });
  return {
    kind: "document" as const,
    documentId,
    collectionId,
    version: 1,
  };
};

/** Whether `text`, once read, holds `marker`. */
const holds = async (text: Promise<string>, marker: string) => {
  const read = await text;
  return read.includes(marker);
};

/** The record a publication's receipt names. */
const idOf = (receipt: {
  resourceRefs: readonly { kind: string; memoryId?: string }[];
}) => {
  const [ref] = receipt.resourceRefs;
  if (ref?.memoryId === undefined) {
    throw new Error("A publication answers its record");
  }
  return ref.memoryId;
};

/** What `person`'s agent reads of memory in a chat of their own. */
const memoryTextOf = async (person: Person) => {
  const agent = { type: "agent" as const, agentId: `agent-${unique()}` };
  const found = await forContext(
    env,
    actingFor(agent, person.userId),
    await newChat(agent),
    { type: "own" }
  );
  return found.text;
};

describe("publishing to the Brain's shared memory", setUpTime, () => {
  it("lets an admin publish to the company, a member to their team and to a chat they're in, and nobody else", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const team = await newTeam(admin, [ada]);
    const agent = { type: "agent" as const, agentId: `agent-${unique()}` };
    const shared = await newChat(agent);
    await keepAudience(env, shared, ada.userId, {
      members: [ada.userId],
      outsiders: false,
    });
    const u = unique();
    const note = (text: string) => ({
      kind: "fact" as const,
      text: `${text} ${u}`,
    });

    const outcomes = {
      company: await codeOf(
        admin.api.knowledge.memoriesPublish(
          { scope: "company", ...note("Company") },
          { idempotencyKey: key() }
        )
      ),
      companyByMember: await codeOf(
        ada.api.knowledge.memoriesPublish(
          { scope: "company", ...note("Not hers") },
          { idempotencyKey: key() }
        )
      ),
      team: await codeOf(
        ada.api.knowledge.memoriesPublish(
          { scope: "team", scopeId: team, ...note("Team") },
          { idempotencyKey: key() }
        )
      ),
      teamByOutsider: await codeOf(
        ben.api.knowledge.memoriesPublish(
          { scope: "team", scopeId: team, ...note("Not his team") },
          { idempotencyKey: key() }
        )
      ),
      session: await codeOf(
        ada.api.knowledge.memoriesPublish(
          { scope: "session", scopeId: shared.chatId, ...note("Session") },
          { idempotencyKey: key() }
        )
      ),
      sessionByOutsider: await codeOf(
        ben.api.knowledge.memoriesPublish(
          { scope: "session", scopeId: shared.chatId, ...note("Not his chat") },
          { idempotencyKey: key() }
        )
      ),
    };
    const adaReads = await memoryTextOf(ada);
    const benReads = await memoryTextOf(ben);

    expect({
      outcomes,
      ada: [`Company ${u}`, `Team ${u}`].filter((text) =>
        adaReads.includes(text)
      ),
      ben: [`Company ${u}`, `Team ${u}`].filter((text) =>
        benReads.includes(text)
      ),
      nothingRefusedKept: [adaReads, benReads].some(
        (text) => text.includes(`Not hers ${u}`) || text.includes(`Not his`)
      ),
    }).toStrictEqual({
      outcomes: {
        company: "ok",
        companyByMember: "brain.denied",
        team: "ok",
        teamByOutsider: "brain.denied",
        session: "ok",
        sessionByOutsider: "brain.denied",
      },
      ada: [`Company ${u}`, `Team ${u}`],
      // Not in the team: its record never reaches him.
      ben: [`Company ${u}`],
      nothingRefusedKept: false,
    });
  });

  it("lists only the shared chats a person is in and could publish into, each by the others in it", async () => {
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const cy = await signedInApi(idp, "user");
    const agent = { type: "agent" as const, agentId: `agent-${unique()}` };
    const [withBen, withOutsiders, benAlone] = await Promise.all([
      newChat(agent),
      newChat(agent),
      newChat(agent),
    ]);
    await keepAudience(env, withBen, ada.userId, {
      members: [ada.userId, ben.userId],
      outsiders: false,
    });
    // Someone Grasp can't name is in it: nothing is published there.
    await keepAudience(env, withOutsiders, ada.userId, {
      members: [ada.userId, cy.userId],
      outsiders: true,
    });
    await keepAudience(env, benAlone, ben.userId, {
      members: [ben.userId],
      outsiders: false,
    });
    const [adaIs, benIs] = await Promise.all([
      ada.api.whoami(),
      ben.api.whoami(),
    ]);
    const names = { ada: adaIs.name, ben: benIs.name };
    const listed = async (person: Person) => {
      const chats = await person.api.knowledge.sharedChats();
      return chats
        .filter(({ chatId }) =>
          [withBen, withOutsiders, benAlone].some(
            (chat) => chat.chatId === chatId
          )
        )
        .map(({ chatId, others }) => ({ chatId, others }))
        .toSorted((a, b) => a.chatId.localeCompare(b.chatId));
    };

    const lists = {
      ada: await listed(ada),
      ben: await listed(ben),
      cy: await listed(cy),
    };
    // What a chat lists is one a record can be published into.
    const published = await codeOf(
      ada.api.knowledge.memoriesPublish(
        {
          scope: "session",
          scopeId: withBen.chatId,
          kind: "fact",
          text: `Listed ${unique()}`,
        },
        { idempotencyKey: key() }
      )
    );

    expect({ lists, published }).toStrictEqual({
      lists: {
        ada: [{ chatId: withBen.chatId, others: [names.ben] }],
        ben: [
          { chatId: withBen.chatId, others: [names.ada] },
          { chatId: benAlone.chatId, others: [] },
        ].toSorted((a, b) => a.chatId.localeCompare(b.chatId)),
        cy: [],
      },
      published: "ok",
    });
  });

  it("refuses a record resting on what its scope's whole audience can't read", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const team = await newTeam(admin, [ada, ben]);
    const adaOnly = await newTeam(admin, [ada]);
    const everyone = await documentIn(admin, {
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const sensitive = await documentIn(admin, {
      name: `Salaries ${unique()}`,
      access: "teams",
      teams: [team],
      sensitive: true,
    });
    // Ada reads it; Ben, in the same team as her, doesn't.
    const narrower = await documentIn(admin, {
      name: `Ada's team ${unique()}`,
      access: "teams",
      teams: [adaOnly],
    });
    const publish = async (
      by: Person,
      target: { scope: "company" } | { scope: "team"; scopeId: string },
      ref: typeof everyone
    ) =>
      await codeOf(
        by.api.knowledge.memoriesPublish(
          {
            ...target,
            kind: "fact",
            text: `Rests on it ${unique()}`,
            sourceRefs: [ref],
          },
          { idempotencyKey: key() }
        )
      );

    expect({
      companyOnEveryone: await publish(admin, { scope: "company" }, everyone),
      companyOnSensitive: await publish(admin, { scope: "company" }, sensitive),
      teamOnSensitiveTheyAllRead: await publish(
        ada,
        { scope: "team", scopeId: team },
        sensitive
      ),
      teamOnNarrower: await publish(
        ada,
        { scope: "team", scopeId: team },
        narrower
      ),
    }).toStrictEqual({
      companyOnEveryone: "ok",
      companyOnSensitive: "brain.not_found",
      teamOnSensitiveTheyAllRead: "ok",
      teamOnNarrower: "brain.not_found",
    });
  });

  it("publishes once per key: a retry answers the same receipt", async () => {
    const admin = await signedInApi(idp, "admin");
    const idempotencyKey = key();
    const input = {
      scope: "company" as const,
      kind: "fact" as const,
      text: `Once ${unique()}`,
    };

    const first = await admin.api.knowledge.memoriesPublish(input, {
      idempotencyKey,
    });
    const retried = await admin.api.knowledge.memoriesPublish(input, {
      idempotencyKey,
    });
    const other = await codeOf(
      admin.api.knowledge.memoriesPublish(
        { ...input, text: "Something else" },
        { idempotencyKey }
      )
    );

    expect({ same: retried.id === first.id, other }).toStrictEqual({
      same: true,
      other: "brain.idempotency_conflict",
    });
  });
});

describe("correcting one's own memory", setUpTime, () => {
  it("supersedes the record with the correction, keeps it retired as its history, and refuses a stale revision or someone else's record", async () => {
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const u = unique();
    const remembered = await ada.api.knowledge.remember(
      { kind: "preference", text: `I like long answers ${u}` },
      { idempotencyKey: key() }
    );
    const [original] = remembered.resourceRefs;
    if (original?.kind !== "memory") {
      throw new Error("A remember answers its record");
    }
    const correction = {
      memoryId: original.memoryId,
      statement: `I like short answers ${u}`,
    };
    const idempotencyKey = key();

    const byBen = await codeOf(
      ben.api.knowledge.memoriesProposeChange(correction, {
        idempotencyKey: key(),
        expectedRevision: 1,
      })
    );
    const corrected = await ada.api.knowledge.memoriesProposeChange(
      correction,
      {
        idempotencyKey,
        expectedRevision: 1,
      }
    );
    // The reply is lost: the same call again.
    const retried = await ada.api.knowledge.memoriesProposeChange(correction, {
      idempotencyKey,
      expectedRevision: 1,
    });
    // Made against the revision the correction retired.
    const stale = await codeOf(
      ada.api.knowledge.memoriesProposeChange(
        { ...correction, statement: `Something else ${u}` },
        { idempotencyKey: key(), expectedRevision: 1 }
      )
    );
    const [next] = corrected.resourceRefs;
    if (next?.kind !== "memory") {
      throw new Error("A correction answers its record");
    }
    const old = await ada.api.knowledge.memoriesGet({
      memoryId: original.memoryId,
    });
    const now = await ada.api.knowledge.memoriesGet({
      memoryId: next.memoryId,
    });
    const reads = await memoryTextOf(ada);

    expect({
      byBen,
      retried: retried.id === corrected.id,
      stale,
      old: { state: old.state, statement: old.statement },
      now: {
        state: now.state,
        statement: now.statement,
        cites: now.sourceRefs,
      },
      reads: {
        corrected: reads.includes(`I like short answers ${u}`),
        retired: reads.includes(`I like long answers ${u}`),
      },
    }).toStrictEqual({
      byBen: "brain.not_found",
      retried: true,
      stale: "brain.revision_conflict",
      // Kept, with what it said: the history of the correction.
      old: { state: "retired", statement: `I like long answers ${u}` },
      now: {
        state: "accepted",
        statement: `I like short answers ${u}`,
        cites: [{ kind: "memory", memoryId: original.memoryId, revision: 1 }],
      },
      reads: { corrected: true, retired: false },
    });
  });
});

describe("shared memory over time", setUpTime, () => {
  it("keeps Grasp staff from publishing to the company, and lets only a record's publisher or an admin retire it", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const team = await newTeam(admin, [ada, ben]);
    const u = unique();
    const staff = {
      type: "person" as const,
      person: {
        userId: admin.userId,
        email: `${admin.userId}@grasp.test`,
        name: "Staff",
        role: "admin" as const,
        teams: [],
        staff: true,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    };
    const byStaff = await codeOf(
      memoriesPublish(
        brainOf(env),
        staff,
        { scope: "company", kind: "fact", text: `From staff ${u}` },
        { idempotencyKey: key() }
      )
    );
    const company = await admin.api.knowledge.memoriesPublish(
      { scope: "company", kind: "fact", text: `Company rule ${u}` },
      { idempotencyKey: key() }
    );
    const teamRecord = await ada.api.knowledge.memoriesPublish(
      { scope: "team", scopeId: team, kind: "fact", text: `Team rule ${u}` },
      { idempotencyKey: key() }
    );
    const retire = async (by: Person, memoryId: string) =>
      await codeOf(
        by.api.knowledge.memoriesRetire(
          { memoryId },
          { idempotencyKey: key(), expectedRevision: 1 }
        )
      );

    const outcomes = {
      byStaff,
      companyByMember: await retire(ben, idOf(company)),
      teamByOtherMember: await retire(ben, idOf(teamRecord)),
      teamByPublisher: await retire(ada, idOf(teamRecord)),
      companyByAdmin: await retire(admin, idOf(company)),
    };
    const reads = await memoryTextOf(ben);

    expect({
      outcomes,
      reads: [`Company rule ${u}`, `Team rule ${u}`].filter((text) =>
        reads.includes(text)
      ),
    }).toStrictEqual({
      outcomes: {
        byStaff: "brain.denied",
        companyByMember: "brain.not_found",
        teamByOtherMember: "brain.not_found",
        teamByPublisher: "ok",
        companyByAdmin: "ok",
      },
      // Retired: kept, never used again.
      reads: [],
    });
  });

  it("names who published a record that isn't the reader's", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const team = await newTeam(admin, [ada, ben]);
    const u = unique();
    await ada.api.knowledge.memoriesPublish(
      { scope: "team", scopeId: team, kind: "fact", text: `Team rule ${u}` },
      { idempotencyKey: key() }
    );

    const line = (text: string) =>
      text.split("\n").find((each) => each.includes(`Team rule ${u}`)) ?? "";
    const forBen = line(await memoryTextOf(ben));
    const forAda = line(await memoryTextOf(ada));

    expect({
      ben: forBen.includes(", by "),
      ada: forAda.includes(", by "),
    }).toStrictEqual({ ben: true, ada: false });
  });

  it("drops a record once its audience includes someone who can't read what it rests on, and a chat's records once outsiders join it", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const cas = await signedInApi(idp, "user");
    const team = await newTeam(admin, [ada, ben]);
    const readers = await newTeam(admin, [ada, ben]);
    const cited = await documentIn(admin, {
      name: `Readers ${unique()}`,
      access: "teams",
      teams: [readers],
    });
    const u = unique();
    await ada.api.knowledge.memoriesPublish(
      {
        scope: "team",
        scopeId: team,
        kind: "fact",
        text: `Rests on it ${u}`,
        sourceRefs: [cited],
      },
      { idempotencyKey: key() }
    );
    const agent = { type: "agent" as const, agentId: `agent-${unique()}` };
    const shared = await newChat(agent);
    await keepAudience(env, shared, ada.userId, {
      members: [ada.userId, ben.userId],
      outsiders: false,
    });
    await ada.api.knowledge.memoriesPublish(
      {
        scope: "session",
        scopeId: shared.chatId,
        kind: "fact",
        text: `This chat ${u}`,
      },
      { idempotencyKey: key() }
    );
    const sharedText = async () => {
      const found = await forContext(
        env,
        actingFor(agent, ada.userId),
        shared,
        {
          type: "own",
        }
      );
      return found.text;
    };
    const beforeSession = await holds(sharedText(), `This chat ${u}`);
    const beforeCas = await holds(memoryTextOf(cas), `Rests on it ${u}`);
    // Cas joins the team, but not the readers of what the record rests on.
    await callAuth("/organization/add-team-member", admin.session, {
      teamId: team,
      userId: cas.userId,
    });
    const afterCas = await holds(memoryTextOf(cas), `Rests on it ${u}`);
    const forAda = await holds(memoryTextOf(ada), `Rests on it ${u}`);
    await keepAudience(env, shared, ada.userId, {
      members: [ada.userId, ben.userId],
      outsiders: true,
    });
    const afterOutsiders = await holds(sharedText(), `This chat ${u}`);

    expect({
      beforeSession,
      beforeCas,
      afterCas,
      forAda,
      afterOutsiders,
    }).toStrictEqual({
      beforeSession: true,
      beforeCas: false,
      // A member of the team, but not of what it rests on: not for her.
      afterCas: false,
      forAda: true,
      afterOutsiders: false,
    });
  });
});

describe("a record whose sources a reader loses", setUpTime, () => {
  // GRA-1123 (GRA-309's S3; the threat model is on the issue): a record
  // rests on what everyone reading it may read now, decided in the query
  // itself. One resting on a collection someone has lost is gone from
  // their next recall and chat, at once, and takes no place among those
  // they may still read, and their next pack is of a new access revision.
  it("leaves it out of the next recall and chat context at once, in the query, so newer ones they can't read never crowd out an older one they can", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const team = await newTeam(admin, [ada, ben]);
    const readers = await newTeam(admin, [ada, ben]);
    const cited = await documentIn(admin, {
      name: `Readers ${unique()}`,
      access: "teams",
      teams: [readers],
    });
    const u = unique();
    await ada.api.knowledge.memoriesPublish(
      { scope: "team", scopeId: team, kind: "fact", text: `Plain ${u}` },
      { idempotencyKey: key() }
    );
    // Newer than it, more of them than a chat's memory holds.
    for (let index = 0; index <= turnMemoryLimits.records; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one record after another, newest last
      await ada.api.knowledge.memoriesPublish(
        {
          scope: "team",
          scopeId: team,
          kind: "fact",
          text: `Rests ${index} ${u}`,
          sourceRefs: [cited],
        },
        { idempotencyKey: key() }
      );
    }
    const recalled = async (person: Person) => {
      const pack = await person.api.knowledge.recall({ query: u });
      return {
        revision: pack.accessRevision,
        resting: pack.items.filter(
          ({ statement }) =>
            statement.startsWith("Rests ") && statement.endsWith(u)
        ).length,
      };
    };
    const before = await recalled(ben);
    // Ben leaves the readers of what the newer records rest on.
    await callAuth("/organization/remove-team-member", admin.session, {
      teamId: readers,
      userId: ben.userId,
    });
    const after = await recalled(ben);
    const context = await memoryTextOf(ben);
    const forAda = await memoryTextOf(ada);

    expect({
      before: before.resting > 0,
      after: after.resting,
      newRevision: after.revision !== before.revision,
      context: {
        plain: context.includes(`Plain ${u}`),
        resting: Array.from({ length: turnMemoryLimits.records + 1 }).some(
          (_each, index) => context.includes(`Rests ${index} ${u}`)
        ),
      },
      forAda: forAda.includes(`Rests ${turnMemoryLimits.records} ${u}`),
    }).toStrictEqual({
      before: true,
      after: 0,
      newRevision: true,
      context: { plain: true, resting: false },
      forAda: true,
    });
  });
});

describe("what a published record rests on", setUpTime, () => {
  it("reads through a correction to the documents the record it corrected cites", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const team = await newTeam(admin, [ada, ben]);
    // Only Ada reads it.
    const own = await documentIn(ada, {
      name: `Mine ${unique()}`,
      access: "me",
    });
    const remembered = await ada.api.knowledge.remember(
      { kind: "fact", text: `From my notes ${unique()}`, sourceRefs: [own] },
      { idempotencyKey: key() }
    );
    const corrected = await ada.api.knowledge.memoriesProposeChange(
      { memoryId: idOf(remembered), statement: `Corrected ${unique()}` },
      { idempotencyKey: key(), expectedRevision: 1 }
    );

    const published = await codeOf(
      ada.api.knowledge.memoriesPublish(
        {
          scope: "team",
          scopeId: team,
          kind: "fact",
          text: `For the team ${unique()}`,
          sourceRefs: [
            { kind: "memory", memoryId: idOf(corrected), revision: 1 },
          ],
        },
        { idempotencyKey: key() }
      )
    );

    // The correction cites only the record it corrected; that one cites
    // her own document, which Ben can't read.
    expect(published).toBe("brain.not_found");
  });
});
