import {
  purgeMaxDocuments,
  purgeMaxTerms,
  purgeTermMaxLength,
} from "@grasp-os/shared/knowledge";
import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { forContext, saveUserMemory } from "../src/knowledge/memory.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import {
  apiWith,
  holding,
  lettersOf,
  newAgent,
  purged,
  rebuildFailingOnce,
  rememberAs,
  saveOver,
  setUpTime,
} from "./knowledge-purge.ts";
import type { Person } from "./knowledge-purge.ts";
import { storedVersionTexts as versionTexts } from "./knowledge.ts";
import { withLoweredLimit } from "./memory-limits.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  refusal,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Purging personal data from Knowledge. These tests start from the ways a
// purge can fail or be abused: the text survives somewhere (an earlier
// version, a section, a title, the search index's pages, a Brain memory, memory cached
// by version); the purge record in the audit log,
// which can't be purged, carries the text it removed; a purge reaches
// documents it wasn't aimed at; someone other than the client's admins
// purges, or purges without confirming, or confirms a purge other than the
// one prepared; and a purge leaves a document that can't be read.

const idp = mockIdp();

const personOf = async (role: Role) => await signedInApi(idp, role);

/** The memory record a remember's receipt names. */
const memoryIdOf = ({
  resourceRefs,
}: Awaited<ReturnType<typeof rememberAs>>): string => {
  const [ref] = resourceRefs;
  return ref?.kind === "memory" ? ref.memoryId : "";
};

/** `person`'s own memory statements, sorted. */
const statementsOf = async (person: Person): Promise<string[]> => {
  const { records } = await person.api.knowledge.memoriesList();
  return records.map(({ statement }) => statement).toSorted();
};

/** Whether a statement of the purge's batch writes or deletes records. */
const writesRecords = (query: string): boolean =>
  /^(?:update|delete from) "brain_memories"/iu.test(query);

describe("a personal purge", setUpTime, () => {
  it("removes the person's USER.md and every version, from everywhere", async () => {
    const admin = await personOf("admin");
    const leaver = await personOf("user");
    const stays = await personOf("user");
    const agent = newAgent();
    const secret = `vanderzwaluw${unique()}`;
    const work = await newChat(agent);
    const asLeaver = actingFor(agent, leaver.userId);
    const asStays = actingFor(agent, stays.userId);
    const own = { type: "own" } as const;
    await saveUserMemory(env, asLeaver, work, own, {
      text: `# About me\nI am ${secret}.`,
      ifVersion: 0,
    });
    await saveUserMemory(env, asLeaver, work, own, {
      text: `# About me\nI am ${secret}, on leave.`,
      ifVersion: 1,
      message: `Learned ${secret} is on leave`,
    });
    await saveUserMemory(env, asStays, work, own, {
      text: `# About me\nI work with ${secret}.`,
      ifVersion: 0,
    });
    const memory = await admin.api.memory.collections();
    await saveOver(admin, memory.memory ?? "", "MEMORY.md", "# Company");
    // What each asked the Brain to remember: the leaver's goes, with its
    // receipt; the one who stays keeps theirs.
    const remembered = await leaver.api.knowledge.remember(
      { kind: "fact", text: `I am ${secret}.` },
      { idempotencyKey: `purge-${unique()}-${unique()}` }
    );
    await stays.api.knowledge.remember(
      { kind: "fact", text: `I work with ${secret}.` },
      { idempotencyKey: `purge-${unique()}-${unique()}` }
    );
    // Cached, keyed by the USER.md's version.
    const before = await forContext(env, asLeaver, work, own);
    const { personal } = await leaver.api.memory.collections();
    const heldBefore = await holding(secret);

    let outcomeOf: Awaited<ReturnType<typeof purged>> | undefined;
    const input: PurgeInput = {
      type: "personal",
      userId: leaver.userId,
      reason: "offboarding",
    };
    const events = await auditedDuring(async () => {
      outcomeOf = await purged(admin, input);
    });

    const after = await forContext(env, asLeaver, work, own);
    const staysAfter = await forContext(env, asStays, work, own);
    const { plan, result } = outcomeOf ?? {};
    const leaversMemories = await leaver.api.knowledge.memoriesList();
    const staysMemories = await stays.api.knowledge.memoriesList();
    expect({
      plan: {
        ...plan,
        token: typeof plan?.token,
        expiresAt: typeof plan?.expiresAt,
      },
      result: { ...result, purgeId: typeof result?.purgeId },
      before: before.text.includes(secret),
      after: after.text.includes(secret),
      afterFiles: after.files.map(({ name }) => name),
      stays: staysAfter.text.includes(secret),
      leaversCollection: await outcome(
        leaver.api.knowledge.listDocuments(personal)
      ),
      leaversMemories: leaversMemories.records,
      leaversReceipt: await outcome(
        leaver.api.knowledge.receiptsGet({ receiptId: remembered.id })
      ),
      staysMemories: staysMemories.records.map(({ statement }) => statement),
    }).toStrictEqual({
      plan: {
        documents: 1,
        versions: 2,
        occurrences: 0,
        inLongerWords: 0,
        memories: 1,
        hostCopies: 0,
        originals: 0,
        token: "string",
        expiresAt: "string",
      },
      result: {
        purgeId: "string",
        documents: 1,
        versions: 2,
      },
      before: true,
      after: false,
      afterFiles: ["MEMORY.md"],
      stays: true,
      leaversCollection: "knowledge.not_found",
      leaversMemories: [],
      leaversReceipt: "brain.not_found",
      staysMemories: [`I work with ${secret}.`],
    });
    // The one who stays still has the name in their own USER.md; the
    // leaver's text is gone from every table, the index's pages too.
    expect(heldBefore).toStrictEqual([
      "BRAIN_OBJECTS",
      "brain_memories.statement",
      "brain_memory_words.statement",
      "brain_memory_words_content.c0",
      "brain_memory_words_data.block",
      "search_trigrams.c3",
      "search_words.text",
      "search_words_content.c3",
      "search_words_data.block",
      "sections.text",
      "versions.message",
    ]);
    const { results: stored } = await env.KNOWLEDGE.prepare(
      "SELECT document_id AS documentId, payload_key AS key, coalesce(message, '') AS message FROM versions"
    ).all<{ documentId: string; key: string; message: string }>();
    const left = await Promise.all(
      stored.map(async ({ documentId, key, message }) => {
        const object = await env.BRAIN_OBJECTS.get(key);
        const text = (await object?.text()) ?? "";
        return text.includes(secret) || message.includes(secret)
          ? [documentId]
          : [];
      })
    );
    expect(left.flat()).toStrictEqual(
      staysAfter.files
        .filter(({ name }) => name === "USER.md")
        .map(({ documentId }) => documentId)
    );
    expect({
      events: events.map(({ action, actor, target, detail }) => ({
        action,
        actor,
        target,
        detail,
      })),
      carriesText: JSON.stringify(events).includes(secret),
    }).toStrictEqual({
      events: [
        {
          action: "knowledge.purge.prepared",
          actor: { type: "person", userId: admin.userId },
          target: { type: "collection", id: personal },
          detail: {
            kind: "personal",
            reason: "offboarding",
            userId: leaver.userId,
            documents: 1,
            versions: 2,
            memories: 1,
            receipts: 1,
          },
        },
        {
          action: "knowledge.purged",
          actor: { type: "person", userId: admin.userId },
          target: { type: "collection", id: personal },
          detail: {
            purgeId: result?.purgeId,
            kind: "personal",
            reason: "offboarding",
            userId: leaver.userId,
            documents: 1,
            versions: 2,
            memories: 1,
            receipts: 1,
          },
        },
      ],
      carriesText: false,
    });
  });

  it("leaves nothing of a person whose text was only theirs, and can run again", async () => {
    const agent = newAgent();
    const admin = await personOf("admin");
    const leaver = await personOf("user");
    const secret = `oudejans${unique()}`;
    const work = await newChat(agent);
    await saveUserMemory(
      env,
      actingFor(agent, leaver.userId),
      work,
      { type: "own" },
      { text: `# ${secret}\nCall me ${secret}.`, ifVersion: 0 }
    );
    const input: PurgeInput = {
      type: "personal",
      userId: leaver.userId,
      reason: "erasure_request",
    };
    const first = await purged(admin, input);
    const again = await purged(admin, input);
    expect({
      first: first.result.documents,
      again: { ...again.result, purgeId: typeof again.result.purgeId },
      held: await holding(secret),
    }).toStrictEqual({
      first: 1,
      again: {
        purgeId: "string",
        documents: 0,
        versions: 0,
      },
      held: [],
    });
  });
});

describe("a purge of content's memory records", setUpTime, () => {
  it("redacts or deletes every record holding a term, whoever's, audited without the text", async () => {
    const admin = await personOf("admin");
    const leaver = await personOf("user");
    const colleague = await personOf("user");
    const name = `Visser${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\n${name} runs payroll.`
    );
    const key = `purge-${unique()}-${unique()}`;
    const redacted = await leaver.api.knowledge.remember(
      { kind: "fact", text: `I report to ${name}.` },
      { idempotencyKey: key }
    );
    const deleted = await rememberAs(colleague, `${name.toUpperCase()}!`);
    await rememberAs(colleague, "I work in payroll.");
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [name],
      reason: "erasure_request",
    };
    let outcomeOf: Awaited<ReturnType<typeof purged>> | undefined;
    const events = await auditedDuring(async () => {
      outcomeOf = await purged(admin, input);
    });
    // A retry of the remember answers its receipt: it never stores the
    // statement again.
    const retried = await leaver.api.knowledge.remember(
      { kind: "fact", text: `I report to ${name}.` },
      { idempotencyKey: key }
    );
    const leavers = await leaver.api.knowledge.memoriesList();
    const colleagues = await colleague.api.knowledge.memoriesList();
    const purgeId = outcomeOf?.result.purgeId;
    expect({
      planned: outcomeOf?.plan.memories,
      stillFound: outcomeOf?.result.stillFound,
      leavers: leavers.records.map(({ statement, revision }) => ({
        statement,
        revision,
      })),
      colleagues: colleagues.records.map(({ statement }) => statement),
      deleted: await outcome(
        colleague.api.knowledge.memoriesGet({ memoryId: memoryIdOf(deleted) })
      ),
      receipts: [
        await outcome(
          leaver.api.knowledge.receiptsGet({ receiptId: redacted.id })
        ),
        await outcome(
          colleague.api.knowledge.receiptsGet({ receiptId: deleted.id })
        ),
      ],
      retried: retried.id === redacted.id,
      held: await holding(name),
      memoryEvents: events
        .filter(({ action }) => action === "knowledge.memory.purged")
        .map(({ actor, target, detail }) => ({ actor, target, detail }))
        .toSorted((one, other) =>
          (one.target?.id ?? "").localeCompare(other.target?.id ?? "")
        ),
      prepared: events.find(
        ({ action }) => action === "knowledge.purge.prepared"
      )?.detail.memories,
      carriesText: JSON.stringify(events)
        .toLowerCase()
        .includes(name.toLowerCase()),
    }).toStrictEqual({
      planned: 2,
      stillFound: 0,
      leavers: [{ statement: "I report to (removed).", revision: 2 }],
      colleagues: ["I work in payroll."],
      deleted: "brain.not_found",
      receipts: ["ok", "ok"],
      retried: true,
      held: [],
      memoryEvents: [
        {
          actor: { type: "person", userId: admin.userId },
          target: { type: "memory", id: memoryIdOf(redacted) },
          detail: { purgeId, change: "redacted", revision: 1 },
        },
        {
          actor: { type: "person", userId: admin.userId },
          target: { type: "memory", id: memoryIdOf(deleted) },
          detail: { purgeId, change: "deleted", revision: 1 },
        },
      ].toSorted((one, other) => one.target.id.localeCompare(other.target.id)),
      prepared: 2,
      carriesText: false,
    });
  });

  it("changes neither records nor documents when its batch of records fails, and finishes when run again", async () => {
    const admin = await personOf("admin");
    const teammate = await personOf("user");
    const name = `Bakker${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\n${name} runs payroll.`
    );
    await rememberAs(teammate, `${name} approves leave.`);
    await rememberAs(teammate, `Ask ${name} first.`);
    let failNext = false;
    const failing = await apiWith(admin, {
      prepare: (query) => {
        failNext ||= writesRecords(query);
      },
      beforeBatch: () => {
        if (failNext) {
          failNext = false;
          throw new Error("D1 is unavailable");
        }
      },
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [name],
      reason: "erasure_request",
    };
    const plan = await failing.knowledge.preparePurge(input);
    const refused = await outcome(failing.knowledge.purge(input, plan.token));
    const afterFailure = {
      memories: await statementsOf(teammate),
      document: await versionTexts(document.id),
    };
    const again = await purged(admin, input);
    expect({
      refused: refused === "ok",
      afterFailure,
      again: again.result.stillFound,
      memories: await statementsOf(teammate),
      held: await holding(name),
    }).toStrictEqual({
      refused: false,
      afterFailure: {
        memories: [`${name} approves leave.`, `Ask ${name} first.`].toSorted(),
        document: [`# Team\n${name} runs payroll.`],
      },
      again: 0,
      memories: [
        "(removed) approves leave.",
        "Ask (removed) first.",
      ].toSorted(),
      held: [],
    });
  });

  it("reports a record remembered after it read them, which a run again erases", async () => {
    const admin = await personOf("admin");
    const teammate = await personOf("user");
    const name = `Smit${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\n${name} runs payroll.`
    );
    await rememberAs(teammate, `${name} approves leave.`);
    // Another remember lands between the purge's read of the records and
    // its batch rewriting them.
    let raceNext = false;
    let raced = false;
    const racing = await apiWith(admin, {
      prepare: (query) => {
        raceNext ||= !raced && writesRecords(query);
      },
      beforeBatch: async () => {
        if (raceNext) {
          raceNext = false;
          raced = true;
          await rememberAs(teammate, `Thank ${name}.`);
        }
      },
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [name],
      reason: "erasure_request",
    };
    const plan = await racing.knowledge.preparePurge(input);
    const first = await racing.knowledge.purge(input, plan.token);
    const afterRace = await statementsOf(teammate);
    const again = await purged(admin, input);
    expect({
      raced,
      stillFound: first.stillFound,
      afterRace,
      again: again.result.stillFound,
      memories: await statementsOf(teammate),
      held: await holding(name),
    }).toStrictEqual({
      raced: true,
      stillFound: 1,
      afterRace: ["(removed) approves leave.", `Thank ${name}.`].toSorted(),
      again: 0,
      memories: ["(removed) approves leave.", "Thank (removed)."].toSorted(),
      held: [],
    });
  });

  it("finds a term typed with a combining accent or in another case as the same word", async () => {
    const admin = await personOf("admin");
    const teammate = await personOf("user");
    const suffix = unique();
    const term = `Ren\u00E9${suffix}`;
    const decomposed = `Rene\u0301${suffix}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\n${term} runs payroll.`
    );
    await rememberAs(teammate, `I report to ${term}.`);
    await rememberAs(teammate, `Ask ${term.toUpperCase()} first.`);
    await rememberAs(teammate, `I met ${decomposed} today.`);
    // Typed decomposed as a term too: the same word.
    const { plan, result } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [decomposed],
      reason: "erasure_request",
    });
    expect({
      planned: plan.memories,
      stillFound: result.stillFound,
      memories: await statementsOf(teammate),
    }).toStrictEqual({
      planned: 3,
      stillFound: 0,
      memories: [
        "Ask (removed) first.",
        "I met (removed) today.",
        "I report to (removed).",
      ].toSorted(),
    });
  });

  it("counts the forms it leaves on purpose, as the index would find them, in its plan and its check", async () => {
    const admin = await personOf("admin");
    const teammate = await personOf("user");
    const suffix = unique();
    const term = `Ren\u00E9${suffix}`;
    const pair = `fiona${suffix} visser`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\n${term} and ${pair} run payroll.`
    );
    // Without its accent, joined by a hyphen, and with a ligature: not
    // the term as typed, so left, but the same tokens to the index.
    const left = [
      `Ask Rene${suffix} first.`,
      `Ask fiona${suffix}-visser first.`,
      `Ask \uFB01ona${suffix} visser first.`,
    ];
    for (const text of left) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await rememberAs(teammate, text);
    }
    await rememberAs(teammate, `Ask ${term} first.`);
    // Inside a longer word: another token, never counted.
    await rememberAs(teammate, `Ask Renes${suffix}x first.`);
    const { plan, result } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [term, pair],
      reason: "erasure_request",
    });
    expect({
      planned: plan.memories,
      stillFound: result.stillFound,
      memories: await statementsOf(teammate),
    }).toStrictEqual({
      planned: 4,
      stillFound: 3,
      memories: [
        ...left,
        "Ask (removed) first.",
        `Ask Renes${suffix}x first.`,
      ].toSorted(),
    });
  });

  it("leaves a record changed between its read and its batch, unrecorded, and reports it", async () => {
    const admin = await personOf("admin");
    const teammate = await personOf("user");
    const other = await personOf("user");
    const name = `Jansen${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\n${name} runs payroll.`
    );
    await rememberAs(teammate, `${name} approves leave.`);
    await rememberAs(other, `Ask ${name}.`);
    // The teammate's record gets a new revision once the purge has read
    // it: a concurrent change, which the purge must not overwrite.
    let changeNext = false;
    let changed = false;
    const racing = await apiWith(admin, {
      prepare: (query) => {
        changeNext ||= !changed && writesRecords(query);
      },
      beforeBatch: async () => {
        if (changeNext) {
          changeNext = false;
          changed = true;
          await env.KNOWLEDGE.prepare(
            "UPDATE brain_memories SET statement = statement || ' Again.', revision = revision + 1 WHERE owner_id = ?"
          )
            .bind(teammate.userId)
            .run();
        }
      },
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [name],
      reason: "erasure_request",
    };
    let stillFound: number | undefined;
    const events = await auditedDuring(async () => {
      const plan = await racing.knowledge.preparePurge(input);
      ({ stillFound } = await racing.knowledge.purge(input, plan.token));
    });
    expect({
      changed,
      stillFound,
      teammate: await statementsOf(teammate),
      other: await statementsOf(other),
      events: events.filter(
        ({ action }) => action === "knowledge.memory.purged"
      ).length,
    }).toStrictEqual({
      changed: true,
      stillFound: 1,
      teammate: [`${name} approves leave. Again.`],
      other: ["Ask (removed)."],
      events: 1,
    });
  });

  it("counts what it removes, where the index's tokens differ: a script without spaces, an emoji, a final sigma", async () => {
    const admin = await personOf("admin");
    const teammate = await personOf("user");
    const tag = unique();
    const cjk = `\u7530\u4E2D${tag}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      "# Team\nNothing."
    );
    await rememberAs(teammate, `${cjk}\u3055\u3093\u306B\u805E\u304F`);
    await rememberAs(teammate, `Ask Tom${tag}\u{1F642} now`);
    await rememberAs(
      teammate,
      `Ask X${tag}\u039F\u0394\u03A5\u03A3\u03A3\u0395\u03A5\u03A3 now`
    );
    const { plan, result } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [
        cjk,
        `Tom${tag}`,
        `x${tag}\u03BF\u03B4\u03C5\u03C3\u03C3\u03B5\u03C5\u03C2`,
      ],
      reason: "erasure_request",
    });
    expect({
      planned: plan.memories,
      stillFound: result.stillFound,
      memories: await statementsOf(teammate),
    }).toStrictEqual({
      planned: 3,
      stillFound: 0,
      memories: [
        "(removed)\u3055\u3093\u306B\u805E\u304F",
        "Ask (removed)\u{1F642} now",
        "Ask (removed) now",
      ].toSorted(),
    });
  });

  it("reports a record in a script without spaces remembered after it read them", async () => {
    const admin = await personOf("admin");
    const teammate = await personOf("user");
    const cjk = `\u7530\u4E2D${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      "# Team\nNothing."
    );
    await rememberAs(teammate, `${cjk}\u3055\u3093\u306B\u805E\u304F`);
    let raceNext = false;
    let raced = false;
    const racing = await apiWith(admin, {
      prepare: (query) => {
        raceNext ||= !raced && writesRecords(query);
      },
      beforeBatch: async () => {
        if (raceNext) {
          raceNext = false;
          raced = true;
          await rememberAs(teammate, `${cjk}\u3055\u3093\u306B\u611F\u8B1D`);
        }
      },
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [cjk],
      reason: "erasure_request",
    };
    const plan = await racing.knowledge.preparePurge(input);
    const first = await racing.knowledge.purge(input, plan.token);
    expect({
      raced,
      stillFound: first.stillFound,
      memories: await statementsOf(teammate),
    }).toStrictEqual({
      raced: true,
      stillFound: 1,
      memories: [
        "(removed)\u3055\u3093\u306B\u805E\u304F",
        `${cjk}\u3055\u3093\u306B\u611F\u8B1D`,
      ].toSorted(),
    });
  });
});

describe("a purge whose index cleanup fails", setUpTime, () => {
  it("says the data is gone and a run again cleans up, for content", async () => {
    const admin = await personOf("admin");
    const secret = `claes${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "people.md",
      `# People\nWrite to ${secret}.`
    );
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [secret],
      reason: "other",
    };
    const failing = await rebuildFailingOnce(admin);
    const { token } = await admin.api.knowledge.preparePurge(input);
    const first = await outcome(failing.knowledge.purge(input, token));
    const heldAfterFirst = await holding(secret);
    // Nothing left to change, but the index is cleaned up.
    const again = await purged(admin, input);
    const status = await admin.api.knowledge.purgeStatus(again.result.purgeId);
    expect({
      first,
      heldAfterFirst,
      // The same purge, gone on with (GRA-1122): what it removed in all.
      again: again.result.versions,
      status: status.state,
      heldAfterAgain: await holding(secret),
    }).toStrictEqual({
      first: "knowledge.purge_index_pending",
      heldAfterFirst: ["search_words_data.block"],
      again: 1,
      status: "complete",
      heldAfterAgain: [],
    });
  });

  it("says the data is gone and a run again cleans up, for a person", async () => {
    const agent = newAgent();
    const admin = await personOf("admin");
    const leaver = await personOf("user");
    const secret = `brouwer${unique()}`;
    await saveUserMemory(
      env,
      actingFor(agent, leaver.userId),
      await newChat(agent),
      { type: "own" },
      { text: `# About me\nCall me ${secret}.`, ifVersion: 0 }
    );
    const input: PurgeInput = {
      type: "personal",
      userId: leaver.userId,
      reason: "offboarding",
    };
    const failing = await rebuildFailingOnce(admin);
    const { token } = await admin.api.knowledge.preparePurge(input);
    const first = await outcome(failing.knowledge.purge(input, token));
    const heldAfterFirst = await holding(secret);
    // The collection is gone already, but the index is cleaned up.
    const again = await purged(admin, input);
    const status = await admin.api.knowledge.purgeStatus(again.result.purgeId);
    expect({
      first,
      heldAfterFirst,
      // The same purge, gone on with (GRA-1122): what it removed in all.
      again: again.result.documents,
      status: status.state,
      heldAfterAgain: await holding(secret),
    }).toStrictEqual({
      first: "knowledge.purge_index_pending",
      heldAfterFirst: ["search_words_data.block"],
      again: 1,
      status: "complete",
      heldAfterAgain: [],
    });
  });
});

describe("purging", setUpTime, () => {
  it("finds a term the index keeps after a word with the same first letters, whose bytes its pages split", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    // "renee…" right after "renee" in the index: kept as the five letters
    // they share, then the rest.
    const term = `renee${lettersOf(Math.floor(Math.random() * 26 ** 6), 6)}`;
    await saveOver(
      admin,
      handbook.id,
      "names.md",
      `# Names\nRene, Renee and ${term}.`
    );
    await expect(holding(term)).resolves.toContain("search_words_data.block");
  });

  it("is only for the client's admins, and never without the token prepared for it", async () => {
    const agent = newAgent();
    const admin = await personOf("admin");
    const otherAdmin = await personOf("admin");
    const builder = await personOf("builder");
    const user = await personOf("user");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staffRpc = await openRpc(staffSession);
    const staff = staffRpc.core.authenticate();
    await saveUserMemory(
      env,
      actingFor(agent, user.userId),
      await newChat(agent),
      { type: "own" },
      { text: "# About me", ifVersion: 0 }
    );
    const input: PurgeInput = {
      type: "personal",
      userId: user.userId,
      reason: "offboarding",
    };
    const { token } = await admin.api.knowledge.preparePurge(input);
    const otherInput: PurgeInput = { ...input, reason: "other" };
    const dot = token.indexOf(".");
    const tampered = `${Number(token.slice(0, dot)) + 1}${token.slice(dot)}`;
    const refusals = await Promise.all([
      outcome(builder.api.knowledge.preparePurge(input)),
      outcome(user.api.knowledge.purge(input, token)),
      outcome(staff.knowledge.preparePurge(input)),
      outcome(staff.knowledge.purge(input, token)),
      outcome(otherAdmin.api.knowledge.purge(input, token)),
      outcome(admin.api.knowledge.purge(otherInput, token)),
      outcome(admin.api.knowledge.purge(input, tampered)),
      outcome(admin.api.knowledge.purge(input, "not-a-token")),
      outcome(
        admin.api.knowledge.preparePurge(
          // SAFETY: invalid on purpose: free text as the reason, which a
          // client can send, as Cap'n Web checks no types, so core must.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          { ...input, reason: "Jan de Vries left" } as never
        )
      ),
      outcome(
        admin.api.knowledge.preparePurge({
          type: "content",
          documentIds: [crypto.randomUUID()],
          terms: ["x"],
          reason: "other",
        })
      ),
      outcome(
        admin.api.knowledge.preparePurge({
          type: "content",
          documentIds: Array.from({ length: purgeMaxDocuments + 1 }, () =>
            crypto.randomUUID()
          ),
          terms: ["Jan"],
          reason: "other",
        })
      ),
      outcome(
        admin.api.knowledge.preparePurge({
          type: "content",
          documentIds: [crypto.randomUUID()],
          terms: Array.from(
            { length: purgeMaxTerms + 1 },
            (_, index) => `Jan${index}`
          ),
          reason: "other",
        })
      ),
      outcome(
        admin.api.knowledge.preparePurge({
          type: "content",
          documentIds: [crypto.randomUUID()],
          terms: ["x".repeat(purgeTermMaxLength + 1)],
          reason: "other",
        })
      ),
      // Terms the marker holds: a purge would find them again in it.
      // Or that the marker and the text next to it would make again.
      ...[
        "removed",
        "MOVE",
        "(r",
        "d)",
        ") Jan",
        "Jan (",
        "ED) Jan",
        "Jan (rem",
      ].map(
        async (term) =>
          await outcome(
            admin.api.knowledge.preparePurge({
              type: "content",
              documentIds: [crypto.randomUUID()],
              terms: ["Jan", term],
              reason: "other",
            })
          )
      ),
    ]);
    // Past its ten minutes.
    vi.useFakeTimers({ toFake: ["Date"] });
    let expired: string;
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      expired = await outcome(admin.api.knowledge.purge(input, token));
    } finally {
      vi.useRealTimers();
    }
    expect({ refusals, expired }).toStrictEqual({
      refusals: [
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
        "knowledge.purge_expired",
        "knowledge.purge_expired",
        "knowledge.purge_expired",
        "knowledge.purge_expired",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
      ],
      expired: "knowledge.purge_expired",
    });
    // None of those changed anything: the token still purges it all.
    await expect(
      admin.api.knowledge.purge(input, token)
    ).resolves.toMatchObject({ documents: 1, versions: 1 });
  });

  it("refuses a purge that would leave a document that can't be read, and changes nothing", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const other = `holt${unique()}`;
    const kept = await saveOver(
      admin,
      handbook.id,
      "kept.md",
      `# Kept\n${other} stays until the purge is refused.`
    );
    const document = await saveOver(
      admin,
      handbook.id,
      "people.md",
      `---\ndescription: HR\n---\n# People\n${other} is here.`
    );
    const input: PurgeInput = {
      type: "content",
      documentIds: [kept.id, document.id],
      // Removing it breaks the frontmatter.
      terms: [other, "description:"],
      reason: "other",
    };
    expect({
      prepared: await outcome(admin.api.knowledge.preparePurge(input)),
      kept: await versionTexts(kept.id),
      document: await versionTexts(document.id),
    }).toStrictEqual({
      prepared: "knowledge.invalid",
      kept: [`# Kept\n${other} stays until the purge is refused.`],
      document: [`---\ndescription: HR\n---\n# People\n${other} is here.`],
    });
  });

  it("refuses to run a purge that a new version made impossible, before changing anything", async () => {
    const admin = await personOf("admin");
    const agent = actingFor(newAgent(), admin.userId);
    const work = await newChat(agent);
    const own = { type: "own" } as const;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const kept = await saveOver(
      admin,
      handbook.id,
      "kept.md",
      "# Kept\nJo stays until the purge is refused."
    );
    const first = await saveUserMemory(env, agent, work, own, {
      text: "# About me\nCall me Jo.",
      ifVersion: 0,
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [kept.id, first.id],
      terms: ["Jo"],
      reason: "erasure_request",
    };
    const { token } = await admin.api.knowledge.preparePurge(input);
    // Within USER.md's 2,000 tokens, but not once each "Jo" is "(removed)".
    const long = `# About me\n${"Jo ".repeat(1600)}`;
    await saveUserMemory(env, agent, work, own, { text: long, ifVersion: 1 });
    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await outcome(admin.api.knowledge.purge(input, token));
    });
    expect({
      refused,
      events: events.map(({ action }) => action),
      kept: await versionTexts(kept.id),
      user: await versionTexts(first.id),
    }).toStrictEqual({
      refused: "knowledge.invalid",
      events: [],
      kept: ["# Kept\nJo stays until the purge is refused."],
      user: ["# About me\nCall me Jo.", long],
    });
  });

  it("refuses to run a purge of a memory file now over its limit, even when only earlier versions hold a term", async () => {
    const admin = await personOf("admin");
    const agent = actingFor(newAgent(), admin.userId);
    const work = await newChat(agent);
    const own = { type: "own" } as const;
    const name = `Mulder${unique()}`;
    const first = await saveUserMemory(env, agent, work, own, {
      text: `# About me\nCall me ${name}.`,
      ifVersion: 0,
    });
    const current = `# About me\n${"Something else. ".repeat(20)}`;
    await saveUserMemory(env, agent, work, own, {
      text: current,
      ifVersion: 1,
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [first.id],
      terms: [name],
      reason: "erasure_request",
    };
    const { token } = await admin.api.knowledge.preparePurge(input);
    // The limit lowered since: the current USER.md, which holds no term,
    // is over it, and a purge would save it again.
    let refused = "";
    const events = await withLoweredLimit(
      "USER.md",
      10,
      async () =>
        await auditedDuring(async () => {
          refused = await outcome(admin.api.knowledge.purge(input, token));
        })
    );
    expect({
      refused,
      events: events.map(({ action }) => action),
      user: await versionTexts(first.id),
    }).toStrictEqual({
      refused: "knowledge.invalid",
      events: [],
      user: [`# About me\nCall me ${name}.`, current],
    });
  });

  it("refuses documents that don't exist, naming them, when prepared and when run", async () => {
    const agent = newAgent();
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const kept = await saveOver(
      admin,
      handbook.id,
      "kept.md",
      "# Kept\nRoos stays."
    );
    const missing = crypto.randomUUID();
    const prepared = await refusal(
      admin.api.knowledge.preparePurge({
        type: "content",
        documentIds: [kept.id, missing],
        terms: ["Roos"],
        reason: "other",
      })
    );
    // A document that goes after the purge was prepared: here, with its
    // owner's Personal collection (the admin's own: another person's is
    // theirs alone).
    const user = await saveUserMemory(
      env,
      actingFor(agent, admin.userId),
      await newChat(agent),
      { type: "own" },
      { text: "# About me\nCall me Roos.", ifVersion: 0 }
    );
    const input: PurgeInput = {
      type: "content",
      documentIds: [kept.id, user.id],
      terms: ["Roos"],
      reason: "other",
    };
    const { token } = await admin.api.knowledge.preparePurge(input);
    await purged(admin, {
      type: "personal",
      userId: admin.userId,
      reason: "offboarding",
    });
    let run: unknown;
    const events = await auditedDuring(async () => {
      run = await refusal(admin.api.knowledge.purge(input, token));
    });
    expect({
      prepared,
      run,
      events: events.map(({ action }) => action),
      kept: await versionTexts(kept.id),
    }).toMatchObject({
      prepared: {
        code: "knowledge.not_found",
        details: { documentIds: [missing] },
      },
      run: {
        code: "knowledge.not_found",
        details: { documentIds: [user.id] },
      },
      events: [],
      kept: ["# Kept\nRoos stays."],
    });
  });
});
