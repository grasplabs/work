import {
  purgeMaxDocuments,
  purgeMaxTerms,
  purgeTermMaxLength,
} from "@grasp-os/shared/knowledge";
import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-outbox.ts";
import { forContext, saveUserMemory } from "../src/knowledge/memory.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import {
  apiWith,
  holding,
  indexedSections,
  lettersOf,
  newAgent,
  payOwedRebuilds,
  purged,
  saveOver,
  setUpTime,
  watchingPurge,
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

/** A person whose Personal collection holds `files`, by path. */
const leaverWith = async (files: Record<string, string>) => {
  const leaver = await personOf("user");
  const { personal } = await leaver.api.memory.collections();
  for (const [path, text] of Object.entries(files)) {
    // oxlint-disable-next-line no-await-in-loop -- one document at a time
    await saveOver(leaver, personal, path, text);
  }
  return { leaver, personal };
};

/**
 * Purges `leaver`'s Personal collection as `admin`, saying what it wrote
 * and how often it rebuilt the whole index.
 */
const purgeCounted = async (
  admin: Person,
  leaver: Person,
  watch: Parameters<typeof watchingPurge>[1] = {}
) => {
  const counting = await watchingPurge(admin, watch);
  const input: PurgeInput = {
    type: "personal",
    userId: leaver.userId,
    reason: "offboarding",
  };
  const { token } = await counting.api.knowledge.preparePurge(input);
  await counting.api.knowledge.purge(input, token);
  return counting.written;
};

/**
 * A word of a new person's notes that heads a page of the words index, in
 * one segment with a document of the handbook: words in order, alternating
 * between the two, so a page holds both and isn't emptied when the
 * person's go, and its directory entry, made from its first word, stays.
 */
const personsWordHeadingAPage = async (admin: Person) => {
  const handbook = await admin.api.knowledge.createCollection({
    name: "Handbook",
    access: "everyone",
  });
  const stem = `zq${lettersOf(Math.floor(Math.random() * 26 ** 6), 6)}`;
  const words = Array.from(
    { length: 3000 },
    (_, at) => `${stem}${lettersOf(at, 3)}`
  );
  const { leaver, personal } = await leaverWith({
    "even.md": `# Words\n${words.filter((_, at) => at % 2 === 0).join(" ")}`,
  });
  await saveOver(
    admin,
    handbook.id,
    "odd.md",
    `# Words\n${words.filter((_, at) => at % 2 === 1).join(" ")}`
  );
  await env.KNOWLEDGE.prepare(
    "INSERT INTO search_words (search_words) VALUES ('optimize')"
  ).run();
  const { results } = await env.KNOWLEDGE.prepare(
    "SELECT CAST(term AS TEXT) AS term FROM search_words_idx WHERE CAST(term AS TEXT) LIKE ?"
  )
    .bind(`0${stem}%`)
    .all<{ term: string }>();
  const leading = words.find(
    (word, at) =>
      at % 2 === 0 && results.some(({ term }) => term === `0${word}`)
  );
  return { leaver, personal, leading };
};

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

/** Remembers `text` as `person`, under a key of its own. */
const rememberAs = async (person: Person, text: string) =>
  await person.api.knowledge.remember(
    { kind: "fact", text },
    { idempotencyKey: `purge-${unique()}-${unique()}` }
  );

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

/**
 * `person`'s API on a platform that refuses secure deletes, as a remote
 * one may (search-erasure.ts), on which the purge's index rebuild also
 * fails once. The index's secure deletes are turned off first: a
 * delete's terms then stay in the index's pages until it is rebuilt.
 */
const rebuildFailingOnce = async (person: Person) => {
  await env.KNOWLEDGE.batch([
    env.KNOWLEDGE.prepare(
      "INSERT INTO search_words (search_words, rank) VALUES ('secure-delete', 0)"
    ),
    env.KNOWLEDGE.prepare(
      "INSERT INTO search_trigrams (search_trigrams, rank) VALUES ('secure-delete', 0)"
    ),
  ]);
  let refuseNext = false;
  let failNext = false;
  let failed = false;
  return await apiWith(person, {
    prepare: (query) => {
      if (query.includes("'secure-delete'")) {
        refuseNext = true;
      } else if (!failed && query.includes("VALUES ('rebuild')")) {
        failNext = true;
      }
    },
    beforeBatch: () => {
      if (refuseNext) {
        refuseNext = false;
        failNext = false;
        throw new Error("not authorized");
      }
      if (failNext) {
        failNext = false;
        failed = true;
        throw new Error("D1 is unavailable");
      }
    },
  });
};

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

/** Each step of a purge's status, as `step: state` or `step: state: reason`. */
const stateOf = (status: {
  steps: readonly { step: string; state: string; reason: string | null }[];
}) =>
  Object.fromEntries(
    status.steps.map(({ step, state, reason }) => [
      step,
      reason === null ? state : `${state}: ${reason}`,
    ])
  );

describe("a purge's record", setUpTime, () => {
  // GRA-1122 (GRA-309's S1; the threat model is on the issue): each purge
  // is a durable erasure, one step per projection it reaches. The ways it
  // can fail, tried here: a step left half done with nothing saying so; a
  // run again repeating a finished step, or starting another purge; the
  // record holding what was erased; anyone but the client's admins
  // reading it.
  it("says which step is blocked and why, and when run again goes on as the same purge, erasing again what was written since", async () => {
    const admin = await personOf("admin");
    const secret = `vanbeek${unique()}`;
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
    let first = "";
    const firstEvents = await auditedDuring(async () => {
      first = await outcome(failing.knowledge.purge(input, token));
    });
    const begun = firstEvents.find(
      ({ action }) => action === "knowledge.purged"
    );
    const purgeId = String(begun?.detail?.purgeId);
    const blocked = await admin.api.knowledge.purgeStatus(purgeId);
    // Remembered after the first run erased the records: the run again
    // erases it too, though that step finished (the security review).
    await admin.api.knowledge.remember(
      { kind: "fact", text: `Mail ${secret} on Mondays.` },
      { idempotencyKey: `key-${unique()}` }
    );
    let again: Awaited<ReturnType<typeof purged>> | undefined;
    const againEvents = await auditedDuring(async () => {
      again = await purged(admin, input);
    });
    const done = await admin.api.knowledge.purgeStatus(purgeId);
    const ledger = await env.KNOWLEDGE.prepare(
      "SELECT * FROM brain_purges JOIN brain_purge_steps ON brain_purge_steps.purge_id = brain_purges.id WHERE brain_purges.id = ?"
    )
      .bind(purgeId)
      .all();
    expect({
      first,
      blocked: { state: blocked.state, steps: stateOf(blocked) },
      samePurge: again?.result.purgeId === purgeId,
      stillFound: again?.result.stillFound,
      memoryHolds: JSON.stringify(
        await admin.api.knowledge.memoriesList()
      ).includes(secret),
      // Begun once: run again, it is only prepared and resumed.
      againActions: againEvents
        .map(({ action }) => action)
        .filter((action) => action.startsWith("knowledge."))
        .toSorted(),
      done: { state: done.state, steps: stateOf(done) },
      ledgerHoldsTerm: JSON.stringify(ledger.results).includes(secret),
    }).toStrictEqual({
      first: "knowledge.purge_index_pending",
      blocked: {
        state: "blocked",
        steps: {
          statements: "complete",
          host_copies: "complete",
          host_documents: "complete",
          [`document:${document.id}`]: "complete",
          payloads: "complete",
          search: "blocked: knowledge.purge_index_pending",
        },
      },
      samePurge: true,
      stillFound: 0,
      memoryHolds: false,
      againActions: [
        "knowledge.memory.purged",
        "knowledge.purge.prepared",
        "knowledge.purge.resumed",
      ],
      done: {
        state: "complete",
        steps: {
          statements: "complete",
          host_copies: "complete",
          host_documents: "complete",
          [`document:${document.id}`]: "complete",
          payloads: "complete",
          search: "complete",
        },
      },
      ledgerHoldsTerm: false,
    });
  });

  it("begins a blocked purge fresh when an admin asks, keeping the one it replaces as it stood", async () => {
    const admin = await personOf("admin");
    const secret = `dekker${unique()}`;
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
    const firstPlan = await admin.api.knowledge.preparePurge(input);
    let blockedId = "";
    const events = await auditedDuring(async () => {
      await outcome(failing.knowledge.purge(input, firstPlan.token));
    });
    blockedId = String(
      events.find(({ action }) => action === "knowledge.purged")?.detail
        ?.purgeId
    );
    const { token } = await admin.api.knowledge.preparePurge(input);
    const fresh = await admin.api.knowledge.purge(input, token, {
      fresh: true,
    });
    const old = await admin.api.knowledge.purgeStatus(blockedId);
    const now = await admin.api.knowledge.purgeStatus(fresh.purgeId);
    expect({
      another: fresh.purgeId !== blockedId,
      old: { state: old.state, supersededBy: old.supersededBy },
      oldSearch: stateOf(old).search,
      now: now.state,
    }).toStrictEqual({
      another: true,
      old: { state: "superseded", supersededBy: fresh.purgeId },
      oldSearch: "blocked: knowledge.purge_index_pending",
      now: "complete",
    });
  });

  it("is read by the client's admins alone", async () => {
    const admin = await personOf("admin");
    const user = await personOf("user");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staffRpc = await openRpc(staffSession);
    const staff = staffRpc.core.authenticate();
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "people.md",
      `# People\nWrite to someone${unique()}.`
    );
    const { result } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["someone"],
      reason: "other",
    });
    const status = await admin.api.knowledge.purgeStatus(result.purgeId);
    expect({
      admin: status.state,
      user: await outcome(user.api.knowledge.purgeStatus(result.purgeId)),
      staff: await outcome(staff.knowledge.purgeStatus(result.purgeId)),
      unknown: await outcome(
        admin.api.knowledge.purgeStatus(crypto.randomUUID())
      ),
    }).toStrictEqual({
      admin: "complete",
      user: "role.forbidden",
      staff: "role.forbidden",
      unknown: "knowledge.not_found",
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
    const leaver = await personOf("user");
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
    // owner's Personal collection.
    const user = await saveUserMemory(
      env,
      actingFor(agent, leaver.userId),
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
      userId: leaver.userId,
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

describe("a personal purge's search index", setUpTime, () => {
  it("writes no more to it however large the corpus, though the person's words are everyone's", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const common = "the plan for the team meeting is a note on leave and pay";
    /** Purges a new person's notes, in everyone's words and their name. */
    const purgeOne = async () => {
      const name = `leaver${unique()}`;
      const { leaver } = await leaverWith({
        "notes.md": `# Notes\n${common} with ${name}.\n\n## More\n${common}, ${name}.`,
      });
      return await purgeCounted(admin, leaver);
    };
    // Secure deletes turned on first, as any purge does.
    await purgeOne();
    const small = await purgeOne();
    const before = await indexedSections();
    for (let at = 0; at < 150; at += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one document at a time
      await saveOver(
        admin,
        handbook.id,
        `other-${at}.md`,
        `# Other ${at}\n${common} ${unique()}.\n\n## Part\n${common} ${unique()}.\n\n## Last\n${common} ${unique()}.`
      );
    }
    // In one segment, as FTS5's own merges put them in time: pages headed
    // by everyone's words.
    await env.KNOWLEDGE.prepare(
      "INSERT INTO search_words (search_words) VALUES ('optimize')"
    ).run();
    await env.KNOWLEDGE.prepare(
      "INSERT INTO search_trigrams (search_trigrams) VALUES ('optimize')"
    ).run();
    const added = (await indexedSections()) - before;
    await payOwedRebuilds();
    // The saves' audit events delivered first: a drain of them while the
    // purge runs would count as its writes.
    await drainAuditOutboxes(env);
    const large = await purgeOne();
    // A rebuild writes at least a row for each section the index holds.
    expect({
      grewBy: large.rows - small.rows,
      bound: large.rows - small.rows < added / 4,
      rebuilds: large.rebuilds,
    }).toMatchObject({ bound: true, rebuilds: 0 });
  });

  it("drops a word of the person's from the page directory, where it was the first term of a page", async () => {
    const admin = await personOf("admin");
    const { leaver, leading } = await personsWordHeadingAPage(admin);
    const heldBefore = leading === undefined ? [] : await holding(leading);
    await purgeCounted(admin, leaver);
    expect({
      found: leading !== undefined,
      heldBefore: heldBefore.includes("search_words_idx.term"),
      heldAfter: await holding(leading ?? ""),
    }).toStrictEqual({ found: true, heldBefore: true, heldAfter: [] });
  });

  it("drops a word the person had only in an earlier version from the page directory", async () => {
    const admin = await personOf("admin");
    const { leaver, personal, leading } = await personsWordHeadingAPage(admin);
    // Saved over: the earlier version's sections go, with secure deletes
    // that leave the page's directory entry, made from the word.
    await saveOver(leaver, personal, "even.md", "# Words\nNothing left here.");
    const heldBefore = leading === undefined ? [] : await holding(leading);
    await purgeCounted(admin, leaver);
    expect({
      found: leading !== undefined,
      heldBefore: heldBefore.includes("search_words_idx.term"),
      heldAfter: await holding(leading ?? ""),
    }).toStrictEqual({ found: true, heldBefore: true, heldAfter: [] });
  });

  it("rebuilds for a word next to a character it can't fold, and when run again after that fails", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    for (let at = 0; at < 60; at += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one document at a time
      await saveOver(
        admin,
        handbook.id,
        `filler-${at}.md`,
        `# Filler ${at}\nText ${unique()}.`
      );
    }
    const name = `Visser${lettersOf(Math.floor(Math.random() * 26 ** 6), 6)}`;
    // A plain person, in words of their own (common words may head pages
    // earlier text left): checked, no rebuild.
    const plain = await leaverWith({ "notes.md": `# ${name}\n${name}.` });
    await payOwedRebuilds();
    const plainPurge = await purgeCounted(admin, plain.leaver);
    const { leaver } = await leaverWith({
      "notes.md": `# Notes\nAsk ${name}さん.`,
    });
    const input: PurgeInput = {
      type: "personal",
      userId: leaver.userId,
      reason: "offboarding",
    };
    // The first run's rebuild fails, once its deletes committed.
    let failed = false;
    let failNext = false;
    const failing = await apiWith(admin, {
      prepare: (query) => {
        if (!failed && query.includes("VALUES ('rebuild')")) {
          failNext = true;
        }
      },
      beforeBatch: () => {
        if (failNext) {
          failNext = false;
          failed = true;
          throw new Error("D1 is unavailable");
        }
      },
    });
    const { token } = await failing.knowledge.preparePurge(input);
    const first = await outcome(failing.knowledge.purge(input, token));
    const again = await purgeCounted(admin, leaver);
    expect({
      plainRebuilds: plainPurge.rebuilds,
      first,
      againRebuilds: again.rebuilds,
    }).toStrictEqual({
      plainRebuilds: 0,
      first: "knowledge.purge_index_pending",
      againRebuilds: 1,
    });
  });

  it("rebuilds when the collection changes while the purge reads it", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    for (let at = 0; at < 60; at += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one document at a time
      await saveOver(
        admin,
        handbook.id,
        `filler-${at}.md`,
        `# Filler ${at}\nText ${unique()}.`
      );
    }
    const name = `late${unique()}`;
    const { leaver, personal } = await leaverWith({
      "notes.md": "# Notes\nAsk me.",
    });
    await payOwedRebuilds();
    const { rebuilds } = await purgeCounted(admin, leaver, {
      beforeRead: async () => {
        await saveOver(leaver, personal, "notes.md", `# Notes\nAsk ${name}.`);
      },
    });
    expect({ rebuilds, held: await holding(name) }).toStrictEqual({
      rebuilds: 1,
      held: [],
    });
  });

  it("rebuilds when it can't read what the index holds, and never logs a word", async () => {
    const admin = await personOf("admin");
    const name = `refused${unique()}`;
    const { leaver } = await leaverWith({
      "notes.md": `# Notes\nAsk ${name}.`,
    });
    const logged: unknown[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      })
    );
    await payOwedRebuilds();
    let rebuilds = 0;
    try {
      ({ rebuilds } = await purgeCounted(admin, leaver, { refuseRead: true }));
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
    const lines = logged.map((args) => JSON.stringify(args));
    expect({
      checkFailed: lines.some((line) =>
        line.includes("knowledge.purge.index_check_failed")
      ),
      leaked: lines.filter((line) => line.includes(name)),
      rebuilds,
      held: await holding(name),
    }).toStrictEqual({
      checkFailed: true,
      leaked: [],
      rebuilds: 1,
      held: [],
    });
  });

  it("rebuilds past its caps, logging counts and never a word", async () => {
    const admin = await personOf("admin");
    /** Purges a person with `files`, saying what it logged and rebuilt. */
    const purgeLogged = async (files: Record<string, string>[]) => {
      const leaver = await personOf("user");
      const { personal } = await leaver.api.memory.collections();
      for (const version of files) {
        for (const [path, text] of Object.entries(version)) {
          // oxlint-disable-next-line no-await-in-loop -- one save at a time
          await saveOver(leaver, personal, path, text);
        }
      }
      const logged: unknown[] = [];
      const spies = (["log", "info", "warn", "error"] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          logged.push(args);
        })
      );
      await payOwedRebuilds();
      try {
        const { rebuilds } = await purgeCounted(admin, leaver);
        return { rebuilds, lines: logged.map((args) => JSON.stringify(args)) };
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
    };
    // More distinct words than keys it looks up.
    const stem = `capped${lettersOf(Math.floor(Math.random() * 26 ** 4), 4)}`;
    const many = await purgeLogged([
      {
        "many.md": `# Many\n${Array.from(
          { length: 21_000 },
          (_, at) => `${stem}${lettersOf(at, 4)}`
        ).join(" ")}`,
      },
    ]);
    // More text than it reads, in short words, over two versions.
    const short = await purgeLogged([
      { "short.md": `# Short\n${"1 ".repeat(300_000)}` },
      { "short.md": `# Short\n${"2 ".repeat(300_000)}` },
    ]);
    // As much text after a NUL, where SQLite's `length` of a text stops:
    // found too much before any of it is read.
    const afterNul = await purgeLogged([
      { "nul.md": `# Nul\n\u0000${"3 ".repeat(300_000)}` },
      { "nul.md": `# Nul\n\u0000${"4 ".repeat(300_000)}` },
    ]);
    // One token of a mebibyte with a digit: as many trigrams as characters.
    const long = await purgeLogged([
      { "long.md": `# Long\n${stem}1${"x".repeat(1_000_000)}` },
    ]);
    // One token of letters longer than it works out, of a key of its own.
    const longWord = await purgeLogged([
      { "word.md": `# Word\n${stem}${"x".repeat(300)}` },
    ]);
    const outcomeOf = ({ rebuilds, lines }: typeof many) => ({
      capped: lines.some((line) =>
        line.includes("knowledge.purge.collection_check_capped")
      ),
      leaked: lines.filter((line) => line.includes(stem)),
      rebuilds,
    });
    const capLines = afterNul.lines.filter((line) =>
      line.includes("knowledge.purge.collection_check_capped")
    );
    expect({
      afterNul: {
        ...outcomeOf(afterNul),
        beforeReading: capLines.every((line) => !line.includes('"keys"')),
      },
      many: outcomeOf(many),
      short: outcomeOf(short),
      long: outcomeOf(long),
      longWord: outcomeOf(longWord),
    }).toStrictEqual({
      afterNul: { capped: true, leaked: [], rebuilds: 1, beforeReading: true },
      many: { capped: true, leaked: [], rebuilds: 1 },
      short: { capped: true, leaked: [], rebuilds: 1 },
      long: { capped: true, leaked: [], rebuilds: 1 },
      longWord: { capped: true, leaked: [], rebuilds: 1 },
    });
  });
});
