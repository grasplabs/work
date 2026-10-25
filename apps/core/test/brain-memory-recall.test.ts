import type { MemoryPack, RecallInput } from "@grasp-os/brain/contract";
import { recallWithSources } from "@grasp-os/brain/recall";
import { brainMemories } from "@grasp-os/brain/schema";
import { appIdSchema, runIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { keepAudience } from "../src/knowledge/access.ts";
import type { Reader } from "../src/knowledge/access.ts";
import { brainOf } from "../src/knowledge/ports.ts";
import { isRestricted } from "../src/restricted.ts";
import type { WorkContext } from "../src/restricted.ts";
import { requestGranted } from "./apps.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { signedInApi, unique } from "./sign-in.ts";

// Recall over the Brain's memory records (GRA-298, slice 3; the threat
// model is on the issue): full text, ranked by BM25, scoped exactly as a
// chat's memory is. It starts from the ways it can fail: a record
// reaching a reader its scope doesn't serve, through a person's own
// recall, a chat's agent, an App, a run or a narrowed recall; a record
// resting on what its readers can't read now; a retired or corrected
// record still matching its old words; and a sensitive collection a
// record rests on not restricting the chat that recalled it.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 90_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** A word no other test's records hold. */
const rareWord = () => `zq${unique().replaceAll("-", "").slice(0, 12)}`;

/** A memory record, as the Brain stores one, saying `statement`. */
const seed = async (
  statement: string,
  record: {
    scope: "person" | "session" | "team" | "company";
    scopeId: string | null;
    ownerId: string;
    state?: "proposed" | "accepted" | "retired";
    sourceRefs?: unknown[];
    recordedAt?: Date;
  }
): Promise<string> => {
  const id = crypto.randomUUID();
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

/** The memory records `pack` hands over, by their statements' markers. */
const recalled = (pack: MemoryPack, markers: Record<string, string>) =>
  Object.entries(markers)
    .filter(([, marker]) =>
      pack.items.some(
        ({ statement, sourceRefs }) =>
          statement.includes(marker) &&
          sourceRefs.some(({ kind }) => kind === "memory")
      )
    )
    .map(([name]) => name)
    .toSorted();

/** How many of `pack`'s items are memory records. */
const memoryItems = (pack: MemoryPack) =>
  pack.items.filter(({ sourceRefs }) =>
    sourceRefs.some(({ kind }) => kind === "memory")
  ).length;

/** What each of `pack`'s items cites first: a document or a memory. */
const kinds = (pack: MemoryPack) =>
  pack.items.map(({ sourceRefs: [ref] }) => ref?.kind);

const newAgent = () => ({
  type: "agent" as const,
  agentId: `agent-${unique()}`,
});

/** An agent with the Brain granted, as an admin approved it. */
const agentWithBrain = async (admin: Person) => {
  const agent = newAgent();
  await requestGranted(idp, admin, {
    subject: agent,
    object: { type: "platform" },
    actions: ["brain"],
    binding: "BRAIN",
  });
  return agent;
};

/** A recall as the delegate `reader`, with what it read. */
const recallAs = async (reader: Reader, input: RecallInput) =>
  await recallWithSources(brainOf(env), reader, input);

/** Keeps `members` as who is in `work`'s chat, `outsiders` or not. */
const sharedWith = async (
  work: Extract<WorkContext, { type: "chat" }>,
  members: Person[],
  outsiders = false
): Promise<void> => {
  const [asker] = members;
  if (asker === undefined) {
    throw new Error("A chat has someone in it");
  }
  await keepAudience(env, work, asker.userId, {
    members: members.map(({ userId }) => userId),
    outsiders,
  });
};

describe("recalling the Brain's memory records", setUpTime, () => {
  it("finds a person their own records, their teams' and the company's by their words, never another person's, a proposed shared one or a retired one", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const both = await newTeam(admin, [ada, ben]);
    const benOnly = await newTeam(admin, [ben]);
    const word = rareWord();
    const markers = {
      ada: `ada-${word}`,
      adaProposed: `adaproposed-${word}`,
      ben: `ben-${word}`,
      both: `both-${word}`,
      bothProposed: `bothproposed-${word}`,
      benOnly: `benonly-${word}`,
      company: `company-${word}`,
      retired: `retired-${word}`,
    };
    const says = (marker: string) => `Remember ${word}: ${marker}.`;
    await seed(says(markers.ada), {
      scope: "person",
      scopeId: ada.userId,
      ownerId: ada.userId,
    });
    await seed(says(markers.adaProposed), {
      scope: "person",
      scopeId: ada.userId,
      ownerId: ada.userId,
      state: "proposed",
    });
    await seed(says(markers.ben), {
      scope: "person",
      scopeId: ben.userId,
      ownerId: ben.userId,
    });
    await seed(says(markers.both), {
      scope: "team",
      scopeId: both,
      ownerId: ben.userId,
    });
    await seed(says(markers.bothProposed), {
      scope: "team",
      scopeId: both,
      ownerId: ben.userId,
      state: "proposed",
    });
    await seed(says(markers.benOnly), {
      scope: "team",
      scopeId: benOnly,
      ownerId: ben.userId,
    });
    await seed(says(markers.company), {
      scope: "company",
      scopeId: null,
      ownerId: admin.userId,
    });
    await seed(says(markers.retired), {
      scope: "company",
      scopeId: null,
      ownerId: admin.userId,
      state: "retired",
    });

    // A prefix of the word finds them, as a section's words are found.
    const pack = await ada.api.knowledge.recall({ query: word.slice(0, 8) });
    const both_ = pack.items.find(({ statement }) =>
      statement.includes(markers.both)
    );

    expect({
      found: recalled(pack, markers),
      cited: both_?.sourceRefs.map(({ kind }) => kind),
      authority: both_?.authorityState,
      locator: both_?.citationLocator.length,
      sourceVersions: pack.sourceVersions.every((ref) => ref.kind === "memory"),
    }).toStrictEqual({
      found: ["ada", "adaProposed", "both", "company"],
      cited: ["memory"],
      authority: "accepted",
      // Its scope, and who published it: Ben, not Ada.
      locator: 2,
      sourceVersions: true,
    });
  });

  it("finds a chat's agent what the chat's memory reads: no person's records where others read the answer, no company's with outsiders there", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const both = await newTeam(admin, [ada, ben]);
    const adaOnly = await newTeam(admin, [ada]);
    const agent = await agentWithBrain(admin);
    const own = await newChat(agent);
    const shared = await newChat(agent);
    await sharedWith(shared, [ada, ben]);
    const withGuests = await newChat(agent);
    await sharedWith(withGuests, [ada, ben], true);
    const word = rareWord();
    const markers = {
      ada: `ada-${word}`,
      both: `both-${word}`,
      adaOnly: `adaonly-${word}`,
      company: `company-${word}`,
      session: `session-${word}`,
    };
    const says = (marker: string) => `Remember ${word}: ${marker}.`;
    await seed(says(markers.ada), {
      scope: "person",
      scopeId: ada.userId,
      ownerId: ada.userId,
    });
    await seed(says(markers.both), {
      scope: "team",
      scopeId: both,
      ownerId: ada.userId,
    });
    await seed(says(markers.adaOnly), {
      scope: "team",
      scopeId: adaOnly,
      ownerId: ada.userId,
    });
    await seed(says(markers.company), {
      scope: "company",
      scopeId: null,
      ownerId: admin.userId,
    });
    await seed(says(markers.session), {
      scope: "session",
      scopeId: shared.chatId,
      ownerId: ada.userId,
    });
    const authority = actingFor(agent, ada.userId);
    const inChat = async (context: WorkContext) => {
      const { pack } = await recallAs(
        { type: "delegate", authority, context },
        { query: word }
      );
      return recalled(pack, markers);
    };

    expect({
      own: await inChat(own),
      shared: await inChat(shared),
      withGuests: await inChat(withGuests),
    }).toStrictEqual({
      own: ["ada", "adaOnly", "both", "company"],
      // Ben reads the answer: only what both of them are served.
      shared: ["both", "company", "session"],
      withGuests: [],
    });
  });

  it("finds no record for an agent working in an App or a run, or for a recall narrowed to collections", async () => {
    const admin = await signedInApi(idp, "admin");
    const agent = await agentWithBrain(admin);
    const appId = appIdSchema.parse(crypto.randomUUID());
    const word = rareWord();
    await seed(`Remember ${word}: company.`, {
      scope: "company",
      scopeId: null,
      ownerId: admin.userId,
    });
    await seed(`Remember ${word}: own.`, {
      scope: "person",
      scopeId: admin.userId,
      ownerId: admin.userId,
    });
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const authority = actingFor(agent, admin.userId);
    const asAgentIn = async (context: WorkContext) => {
      const { pack } = await recallAs(
        { type: "delegate", authority, context },
        { query: word }
      );
      return memoryItems(pack);
    };

    expect({
      app: await asAgentIn({ type: "app", appId }),
      run: await asAgentIn({
        type: "run",
        appId,
        runId: runIdSchema.parse(crypto.randomUUID()),
      }),
      narrowed: memoryItems(
        await admin.api.knowledge.recall({
          query: word,
          filters: { collectionIds: [collectionId] },
        })
      ),
      whole: memoryItems(await admin.api.knowledge.recall({ query: word })),
    }).toStrictEqual({ app: 0, run: 0, narrowed: 0, whole: 2 });
  });

  it("drops a record resting on what someone reading the answer can't read now, and restricts the chat for a sensitive one it hands over", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const adaOnly = await newTeam(admin, [ada]);
    const agent = await agentWithBrain(admin);
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Salaries ${unique()}`,
      access: "teams",
      teams: [adaOnly],
      sensitive: true,
    });
    const { id: documentId } = await admin.api.knowledge.saveDocument({
      collectionId,
      path: "note.md",
      text: "# Note\nBands are reviewed in March.",
      ifVersion: 0,
    });
    const word = rareWord();
    const shared = await newChat(agent);
    await sharedWith(shared, [ada]);
    await seed(`Remember ${word}: bands.`, {
      scope: "session",
      scopeId: shared.chatId,
      ownerId: ada.userId,
      sourceRefs: [{ kind: "document", documentId, collectionId, version: 1 }],
    });
    const authority = actingFor(agent, ada.userId);
    const recallInChat = async () =>
      await recallAs(
        { type: "delegate", authority, context: shared },
        { query: word }
      );

    const alone = await recallInChat();
    const restricted = await isRestricted(env, authority, shared);
    // Ben joins the chat; he can't read what the record rests on.
    await sharedWith(shared, [ada, ben]);
    const joined = await recallInChat();

    expect({
      alone: alone.pack.items.length,
      sensitive: alone.provenance.sensitive,
      sources: alone.sources.includes(collectionId),
      restricted,
      joined: joined.pack.items.length,
    }).toStrictEqual({
      alone: 1,
      sensitive: true,
      sources: true,
      restricted: true,
      joined: 0,
    });
  });

  it("never matches a retired record or a corrected record's old words", async () => {
    const admin = await signedInApi(idp, "admin");
    const before = rareWord();
    const after = rareWord();
    const retiredWord = rareWord();
    const corrected = await seed(`Remember ${before}.`, {
      scope: "company",
      scopeId: null,
      ownerId: admin.userId,
    });
    const retired = await seed(`Remember ${retiredWord}.`, {
      scope: "company",
      scopeId: null,
      ownerId: admin.userId,
    });
    const findsWord = async (word: string) => {
      const pack = await admin.api.knowledge.recall({ query: word });
      return pack.items.length;
    };
    const found = {
      before: await findsWord(before),
      retired: await findsWord(retiredWord),
    };

    const db = drizzle(env.KNOWLEDGE);
    await db
      .update(brainMemories)
      .set({ statement: `Remember ${after}.`, revision: 2 })
      .where(eq(brainMemories.id, corrected));
    await admin.api.knowledge.memoriesRetire(
      { memoryId: retired },
      { idempotencyKey: `key-${unique()}`, expectedRevision: 1 }
    );
    await db.delete(brainMemories).where(eq(brainMemories.id, corrected));
    const afterDelete = await findsWord(after);

    expect({
      found,
      // Retired through the Brain; deleted as a purge deletes.
      retired: await findsWord(retiredWord),
      afterDelete,
    }).toStrictEqual({
      found: { before: 1, retired: 1 },
      retired: 0,
      afterDelete: 0,
    });
  });

  it("ranks a person's records by the words each holds, never by what others' private records hold", async () => {
    const ada = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const common = rareWord();
    const rare = rareWord();
    const older = new Date(Date.now() - 60_000);
    const both = await seed(`Remember ${common} and ${rare}.`, {
      scope: "person",
      scopeId: ada.userId,
      ownerId: ada.userId,
      recordedAt: new Date(Date.now() - 120_000),
    });
    const onlyCommon = await seed(`Remember ${common}.`, {
      scope: "person",
      scopeId: ada.userId,
      ownerId: ada.userId,
    });
    const onlyRare = await seed(`Remember ${rare}.`, {
      scope: "person",
      scopeId: ada.userId,
      ownerId: ada.userId,
      recordedAt: older,
    });
    const order = async () => {
      const pack = await ada.api.knowledge.recall({
        query: `${common} ${rare}`,
      });
      return pack.items.map(({ id }) => id);
    };

    const before = await order();
    // Ben's private records, many of them holding one of the words: under
    // BM25 that word would weigh less, and Ada's order would show it.
    for (let n = 0; n < 30; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- seeded one by one
      await seed(`Ben's note ${n}: ${rare}.`, {
        scope: "person",
        scopeId: ben.userId,
        ownerId: ben.userId,
      });
    }
    const after = await order();

    expect({ before, after }).toStrictEqual({
      // Both words first, then one word each, newest first.
      before: [both, onlyCommon, onlyRare],
      after: [both, onlyCommon, onlyRare],
    });
  });

  it("takes sections and records in turn within the budget, and says when it cut", async () => {
    const admin = await signedInApi(idp, "admin");
    const word = rareWord();
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    await admin.api.knowledge.saveDocument({
      collectionId,
      path: "a.md",
      text: `# A\n${word} in a section.`,
      ifVersion: 0,
    });
    for (const n of [1, 2]) {
      // oxlint-disable-next-line no-await-in-loop -- two records, in order
      await seed(`Remember ${word}: record ${n}.`, {
        scope: "company",
        scopeId: null,
        ownerId: admin.userId,
      });
    }

    const full = await admin.api.knowledge.recall({ query: word });
    const cut = await admin.api.knowledge.recall({
      query: word,
      budget: { maxItems: 2 },
    });

    expect({
      full: kinds(full),
      fullTruncated: full.truncated,
      cut: kinds(cut),
      cutTruncated: cut.truncated,
    }).toStrictEqual({
      full: ["document", "memory", "memory"],
      fullTruncated: false,
      cut: ["document", "memory"],
      cutTruncated: true,
    });
  });
});
