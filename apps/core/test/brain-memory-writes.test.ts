import { brainErrors } from "@grasp-os/brain/contract";
import { turnMemoryLimits } from "@grasp-os/brain/memories";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { newTeam, seed } from "./knowledge.ts";
import type { CollectionInput } from "./knowledge.ts";
import { callAuth, signedInApi, unique } from "./sign-in.ts";

// The Brain's shared memory as a deployment still holds it until the
// cutover removes today's Brain (GRA-298; nothing publishes or corrects a
// record any more, GRA-1911, so records are planted through the package,
// `seed`). It starts from the ways what is held can fail: someone
// retiring a record that isn't theirs, a record reaching an audience that
// can't read what it rests on, and a correction losing what it corrected.

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
const documentIn = async (owner: Person, collection: CollectionInput) => {
  const { id: collectionId } = await seed(owner.api).createCollection(
    collection
  );
  const { id: documentId } = await seed(owner.api).saveDocument({
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

/** The statements `person` recalls for `words`, a line each. */
const memoryTextOf = async (person: Person, words: string) => {
  const pack = await person.api.knowledge.recall({ query: words });
  return pack.items.map(({ statement }) => statement).join("\n");
};

describe("shared memory over time", setUpTime, () => {
  it("lets only a record's publisher or an admin retire it", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const team = await newTeam(admin, [ada, ben]);
    const u = unique();
    const company = await seed(admin.api).memoriesPublish(
      { scope: "company", kind: "fact", text: `Company rule ${u}` },
      { idempotencyKey: key() }
    );
    const teamRecord = await seed(ada.api).memoriesPublish(
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
      companyByMember: await retire(ben, idOf(company)),
      teamByOtherMember: await retire(ben, idOf(teamRecord)),
      teamByPublisher: await retire(ada, idOf(teamRecord)),
      companyByAdmin: await retire(admin, idOf(company)),
    };
    const reads = await memoryTextOf(ben, u);

    expect({
      outcomes,
      reads: [`Company rule ${u}`, `Team rule ${u}`].filter((text) =>
        reads.includes(text)
      ),
    }).toStrictEqual({
      outcomes: {
        companyByMember: "brain.not_found",
        teamByOtherMember: "brain.not_found",
        teamByPublisher: "ok",
        companyByAdmin: "ok",
      },
      // Retired: kept, never used again.
      reads: [],
    });
  });

  it("drops a record once its audience includes someone who can't read what it rests on", async () => {
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
    await seed(ada.api).memoriesPublish(
      {
        scope: "team",
        scopeId: team,
        kind: "fact",
        text: `Rests on it ${u}`,
        sourceRefs: [cited],
      },
      { idempotencyKey: key() }
    );
    const beforeCas = await holds(memoryTextOf(cas, u), `Rests on it ${u}`);
    // Cas joins the team, but not the readers of what the record rests on.
    await callAuth("/organization/add-team-member", admin.session, {
      teamId: team,
      userId: cas.userId,
    });
    const afterCas = await holds(memoryTextOf(cas, u), `Rests on it ${u}`);
    const forAda = await holds(memoryTextOf(ada, u), `Rests on it ${u}`);

    expect({
      beforeCas,
      afterCas,
      forAda,
    }).toStrictEqual({
      beforeCas: false,
      // A member of the team, but not of what it rests on: not for her.
      afterCas: false,
      forAda: true,
    });
  });
});

describe("a record whose sources a reader loses", setUpTime, () => {
  // GRA-1123 (GRA-309's S3; the threat model is on the issue): a record
  // rests on what everyone reading it may read now, decided in the query
  // itself. One resting on a collection someone has lost is gone from
  // their next recall and chat, at once, and takes no place among those
  // they may still read, and their next pack is of a new access revision.
  it("leaves it out of the next recall at once, in the query", async () => {
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
    await seed(ada.api).memoriesPublish(
      { scope: "team", scopeId: team, kind: "fact", text: `Plain ${u}` },
      { idempotencyKey: key() }
    );
    // Newer than it, more of them than a chat's memory holds.
    for (let index = 0; index <= turnMemoryLimits.records; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one record after another, newest last
      await seed(ada.api).memoriesPublish(
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

    expect({
      before: before.resting > 0,
      after: after.resting,
      newRevision: after.revision !== before.revision,
    }).toStrictEqual({
      before: true,
      after: 0,
      newRevision: true,
    });
  });
});
