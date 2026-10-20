import { GraspError } from "@grasp-os/sdk/client";
import { GraspClient } from "@grasp-os/sdk/host";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import type { Json } from "@grasp-os/shared/json";
import type { Role } from "@grasp-os/shared/roles";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import {
  appFunctionPath,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import { maxSubmissionsPerApp } from "@grasp-os/shared/submissions";
import type { ScreenSubmission } from "@grasp-os/shared/submissions";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { readFunctionRequest } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import {
  noteScreenAnswer,
  noteScreenSubmission,
  screenSubmissionReceived,
  sweepScreenSubmissions,
} from "../src/screen-submissions.ts";
import { mockIdp } from "./idp.ts";
import { referenceTo } from "./notes-client-app.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  openRpc,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// Cross-screen receipt recovery (screen-submissions.ts, spec 10.7.8),
// from its threat model: a screen's keyed submission is indexed for the
// person who sent it, until their page acknowledges its answer; listing
// says how each came out from its receipt alone, never what it changed or
// answered, never runs it again, and shows nobody else's.

const idp = mockIdp();

const files: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(200) }),
});
`,
  "operations/notes.ts": `import { AppError, v } from "@grasp-os/sdk";
import { action, mutation, query } from "#grasp/server";

export const create = mutation({
  args: { title: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map((note) => note.title),
});

export const add = action({
  args: { title: v.string() },
  returns: v.string(),
  uses: [create],
  handler: async (ctx, args) => {
    await ctx.runMutation(create, { title: args.title });
    return args.title;
  },
});

const pause = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

// Takes a while before it saves: a build revoked meanwhile gets no answer.
export const slowCreate = mutation({
  args: { title: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => {
    await pause(2000);
    return await ctx.db.insert("notes", args);
  },
});

// Still running for a while after it was asked.
export const slowAdd = action({
  args: { title: v.string() },
  returns: v.string(),
  uses: [create],
  handler: async (ctx, args) => {
    await pause(3000);
    await ctx.runMutation(create, { title: args.title });
    return args.title;
  },
});

export const reject = mutation({
  args: { title: v.string() },
  returns: v.null(),
  handler: async () => {
    throw new AppError("note.closed", "Notes are closed today.");
  },
});

export const addThenFail = action({
  args: { title: v.string() },
  returns: v.null(),
  uses: [create],
  handler: async (ctx, args) => {
    await ctx.runMutation(create, { title: args.title });
    throw new AppError("note.after_create", "Created, then failed.");
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { add, addThenFail, create, reject, slowAdd, slowCreate, titles } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  operations: { notes: { add, addThenFail, create, reject, slowAdd, slowCreate, titles } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
  "screens/notes.tsx": `export default function Notes() {
  return <p>Notes</p>;
}
`,
};

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

/** A builder's Notes App, activated, its screen's build approved. */
const approvedApp = async () => {
  const builder = await personApi("builder");
  const admin = await personApi("admin");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await builder.api.apps.files.commit(id, files, "First");
  await builder.api.apps.versions.setCurrent(id, version);
  const review = await admin.api.screenTrust.review(id);
  await admin.api.screenTrust.approve(id, {
    version: review.version,
    generation: review.generation,
    artifacts: builtArtifacts(review.screens),
  });
  const { lease } = await builder.api.screens.open(id, "notes");
  const release = await loadRelease(env, id, version);
  return {
    builder,
    admin,
    app: id,
    lease,
    release,
    artifacts: builtArtifacts(review.screens),
  };
};

type Approved = Awaited<ReturnType<typeof approvedApp>>;

/** A call's request, as the screen client writes it. */
const requestFor = (
  { release }: Approved,
  path: string,
  input: Json,
  idempotencyKey?: string
): string =>
  JSON.stringify({
    reference: {
      resourceId: release.manifest.resourceId,
      resourceVersion: release.manifest.resourceVersion,
      contractId: path,
      fingerprint: release.fingerprints[path],
      kind: release.app.operations[path]?.kind,
    },
    input,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });

/** Calls `request` as the builder's approved screen does: its result. */
const called = async (
  approved: Approved,
  request: string
): Promise<unknown> => {
  const response = await routed(`${appFunctionPath}/${approved.app}`, {
    method: "POST",
    headers: {
      origin: clientOrigin,
      "content-type": "application/json",
      cookie: approved.builder.session,
      [screenPersonHeader]: approved.builder.userId,
      [screenLeaseHeader]: approved.lease,
    },
    body: request,
  });
  expect(response.status).toBe(200);
  const answer: unknown = await response.json();
  return typeof answer === "object" && answer !== null
    ? Reflect.get(answer, "result")
    : undefined;
};

/** What `person` is told of their submissions, by operation and status. */
const statuses = async (
  person: Person
): Promise<Pick<ScreenSubmission, "operation" | "status" | "failure">[]> => {
  const listed = await person.api.screenSubmissions.list();
  return listed.map(({ operation, status, failure }) => ({
    operation,
    status,
    failure,
  }));
};

/**
 * Moves every claimed receipt of `approved`'s store past its claim's
 * deadline: the attempts that claimed them can't commit any more.
 */
const pastClaims = async ({ release }: Approved): Promise<void> => {
  const storeId = release.store?.storeId;
  if (storeId === undefined) {
    throw new Error("The Notes App has a store");
  }
  await runInDurableObject(
    inJurisdiction(env, env.DATA_STORES).getByName(storeId),
    (_object, state) => {
      state.storage.sql.exec(
        "UPDATE sdk_mutation_receipts SET deadline = 1 WHERE committed_at IS NULL"
      );
    }
  );
};

/** The notes the App holds. */
const titlesOf = async (approved: Approved): Promise<unknown> =>
  await called(approved, requestFor(approved, "notes.titles", {}));

describe("recovering a screen's submissions", { timeout: 120_000 }, () => {
  it("lists a keyed submission the page never acknowledged, by status alone, until it does", async () => {
    const approved = await approvedApp();
    const saved = requestFor(approved, "notes.create", { title: "A" }, "k-1");
    await called(approved, saved);
    // No key: nothing to recover it by.
    await called(
      approved,
      requestFor(approved, "notes.create", { title: "B" })
    );
    const listed = await approved.builder.api.screenSubmissions.list();
    await screenSubmissionReceived(env, approved.builder, approved.app, saved);
    expect({
      listed: listed.map((submission) => Object.keys(submission).toSorted()),
      statuses: listed.map(({ app, kind, operation, status, failure }) => ({
        app,
        kind,
        operation,
        status,
        failure,
      })),
      after: await approved.builder.api.screenSubmissions.list(),
    }).toStrictEqual({
      // Nothing it changed or answered, nor its key.
      listed: [
        ["app", "createdAt", "failure", "id", "kind", "operation", "status"],
      ],
      statuses: [
        {
          app: approved.app,
          kind: "mutation",
          operation: "notes.create",
          status: "saved",
          failure: null,
        },
      ],
      after: [],
    });
  });

  it("says how an action came out, never what it answered, and runs nothing again to tell", async () => {
    const approved = await approvedApp();
    await called(
      approved,
      requestFor(approved, "notes.add", { title: "Added" }, "a-1")
    );
    await called(
      approved,
      requestFor(approved, "notes.addThenFail", { title: "Failed" }, "a-2")
    );
    const first = await statuses(approved.builder);
    const second = await statuses(approved.builder);
    expect({
      first,
      second,
      // Each ran once: listing twice made no note.
      titles: await titlesOf(approved),
    }).toStrictEqual({
      first: [
        { operation: "notes.addThenFail", status: "failed", failure: "domain" },
        { operation: "notes.add", status: "saved", failure: null },
      ],
      second: first,
      titles: { ok: true, value: ["Added", "Failed"] },
    });
  });

  it("shows nobody else a person's submissions, nor lets them forget one", async () => {
    const approved = await approvedApp();
    const request = requestFor(
      approved,
      "notes.create",
      { title: "Mine" },
      "m-1"
    );
    await called(approved, request);
    const other = await personApi("admin");
    const [mine] = await approved.builder.api.screenSubmissions.list();
    await other.api.screenSubmissions.dismiss(mine?.id ?? "none");
    await screenSubmissionReceived(env, other, approved.app, request);
    expect({
      theirs: await other.api.screenSubmissions.list(),
      mine: await statuses(approved.builder),
    }).toStrictEqual({
      theirs: [],
      mine: [{ operation: "notes.create", status: "saved", failure: null }],
    });
  });

  it("says a submission no receipt was claimed for, once its time is past, wasn't saved", async () => {
    const approved = await approvedApp();
    // Refused as invalid before the store claimed anything under its key.
    await called(
      approved,
      requestFor(approved, "notes.create", { title: "" }, "n-1")
    );
    const soon = await statuses(approved.builder);
    await env.DB.prepare(
      "UPDATE screen_submissions SET created_at = ? WHERE person_id = ?"
    )
      .bind(Date.now() - 5 * 60_000, approved.builder.userId)
      .run();
    expect({ soon, later: await statuses(approved.builder) }).toStrictEqual({
      soon: [{ operation: "notes.create", status: "pending", failure: null }],
      later: [
        { operation: "notes.create", status: "not_saved", failure: null },
      ],
    });
  });

  it("hides the submissions of an App the person can no longer open", async () => {
    const approved = await approvedApp();
    const admin = await personApi("admin");
    const { generation } = await admin.api.screenTrust.review(approved.app);
    await admin.api.screenTrust.classify(approved.app, "ordinary", generation);
    const member = await personApi("user");
    await approved.builder.api.apps.members.add(approved.app, {
      type: "person",
      id: member.userId,
      role: "user",
    });
    const response = await routed(`${appFunctionPath}/${approved.app}`, {
      method: "POST",
      headers: {
        origin: clientOrigin,
        "content-type": "application/json",
        cookie: member.session,
        [screenPersonHeader]: member.userId,
      },
      body: requestFor(approved, "notes.create", { title: "Theirs" }, "h-1"),
    });
    expect(response.status).toBe(200);
    const before = await statuses(member);
    await approved.builder.api.apps.members.remove(approved.app, {
      type: "person",
      id: member.userId,
    });
    expect({ before, after: await statuses(member) }).toStrictEqual({
      before: [{ operation: "notes.create", status: "saved", failure: null }],
      after: [],
    });
  });

  it("notes no more of one App past its cap, and never evicts another App's, nor any App's own", async () => {
    const approved = await approvedApp();
    const by = approved.builder;
    // The same release, as another App's: only its App's ID is read.
    const asApp = (app: string) => ({
      ...approved.release,
      manifest: { ...approved.release.manifest, resourceId: app },
    });
    const noteAs = async (app: string, count: number) => {
      for (let index = 0; index < count; index += 1) {
        const request = requestFor(
          approved,
          "notes.create",
          { title: "Many" },
          `${app}-${index}`
        );
        // oxlint-disable-next-line no-await-in-loop -- one after another
        await noteScreenSubmission(
          env,
          by,
          asApp(app),
          readFunctionRequest(request),
          "notes.create"
        );
      }
    };
    await noteAs("first", maxSubmissionsPerApp);
    // Past its own cap: noted nothing more, the first App's all kept.
    await noteAs("second", maxSubmissionsPerApp + 10);
    // Past the person's: nothing of a third App.
    await noteAs("third", 5);
    const counts = await env.DB.prepare(
      "SELECT app_id AS app, count(*) AS n, min(idempotency_key) AS oldest FROM screen_submissions WHERE person_id = ? GROUP BY app_id ORDER BY app_id"
    )
      .bind(by.userId)
      .all<{ app: string; n: number; oldest: string }>();
    expect(counts.results).toStrictEqual([
      { app: "first", n: maxSubmissionsPerApp, oldest: "first-0" },
      { app: "second", n: maxSubmissionsPerApp, oldest: "second-0" },
    ]);
  });

  it("keeps the row of a change committed under a build revoked before its answer, and lists it saved", async () => {
    const approved = await approvedApp();
    const received: string[] = [];
    const client = new GraspClient({
      call: async (request) => {
        const response = await routed(`${appFunctionPath}/${approved.app}`, {
          method: "POST",
          headers: {
            origin: clientOrigin,
            "content-type": "application/json",
            cookie: approved.builder.session,
            [screenPersonHeader]: approved.builder.userId,
            [screenLeaseHeader]: approved.lease,
          },
          body: request,
        });
        const answer: unknown = await response.json();
        if (response.ok) {
          return answer;
        }
        // As the page does: core's refusal, by its code.
        const { code, message } = errorPayloadSchema.parse(answer);
        throw Object.assign(new Error(message), { code });
      },
      // As the frame's way to core does, but for what the client tells it.
      received: (request) => {
        received.push(request);
        void screenSubmissionReceived(
          env,
          approved.builder,
          approved.app,
          request
        );
      },
      watch: async () => await Promise.reject(new Error("Nothing followed.")),
    });
    const saving = (async (): Promise<string> => {
      try {
        await client.mutation(
          referenceTo<{ title: string }, string, "mutation">(
            approved.release,
            "notes.slowCreate"
          ),
          { title: "Committed" },
          { idempotencyKey: "revoked-mid-run" }
        );
        return "ok";
      } catch (error) {
        return error instanceof GraspError ? error.code : "threw";
      }
    })();
    // Revoked while it runs: it commits, and its answer is refused.
    await scheduler.wait(500);
    for (const artifact of approved.artifacts) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await approved.admin.api.screenTrust.revoke(approved.app, artifact);
    }
    expect({
      saving: await saving,
      received,
      listed: await statuses(approved.builder),
    }).toStrictEqual({
      saving: "screen.revoked",
      received: [],
      listed: [
        { operation: "notes.slowCreate", status: "saved", failure: null },
      ],
    });
  });

  it("forgets nothing for an acknowledgement before the receipt settled: a running action reads as pending, and keeps its row", async () => {
    const approved = await approvedApp();
    const request = requestFor(
      approved,
      "notes.slowAdd",
      { title: "Later" },
      "early-ack"
    );
    const running = called(approved, request);
    await scheduler.wait(1000);
    await screenSubmissionReceived(
      env,
      approved.builder,
      approved.app,
      request
    );
    const whileRunning = await statuses(approved.builder);
    await running;
    expect({
      whileRunning,
      after: await statuses(approved.builder),
    }).toStrictEqual({
      whileRunning: [
        { operation: "notes.slowAdd", status: "pending", failure: null },
      ],
      after: [{ operation: "notes.slowAdd", status: "saved", failure: null }],
    });
  });

  it("ignores another App's reference acknowledged through a frame's own way to its App", async () => {
    const first = await approvedApp();
    const second = await approvedApp();
    // The same person's, in the second App.
    await second.builder.api.apps.members.add(second.app, {
      type: "person",
      id: first.builder.userId,
      role: "user",
    });
    const theirs = requestFor(second, "notes.create", { title: "B" }, "b-1");
    await noteScreenSubmission(
      env,
      first.builder,
      second.release,
      readFunctionRequest(theirs),
      "notes.create"
    );
    const frame = await first.builder.api.screens.frame(first.app, first.lease);
    await frame.received(theirs);
    const row = await env.DB.prepare(
      "SELECT count(*) AS n FROM screen_submissions WHERE person_id = ? AND app_id = ?"
    )
      .bind(first.builder.userId, second.app)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("forgets the owner's own on dismissal, and expired rows on the sweep, and lists none past expiry", async () => {
    const approved = await approvedApp();
    await called(
      approved,
      requestFor(approved, "notes.create", { title: "A" }, "d-1")
    );
    await called(
      approved,
      requestFor(approved, "notes.create", { title: "B" }, "d-2")
    );
    const [newest] = await approved.builder.api.screenSubmissions.list();
    await approved.builder.api.screenSubmissions.dismiss(newest?.id ?? "none");
    const afterDismiss = await statuses(approved.builder);
    await env.DB.prepare(
      "UPDATE screen_submissions SET expires_at = ? WHERE person_id = ?"
    )
      .bind(Date.now() - 1000, approved.builder.userId)
      .run();
    const pastExpiry = await statuses(approved.builder);
    await sweepScreenSubmissions(env, new Date());
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM screen_submissions WHERE person_id = ?"
    )
      .bind(approved.builder.userId)
      .first<{ n: number }>();
    expect({ afterDismiss, pastExpiry, left: left?.n }).toStrictEqual({
      afterDismiss: [
        { operation: "notes.create", status: "saved", failure: null },
      ],
      pastExpiry: [],
      left: 0,
    });
  });

  it("reads a keyed mutation whose handler failed as failed at once, and forgets it once acknowledged", async () => {
    const approved = await approvedApp();
    const request = requestFor(
      approved,
      "notes.reject",
      { title: "No" },
      "f-1"
    );
    await called(approved, request);
    // Its own claim, nobody's since: failed at once.
    const before = await statuses(approved.builder);
    await screenSubmissionReceived(
      env,
      approved.builder,
      approved.app,
      request
    );
    expect({
      before,
      after: await approved.builder.api.screenSubmissions.list(),
    }).toStrictEqual({
      before: [
        { operation: "notes.reject", status: "failed", failure: "domain" },
      ],
      after: [],
    });
  });

  it("clears an earlier attempt's failure when the same key is sent again", async () => {
    const approved = await approvedApp();
    const request = requestFor(
      approved,
      "notes.reject",
      { title: "No" },
      "f-2"
    );
    await called(approved, request);
    await pastClaims(approved);
    const failed = await statuses(approved.builder);
    // Admitted again under its key: until core answers, the earlier
    // failure says nothing of how it stands.
    await noteScreenSubmission(
      env,
      approved.builder,
      approved.release,
      readFunctionRequest(request),
      "notes.reject"
    );
    const retried = await env.DB.prepare(
      "SELECT failed_category AS failed FROM screen_submissions WHERE person_id = ?"
    )
      .bind(approved.builder.userId)
      .first<{ failed: string | null }>();
    // And once more, as a release whose store is another: the row follows
    // the latest attempt's receipt.
    const { store } = approved.release;
    await noteScreenSubmission(
      env,
      approved.builder,
      {
        ...approved.release,
        manifest: { ...approved.release.manifest, resourceVersion: 2 },
        store: store === null ? null : { ...store, storeId: "moved-store" },
      },
      readFunctionRequest(request),
      "notes.reject"
    );
    const moved = await env.DB.prepare(
      "SELECT store_id AS store, app_version AS version FROM screen_submissions WHERE person_id = ?"
    )
      .bind(approved.builder.userId)
      .first<{ store: string | null; version: number }>();
    expect({ failed, retried: retried?.failed, moved }).toStrictEqual({
      failed: [
        { operation: "notes.reject", status: "failed", failure: "domain" },
      ],
      retried: null,
      moved: { store: "moved-store", version: 2 },
    });
  });

  it("reads a key sent again as pending, whenever it was first noted", async () => {
    const approved = await approvedApp();
    // Refused before the store claimed anything: no receipt under its key.
    const request = requestFor(approved, "notes.create", { title: "" }, "r-1");
    await called(approved, request);
    await env.DB.prepare(
      "UPDATE screen_submissions SET created_at = ? WHERE person_id = ?"
    )
      .bind(Date.now() - 5 * 60_000, approved.builder.userId)
      .run();
    const stale = await statuses(approved.builder);
    const attempt = await noteScreenSubmission(
      env,
      approved.builder,
      approved.release,
      readFunctionRequest(request),
      "notes.create"
    );
    // A frame's acknowledgement now forgets nothing: it is pending again.
    await screenSubmissionReceived(
      env,
      approved.builder,
      approved.app,
      request
    );
    expect({
      stale,
      attempt,
      again: await statuses(approved.builder),
    }).toStrictEqual({
      stale: [
        { operation: "notes.create", status: "not_saved", failure: null },
      ],
      attempt: 2,
      again: [{ operation: "notes.create", status: "pending", failure: null }],
    });
  });

  it("marks a row failed only by its own attempt's answer, never a late one of an earlier attempt", async () => {
    const approved = await approvedApp();
    const request = requestFor(
      approved,
      "notes.reject",
      { title: "No" },
      "l-1"
    );
    const call = readFunctionRequest(request);
    const first = await noteScreenSubmission(
      env,
      approved.builder,
      approved.release,
      call,
      "notes.reject"
    );
    const second = await noteScreenSubmission(
      env,
      approved.builder,
      approved.release,
      call,
      "notes.reject"
    );
    const failure = {
      ok: false,
      error: { code: "note.closed", category: "domain" },
    };
    const failedBy = async (attempt: number): Promise<unknown> => {
      await noteScreenAnswer(
        env,
        approved.builder,
        approved.app,
        request,
        failure,
        { attempt, fence: null }
      );
      const row = await env.DB.prepare(
        "SELECT failed_category AS failed FROM screen_submissions WHERE person_id = ?"
      )
        .bind(approved.builder.userId)
        .first<{ failed: string | null }>();
      return row?.failed;
    };
    expect({
      first,
      second,
      late: await failedBy(1),
      own: await failedBy(2),
    }).toStrictEqual({ first: 1, second: 2, late: null, own: "domain" });
  });

  it("makes room at an App's cap by forgetting one settled row, never an unsettled one, and takes a key sent again", async () => {
    const approved = await approvedApp();
    const by = approved.builder;
    // A release with no store: a mutation of it can save nothing, so its
    // rows read as settled (`not_saved`).
    const storeless = { ...approved.release, store: null };
    const noteWith = async (
      release: typeof approved.release,
      key: string
    ): Promise<number | undefined> =>
      await noteScreenSubmission(
        env,
        by,
        release,
        readFunctionRequest(
          requestFor(approved, "notes.create", { title: "Many" }, key)
        ),
        "notes.create"
      );
    for (let index = 0; index < maxSubmissionsPerApp; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await noteWith(storeless, `settled-${index}`);
    }
    // At the cap, a key sent again takes its own row.
    const again = await noteWith(storeless, "settled-0");
    // A new one lands once one settled row made room: the oldest.
    const fresh = await noteWith(approved.release, "fresh");
    const rows = await env.DB.prepare(
      "SELECT idempotency_key AS key FROM screen_submissions WHERE person_id = ?"
    )
      .bind(by.userId)
      .all<{ key: string }>();
    const kept = rows.results.map(({ key }) => key);
    expect({
      again,
      fresh,
      count: kept.length,
      oldestGone: !kept.includes("settled-1"),
      resentKept: kept.includes("settled-0"),
      freshKept: kept.includes("fresh"),
    }).toStrictEqual({
      again: 2,
      fresh: 1,
      count: maxSubmissionsPerApp,
      oldestGone: true,
      resentKept: true,
      freshKept: true,
    });
  });

  it("keeps a key sent again after its earlier claim's deadline when another submission needs room at the cap", async () => {
    const approved = await approvedApp();
    const by = approved.builder;
    const noteKey = async (path: string, input: Json, key: string) =>
      await noteScreenSubmission(
        env,
        by,
        approved.release,
        readFunctionRequest(requestFor(approved, path, input, key)),
        path
      );
    // Its first attempt failed, its claim long past, so it read as settled.
    const retried = requestFor(approved, "notes.reject", { title: "R" }, "re");
    await called(approved, retried);
    await pastClaims(approved);
    await env.DB.prepare(
      "UPDATE screen_submissions SET created_at = ? WHERE person_id = ?"
    )
      .bind(Date.now() - 5 * 60_000, by.userId)
      .run();
    // The rest of the App's cap: submissions just noted, still unsettled.
    for (let index = 1; index < maxSubmissionsPerApp; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await noteKey("notes.create", { title: "Many" }, `open-${index}`);
    }
    // Sent again: noted before its new attempt claims the receipt.
    const again = await noteKey("notes.reject", { title: "R" }, "re");
    // Another submission at the cap, while that attempt is on its way.
    const overflow = await noteKey("notes.create", { title: "One more" }, "x");
    const listed = await statuses(by);
    expect({
      again,
      overflow,
      retry: listed.filter(({ operation }) => operation === "notes.reject"),
    }).toStrictEqual({
      again: 2,
      // No room: every row is unsettled, the re-sent one included.
      overflow: undefined,
      retry: [{ operation: "notes.reject", status: "pending", failure: null }],
    });
  });

  it("makes room at the person's cap by forgetting one settled row of another App", async () => {
    const approved = await approvedApp();
    const by = approved.builder;
    // Releases with no store, as other Apps': their rows read as settled.
    const storelessAs = (app: string) => ({
      ...approved.release,
      store: null,
      manifest: { ...approved.release.manifest, resourceId: app },
    });
    for (const app of ["first", "second"]) {
      for (let index = 0; index < maxSubmissionsPerApp; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one after another
        await noteScreenSubmission(
          env,
          by,
          storelessAs(app),
          readFunctionRequest(
            requestFor(
              approved,
              "notes.create",
              { title: "Many" },
              `${app}-${index}`
            )
          ),
          "notes.create"
        );
      }
    }
    const fresh = await noteScreenSubmission(
      env,
      by,
      approved.release,
      readFunctionRequest(
        requestFor(approved, "notes.create", { title: "New" }, "third-0")
      ),
      "notes.create"
    );
    const left = await env.DB.prepare(
      "SELECT idempotency_key AS key FROM screen_submissions WHERE person_id = ?"
    )
      .bind(by.userId)
      .all<{ key: string }>();
    const keys = left.results.map(({ key }) => key);
    // One settled row of another App made room: the oldest, nothing more.
    expect({
      fresh,
      count: keys.length,
      oldestGone: !keys.includes("first-0"),
      freshKept: keys.includes("third-0"),
    }).toStrictEqual({
      fresh: 1,
      count: 100,
      oldestGone: true,
      freshKept: true,
    });
  });

  it("takes no other App's settled row for an App full of its own unsettled ones", async () => {
    const approved = await approvedApp();
    const by = approved.builder;
    const noteAs = async (
      release: typeof approved.release,
      key: string
    ): Promise<number | undefined> =>
      await noteScreenSubmission(
        env,
        by,
        release,
        readFunctionRequest(
          requestFor(approved, "notes.create", { title: "Many" }, key)
        ),
        "notes.create"
      );
    // Another App's settled rows: no store, nothing saved.
    const other = {
      ...approved.release,
      store: null,
      manifest: { ...approved.release.manifest, resourceId: "other" },
    };
    for (let index = 0; index < 10; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await noteAs(other, `other-${index}`);
    }
    // This App's own, all pending: no receipt yet, just noted.
    for (let index = 0; index < maxSubmissionsPerApp; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await noteAs(approved.release, `full-${index}`);
    }
    const refused = await noteAs(approved.release, "one-more");
    const others = await env.DB.prepare(
      "SELECT count(*) AS n FROM screen_submissions WHERE person_id = ? AND app_id = 'other'"
    )
      .bind(by.userId)
      .first<{ n: number }>();
    expect({ refused, others: others?.n }).toStrictEqual({
      refused: undefined,
      others: 10,
    });
  });

  it("refuses an acknowledgement through the frame's own way to its App from a build revoked since", async () => {
    const approved = await approvedApp();
    const request = requestFor(approved, "notes.create", { title: "A" }, "v-1");
    await called(approved, request);
    const frame = await approved.builder.api.screens.frame(
      approved.app,
      approved.lease
    );
    for (const artifact of approved.artifacts) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await approved.admin.api.screenTrust.revoke(approved.app, artifact);
    }
    const refused = await frame.received(request).then(
      () => "ok",
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : "threw"
    );
    expect({ refused, kept: await statuses(approved.builder) }).toStrictEqual({
      refused: "screen.revoked",
      kept: [{ operation: "notes.create", status: "saved", failure: null }],
    });
  });

  it("leaves core's answer to the screen whatever writing a failure for recovery comes to", async () => {
    const approved = await approvedApp();
    const request = requestFor(
      approved,
      "notes.reject",
      { title: "No" },
      "w-1"
    );
    // A database that refuses every write.
    const db = new Proxy(env.DB, {
      get: (target, name): unknown =>
        name === "prepare"
          ? () => {
              throw new Error("The database is unavailable.");
            }
          : Reflect.get(target, name, target),
    });
    const failing = new Proxy(env, {
      get: (target, name): unknown =>
        name === "DB" ? db : Reflect.get(target, name, target),
    });
    await expect(
      noteScreenAnswer(
        failing,
        approved.builder,
        approved.app,
        request,
        { ok: false, error: { code: "note.closed", category: "domain" } },
        { attempt: 1, fence: null }
      )
    ).resolves.toBeUndefined();
  });

  it("reads a failure core answered as pending while an attempt that claimed the receipt since may still commit", async () => {
    const approved = await approvedApp();
    const request = requestFor(
      approved,
      "notes.slowCreate",
      { title: "Racing" },
      "race-1"
    );
    // This attempt claims the receipt and takes a while to commit.
    const running = called(approved, request);
    await scheduler.wait(500);
    const row = await env.DB.prepare(
      "SELECT attempt FROM screen_submissions WHERE person_id = ?"
    )
      .bind(approved.builder.userId)
      .first<{ attempt: number }>();
    // Another attempt's failure lands on the row meanwhile.
    await noteScreenAnswer(
      env,
      approved.builder,
      approved.app,
      request,
      { ok: false, error: { code: "note.closed", category: "domain" } },
      // The failed attempt's claim was an older one than the running one's.
      { attempt: row?.attempt ?? 1, fence: 0 }
    );
    const whileClaimed = await statuses(approved.builder);
    // Its acknowledgement now forgets nothing.
    await screenSubmissionReceived(
      env,
      approved.builder,
      approved.app,
      request
    );
    await running;
    expect({
      whileClaimed,
      after: await statuses(approved.builder),
    }).toStrictEqual({
      whileClaimed: [
        { operation: "notes.slowCreate", status: "pending", failure: null },
      ],
      after: [
        { operation: "notes.slowCreate", status: "saved", failure: null },
      ],
    });
  });

  it("keeps the expiry of a re-sent action its invocation keeps, gives one that never started a fresh one, and extends a re-sent mutation's", async () => {
    const approved = await approvedApp();
    const by = approved.builder;
    const noteAgain = async (path: string, key: string, input: Json) => {
      await noteScreenSubmission(
        env,
        by,
        approved.release,
        readFunctionRequest(requestFor(approved, path, input, key)),
        path
      );
    };
    const expiryOf = async (key: string): Promise<number | undefined> => {
      const row = await env.DB.prepare(
        "SELECT expires_at AS at FROM screen_submissions WHERE person_id = ? AND idempotency_key = ?"
      )
        .bind(by.userId, key)
        .first<{ at: number }>();
      return row?.at;
    };
    // An action that ran: its invocation is kept.
    await called(
      approved,
      requestFor(approved, "notes.add", { title: "T" }, "ran")
    );
    // One noted whose run never started: nothing of it is kept.
    await noteAgain("notes.add", "unstarted", { title: "T" });
    await noteAgain("notes.create", "mut-1", { title: "T" });
    const before = {
      ran: await expiryOf("ran"),
      unstarted: await expiryOf("unstarted"),
      mutation: await expiryOf("mut-1"),
    };
    await scheduler.wait(20);
    await noteAgain("notes.add", "ran", { title: "T" });
    await noteAgain("notes.add", "unstarted", { title: "T" });
    await noteAgain("notes.create", "mut-1", { title: "T" });
    expect({
      ranKept: (await expiryOf("ran")) === before.ran,
      unstartedFresh:
        ((await expiryOf("unstarted")) ?? 0) > (before.unstarted ?? 0),
      mutationExtended:
        ((await expiryOf("mut-1")) ?? 0) > (before.mutation ?? 0),
    }).toStrictEqual({
      ranKept: true,
      unstartedFresh: true,
      mutationExtended: true,
    });
  });

  it("reads an action's receipt gone past its keeping as expired, never not saved", async () => {
    const approved = await approvedApp();
    const by = approved.builder;
    await noteScreenSubmission(
      env,
      by,
      approved.release,
      readFunctionRequest(
        requestFor(approved, "notes.add", { title: "T" }, "gone")
      ),
      "notes.add"
    );
    // As if first noted past an action's keeping: no invocation says
    // anything of it now.
    const hour = 60 * 60_000;
    await env.DB.prepare(
      "UPDATE screen_submissions SET created_at = ?, expires_at = ? WHERE person_id = ?"
    )
      .bind(Date.now() - 2 * hour, Date.now() + 22 * hour, by.userId)
      .run();
    await expect(statuses(by)).resolves.toStrictEqual([
      { operation: "notes.add", status: "expired", failure: null },
    ]);
  });

  it("lists nothing for Grasp staff", async () => {
    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staff);
    await expect(
      core.authenticate().screenSubmissions.list()
    ).resolves.toStrictEqual([]);
  });
});
