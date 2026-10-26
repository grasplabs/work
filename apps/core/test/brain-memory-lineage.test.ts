import { createBrain } from "@grasp-os/brain/brain";
import { brainErrors } from "@grasp-os/brain/contract";
import type { MemoryLineage } from "@grasp-os/brain/contract";
import { memoriesList } from "@grasp-os/brain/memories";
import { brainMemories } from "@grasp-os/brain/schema";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import type { Reader } from "../src/knowledge/access.ts";
import { portsOf } from "../src/knowledge/ports.ts";
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

/** The most statements and host checks any one of `calls` made. */
const most = (calls: readonly { statements: number; checks: number }[]) => ({
  statements: Math.max(...calls.map(({ statements }) => statements)),
  checks: Math.max(...calls.map(({ checks }) => checks)),
});

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

    expect({
      one: idsOf(one),
      cursorNamesHidden: keptFrom.some(
        (id) => one.cursor?.includes(id) === true
      ),
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

  it("pages the shared listing as if records resting on what the reader can't read weren't there: full pages, and a cursor only when more follow", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const both = await newTeam(admin, [ada, ben]);
    const adaOnly = await newTeam(admin, [ada]);
    // Shared with the team while the records are published, so citing it
    // is allowed; then shared with Ada's team alone.
    const cited = await documentIn(admin, {
      name: `Team notes ${unique()}`,
      access: "teams",
      teams: [both],
    });
    // A word only these records hold, for recall.
    const mark = `m${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const publish = async (text: string, restsOnCited: boolean) =>
      idOf(
        await ada.api.knowledge.memoriesPublish(
          {
            scope: "team",
            scopeId: both,
            // A kind no other test's records have: the listing is of these.
            kind: "preference",
            text: `${text} ${mark}`,
            ...(restsOnCited ? { sourceRefs: [cited] } : {}),
          },
          { idempotencyKey: key() }
        )
      );
    // Three Ben may see, and one resting on the cited collection, all
    // through the Brain's own writes.
    const visible = [
      await publish("First.", false),
      await publish("Second.", false),
      await publish("Third.", false),
    ];
    const restsOnCited = await publish("Hidden.", true);
    await env.DB.prepare(
      "UPDATE collection_teams SET team_id = ? WHERE collection_id = ? AND team_id = ?"
    )
      .bind(adaOnly, cited.collectionId, both)
      .run();
    // More records like the hidden one than one call reads (three batches
    // of 100), between the first visible record and the others: each a
    // copy of it, what it rests on included, newest first in that order.
    const now = Date.now();
    const timed = (id: string, msAgo: number) =>
      env.KNOWLEDGE.prepare(
        "UPDATE brain_memories SET recorded_at = ? WHERE id = ?"
      ).bind(now - msAgo, id);
    const hidden = [
      restsOnCited,
      ...Array.from({ length: 320 }, () => crypto.randomUUID()),
    ];
    await env.KNOWLEDGE.batch([
      timed(visible[0] ?? "", 0),
      timed(restsOnCited, 10),
      timed(visible[1] ?? "", 1000),
      timed(visible[2] ?? "", 1001),
      ...hidden
        .slice(1)
        .flatMap((id, index) => [
          env.KNOWLEDGE.prepare(
            "INSERT INTO brain_memories SELECT ?, revision, scope, owner_id, kind, statement, source_refs, state, indexing_state, ?, updated_at, scope_id FROM brain_memories WHERE id = ?"
          ).bind(id, now - 11 - index, restsOnCited),
          env.KNOWLEDGE.prepare(
            "INSERT INTO brain_memory_cites SELECT ?, collection_id FROM brain_memory_cites WHERE memory_id = ?"
          ).bind(id, restsOnCited),
        ]),
    ]);
    /** Every page of Ben's shared listing at `limit`, as sizes and cursors. */
    const walk = async (limit: number) => {
      const pages: { size: number; more: boolean }[] = [];
      const shown: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        // oxlint-disable-next-line no-await-in-loop -- each page from the last
        const listed = await ben.api.knowledge.memoriesList({
          among: "shared",
          kind: "preference",
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        });
        const mine = idsOf(listed).filter(
          (id) => visible.includes(id) || hidden.includes(id)
        );
        shown.push(...mine);
        pages.push({
          size: listed.records.length,
          more: listed.cursor !== null,
        });
        if (listed.cursor === null) {
          break;
        }
        ({ cursor } = listed);
      }
      return { pages, shown };
    };

    const byOne = await walk(1);
    const byTwo = await walk(2);
    // Recall ranks and limits within the same condition: the hidden ones
    // take no place in its memory pass.
    const pack = await ben.api.knowledge.recall({ query: mark });
    const recalled = pack.items.flatMap(({ sourceRefs }) =>
      sourceRefs.flatMap((ref) => (ref.kind === "memory" ? [ref.memoryId] : []))
    );

    expect({
      byOne: byOne.pages,
      byTwo: byTwo.pages,
      shown: byOne.shown.toSorted(),
      hiddenShown: [...byOne.shown, ...byTwo.shown].filter((id) =>
        hidden.includes(id)
      ),
      recalled: recalled.toSorted(),
    }).toStrictEqual({
      // Three visible records: as many full pages as they fill, the last
      // without a cursor, as though the 321 hidden ones weren't there.
      byOne: [
        { size: 1, more: true },
        { size: 1, more: true },
        { size: 1, more: false },
      ],
      byTwo: [
        { size: 2, more: true },
        { size: 1, more: false },
      ],
      shown: visible.toSorted(),
      hiddenShown: [],
      recalled: visible.toSorted(),
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

  it("does the same bounded work per shared page however many records are kept from the reader, going on from where it stopped", async () => {
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
    const visible = await seed("The one Ben may see.", {
      scope: "team",
      scopeId: both,
      ownerId: ada.userId,
      recordedAt: at(10_000),
    });
    const reader: Reader = {
      type: "person",
      person: {
        userId: ben.userId,
        email: "ben@example.com",
        name: "Ben",
        role: "user",
        teams: [],
        staff: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    // Walks Ben's shared list a record at a time to its end, counting the
    // statements each call sends to the Brain's database and the checks it
    // asks of the host.
    const walk = async () => {
      let statements = 0;
      let checks = 0;
      const real = env.KNOWLEDGE;
      const counted: D1Database = {
        prepare: (query) => {
          statements += 1;
          return real.prepare(query);
        },
        batch: async <T>(batched: D1PreparedStatement[]) =>
          await real.batch<T>(batched),
        exec: async (query) => await real.exec(query),
        // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
        dump: async () => await real.dump(),
        withSession: (constraint) => real.withSession(constraint),
      };
      const ports = portsOf(env);
      const brain = createBrain(counted, {
        ...ports,
        memories: {
          ...ports.memories,
          keep: async (...args) => {
            checks += 1;
            return await ports.memories.keep(...args);
          },
        },
      });
      const calls: { records: number; statements: number; checks: number }[] =
        [];
      const found: string[] = [];
      let cursor: string | null | undefined;
      do {
        statements = 0;
        checks = 0;
        // oxlint-disable-next-line no-await-in-loop -- page after page
        const page = await memoriesList(brain, reader, {
          among: "shared",
          limit: 1,
          ...(typeof cursor === "string" ? { cursor } : {}),
        });
        found.push(...page.records.map(({ id }) => id));
        calls.push({ records: page.records.length, statements, checks });
        ({ cursor } = page);
      } while (cursor !== null && calls.length < 20);
      return { calls, found: found.filter((id) => id === visible).length };
    };

    const fewHidden = await walk();
    const keptFrom = 300;
    for (let n = 0; n < keptFrom; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- seeded one by one
      await seed(`Hidden ${n}.`, {
        scope: "team",
        scopeId: both,
        ownerId: ada.userId,
        recordedAt: at(n),
        sourceRefs: [hidden],
      });
    }
    const manyHidden = await walk();

    expect({
      few: { found: fewHidden.found, calls: fewHidden.calls.length },
      many: {
        found: manyHidden.found,
        // Empty pages with a cursor until the scan gets past what he
        // can't see, then his record.
        pages: manyHidden.calls.map(({ records }) => records),
        most: most(manyHidden.calls),
      },
    }).toStrictEqual({
      few: { found: 1, calls: 1 },
      many: {
        found: 1,
        pages: [0, 1],
        // Three batches at most, whatever is kept from him.
        most: { statements: 3, checks: 3 },
      },
    });
  });
});
