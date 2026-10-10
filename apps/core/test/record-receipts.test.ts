import {
  appIdSchema,
  collectionIdSchema,
  permissionIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId, CollectionId, PermissionId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { SubmissionIntent } from "@grasp-os/shared/submissions";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import type { AppCallerInput } from "../src/app.ts";
import {
  defaultMaxAttempts as maxAttempts,
  drainSubmissionOutbox,
} from "../src/knowledge/outbox.ts";
import type {
  OutboxConsumer,
  OutboxConsumers,
  OutboxEntry,
} from "../src/knowledge/outbox.ts";
import {
  claim,
  inputHashOf,
  sweepReceipts,
  submissionKey,
} from "../src/knowledge/receipts.ts";
import type { Submission } from "../src/knowledge/receipts.ts";
import { saveRecordAsDelegate } from "../src/knowledge/records.ts";
import { restrict } from "../src/restricted.ts";
import { release, requestGranted, serverBuilt } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// Receipts of the record saves an App's code makes (knowledge/receipts.ts):
// one save per idempotency key, committed only by the attempt holding the
// receipt's current fence, before its call's deadline. These tests start
// from how that can fail:
//
// - an attempt that a newer one took over commits after it, or one whose
//   call ran out of time commits once its batch is finally sent, while
//   every check made before the batch said yes;
// - an attempt killed after it claimed the receipt leaves something
//   written, or keeps the key from ever being saved;
// - a save commits and its answer is lost: the retry saves again, or
//   answers something other than the save made;
// - a key is reused with other input and gets the first input's outcome,
//   or goes through as a new save;
// - two saves from the same version both commit, or a save that changes
//   nothing commits over a version it never saw;
// - a key crosses people or bindings, so one caller's save answers or
//   blocks another's;
// - a malformed key is taken, or anything is done before it is refused;
// - a receipt is dropped before its retention, or while the workflow run
//   it belongs to is live, or an expired key goes through as new while
//   its tombstone is kept.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const serverCode = `import { DurableObject } from "cloudflare:workers";

type Caller = { userId: string; token: string };
type Stub = Record<string, (caller: Caller, ...args: unknown[]) => Promise<unknown>>;

export class App extends DurableObject {
  async save(caller: Caller, binding: string, input: unknown, options?: unknown): Promise<unknown> {
    try {
      const stub = (this.env as Record<string, Stub>)[binding] ?? {};
      return { ok: await stub.saveRecord(caller, input, options) };
    } catch (error) {
      return { error: (error as { code?: string }).code ?? "failed" };
    }
  }
}
`;

const dayMs = 24 * 60 * 60 * 1000;

const as = (userId: string): AppCallerInput => ({
  userId,
  mode: "interactive",
});

const collectionFor = (
  app: AppId,
  collectionId: string,
  binding: string
): PermissionRequest => ({
  subject: { type: "app", appId: app },
  object: { type: "collection", collectionId },
  actions: ["read", "write"],
  binding,
});

/** A record save of a doc at `path`, from `ifVersion`, titled `title`. */
const docSave = (path: string, title: string, ifVersion = 0) => ({
  path,
  ifVersion,
  record: { type: "doc", title },
  body: "",
});

/** An admin's collection open to everyone, and an App granted to write it. */
const setUp = async () => {
  const admin = await signedInApi(idp, "admin");
  const { id } = await admin.api.knowledge.createCollection({
    name: `Notes ${unique()}`,
    access: "everyone",
  });
  const collectionId = collectionIdSchema.parse(id);
  const { id: created } = await admin.api.apps.create({
    name: `Notes ${unique()}`,
  });
  const app = appIdSchema.parse(created);
  await serverBuilt(
    app,
    await release(admin, app, { "app/server.ts": serverCode })
  );
  const permissionId = permissionIdSchema.parse(
    await requestGranted(idp, admin, collectionFor(app, collectionId, "NOTES"))
  );
  return { admin, app, collectionId, permissionId };
};

type SetUp = Awaited<ReturnType<typeof setUp>>;

/** How many versions the document at `path` in `collectionId` has. */
const versionsAt = async (
  collectionId: string,
  path: string
): Promise<number> => {
  const row = await env.KNOWLEDGE.prepare(
    "SELECT count(*) AS count FROM versions JOIN documents ON documents.id = versions.document_id WHERE documents.collection_id = ? AND documents.path = ?"
  )
    .bind(collectionId, path)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

/** The submission `directSave` makes. */
const submissionOf = (
  admin: Person,
  app: AppId,
  collectionId: CollectionId,
  permissionId: PermissionId,
  key: string,
  inputHash: string,
  deadline: number
): Submission => ({
  ...submissionKey(undefined, key, inputHash),
  scope: {
    principal: admin.userId,
    chain: [app],
    appVersion: 1,
    method: "save",
    collectionId,
    permissionId,
  },
  deadline,
});

/**
 * Saves as the App would for `admin`, straight through
 * `saveRecordAsDelegate`, under `key` (the caller's), on `db`, by
 * `deadline`; `last` runs as the last check before the batch, where a
 * racing request lands.
 */
const directSave = async (
  { admin, app, collectionId, permissionId }: SetUp,
  input: ReturnType<typeof docSave>,
  {
    key,
    deadline = Date.now() + 60_000,
    db = env.KNOWLEDGE,
    last,
    intents = [],
    consumers,
  }: {
    key: string;
    deadline?: number;
    db?: D1Database;
    last?: () => Promise<void>;
    intents?: SubmissionIntent[];
    consumers?: OutboxConsumers;
  }
) =>
  await saveRecordAsDelegate(
    { ...env, KNOWLEDGE: db },
    {
      subject: { type: "app", appId: app },
      onBehalfOf: admin.userId,
      mode: "interactive",
      appVersion: 1,
    },
    { type: "app", appId: app },
    permissionId,
    collectionId,
    input,
    { app, method: "save" },
    last,
    (inputHash) => ({
      ...submissionOf(
        admin,
        app,
        collectionId,
        permissionId,
        key,
        inputHash,
        deadline
      ),
      intents,
      ...(consumers === undefined ? {} : { consumers }),
    })
  );

/**
 * Knowledge's database, with `first` run once, just before the first
 * query matching `when` is run.
 */
const onFirstQuery = (
  when: RegExp,
  first: () => Promise<void>,
  real: D1Database = env.KNOWLEDGE
): D1Database => {
  let done = false;
  const racing = (statement: D1PreparedStatement): D1PreparedStatement => {
    const once = async (): Promise<void> => {
      if (!done) {
        done = true;
        await first();
      }
    };
    // SAFETY: an object whose prototype is `statement` is a statement: it
    // has every member, and the ones it runs by are replaced below.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return Object.assign(Object.create(statement) as D1PreparedStatement, {
      bind: (...values: unknown[]) => racing(statement.bind(...values)),
      first: async () => {
        await once();
        return await statement.first();
      },
      all: async () => {
        await once();
        return await statement.all();
      },
      raw: async () => {
        await once();
        return await statement.raw();
      },
      run: async () => {
        await once();
        return await statement.run();
      },
    });
  };
  // SAFETY: as above, for the database.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return Object.assign(Object.create(real) as D1Database, {
    prepare: (query: string) => {
      const statement = real.prepare(query);
      return !done && when.test(query) ? racing(statement) : statement;
    },
  });
};

/** Knowledge's database, with `first` run before each batch is sent. */
const beforeBatch = (
  first: () => Promise<void>,
  real: D1Database = env.KNOWLEDGE
): D1Database =>
  // SAFETY: an object whose prototype is `real` is a database: it has
  // every member, and its batch is replaced below.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  Object.assign(Object.create(real) as D1Database, {
    batch: async (statements: D1PreparedStatement[]) => {
      await first();
      return await real.batch(statements);
    },
  });

/**
 * Knowledge's database, with every batch answered by a lost connection
 * once it committed.
 */
const losingReplies = (real: D1Database = env.KNOWLEDGE): D1Database =>
  // SAFETY: an object whose prototype is `real` is a database: it has
  // every member, and its batch is replaced below.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  Object.assign(Object.create(real) as D1Database, {
    batch: async (statements: D1PreparedStatement[]) => {
      await real.batch(statements);
      throw new Error("Network connection lost.");
    },
  });

/** The outbox entries whose intent's data has `marker`, oldest first. */
const entriesOf = async (marker: string) => {
  const { results } = await env.KNOWLEDGE.prepare(
    "SELECT id, kind, intent, attempts, settled_at AS settledAt, undeliverable FROM submission_outbox WHERE json_extract(intent, '$.data.marker') = ? ORDER BY rowid"
  )
    .bind(marker)
    .all<{
      id: string;
      kind: string;
      intent: string;
      attempts: number;
      settledAt: number | null;
      undeliverable: string | null;
    }>();
  return results.map(
    ({ id, kind, intent, attempts, settledAt, undeliverable }) => ({
      id,
      kind,
      intent: z.json().parse(JSON.parse(intent)),
      attempts,
      settled: settledAt !== null,
      undeliverable,
    })
  );
};

/** Whether `entry` is one of `marker`'s (`entriesOf`). */
const isOf = (entry: OutboxEntry, marker: string): boolean =>
  entry.intent.kind !== "record.changed" &&
  z.object({ marker: z.string() }).safeParse(entry.intent.data).data?.marker ===
    marker;

/**
 * Consumers of workflow notifications and starts: `of` takes `marker`'s
 * entries, and any other entry is delivered at once.
 */
const consumersFor = (
  marker: string,
  of: OutboxConsumer = async () => await Promise.resolve("delivered")
): OutboxConsumers => {
  const consumer: OutboxConsumer = async (entry) =>
    isOf(entry, marker) ? await of(entry) : "delivered";
  return { "workflow.notify": consumer, "workflow.start": consumer };
};

const savedSchema = z.object({
  ok: z.object({ id: z.string(), currentVersion: z.number() }),
});

/** A save's answer, as its document and version when it saved. */
const summaryOf = (answer: unknown): unknown => {
  const saved = savedSchema.safeParse(answer);
  return saved.success
    ? { id: saved.data.ok.id, version: saved.data.ok.currentVersion }
    : answer;
};

/** The version a save's answer (`summaryOf`'s) saved, or the answer. */
const versionOf = (answer: unknown): unknown => {
  const saved = z
    .object({ id: z.string(), version: z.number() })
    .safeParse(answer);
  return saved.success ? saved.data.version : answer;
};

describe("record saves under an idempotency key", { timeout: 60_000 }, () => {
  it("are made once: a retry answers the save made, and other input under the key is refused", async () => {
    const { admin, app, collectionId } = await setUp();
    const path = `notes/${unique()}.md`;
    const key = `submit-${unique()}`;
    const save = async (title: string) =>
      summaryOf(
        await callApp(env, app, as(admin.userId), "save", [
          "NOTES",
          docSave(path, title),
          { idempotencyKey: key },
        ])
      );
    const first = await save("Plan");
    expect({
      first: versionOf(first),
      retried: await save("Plan"),
      otherInput: await save("Another plan"),
      versions: await versionsAt(collectionId, path),
    }).toStrictEqual({
      first: 1,
      retried: first,
      otherInput: { error: "submission.key_conflict" },
      versions: 1,
    });
  });

  it("refuse a key that isn't one before anything is saved", async () => {
    const { admin, app, collectionId } = await setUp();
    const path = `notes/${unique()}.md`;
    const save = async (options: unknown) =>
      await callApp(env, app, as(admin.userId), "save", [
        "NOTES",
        docSave(path, "Plan"),
        options,
      ]);
    expect({
      empty: await save({ idempotencyKey: "" }),
      long: await save({ idempotencyKey: "k".repeat(129) }),
      notAscii: await save({ idempotencyKey: "clé" }),
      control: await save({ idempotencyKey: "a\nb" }),
      extra: await save({ idempotencyKey: "fine", fence: 9 }),
      versions: await versionsAt(collectionId, path),
      longest: versionOf(
        summaryOf(await save({ idempotencyKey: "k".repeat(128) }))
      ),
    }).toStrictEqual({
      empty: { error: "submission.key_invalid" },
      long: { error: "submission.key_invalid" },
      notAscii: { error: "submission.key_invalid" },
      control: { error: "submission.key_invalid" },
      extra: { error: "submission.key_invalid" },
      versions: 0,
      longest: 1,
    });
  });

  it("don't cross people or bindings: the same key elsewhere is another save", async () => {
    const setup = await setUp();
    const { admin, app, collectionId } = setup;
    const other = await signedInApi(idp, "admin");
    await requestGranted(
      idp,
      admin,
      collectionFor(app, collectionId, "NOTES_TOO")
    );
    const key = `shared-${unique()}`;
    const save = async (who: Person, binding: string, path: string) =>
      summaryOf(
        await callApp(env, app, as(who.userId), "save", [
          binding,
          docSave(path, `Plan of ${binding}`),
          { idempotencyKey: key },
        ])
      );
    const paths = [
      `notes/${unique()}.md`,
      `notes/${unique()}.md`,
      `notes/${unique()}.md`,
    ];
    expect({
      mine: versionOf(await save(admin, "NOTES", paths[0] ?? "")),
      theirs: versionOf(await save(other, "NOTES", paths[1] ?? "")),
      otherBinding: versionOf(await save(admin, "NOTES_TOO", paths[2] ?? "")),
      versions: await Promise.all(
        paths.map(async (path) => await versionsAt(collectionId, path))
      ),
    }).toStrictEqual({
      mine: 1,
      theirs: 1,
      otherBinding: 1,
      versions: [1, 1, 1],
    });
  });

  it("commit once when the answer is lost, and the retry gets that save", async () => {
    const setup = await setUp();
    const path = `notes/${unique()}.md`;
    const key = `lost-${unique()}`;
    const lost = await directSave(setup, docSave(path, "Plan"), {
      key,
      db: losingReplies(),
    });
    const retried = await directSave(setup, docSave(path, "Plan"), { key });
    expect({
      lost: lost.currentVersion,
      retried,
      changed: await outcome(
        directSave(setup, docSave(path, "Other"), { key })
      ),
      versions: await versionsAt(setup.collectionId, path),
    }).toStrictEqual({
      lost: 1,
      retried: lost,
      changed: "submission.key_conflict",
      versions: 1,
    });
  });

  it("don't commit an attempt that a newer one took over, even with every check before its batch passing", async () => {
    const setup = await setUp();
    const { admin, app, collectionId, permissionId } = setup;
    const path = `notes/${unique()}.md`;
    const key = `stale-${unique()}`;
    const input = docSave(path, "Plan");
    const stale = await outcome(
      directSave(setup, input, {
        key,
        // A newer attempt of the same save claims the receipt just before
        // this one's batch, and is killed before its own.
        last: async () => {
          const inputHash = await inputHashOf(input);
          await claim(
            env,
            submissionOf(
              admin,
              app,
              collectionId,
              permissionId,
              key,
              inputHash,
              Date.now() + 60_000
            ),
            inputHash
          );
        },
      })
    );
    const afterStale = await versionsAt(collectionId, path);
    // The newer attempt was killed before its batch: its key still holds
    // its input, and the save goes through once it is retried.
    const otherInput = await outcome(
      directSave(setup, docSave(path, "Other"), { key })
    );
    const retried = await directSave(setup, input, { key });
    expect({
      stale,
      afterStale,
      otherInput,
      retried: retried.currentVersion,
      versions: await versionsAt(collectionId, path),
    }).toStrictEqual({
      stale: "submission.superseded",
      afterStale: 0,
      otherInput: "submission.key_conflict",
      retried: 1,
      versions: 1,
    });
  });

  it("answer a stale attempt with the save a newer one of the same input committed first", async () => {
    const setup = await setUp();
    const path = `notes/${unique()}.md`;
    const key = `overtaken-${unique()}`;
    let newer: unknown;
    const stale = await directSave(setup, docSave(path, "Plan"), {
      key,
      // A newer attempt of the same save claims and commits just before
      // this one's batch.
      last: async () => {
        newer = await directSave(setup, docSave(path, "Plan"), { key });
      },
    });
    expect({
      stale,
      versions: await versionsAt(setup.collectionId, path),
    }).toStrictEqual({ stale: newer, versions: 1 });
  });

  it("answer nothing to an attempt refused at its last check, though its save was made meanwhile", async () => {
    const setup = await setUp();
    const path = `notes/${unique()}.md`;
    const key = `refused-${unique()}`;
    const refused = await outcome(
      directSave(setup, docSave(path, "Plan"), {
        key,
        // Another attempt makes the save, then this call loses what let
        // it write.
        last: async () => {
          await directSave(setup, docSave(path, "Plan"), { key });
          throw permissionErrors.create("permission.denied");
        },
      })
    );
    expect({
      refused,
      versions: await versionsAt(setup.collectionId, path),
    }).toStrictEqual({ refused: "permission.denied", versions: 1 });
  });

  it("answer a retry only while its caller may still write, and nothing when its last check fails", async () => {
    const setup = await setUp();
    const { admin, app, collectionId } = setup;
    const other = await signedInApi(idp, "admin");
    const key = `again-${unique()}`;
    const path = `notes/${unique()}.md`;
    const save = async () =>
      summaryOf(
        await callApp(env, app, as(other.userId), "save", [
          "NOTES",
          docSave(path, "Plan"),
          { idempotencyKey: key },
        ])
      );
    const first = versionOf(await save());
    await admin.api.members.setRole(other.userId, "user");
    const demoted = await save();
    const directKey = `direct-${unique()}`;
    const directPath = `notes/${unique()}.md`;
    await directSave(setup, docSave(directPath, "Plan"), { key: directKey });
    const refused = await outcome(
      directSave(setup, docSave(directPath, "Plan"), {
        key: directKey,
        last: async () => {
          await Promise.resolve();
          throw permissionErrors.create("permission.denied");
        },
      })
    );
    const brokenPath = `notes/${unique()}.md`;
    const broken = await outcome(
      directSave(setup, docSave(brokenPath, "Plan"), {
        key: directKey.replace("direct", "broken"),
        // Another attempt makes the save, then the last check itself
        // fails: that says nothing about whether this one committed.
        last: async () => {
          await directSave(setup, docSave(brokenPath, "Plan"), {
            key: directKey.replace("direct", "broken"),
          });
          throw new Error("The admission check failed.");
        },
      })
    );
    expect({
      first,
      demoted,
      refused,
      broken,
      versions: await versionsAt(collectionId, path),
    }).toStrictEqual({
      first: 1,
      demoted: { error: "knowledge.forbidden" },
      refused: "permission.denied",
      broken: "Error: The admission check failed.",
      versions: 1,
    });
  });

  it("keep a workflow step's keyed saves apart from those it keys by their input", async () => {
    const setup = await setUp();
    const { admin, app, collectionId, permissionId } = setup;
    const stepKey = `${crypto.randomUUID()}:save`;
    const stepSave = async (input: ReturnType<typeof docSave>, key?: string) =>
      await saveRecordAsDelegate(
        env,
        {
          subject: { type: "app", appId: app },
          onBehalfOf: admin.userId,
          mode: "workflow",
          appVersion: 1,
        },
        { type: "app", appId: app },
        permissionId,
        collectionId,
        input,
        { app, method: "save" },
        undefined,
        (inputHash) => ({
          ...submissionOf(
            admin,
            app,
            collectionId,
            permissionId,
            "",
            inputHash,
            Date.now() + 60_000
          ),
          ...submissionKey(stepKey, key, inputHash),
        })
      );
    const first = docSave(`notes/${unique()}.md`, "First");
    const second = docSave(`notes/${unique()}.md`, "Second");
    await stepSave(first);
    // Keyed with what the first save's input hashes to.
    const keyed = await outcome(stepSave(second, await inputHashOf(first)));
    expect(keyed).toBe("ok");
  });

  it("answer a conflicted attempt with a newer one's save only after its own last check", async () => {
    const setup = await setUp();
    const { admin, app } = setup;
    const path = `notes/${unique()}.md`;
    const key = `conflicted-${unique()}`;
    let newer: unknown;
    // Once A has claimed and goes to read the document, B makes the same
    // save, then the App reads restricted data: A's caller may no longer
    // write, and A meets B's version before its last check.
    const racing = onFirstQuery(/from "documents"/iu, async () => {
      newer = await directSave(setup, docSave(path, "Plan"), { key });
      await restrict(
        env,
        {
          subject: { type: "app", appId: app },
          onBehalfOf: admin.userId,
          mode: "interactive",
          appVersion: 1,
        },
        { type: "app", appId: app },
        ["payroll"]
      );
    });
    const conflicted = await outcome(
      directSave(setup, docSave(path, "Plan"), { key, db: racing })
    );
    expect({
      newer: versionOf(summaryOf({ ok: newer })),
      conflicted,
      versions: await versionsAt(setup.collectionId, path),
    }).toStrictEqual({
      newer: 1,
      conflicted: "permission.restricted",
      versions: 1,
    });
  });

  it("don't commit once the call's deadline passed, by the database's clock, though the last check before the batch said yes", async () => {
    const setup = await setUp();
    const path = `notes/${unique()}.md`;
    const key = `late-${unique()}`;
    const deadline = Date.now() + 300;
    const late = await outcome(
      directSave(setup, docSave(path, "Plan"), {
        key,
        deadline,
        last: async () => {
          await scheduler.wait(400);
        },
      })
    );
    const afterLate = await versionsAt(setup.collectionId, path);
    const retried = await directSave(setup, docSave(path, "Plan"), { key });
    expect({ late, afterLate, retried: retried.currentVersion }).toStrictEqual({
      late: "app.caller_invalid",
      afterLate: 0,
      retried: 1,
    });
  });
});

describe("record saves from the same version", { timeout: 60_000 }, () => {
  it("let one in and refuse the other as a conflict", async () => {
    const setup = await setUp();
    const path = `notes/${unique()}.md`;
    await directSave(setup, docSave(path, "Plan"), { key: unique() });
    let racing: string | undefined;
    const first = await outcome(
      directSave(setup, docSave(path, "Mine", 1), {
        key: unique(),
        last: async () => {
          racing = await outcome(
            directSave(setup, docSave(path, "Theirs", 1), { key: unique() })
          );
        },
      })
    );
    expect({
      first,
      racing,
      versions: await versionsAt(setup.collectionId, path),
    }).toStrictEqual({
      first: "knowledge.conflict",
      racing: "ok",
      versions: 2,
    });
  });

  it("that change nothing make no version, keep a receipt, and are still refused once the record moved on", async () => {
    const setup = await setUp();
    const path = `notes/${unique()}.md`;
    const created = await directSave(setup, docSave(path, "Plan"), {
      key: unique(),
    });
    const key = `same-${unique()}`;
    const unchanged = await directSave(setup, docSave(path, "Plan", 1), {
      key,
    });
    const replayed = await directSave(setup, docSave(path, "Plan", 1), { key });
    const stale = await outcome(
      directSave(setup, docSave(path, "Plan", 1), {
        key: unique(),
        last: async () => {
          await directSave(setup, docSave(path, "Moved on", 1), {
            key: unique(),
          });
        },
      })
    );
    expect({
      unchanged,
      replayed,
      stale,
      versions: await versionsAt(setup.collectionId, path),
    }).toStrictEqual({
      unchanged: created,
      replayed: created,
      stale: "knowledge.conflict",
      versions: 2,
    });
  });
});

describe("record save receipts", { timeout: 60_000 }, () => {
  it("are kept their retention, and while their run is live, then refuse their key as expired until their tombstone goes", async () => {
    const setup = await setUp();
    const { admin, app, collectionId, permissionId } = setup;
    const runId = crypto.randomUUID();
    // A run that is still going, as the engine records it.
    await env.DB.prepare(
      "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at) VALUES (?, ?, 'saver', 1, ?, 'running', ?)"
    )
      .bind(runId, app, admin.userId, Date.now())
      .run();
    const path = `notes/${unique()}.md`;
    const key = `kept-${unique()}`;
    const input = docSave(path, "Plan");
    const stepKey = `${runId}:save`;
    const stepPath = `notes/${unique()}.md`;
    const stepInput = docSave(stepPath, "Step");
    const stepSave = async () =>
      await saveRecordAsDelegate(
        env,
        {
          subject: { type: "app", appId: app },
          onBehalfOf: admin.userId,
          mode: "workflow",
          appVersion: 1,
        },
        { type: "app", appId: app },
        permissionId,
        collectionId,
        stepInput,
        { app, method: "save" },
        undefined,
        (inputHash) => ({
          ...submissionOf(
            admin,
            app,
            collectionId,
            permissionId,
            key,
            inputHash,
            Date.now() + 60_000
          ),
          ...submissionKey(stepKey, undefined, inputHash),
        })
      );
    await directSave(setup, input, { key });
    await stepSave();
    const swept = async (days: number) => {
      await sweepReceipts(env, new Date(Date.now() + days * dayMs));
    };
    await swept(29);
    const within = await directSave(setup, input, { key });
    await swept(31);
    const expired = await outcome(directSave(setup, input, { key }));
    const runKept = await stepSave();
    await swept(62);
    const afterTombstone = await outcome(directSave(setup, input, { key }));
    expect({
      within: within.currentVersion,
      expired,
      runKept: runKept.currentVersion,
      stepVersions: await versionsAt(collectionId, stepPath),
      afterTombstone,
    }).toStrictEqual({
      within: 1,
      expired: "submission.expired",
      runKept: 1,
      stepVersions: 1,
      // Past every trace of the key, it can't be told from a new one: the
      // save is tried again, and its version check refuses it.
      afterTombstone: "knowledge.conflict",
    });
  });

  it("don't stall behind a live run's receipts: the others due expire in the same sweep", async () => {
    const setup = await setUp();
    const { admin, app, collectionId, permissionId } = setup;
    const runId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at) VALUES (?, ?, 'saver', 1, ?, 'running', ?)"
    )
      .bind(runId, app, admin.userId, Date.now())
      .run();
    const claimedAt = async (
      key: Json,
      daysAgo: number,
      runOf: string | null
    ) => {
      const inputHash = await inputHashOf({ key });
      await claim(
        env,
        {
          ...submissionOf(
            admin,
            app,
            collectionId,
            permissionId,
            "",
            inputHash,
            Date.now() + 60_000
          ),
          key,
          runId: runOf,
        },
        inputHash,
        new Date(Date.now() - daysAgo * dayMs)
      );
      return inputHash;
    };
    // More of the run's receipts due than a page holds, due first.
    await Promise.all(
      Array.from({ length: 120 }, async (_, index) => {
        await claimedAt(
          ["step", `${runId}:s${index}`, "input", `${index}`],
          32,
          runId
        );
      })
    );
    const plainKey: Json = ["call", `plain-${unique()}`];
    const plainHash = await claimedAt(plainKey, 31, null);
    await sweepReceipts(env, new Date());
    await expect(
      outcome(
        claim(
          env,
          {
            ...submissionOf(
              admin,
              app,
              collectionId,
              permissionId,
              "",
              plainHash,
              Date.now() + 60_000
            ),
            key: plainKey,
          },
          plainHash
        )
      )
    ).resolves.toBe("submission.expired");
  });

  it("count their retention from the commit, not the first claim", async () => {
    const setup = await setUp();
    const { admin, app, collectionId, permissionId } = setup;
    const path = `notes/${unique()}.md`;
    const key = `late-commit-${unique()}`;
    const input = docSave(path, "Plan");
    const inputHash = await inputHashOf(input);
    // An attempt claimed it 30 days ago and was killed.
    await claim(
      env,
      submissionOf(
        admin,
        app,
        collectionId,
        permissionId,
        key,
        inputHash,
        Date.now() + 60_000
      ),
      inputHash,
      new Date(Date.now() - 30 * dayMs)
    );
    const saved = await directSave(setup, input, { key });
    await sweepReceipts(env, new Date(Date.now() + 60_000));
    await expect(directSave(setup, input, { key })).resolves.toStrictEqual(
      saved
    );
  });

  it("keep the outcome of a commit landing between the sweep's read and its batch", async () => {
    const setup = await setUp();
    const { admin, app, collectionId, permissionId } = setup;
    const path = `notes/${unique()}.md`;
    const key = `racing-${unique()}`;
    const input = docSave(path, "Plan");
    const inputHash = await inputHashOf(input);
    await claim(
      env,
      submissionOf(
        admin,
        app,
        collectionId,
        permissionId,
        key,
        inputHash,
        Date.now() + 60_000
      ),
      inputHash,
      new Date(Date.now() - 31 * dayMs)
    );
    let saved: unknown;
    let raced = false;
    await sweepReceipts(
      {
        ...env,
        KNOWLEDGE: beforeBatch(async () => {
          if (!raced) {
            raced = true;
            saved = await directSave(setup, input, { key });
          }
        }),
      },
      new Date()
    );
    expect({
      raced,
      again: await directSave(setup, input, { key }),
      versions: await versionsAt(collectionId, path),
    }).toStrictEqual({ raced: true, again: saved, versions: 1 });
  });

  it("never sweep a receipt claimed again past its retention while that claim is in flight", async () => {
    const setup = await setUp();
    const { admin, app, collectionId, permissionId } = setup;
    const path = `notes/${unique()}.md`;
    const key = `expiring-${unique()}`;
    const input = docSave(path, "Plan");
    const inputHash = await inputHashOf(input);
    await claim(
      env,
      submissionOf(
        admin,
        app,
        collectionId,
        permissionId,
        key,
        inputHash,
        Date.now() + 60_000
      ),
      inputHash,
      new Date(Date.now() - 31 * dayMs)
    );
    const late = await outcome(
      directSave(setup, input, {
        key,
        // The sweep runs between the claim and the commit.
        last: async () => {
          await sweepReceipts(env, new Date());
        },
      })
    );
    expect({
      late,
      versions: await versionsAt(collectionId, path),
    }).toStrictEqual({ late: "ok", versions: 1 });
  });
});

describe("record save outboxes", { timeout: 60_000 }, () => {
  it("are committed with the change and its receipt, once, with only what the save staged", async () => {
    const setup = await setUp();
    const path = `notes/${unique()}.md`;
    const key = `outbox-${unique()}`;
    const marker = unique();
    const consumers = consumersFor(marker);
    const notify: SubmissionIntent = {
      kind: "workflow.notify",
      data: { marker, runId: "run-1", event: "noteSaved" },
    };
    const start: SubmissionIntent = {
      kind: "workflow.start",
      data: { marker, workflow: "review" },
    };
    const save = async (last?: () => Promise<void>) =>
      await directSave(setup, docSave(path, "Plan"), {
        key,
        intents: [notify, start],
        consumers,
        ...(last === undefined ? {} : { last }),
      });
    // A newer attempt claims and commits just before this one's batch.
    const stale = await outcome(
      save(async () => {
        await save();
      })
    );
    const replayed = await outcome(save());
    const unchanged = await directSave(setup, docSave(path, "Plan", 1), {
      key: unique(),
      consumers,
    });
    const entries = await entriesOf(marker);
    expect({
      stale,
      replayed,
      unchanged: unchanged.currentVersion,
      kinds: entries.map(({ kind }) => kind),
      intents: entries.map(({ intent }) => intent),
      // One receipt's, numbered in order.
      ids: entries.map(({ id }) => id.replace(/^[0-9a-f]{64}:/u, "")),
      versions: await versionsAt(setup.collectionId, path),
    }).toStrictEqual({
      stale: "ok",
      replayed: "ok",
      unchanged: 1,
      kinds: ["workflow.notify", "workflow.start"],
      intents: [notify, start],
      ids: ["0", "1"],
      versions: 1,
    });
  });

  it("refuse an intent nothing takes before anything is saved", async () => {
    const setup = await setUp();
    const path = `notes/${unique()}.md`;
    const marker = unique();
    const refused = await outcome(
      directSave(setup, docSave(path, "Plan"), {
        key: unique(),
        intents: [{ kind: "workflow.notify", data: { marker } }],
      })
    );
    const partly = await outcome(
      directSave(setup, docSave(path, "Plan"), {
        key: unique(),
        intents: [{ kind: "workflow.start", data: { marker } }],
        consumers: {
          "workflow.notify": consumersFor(marker)["workflow.notify"],
        },
      })
    );
    expect({
      refused,
      partly,
      versions: await versionsAt(setup.collectionId, path),
      entries: await entriesOf(marker),
    }).toStrictEqual({
      refused: "submission.intent_unsupported",
      partly: "submission.intent_unsupported",
      versions: 0,
      entries: [],
    });
  });

  it("are handed over until taken, under the same ID, without making the change again", async () => {
    const setup = await setUp();
    const path = `notes/${unique()}.md`;
    const marker = unique();
    const handed: OutboxEntry[] = [];
    let failing = true;
    const consumers = consumersFor(marker, async (entry) => {
      handed.push(entry);
      if (entry.intent.kind === "workflow.start") {
        return await Promise.resolve({ undeliverable: "workflow.not_found" });
      }
      if (failing) {
        throw new Error("The consumer is down.");
      }
      return "delivered";
    });
    await directSave(setup, docSave(path, "Plan"), {
      key: unique(),
      intents: [
        { kind: "workflow.notify", data: { marker } },
        { kind: "workflow.start", data: { marker } },
      ],
      consumers,
    });
    await drainSubmissionOutbox(env, consumers);
    const afterFailure = await entriesOf(marker);
    failing = false;
    // Not before its backoff, then once it is due.
    await drainSubmissionOutbox(env, consumers);
    const early = await entriesOf(marker);
    await drainSubmissionOutbox(env, consumers, {
      now: new Date(Date.now() + 60 * 60 * 1000),
    });
    const settledEntries = await entriesOf(marker);
    const notified = handed.filter(
      ({ intent }) => intent.kind === "workflow.notify"
    );
    expect({
      afterFailure: afterFailure.map(({ settled, attempts }) => ({
        settled,
        attempts,
      })),
      early: early.map(({ settled }) => settled),
      handed: notified.map(({ id, attempts }) => ({ id, attempts })),
      settled: settledEntries.map(({ settled, undeliverable }) => ({
        settled,
        undeliverable,
      })),
      versions: await versionsAt(setup.collectionId, path),
    }).toStrictEqual({
      afterFailure: [
        { settled: false, attempts: 1 },
        { settled: true, attempts: 0 },
      ],
      early: [false, true],
      handed: [
        { id: afterFailure[0]?.id, attempts: 0 },
        { id: afterFailure[0]?.id, attempts: 1 },
      ],
      settled: [
        { settled: true, undeliverable: null },
        { settled: true, undeliverable: "workflow.not_found" },
      ],
      versions: 1,
    });
  });

  it("are handed over once by drains running at once", async () => {
    const setup = await setUp();
    const marker = unique();
    const handed: string[] = [];
    const consumers = consumersFor(marker, async (entry) => {
      handed.push(entry.id);
      await scheduler.wait(200);
      return "delivered";
    });
    await directSave(setup, docSave(`notes/${unique()}.md`, "Plan"), {
      key: unique(),
      intents: [
        { kind: "workflow.notify", data: { marker, n: 1 } },
        { kind: "workflow.notify", data: { marker, n: 2 } },
      ],
      consumers,
    });
    await Promise.all([
      drainSubmissionOutbox(env, consumers),
      drainSubmissionOutbox(env, consumers),
      drainSubmissionOutbox(env, consumers),
    ]);
    const entries = await entriesOf(marker);
    expect({
      handed: handed.toSorted(),
      settled: entries.map(({ settled }) => settled),
    }).toStrictEqual({
      handed: entries.map(({ id }) => id).toSorted(),
      settled: [true, true],
    });
  });

  it("are all handed over by one drain, page after page", async () => {
    const setup = await setUp();
    const marker = unique();
    const consumers = consumersFor(marker);
    await directSave(setup, docSave(`notes/${unique()}.md`, "Plan"), {
      key: unique(),
      intents: Array.from({ length: 120 }, (_, n) => ({
        kind: "workflow.notify" as const,
        data: { marker, n },
      })),
      consumers,
    });
    await drainSubmissionOutbox(env, consumers);
    const entries = await entriesOf(marker);
    expect({
      count: entries.length,
      unsettled: entries.filter(({ settled }) => !settled).length,
    }).toStrictEqual({ count: 120, unsettled: 0 });
  });

  it("lease each entry when its turn comes, so a drain started meanwhile hands none over again", async () => {
    const setup = await setUp();
    const marker = unique();
    const handed: string[] = [];
    // Slower than a hand-over may take: each one fails, and is put back.
    const consumers = consumersFor(marker, async (entry) => {
      handed.push(entry.id);
      await scheduler.wait(30);
      return "delivered";
    });
    await directSave(setup, docSave(`notes/${unique()}.md`, "Plan"), {
      key: unique(),
      intents: Array.from({ length: 12 }, (_, n) => ({
        kind: "workflow.notify" as const,
        data: { marker, n },
      })),
      consumers,
    });
    const first = drainSubmissionOutbox(env, consumers, { timeoutMs: 20 });
    await scheduler.wait(150);
    await drainSubmissionOutbox(env, consumers, { timeoutMs: 20 });
    await first;
    const entries = await entriesOf(marker);
    const ids = entries.map(({ id }) => id);
    expect(handed.toSorted()).toStrictEqual(ids.toSorted());
  });

  it("hand over one entry with no budget left, and stop", async () => {
    const setup = await setUp();
    const marker = unique();
    let calls = 0;
    const consumers = consumersFor(marker);
    const counting: OutboxConsumers = {
      "workflow.notify": async (entry) => {
        calls += 1;
        return await (consumers["workflow.notify"]?.(entry) ?? "delivered");
      },
    };
    await directSave(setup, docSave(`notes/${unique()}.md`, "Plan"), {
      key: unique(),
      intents: Array.from({ length: 3 }, (_, n) => ({
        kind: "workflow.notify" as const,
        data: { marker, n },
      })),
      consumers,
    });
    await drainSubmissionOutbox(env, counting, { budgetMs: 0 });
    const entries = await entriesOf(marker);
    expect({
      calls,
      unsettled: entries.filter(({ settled }) => !settled).length,
    }).toStrictEqual({ calls: 1, unsettled: 2 });
  });

  it("give up on a consumer that hangs or keeps failing only after their attempts, settling the entry", async () => {
    const setup = await setUp();
    const marker = unique();
    // Never settles.
    const hanging = Promise.withResolvers<never>().promise;
    const consumers = consumersFor(marker, async (entry) => {
      if (
        z
          .object({ hang: z.literal(true) })
          .safeParse(
            entry.intent.kind === "record.changed" ? null : entry.intent.data
          ).success
      ) {
        return await hanging;
      }
      await Promise.resolve();
      throw new Error("The consumer is down.");
    });
    await directSave(setup, docSave(`notes/${unique()}.md`, "Plan"), {
      key: unique(),
      intents: [
        { kind: "workflow.notify", data: { marker, hang: true } },
        { kind: "workflow.notify", data: { marker, hang: false } },
      ],
      consumers,
    });
    await drainSubmissionOutbox(env, consumers, { timeoutMs: 100 });
    const afterOne = await entriesOf(marker);
    // Each later attempt once its backoff is over.
    for (let attempt = 1; attempt < maxAttempts + 2; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt after the other
      await drainSubmissionOutbox(env, consumers, {
        now: new Date(Date.now() + attempt * 2 * 60 * 60 * 1000),
        timeoutMs: 100,
      });
    }
    const finalEntries = await entriesOf(marker);
    expect({
      afterOne: afterOne.map(({ settled, attempts }) => ({
        settled,
        attempts,
      })),
      after: finalEntries.map(({ settled, attempts, undeliverable }) => ({
        settled,
        attempts,
        undeliverable,
      })),
    }).toStrictEqual({
      afterOne: [
        { settled: false, attempts: 1 },
        { settled: false, attempts: 1 },
      ],
      after: [
        {
          settled: true,
          attempts: maxAttempts,
          undeliverable: "outbox.attempts_exhausted",
        },
        {
          settled: true,
          attempts: maxAttempts,
          undeliverable: "outbox.attempts_exhausted",
        },
      ],
    });
  });

  it("keep their receipt and entries while an entry is owed, also against a commit landing under the sweep", async () => {
    const setup = await setUp();
    const { admin, app, collectionId, permissionId } = setup;
    const marker = unique();
    const path = `notes/${unique()}.md`;
    const key = `owed-${unique()}`;
    const input = docSave(path, "Plan");
    const intents: SubmissionIntent[] = [
      { kind: "workflow.notify", data: { marker } },
    ];
    // Consumers that never take it, for now.
    const down = consumersFor(marker, async () => {
      await Promise.resolve();
      throw new Error("The consumer is down.");
    });
    const saved = await directSave(setup, input, {
      key,
      intents,
      consumers: down,
    });
    const late = new Date(Date.now() + 31 * dayMs);
    await drainSubmissionOutbox(env, down);
    await sweepReceipts(env, late);
    const owed = await directSave(setup, input, {
      key,
      intents,
      consumers: down,
    });
    const owedEntries = await entriesOf(marker);
    // A save claimed long ago commits, with an intent, under the sweep.
    const racingPath = `notes/${unique()}.md`;
    const racingKey = `racing-${unique()}`;
    const racingInput = docSave(racingPath, "Plan");
    const racingHash = await inputHashOf(racingInput);
    await claim(
      env,
      submissionOf(
        admin,
        app,
        collectionId,
        permissionId,
        racingKey,
        racingHash,
        Date.now() + 60_000
      ),
      racingHash,
      new Date(Date.now() - 31 * dayMs)
    );
    let racing: unknown;
    await sweepReceipts(
      {
        ...env,
        KNOWLEDGE: beforeBatch(async () => {
          if (racing === undefined) {
            racing = await directSave(setup, racingInput, {
              key: racingKey,
              intents: [
                { kind: "workflow.notify", data: { marker, racing: true } },
              ],
              consumers: down,
            });
          }
        }),
      },
      new Date()
    );
    const racingAgain = await directSave(setup, racingInput, {
      key: racingKey,
      intents: [{ kind: "workflow.notify", data: { marker, racing: true } }],
      consumers: down,
    });
    const afterRace = await entriesOf(marker);
    // Taken at last: then it expires.
    await drainSubmissionOutbox(env, consumersFor(marker), {
      now: new Date(late.getTime() + 2 * 60 * 60 * 1000),
    });
    await sweepReceipts(env, new Date(late.getTime() + 3 * 60 * 60 * 1000));
    expect({
      owed,
      owedEntries: owedEntries.map(({ settled }) => settled),
      racingAgain,
      afterRace: afterRace.map(({ settled }) => settled),
      expired: await outcome(
        directSave(setup, input, { key, intents, consumers: down })
      ),
    }).toStrictEqual({
      owed: saved,
      owedEntries: [false],
      racingAgain: racing,
      afterRace: [false, false],
      expired: "submission.expired",
    });
  });

  it("let only the drain holding an entry's lease settle it", async () => {
    const setup = await setUp();
    const marker = unique();
    const held = Promise.withResolvers<null>();
    const slow = consumersFor(marker, async () => {
      await held.promise;
      return "delivered";
    });
    const failing = consumersFor(marker, async () => {
      await Promise.resolve();
      throw new Error("The consumer is down.");
    });
    await directSave(setup, docSave(`notes/${unique()}.md`, "Plan"), {
      key: unique(),
      intents: [{ kind: "workflow.notify", data: { marker } }],
      consumers: slow,
    });
    // The first drain takes the entry and is slow; by the time it is done
    // another, an hour on, found the lease run out and took it over.
    const first = drainSubmissionOutbox(env, slow, { timeoutMs: 5000 });
    await scheduler.wait(100);
    await drainSubmissionOutbox(env, failing, {
      now: new Date(Date.now() + 60 * 60 * 1000),
    });
    held.resolve(null);
    await first;
    const entries = await entriesOf(marker);
    expect(
      entries.map(({ settled, attempts }) => ({ settled, attempts }))
    ).toStrictEqual([{ settled: false, attempts: 1 }]);
  });

  it("don't stall behind receipts whose entries are owed: the others due expire in the same sweep", async () => {
    const setup = await setUp();
    const { admin, app, collectionId, permissionId } = setup;
    const marker = unique();
    const down = consumersFor(marker, async () => {
      await Promise.resolve();
      throw new Error("The consumer is down.");
    });
    await Promise.all(
      Array.from({ length: 110 }, async () => {
        await directSave(setup, docSave(`notes/${unique()}.md`, "Owed"), {
          key: unique(),
          intents: [{ kind: "workflow.notify", data: { marker } }],
          consumers: down,
        });
      })
    );
    // Due after all of them.
    const plainKey: Json = ["call", `plain-${unique()}`];
    const plainHash = await inputHashOf({ plainKey });
    const plain = {
      ...submissionOf(
        admin,
        app,
        collectionId,
        permissionId,
        "",
        plainHash,
        Date.now() + 60_000
      ),
      key: plainKey,
    };
    await claim(env, plain, plainHash, new Date(Date.now() + dayMs));
    await sweepReceipts(env, new Date(Date.now() + 32 * dayMs), 5000);
    await expect(outcome(claim(env, plain, plainHash))).resolves.toBe(
      "submission.expired"
    );
  });
});
