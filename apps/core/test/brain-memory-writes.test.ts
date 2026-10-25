import { brainErrors } from "@grasp-os/brain/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { keepAudience } from "../src/knowledge/access.ts";
import { forContext } from "../src/knowledge/memory.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { signedInApi, unique } from "./sign-in.ts";

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
