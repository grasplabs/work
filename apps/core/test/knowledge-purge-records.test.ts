import {
  attemptHolds,
  attemptHoldsOrIdle,
  finishPurge,
  openPurge,
  purgeAttemptLeaseMs,
  purgeStatus,
  heldNow,
  runStep,
  whileHeld,
} from "@grasp-os/brain/purge-ledger";
import { collections } from "@grasp-os/brain/schema";
import {
  owedWritesDoneWhile,
  rebuildOwedWhile,
} from "@grasp-os/brain/search-erasure";
import { documentIdSchema } from "@grasp-os/shared/ids";
import { purgeMaxDocuments } from "@grasp-os/shared/knowledge";
import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { saveUserMemory } from "../src/knowledge/memory.ts";
import { brainOf } from "../src/knowledge/ports.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import {
  newAgent,
  payOwedRebuilds,
  purged,
  purgesWith,
  rebuildFailingOnce,
  rememberAs,
  saveOver,
  setUpTime,
} from "./knowledge-purge.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
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

const { leaverWith } = purgesWith(idp);

/** Each step of a purge's status, as `step: state` or `step: state: reason`. */
/** How many rebuilds purge `purgeId` owes: one, or none. */
const owed = async (purgeId: string) => {
  const row = await env.KNOWLEDGE.prepare(
    "SELECT count(*) AS n FROM search_rebuilds WHERE id = ?"
  )
    .bind(purgeId)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

const stateOf = (status: {
  steps: readonly { step: string; state: string; reason: string | null }[];
}) =>
  Object.fromEntries(
    status.steps.map(({ step, state, reason }) => [
      step,
      reason === null ? state : `${state}: ${reason}`,
    ])
  );

/** How many collections have id `id`: one, or none. */
const collectionsWithId = async (id: string) => {
  const row = await env.KNOWLEDGE.prepare(
    "SELECT count(*) AS n FROM collections WHERE id = ?"
  )
    .bind(id)
    .first<{ n: number }>();
  return row?.n;
};

/** What step `step` of a purge's status counted. */
const stepCounts = (
  status: { steps: readonly { step: string; counts: unknown }[] },
  step: string
) => status.steps.find((each) => each.step === step)?.counts;

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

  it("starts and finishes a purge naming as many documents as a purge may", async () => {
    const admin = await personOf("admin");
    const secret = `smit${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const documentIds: string[] = [];
    for (let number = 1; number <= purgeMaxDocuments; number += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one document after another
      const saved = await saveOver(
        admin,
        handbook.id,
        `page-${number}.md`,
        `# Page ${number}\nWrite to ${secret}.`
      );
      documentIds.push(saved.id);
    }
    const { result } = await purged(admin, {
      type: "content",
      documentIds,
      terms: [secret],
      reason: "other",
    });
    const status = await admin.api.knowledge.purgeStatus(result.purgeId);

    expect({
      documents: result.documents,
      state: status.state,
      steps: status.steps.length,
    }).toStrictEqual({
      documents: purgeMaxDocuments,
      state: "complete",
      // A step per document, and the purge's own five.
      steps: purgeMaxDocuments + 5,
    });
  });

  it("owes its own rebuild on every run, though another purge's rebuild cleared the run before's", async () => {
    const admin = await personOf("admin");
    const secret = `bos${unique()}`;
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
    const first = await admin.api.knowledge.preparePurge(input);
    const events = await auditedDuring(async () => {
      await outcome(failing.knowledge.purge(input, first.token));
    });
    const purgeId = String(
      events.find(({ action }) => action === "knowledge.purged")?.detail
        ?.purgeId
    );
    // Another purge's rebuild: the first run's writes were done, so it
    // clears what that run owed.
    await payOwedRebuilds();
    const cleared = await owed(purgeId);
    // Run again, and its rebuild fails once more.
    const failingAgain = await rebuildFailingOnce(admin);
    const again = await admin.api.knowledge.preparePurge(input);
    const second = await outcome(
      failingAgain.knowledge.purge(input, again.token)
    );

    expect({ cleared, second, owedAgain: await owed(purgeId) }).toStrictEqual({
      cleared: 0,
      second: "knowledge.purge_index_pending",
      // The next purge knows to rebuild for this run's writes.
      owedAgain: 1,
    });
  });

  it("lets one run at a time hold a purge, and a trailing run change nothing of one that finished", async () => {
    const admin = await personOf("admin");
    const brain = brainOf(env);
    const by = {
      actor: { type: "person", userId: admin.userId },
      userId: admin.userId,
    };
    const input = {
      type: "content" as const,
      documentIds: [documentIdSchema.parse(crypto.randomUUID())],
      terms: [`term${unique()}`],
      reason: "other" as const,
    };
    const open = async () =>
      await openPurge(
        brain,
        by,
        input,
        ["one"],
        {},
        () => [],
        () => []
      );
    const first = await open();
    // A second run while the first holds it, within its lease.
    const secondRun = await outcome(open());
    await runStep(brain, first, "one", async () => {
      await Promise.resolve();
    });
    await finishPurge(brain, first);
    // The first run's handle, trailing after it finished, failing a step.
    const trailing = await outcome(
      runStep(brain, first, "one", async () => {
        await Promise.resolve();
        throw new Error("too late");
      })
    );
    const status = await purgeStatus(brain, by, first.purgeId);

    expect({
      secondRun,
      trailing,
      state: status.state,
      steps: stateOf(status),
    }).toStrictEqual({
      secondRun: "knowledge.conflict",
      trailing: "knowledge.conflict",
      state: "complete",
      steps: { one: "complete" },
    });
  });

  it("keeps the rebuild owed when an attempt that lost its purge marks its writes done", async () => {
    const admin = await personOf("admin");
    let now = Date.now();
    const real = brainOf(env);
    const brain = {
      ...real,
      ports: { ...real.ports, clock: () => new Date(now) },
    };
    const db = drizzle(env.KNOWLEDGE);
    const by = {
      actor: { type: "person", userId: admin.userId },
      userId: admin.userId,
    };
    const input = {
      type: "content" as const,
      documentIds: [documentIdSchema.parse(crypto.randomUUID())],
      terms: [`term${unique()}`],
      reason: "other" as const,
    };
    const open = async () =>
      await openPurge(
        brain,
        by,
        input,
        ["one"],
        {},
        () => [],
        (held, at) => [
          rebuildOwedWhile(db, held.purgeId, attemptHolds(held, at)),
        ]
      );
    const lapsed = await open();
    // Its lease runs out; another run takes the purge over and writes.
    now += purgeAttemptLeaseMs + 1000;
    const current = await open();
    const marked = await whileHeld(brain, lapsed, (at) => [
      owedWritesDoneWhile(db, lapsed.purgeId, attemptHoldsOrIdle(lapsed, at)),
    ]);
    const row = await env.KNOWLEDGE.prepare(
      "SELECT writes_done_at AS done FROM search_rebuilds WHERE id = ?"
    )
      .bind(lapsed.purgeId)
      .first<{ done: number | null }>();
    // Owed for good otherwise: later tests would count its rebuild.
    await env.KNOWLEDGE.prepare("DELETE FROM search_rebuilds WHERE id = ?")
      .bind(lapsed.purgeId)
      .run();

    expect({
      samePurge: current.purgeId === lapsed.purgeId,
      marked,
      // Still owed as written to: another purge's rebuild leaves it.
      owed: row !== null,
      writesDone: row?.done,
    }).toStrictEqual({
      samePurge: true,
      marked: false,
      owed: true,
      writesDone: null,
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

  it("refuses to begin a purge fresh while a run holds it, and a run that lost it deletes nothing", async () => {
    const admin = await personOf("admin");
    let now = Date.now();
    const real = brainOf(env);
    const brain = {
      ...real,
      ports: { ...real.ports, clock: () => new Date(now) },
    };
    const db = drizzle(env.KNOWLEDGE);
    const by = {
      actor: { type: "person", userId: admin.userId },
      userId: admin.userId,
    };
    const input = {
      type: "content" as const,
      documentIds: [documentIdSchema.parse(crypto.randomUUID())],
      terms: [`term${unique()}`],
      reason: "other" as const,
    };
    const open = async (fresh: boolean) =>
      await openPurge(
        brain,
        by,
        input,
        ["records"],
        {},
        () => [],
        () => [],
        fresh
      );
    const created = async (name: string) =>
      await admin.api.knowledge.createCollection({ name, access: "everyone" });
    const gone = await created("Gone");
    const kept = await created("Kept");
    /** A data batch of the step: deletes collection `id`, guarded. */
    const deleting = async (held: typeof running, id: string) => {
      await db.batch([
        db
          .delete(collections)
          .where(and(eq(collections.id, id), heldNow(brain, held))),
      ]);
    };
    const running = await open(false);
    const whileRunning = await outcome(open(true));
    let replacement = "";
    const late = await outcome(
      runStep(brain, running, "records", async () => {
        // While it holds the purge, its batch deletes.
        await deleting(running, gone.id);
        // Stalled past its lease mid-step; an admin begins it fresh.
        now += purgeAttemptLeaseMs + 1000;
        const replacing = await open(true);
        replacement = replacing.purgeId;
        // The stalled run's next batch.
        await deleting(running, kept.id);
      })
    );

    expect({
      whileRunning,
      late,
      replaced: replacement !== running.purgeId,
      gone: await collectionsWithId(gone.id),
      kept: await collectionsWithId(kept.id),
    }).toStrictEqual({
      whileRunning: "knowledge.conflict",
      late: "knowledge.conflict",
      replaced: true,
      gone: 0,
      kept: 1,
    });
  });

  it("keeps what each committed batch of a step counted when the step then fails, and adds a run again's", async () => {
    const admin = await personOf("admin");
    const brain = brainOf(env);
    const by = {
      actor: { type: "person", userId: admin.userId },
      userId: admin.userId,
    };
    const input = {
      type: "content" as const,
      documentIds: [documentIdSchema.parse(crypto.randomUUID())],
      terms: [`term${unique()}`],
      reason: "other" as const,
    };
    const open = async () =>
      await openPurge(
        brain,
        by,
        input,
        ["versions"],
        {},
        () => [],
        () => []
      );
    const first = await open();
    const failed = await outcome(
      runStep(brain, first, "versions", async (save) => {
        // A page of versions rewritten, its count with it; the next fails.
        await brain.db.batch([save({ versions: 5 })]);
        throw new Error("D1 is unavailable");
      })
    );
    const blocked = await purgeStatus(brain, by, first.purgeId);
    const again = await open();
    const total = await runStep(brain, again, "versions", async (save) => {
      await brain.db.batch([save({ versions: 2 })]);
      return { versions: 2 };
    });

    expect({
      failed,
      blocked: blocked.steps.map(({ state, counts }) => ({ state, counts })),
      total,
    }).toStrictEqual({
      failed: "Error: D1 is unavailable",
      blocked: [{ state: "blocked", counts: { versions: 5 } }],
      total: { versions: 7 },
    });
  });

  it("counts what each step changed, and a person's documents across runs", async () => {
    const admin = await personOf("admin");
    const secret = `jansen${unique()}`;
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
    await rememberAs(admin, `${secret.toUpperCase()}!`);
    const content = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [secret],
      reason: "other",
    });
    const contentStatus = await admin.api.knowledge.purgeStatus(
      content.result.purgeId
    );
    const { leaver } = await leaverWith({ "notes.md": "# Notes\nOne." });
    const input: PurgeInput = {
      type: "personal",
      userId: leaver.userId,
      reason: "offboarding",
    };
    const failing = await rebuildFailingOnce(admin);
    const { token } = await admin.api.knowledge.preparePurge(input);
    await outcome(failing.knowledge.purge(input, token));
    // Written before the run again, in a Personal collection made anew:
    // it goes too, and counts.
    const agent = newAgent();
    await saveUserMemory(
      env,
      actingFor(agent, leaver.userId),
      await newChat(agent),
      { type: "own" },
      { text: "# About me\nTwo.", ifVersion: 0 }
    );
    const person = await purged(admin, input);
    const personStatus = await admin.api.knowledge.purgeStatus(
      person.result.purgeId
    );
    expect({
      statements: stepCounts(contentStatus, "statements"),
      document: stepCounts(contentStatus, `document:${document.id}`),
      records: stepCounts(personStatus, "records"),
      result: {
        documents: person.result.documents,
        versions: person.result.versions,
      },
    }).toStrictEqual({
      statements: { redacted: 0, deleted: 1 },
      document: { documents: 1, versions: 1 },
      records: { documents: 2, versions: 2 },
      result: { documents: 2, versions: 2 },
    });
  });

  it("finishes an unfinished purge run again whose document another purge deleted meanwhile", async () => {
    const admin = await personOf("admin");
    const secret = `meijer${unique()}`;
    // The admin's own Personal collection: another person's is theirs alone.
    const { personal } = await admin.api.memory.collections();
    const named = await saveOver(
      admin,
      personal,
      "people.md",
      `# People\nWrite to ${secret}.`
    );
    const input: PurgeInput = {
      type: "content",
      documentIds: [named.id],
      terms: [secret],
      reason: "other",
    };
    const failing = await rebuildFailingOnce(admin);
    const first = await admin.api.knowledge.preparePurge(input);
    await outcome(failing.knowledge.purge(input, first.token));
    // A personal purge deletes the document the first one names.
    await purged(admin, {
      type: "personal",
      userId: admin.userId,
      reason: "offboarding",
    });
    const resumed = await purged(admin, input);
    const status = await admin.api.knowledge.purgeStatus(
      resumed.result.purgeId
    );
    // Strict as ever for a purge not begun: the document is gone.
    const other = await outcome(
      admin.api.knowledge.preparePurge({ ...input, terms: [`${secret}x`] })
    );

    expect({
      state: status.state,
      step: stateOf(status)[`document:${named.id}`],
      other,
    }).toStrictEqual({
      state: "complete",
      step: "complete",
      other: "knowledge.not_found",
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
