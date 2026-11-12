import { brainOf, recallBudgetMax } from "@grasp-os/brain-next/contract";
import type { PurgeInput } from "@grasp-os/shared/knowledge";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  chatTurnSource,
  runSource,
  uploadSource,
} from "../src/brain-next-origins.ts";
import { addSource, recallAs } from "../src/brain-next.ts";
import type { SourceRef } from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { sweepRunDetails } from "../src/workflows/retention.ts";
import { personalChatsOf, says } from "./agent-chat.ts";
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
import { outcome, signedInApi, unique } from "./sign-in.ts";

// Erasure reaching the new Brain from what core deletes (GRA-1727), from
// its threat model on the issue: a chat deleted, an upload's document
// purged and a run past its retention each erase their sources, and a
// person's erasure erases what only they may read. Each Brain call is
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
  "Error: The Brain refused it: what this adds was erased";

/** The Brain's contract on its store, for a reader core no longer has. */
const brain = () => brainOf(inJurisdiction(env, env.BRAIN_STORE));

/** Adds `text` to `source`, read by `personId` alone, as a producer would. */
const handOver = async (
  source: SourceRef,
  text: string,
  personId: string
): Promise<number> => {
  const { version } = await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text,
    readers: { kind: "owner", personId },
  });
  return version;
};

/** A text holding `mark` where recall finds it by its word. */
const markedText = (mark: string): string => `What was said: ${wordOf(mark)}.`;

/** How many passages `personId` recalls for `mark`, as the store reads. */
const recalled = async (personId: string, mark: string): Promise<number> => {
  const { items } = await brain().recall({
    question: wordOf(mark),
    reader: { person: personId, groups: [] },
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

/** Whether `chatId` is among `person`'s chats. */
const listed = async (
  person: Awaited<ReturnType<typeof signedInApi>>,
  chatId: string
): Promise<boolean> => {
  const chats = await person.api.chats.list();
  return chats.some(({ id }) => id === chatId);
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

describe("a chat deleted", { timeout: 120_000 }, () => {
  /**
   * A person's chat with one turn answered, its turns handed to the
   * Brain under every message id it holds, each with a mark of its own.
   */
  const chatInBrain = async () => {
    const person = await signedInApi(idp, "user");
    const { stub, newChat } = await personalChatsOf(
      person.userId,
      says("Noted.")
    );
    const { chat, ask } = await newChat();
    await ask("Where are we?");
    const ids = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ id: number }>(
          "SELECT id FROM chat_messages WHERE chat_id = ?",
          chat.id
        )
        .toArray()
        .map(({ id }) => id)
    );
    const marks = ids.map(() => newMark());
    const sources = ids.map((id) => chatTurnSource(chat.id, id));
    for (const [index, source] of sources.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one turn at a time
      await handOver(source, markedText(marks[index] ?? ""), person.userId);
    }
    return { person, chat, marks, sources };
  };

  it("erases every turn of it, so its person recalls none and the store keeps nothing of them", async () => {
    const { person, chat, marks, sources } = await chatInBrain();
    const before = await recalled(person.userId, marks[0] ?? "");

    await person.api.chats.remove(chat.id);

    expect({
      turns: sources.length,
      before,
      after: await Promise.all(
        marks.map(async (mark) => await recalled(person.userId, mark))
      ),
      ledger: await Promise.all(sources.map(inLedger)),
      left: await leftOf(marks),
    }).toStrictEqual({
      turns: 2,
      before: 1,
      after: [0, 0],
      ledger: [1, 1],
      left: nothingLeft,
    });
  });

  it("stays, with its turns owed, while the Brain can't record their erasure, and is erased once deleted again", async () => {
    const { person, chat, marks, sources } = await chatInBrain();

    await failNextBucketPut();
    const failed = await outcome(person.api.chats.remove(chat.id));
    const meanwhile = await listed(person, chat.id);
    await person.api.chats.remove(chat.id);

    expect({
      failed: failed === "ok" ? "deleted" : "refused",
      meanwhile,
      listed: await listed(person, chat.id),
      ledger: await Promise.all(sources.map(inLedger)),
      left: await leftOf(marks),
    }).toStrictEqual({
      failed: "refused",
      meanwhile: true,
      listed: false,
      ledger: [1, 1],
      left: nothingLeft,
    });
  });

  it("refuses a hand-over of one of its turns that was writing its file as the chat was deleted", async () => {
    const { person, chat, sources } = await chatInBrain();
    const late = newMark();
    const gate = await holdNextBucketPut();
    const handing = settled(
      handOver(
        sources[0] ?? chatTurnSource(chat.id, 0),
        markedText(late),
        person.userId
      )
    );
    await vi.waitFor(
      () => {
        expect(gate.reached).toBeTruthy();
      },
      { timeout: 10_000 }
    );

    await person.api.chats.remove(chat.id);
    gate.released = true;

    expect({
      handed: await handing,
      recalled: await recalled(person.userId, late),
      left: await leftOf([late]),
    }).toStrictEqual({
      handed: {
        error: refusedAsErased,
      },
      recalled: 0,
      left: nothingLeft,
    });
  });
});

describe("an upload's document purged", { timeout: 120_000 }, () => {
  /**
   * A document an admin's colleague uploaded into a collection for
   * everyone, recorded as their upload saved as it, and its text handed
   * to the Brain for them alone. The document itself holds no mark: the
   * Brain's copy alone does.
   */
  const uploadInBrain = async () => {
    const uploader = await signedInApi(idp, "admin");
    const admin = await signedInApi(idp, "admin");
    const collection = await uploader.api.knowledge.createCollection({
      name: `Files ${unique()}`,
      access: "everyone",
    });
    const path = `offices-${unique()}.md`;
    const document = await uploader.api.knowledge.saveDocument({
      collectionId: collection.id,
      path,
      text: "The facilities desk is at facilities@example.com.",
      ifVersion: 0,
    });
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO uploads (id, collection_id, path, media_type, bytes, sha256,
         uploaded_by, actor, status, document_id, version, created_at, updated_at)
       VALUES (?, ?, ?, 'text/markdown', 1, ?, ?, ?, 'ready', ?, 1, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        collection.id,
        path,
        "0".repeat(64),
        uploader.userId,
        JSON.stringify({ type: "person", userId: uploader.userId }),
        document.id,
        now,
        now
      )
      .run();
    const mark = newMark();
    const source = uploadSource(document.id);
    await handOver(source, markedText(mark), uploader.userId);
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: ["facilities@example.com"],
      reason: "erasure_request",
    };
    const purge = async () => {
      const plan = await admin.api.knowledge.preparePurge(input);
      await admin.api.knowledge.purge(input, plan.token);
    };
    return { uploader, mark, source, purge };
  };

  it("erases its text in the Brain, so its uploader recalls none and the store keeps nothing of it, and a late hand-over is refused", async () => {
    const { uploader, mark, source, purge } = await uploadInBrain();
    const before = await recalled(uploader.userId, mark);

    await purge();
    const late = await settled(
      handOver(source, markedText(newMark()), uploader.userId)
    );

    expect({
      before,
      after: await recalled(uploader.userId, mark),
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

  it("fails the purge before it forgets the upload while the Brain can't record the erasure, and erases it when run again", async () => {
    const { uploader, mark, source, purge } = await uploadInBrain();

    await failNextBucketPut();
    const failed = await outcome(purge());
    const kept = await env.DB.prepare(
      "SELECT count(*) AS n FROM uploads WHERE document_id = ?"
    )
      .bind(source.id)
      .first<{ n: number }>();
    await purge();

    expect({
      failed: failed === "ok" ? "purged" : "failed",
      kept: kept?.n,
      after: await recalled(uploader.userId, mark),
      ledger: await inLedger(source),
      left: await leftOf([mark]),
    }).toStrictEqual({
      failed: "failed",
      // Still names its document, for the purge run again to erase.
      kept: 1,
      after: 0,
      ledger: 1,
      left: nothingLeft,
    });
  });
});

describe("a run past its retention", { timeout: 120_000 }, () => {
  /** A run of a builder's that ended, its result handed to the Brain. */
  const runInBrain = async () => {
    const builder = await signedIn("builder");
    const { id } = await publishedWorkflow(builder, greetingTasks());
    const runId = await startedBy(builder, id, { who: "the guest" });
    await endedRun(builder, id, runId);
    const mark = newMark();
    const source = runSource(runId);
    await handOver(source, markedText(mark), builder.userId);
    return { builder, mark, source };
  };

  /** The run retention's sweep, as of 31 days on. */
  const sweep = async () => {
    await sweepRunDetails(env, new Date(Date.now() + 31 * day));
  };

  it("erases what the Brain took in of it with its details, and a late hand-over is refused", async () => {
    const { builder, mark, source } = await runInBrain();
    const before = await recalled(builder.userId, mark);

    await sweep();
    const late = await settled(
      handOver(source, markedText(newMark()), builder.userId)
    );

    expect({
      before,
      after: await recalled(builder.userId, mark),
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

  it("marks nothing while the Brain can't record the erasure, and the next sweep erases it", async () => {
    const { builder, mark, source } = await runInBrain();

    await failNextBucketPut();
    const failed = await outcome(sweep());
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
      marked: marked?.removed,
      swept: typeof swept?.removed,
      after: await recalled(builder.userId, mark),
      ledger: await inLedger(source),
      left: await leftOf([mark]),
    }).toStrictEqual({
      failed: "failed",
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
    const marks = [newMark(), newMark(), newMark()];
    const sources = [
      chatTurnSource(crypto.randomUUID(), 1),
      uploadSource(crypto.randomUUID()),
      runSource(crypto.randomUUID()),
    ];
    for (const [index, source] of sources.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await handOver(source, markedText(marks[index] ?? ""), person.userId);
    }
    const before = await recallAs(env, person.userId, {
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
        marks.map(async (mark) => await recalled(person.userId, mark))
      ),
      // A retry writes the erasure the failed call recorded, then its own.
      inLedger: entries.length > 0,
      erased,
      restored,
    }).toStrictEqual({
      before: 3,
      pending: {
        completed: null,
        brain: { area: "brain_sources", state: "pending" },
      },
      done: {
        completed: "string",
        brain: { area: "brain_sources", state: "complete" },
      },
      recalled: [0, 0, 0],
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
    const gate = await holdNextBucketPut();
    const handing = settled(
      handOver(
        uploadSource(crypto.randomUUID()),
        markedText(late),
        person.userId
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

    expect({
      completed: typeof erasure.completedAt,
      handed: await handing,
      recalled: await recalled(person.userId, late),
      left: await leftOf([late]),
    }).toStrictEqual({
      completed: "string",
      handed: {
        error: refusedAsErased,
      },
      recalled: 0,
      left: nothingLeft,
    });
  });
});
