import { brainErrors } from "@grasp-os/brain/contract";
import type { MemoryLineage } from "@grasp-os/brain/contract";
import { brainMemories } from "@grasp-os/brain/schema";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { signedInApi, unique } from "./sign-in.ts";

// Inspecting a Brain memory record's lineage, and its correction (GRA-298,
// slice 4; the threat model is on the issue). It starts from the ways it
// can fail: someone inspecting a record outside their memory, a lineage
// showing what lies behind a record its reader can't see (a record or a
// document, or a count or trace of either), a crafted chain that loops,
// and a correction losing what it corrected.

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

/** A memory record, as the Brain stores one; its ID. */
const seed = async (
  statement: string,
  record: {
    scope: "person" | "session" | "team" | "company";
    scopeId: string | null;
    ownerId: string;
    id?: string;
    state?: "proposed" | "accepted" | "retired";
    sourceRefs?: unknown[];
    recordedAt?: Date;
  }
): Promise<string> => {
  const id = record.id ?? crypto.randomUUID();
  const now = record.recordedAt ?? new Date();
  await drizzle(env.KNOWLEDGE)
    .insert(brainMemories)
    .values({
      id,
      revision: 1,
      scope: record.scope,
      scopeId: record.scopeId,
      ownerId: record.ownerId,
      kind: "fact",
      statement,
      sourceRefs: JSON.stringify(record.sourceRefs ?? []),
      state: record.state ?? "accepted",
      indexingState: "pending",
      recordedAt: now,
      updatedAt: now,
    });
  return id;
};

/** A document holding a note, in a new collection of `owner`'s. */
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

/** What `lineage` shows of what its record rests on, by kind and ID. */
const nodesOf = (lineage: MemoryLineage) =>
  lineage.restsOn
    .map((node) =>
      node.kind === "memory"
        ? `memory:${node.record.id}`
        : `document:${node.documentId}`
    )
    .toSorted();

/** The time `minutesAgo` minutes ago. */
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

/** The IDs of a page's records, in its order. */
const idsOf = (page: { records: readonly { id: string }[] }): string[] =>
  page.records.map(({ id }) => id);

/** The receipt's record. */
const idOf = (receipt: {
  resourceRefs: readonly { kind: string; memoryId?: string }[];
}) => {
  const [ref] = receipt.resourceRefs;
  if (ref?.memoryId === undefined) {
    throw new Error("A command answers its record");
  }
  return ref.memoryId;
};

describe("a memory record's lineage", setUpTime, () => {
  it("shows a correction what it corrected and what that rested on, and the corrected record what superseded it", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const handbook = await documentIn(admin, {
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const first = idOf(
      await ada.api.knowledge.remember(
        {
          kind: "fact",
          text: `Quiet floor ${unique()}`,
          sourceRefs: [handbook],
        },
        { idempotencyKey: key() }
      )
    );
    const correction = idOf(
      await ada.api.knowledge.memoriesProposeChange(
        { memoryId: first, statement: "Floor 4 is the quiet one." },
        { idempotencyKey: key(), expectedRevision: 1 }
      )
    );
    const stale = await codeOf(
      ada.api.knowledge.memoriesProposeChange(
        { memoryId: first, statement: "Floor 5." },
        { idempotencyKey: key(), expectedRevision: 1 }
      )
    );

    const ofCorrection = await ada.api.knowledge.memoriesLineage({
      memoryId: correction,
    });
    const ofFirst = await ada.api.knowledge.memoriesLineage({
      memoryId: first,
    });
    const document = ofFirst.restsOn.find((node) => node.kind === "document");

    expect({
      correction: {
        state: ofCorrection.record.state,
        by: ofCorrection.record.by,
        restsOn: nodesOf(ofCorrection),
      },
      first: {
        state: ofFirst.record.state,
        supersededBy: ofFirst.supersededBy?.id,
        document: document?.kind === "document" && {
          title: document.title,
          path: document.path,
          currentVersion: document.currentVersion,
        },
      },
      stale,
    }).toStrictEqual({
      correction: {
        state: "accepted",
        by: null,
        restsOn: [
          `document:${handbook.documentId}`,
          `memory:${first}`,
        ].toSorted(),
      },
      first: {
        state: "retired",
        supersededBy: correction,
        document: { title: "Note", path: "note.md", currentVersion: 1 },
      },
      // Corrected already: never a second correction over the first.
      stale: "brain.revision_conflict",
    });
  });

  it("answers a record outside the reader's memory as not found, alike for one that doesn't exist", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const adaOnly = await newTeam(admin, [ada]);
    const personal = await seed("Ada's own.", {
      scope: "person",
      scopeId: ada.userId,
      ownerId: ada.userId,
    });
    const team = await seed("Ada's team's.", {
      scope: "team",
      scopeId: adaOnly,
      ownerId: ada.userId,
    });
    const retired = await seed("Retired company record.", {
      scope: "company",
      scopeId: null,
      ownerId: admin.userId,
      state: "retired",
    });
    const lineageOf = async (person: Person, memoryId: string) =>
      await codeOf(person.api.knowledge.memoriesLineage({ memoryId }));

    expect({
      personal: await lineageOf(ben, personal),
      team: await lineageOf(ben, team),
      retired: await lineageOf(ben, retired),
      missing: await lineageOf(ben, crypto.randomUUID()),
      own: await lineageOf(ada, personal),
      ownTeam: await lineageOf(ada, team),
      retiredByItsOwner: await lineageOf(admin, retired),
    }).toStrictEqual({
      personal: "brain.not_found",
      team: "brain.not_found",
      retired: "brain.not_found",
      missing: "brain.not_found",
      own: "ok",
      ownTeam: "ok",
      // Their history: a retired record of their own stays inspectable.
      retiredByItsOwner: "ok",
    });
  });

  it("leaves out, without a trace, a record or document the reader can't see, and what lies behind it", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const both = await newTeam(admin, [ada, ben]);
    const adaOnly = await newTeam(admin, [ada]);
    const everyone = await documentIn(admin, {
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const adasTeamDocument = await documentIn(admin, {
      name: `Ada's team ${unique()}`,
      access: "teams",
      teams: [adaOnly],
    });
    // Ada's own record, resting on nothing: Ben may not see it.
    const behind = await seed("Ada's own note.", {
      scope: "person",
      scopeId: ada.userId,
      ownerId: ada.userId,
      sourceRefs: [everyone],
    });
    const shared = await seed("Shared with the team.", {
      scope: "team",
      scopeId: both,
      ownerId: ada.userId,
      sourceRefs: [everyone, { kind: "memory", memoryId: behind, revision: 1 }],
    });
    // Her own, resting on a document only her team reads.
    const own = await seed("Ada's quiet floor.", {
      scope: "person",
      scopeId: ada.userId,
      ownerId: ada.userId,
      sourceRefs: [adasTeamDocument],
    });

    const asBen = await ben.api.knowledge.memoriesLineage({ memoryId: shared });
    const asAda = await ada.api.knowledge.memoriesLineage({ memoryId: shared });
    const ownAsAda = await ada.api.knowledge.memoriesLineage({ memoryId: own });

    expect({
      ben: { by: asBen.record.by !== null, restsOn: nodesOf(asBen) },
      ada: { by: asAda.record.by, restsOn: nodesOf(asAda) },
      own: nodesOf(ownAsAda),
      nothingOfItInBens: JSON.stringify(asBen).includes(behind),
    }).toStrictEqual({
      // Ada's own record isn't his to see: not shown, not counted, and
      // what it rests on is not followed.
      ben: { by: true, restsOn: [`document:${everyone.documentId}`] },
      ada: {
        by: null,
        restsOn: [
          `document:${everyone.documentId}`,
          `document:${everyone.documentId}`,
          `memory:${behind}`,
        ].toSorted(),
      },
      own: [`document:${adasTeamDocument.documentId}`],
      nothingOfItInBens: false,
    });
  });

  it("follows a chain that loops back once, to its end", async () => {
    const ada = await signedInApi(idp, "user");
    const first = crypto.randomUUID();
    const second = await seed("Rests on the first.", {
      scope: "person",
      scopeId: ada.userId,
      ownerId: ada.userId,
      sourceRefs: [{ kind: "memory", memoryId: first, revision: 1 }],
    });
    await seed("Rests on the second.", {
      id: first,
      scope: "person",
      scopeId: ada.userId,
      ownerId: ada.userId,
      sourceRefs: [{ kind: "memory", memoryId: second, revision: 1 }],
    });

    const lineage = await ada.api.knowledge.memoriesLineage({
      memoryId: second,
    });

    expect(nodesOf(lineage)).toStrictEqual([`memory:${first}`]);
  });

  it("lists the shared records of others a person's memory reads, and never pages one list with another's cursor", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const both = await newTeam(admin, [ada, ben]);
    const adaOnly = await newTeam(admin, [ada]);
    const u = unique();
    const personal = await seed(`Ada's own ${u}.`, {
      scope: "person",
      scopeId: ada.userId,
      ownerId: ada.userId,
    });
    const team = await seed(`Team ${u}.`, {
      scope: "team",
      scopeId: both,
      ownerId: ada.userId,
      sourceRefs: [{ kind: "memory", memoryId: personal, revision: 1 }],
    });
    const notHis = await seed(`Ada's team ${u}.`, {
      scope: "team",
      scopeId: adaOnly,
      ownerId: ada.userId,
    });
    await seed(`Ben's own ${u}.`, {
      scope: "person",
      scopeId: ben.userId,
      ownerId: ben.userId,
    });
    await seed(`Ben's other ${u}.`, {
      scope: "person",
      scopeId: ben.userId,
      ownerId: ben.userId,
    });

    const shared = await ben.api.knowledge.memoriesList({ among: "shared" });
    const ids = new Set<string>(shared.records.map(({ id }) => id));
    const teamRecord = shared.records.find(({ id }) => id === team);
    const mine = await ben.api.knowledge.memoriesList({ limit: 1 });
    const crossed = await codeOf(
      ben.api.knowledge.memoriesList({
        among: "shared",
        cursor: mine.cursor ?? "",
      })
    );

    expect({
      team: ids.has(team),
      personal: ids.has(personal),
      notHis: ids.has(notHis),
      ownAmongShared: shared.records.some(({ statement }) =>
        statement.startsWith("Ben's")
      ),
      // What it rests on is in its lineage, as far as he may see it.
      refs: teamRecord?.sourceRefs,
      crossed,
    }).toStrictEqual({
      team: true,
      personal: false,
      notHis: false,
      ownAmongShared: false,
      refs: [],
      crossed: "brain.invalid",
    });
  });

  it("pages the shared listing by what it shows: a cursor never points at, or tells of, a record kept from the reader", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const both = await newTeam(admin, [ada, ben]);
    const adaOnly = await newTeam(admin, [ada]);
    const hidden = await documentIn(admin, {
      name: `Ada's team ${unique()}`,
      access: "teams",
      teams: [adaOnly],
    });
    const teamRecord = async (
      statement: string,
      minutesAgo: number,
      restsOnHidden = false
    ) =>
      await seed(statement, {
        scope: "team",
        scopeId: both,
        ownerId: ada.userId,
        recordedAt: at(minutesAgo),
        ...(restsOnHidden ? { sourceRefs: [hidden] } : {}),
      });
    // Newest first: one Ben may see, two resting on what he can't read,
    // one he may see, and another he can't.
    const first = await teamRecord("First.", 1);
    const keptFrom = [
      await teamRecord("Hidden one.", 2, true),
      await teamRecord("Hidden two.", 3, true),
    ];
    const last = await teamRecord("Last.", 4);
    keptFrom.push(await teamRecord("Hidden three.", 5, true));
    const list = async (limit: number, cursor?: string) =>
      await ben.api.knowledge.memoriesList({
        among: "shared",
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });

    const one = await list(1);
    const next = await list(1, one.cursor ?? undefined);
    const two = await list(2);
    const decoded = atob(one.cursor ?? "");

    expect({
      one: idsOf(one),
      cursorNamesHidden: keptFrom.some((id) => decoded.includes(id)),
      next: idsOf(next),
      // Nothing kept follows: no cursor, so nothing says more exists.
      nextCursor: next.cursor,
      two: idsOf(two),
      twoCursor: two.cursor,
    }).toStrictEqual({
      one: [first],
      cursorNamesHidden: false,
      next: [last],
      nextCursor: null,
      two: [first, last],
      twoCursor: null,
    });
  });

  it("reads a wide lineage within its bounds", async () => {
    const ada = await signedInApi(idp, "user");
    const fanOut = 20;
    const leaves = await Promise.all(
      Array.from(
        { length: fanOut },
        async (_, n) =>
          await seed(`Leaf ${n}.`, {
            scope: "person",
            scopeId: ada.userId,
            ownerId: ada.userId,
            // Each cites twenty document versions nobody can read.
            sourceRefs: Array.from({ length: fanOut }, () => ({
              kind: "document",
              documentId: crypto.randomUUID(),
              collectionId: crypto.randomUUID(),
              version: 1,
            })),
          })
      )
    );
    const root = await seed("Rests on twenty records.", {
      scope: "person",
      scopeId: ada.userId,
      ownerId: ada.userId,
      sourceRefs: leaves.map((memoryId) => ({
        kind: "memory",
        memoryId,
        revision: 1,
      })),
    });

    const lineage = await ada.api.knowledge.memoriesLineage({
      memoryId: root,
    });

    expect(nodesOf(lineage)).toStrictEqual(
      leaves.map((id) => `memory:${id}`).toSorted()
    );
  });
});
