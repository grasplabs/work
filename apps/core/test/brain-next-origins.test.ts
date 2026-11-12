import { brainOf, recallBudgetMax } from "@grasp-os/brain-next/contract";
import type { Reader } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { runSource, uploadSource } from "../src/brain-next-origins.ts";
import { addSource, recallAs } from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { sweepRunDetails } from "../src/workflows/retention.ts";
import { finishedByTheClock } from "./brain-next-own-store.ts";
import { soleReadersOf } from "./brain-next-sole-readers.ts";
import { copyOfStore, restoreStore } from "./brain-next-store-copy.ts";
import {
  holdNextBucketPut,
  ledgerOf,
  newMark,
  nextBucketPut,
  objectsHolding,
  settled,
  tablesHolding,
  tickPastGrace,
  tickUntilErased,
  wordOf,
} from "./brain-next-traces.ts";
import { mockIdp } from "./idp.ts";
import {
  endedRun,
  greetingTasks,
  jsonWorkflowAppsOf,
  publishedWorkflow,
  startedBy,
} from "./json-workflow-apps.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// Erasure reaching the new Brain from what core deletes (GRA-1727), from
// its threat model on the issue: a run past its retention erases its
// source, and a person's erasure erases what only they may read. Each Brain call is
// owed until it returns: one that fails (the Brain's bucket out of reach)
// leaves the origin as it was, or the erasure's area pending, and the
// retry finishes it. A hand-over still on its way for what was deleted is
// refused. What is left is looked for everywhere the store keeps
// anything, every table, index page and object, after the tick deleted
// it, and again after the store is restored from a copy taken before.

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

const day = 24 * 60 * 60 * 1000;

/** What a hand-over to an erased key, or for a person erased since it began, is told. */
const refusedAsErased =
  "Error: What this adds was erased: it stays erased, and isn't added.";

/** The Brain's contract on its store, for a reader core no longer has. */
const brain = () => brainOf(inJurisdiction(env, env.BRAIN_STORE));

/**
 * Adds `text` to `source` as a producer would, read by `readers`: one
 * person's own by default, which goes to that person's own store.
 */
const handOver = async (
  source: SourceRef,
  text: string,
  readers: SourceReaders
): Promise<number> => {
  const { version } = await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text,
    readers,
  });
  return version;
};

/** Readers of `personId` alone. */
const ownedBy = (personId: string): SourceReaders => ({
  kind: "owner",
  personId,
});

/** The Brain's reader of `readers`'s person: the person and the team, if any. */
const readerOf = (personId: string, readers: SourceReaders): Reader => ({
  person: personId,
  groups: readers.kind === "team" ? [`team:${readers.teamId}`] : [],
});

/** A text holding `mark` where recall finds it by its word. */
const markedText = (mark: string): string => `What was said: ${wordOf(mark)}.`;

/** How many passages `reader` recalls for `mark`, as the shared store reads. */
const recalled = async (reader: Reader, mark: string): Promise<number> => {
  const { items } = await brain().recall({
    question: wordOf(mark),
    reader,
    budget: { tokens: recallBudgetMax },
  });
  return items.length;
};

/**
 * What the store keeps of `marks` once the tick deleted what was erased
 * and the sweep its files: the tables and objects holding any of them.
 */
const leftOf = async (marks: readonly string[]) => {
  const ticks = await tickUntilErased();
  try {
    await tickPastGrace();
  } finally {
    vi.useRealTimers();
  }
  return {
    erasedWithin: Number.isFinite(ticks),
    tables: await tablesHolding(marks),
    objects: await objectsHolding(marks),
  };
};

const nothingLeft = { erasedWithin: true, tables: [], objects: [] };

/** How many ledger entries name `source`. */
const inLedger = async ({ producer, id }: SourceRef): Promise<number> => {
  const entries = await ledgerOf(`${producer}:${id}`);
  return entries.length;
};

/**
 * Fails the Brain's next write to its bucket, as an R2 out of reach: the
 * ledger write of the next erasure.
 */
const failNextBucketPut = async (): Promise<void> => {
  await nextBucketPut(async () => {
    await Promise.resolve();
    throw new Error("R2 out of reach, for the test");
  });
};

describe("a run past its retention", { timeout: 120_000 }, () => {
  /**
   * A run of a builder's that ended, its result handed to the Brain. For
   * a team of the builder alone, so it is in the shared store, whose
   * erasure the clock's ticks finish here (a person's own store does its
   * own work: brain-next-personal.test.ts); retention erases a run's
   * source in the shared store whatever its readers.
   */
  const runInBrain = async () => {
    const builder = await signedIn("builder");
    const { id } = await publishedWorkflow(builder, greetingTasks());
    const runId = await startedBy(builder, id, { who: "the guest" });
    await endedRun(builder, id, runId);
    const mark = newMark();
    const source = runSource(runId);
    const readers = await soleReadersOf(builder.userId);
    await handOver(source, markedText(mark), readers);
    return { reader: readerOf(builder.userId, readers), readers, mark, source };
  };

  /** The run retention's sweep, as of 31 days on. */
  const sweep = async () => {
    await sweepRunDetails(env, new Date(Date.now() + 31 * day));
  };

  it("erases what the Brain took in of it with its details, and a late hand-over is refused", async () => {
    const { reader, readers, mark, source } = await runInBrain();
    const before = await recalled(reader, mark);

    await sweep();
    const late = await settled(
      handOver(source, markedText(newMark()), readers)
    );

    expect({
      before,
      after: await recalled(reader, mark),
      late,
      ledger: await inLedger(source),
      left: await leftOf([mark]),
    }).toStrictEqual({
      before: 1,
      after: 0,
      late: { error: refusedAsErased },
      ledger: 1,
      left: nothingLeft,
    });
  });

  it("marks nothing while the Brain can't record the erasure, still removes what needs no Brain, and the next sweep erases it", async () => {
    const { reader, mark, source } = await runInBrain();
    // A snapshot no start names: retention removes it whatever the Brain does.
    const orphan = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO workflow_state_snapshots (hash, body, created_at) VALUES (?, '{}', ?)"
    )
      .bind(orphan, Date.now())
      .run();

    await failNextBucketPut();
    const failed = await outcome(sweep());
    const orphanKept = await env.DB.prepare(
      "SELECT count(*) AS n FROM workflow_state_snapshots WHERE hash = ?"
    )
      .bind(orphan)
      .first<{ n: number }>();
    const marked = await env.DB.prepare(
      "SELECT details_removed_at AS removed FROM workflow_start_receipts WHERE id = ?"
    )
      .bind(source.id)
      .first<{ removed: number | null }>();
    await sweep();
    const swept = await env.DB.prepare(
      "SELECT details_removed_at AS removed FROM workflow_start_receipts WHERE id = ?"
    )
      .bind(source.id)
      .first<{ removed: number | null }>();

    expect({
      failed: failed === "ok" ? "swept" : "failed",
      orphanKept: orphanKept?.n,
      marked: marked?.removed,
      swept: typeof swept?.removed,
      after: await recalled(reader, mark),
      ledger: await inLedger(source),
      left: await leftOf([mark]),
    }).toStrictEqual({
      failed: "failed",
      orphanKept: 0,
      marked: null,
      swept: "number",
      after: 0,
      ledger: 1,
      left: nothingLeft,
    });
  });
});

describe("a person erased", { timeout: 120_000 }, () => {
  it("is not complete while the Brain's erasure is owed, is once the clock retried it, and nothing of theirs comes back after a restore", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "builder");
    const marks = [newMark(), newMark()];
    const sources = [
      uploadSource(crypto.randomUUID()),
      runSource(crypto.randomUUID()),
    ];
    for (const [index, source] of sources.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await handOver(
        source,
        markedText(marks[index] ?? ""),
        ownedBy(person.userId)
      );
    }
    const before = await recallAs(env, person.userId, {
      personal: true,
      question: marks.map(wordOf).join(" "),
      budget: { tokens: recallBudgetMax },
    });
    const copy = await copyOfStore();
    await admin.api.members.remove(person.userId);

    await failNextBucketPut();
    const pending = await admin.api.members.erase(
      person.userId,
      String(person.person.name)
    );
    await runMinuteTasks();
    await finishedByTheClock(person.userId);
    const done = await admin.api.members.erasure(person.userId);
    const erased = await leftOf(marks);
    await restoreStore(copy);
    const restored = await leftOf(marks);
    const entries = await ledgerOf(person.userId);

    expect({
      before: before.items.length,
      pending: {
        completed: pending.completedAt,
        brain: pending.areas.find(({ area }) => area === "brain_sources"),
      },
      done: {
        completed: typeof done.erasure?.completedAt,
        brain: done.erasure?.areas.find(({ area }) => area === "brain_sources"),
      },
      recalled: await Promise.all(
        marks.map(
          async (mark) =>
            await recalled({ person: person.userId, groups: [] }, mark)
        )
      ),
      // A retry writes the erasure the failed call recorded, then its own.
      inLedger: entries.length > 0,
      erased,
      restored,
    }).toStrictEqual({
      before: 2,
      pending: {
        completed: null,
        brain: { area: "brain_sources", state: "pending" },
      },
      done: {
        completed: "string",
        brain: { area: "brain_sources", state: "complete" },
      },
      recalled: [0, 0],
      inLedger: true,
      erased: nothingLeft,
      restored: nothingLeft,
    });
  });

  it("refuses a hand-over for them that was writing its file as they were erased", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "builder");
    await admin.api.members.remove(person.userId);
    const late = newMark();
    // Their own store's write: a hand-over for them alone is kept there.
    const gate = await holdNextBucketPut(`person:${person.userId}`);
    const handing = settled(
      handOver(
        uploadSource(crypto.randomUUID()),
        markedText(late),
        ownedBy(person.userId)
      )
    );
    await vi.waitFor(
      () => {
        expect(gate.reached).toBeTruthy();
      },
      { timeout: 10_000 }
    );

    const erasure = await admin.api.members.erase(
      person.userId,
      String(person.person.name)
    );
    gate.released = true;
    const handed = await handing;
    await finishedByTheClock(person.userId);
    const done = await admin.api.members.erasure(person.userId);

    expect({
      // Not finished while the hand-over was under way in their store.
      pending: erasure.completedAt,
      completed: typeof done.erasure?.completedAt,
      handed,
      recalled: await recalled({ person: person.userId, groups: [] }, late),
      left: await leftOf([late]),
    }).toStrictEqual({
      pending: null,
      completed: "string",
      // Their own store was erased while it wrote: refused as such.
      handed: {
        error: "Error: The Brain refused it: this store was erased",
      },
      recalled: 0,
      left: nothingLeft,
    });
  });
});
