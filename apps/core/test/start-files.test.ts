import {
  fileChannel,
  declaredWorkflows,
  workflowFingerprint,
} from "@grasp-os/sdk/host";
import { sha256HexOfBytes } from "@grasp-os/shared/encoding";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import type { Json } from "@grasp-os/shared/json";
import {
  appFunctionPath,
  pageLeaseHeader,
  pagePersonHeader,
} from "@grasp-os/shared/pages";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { runFileLimits } from "@grasp-os/shared/run-files";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { publishVersion } from "../src/app-publish.ts";
import { loadRelease } from "../src/app-releases.ts";
import { appStartFiles } from "../src/app-start-files.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appFor } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { StoreHost } from "../src/store-host.ts";
import { storeOutboxConsumers } from "../src/store-outbox-consumers.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { resultOf, runOf } from "../src/workflows/resource-runs.ts";
import { copyIntoRun, sweepRunFiles } from "../src/workflows/run-files.ts";
import { handFiles } from "../src/workflows/start-files.ts";
import type { StartFile } from "../src/workflows/start-files.ts";
import { appDefinition } from "./app-definitions.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { appWith, seal } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { outcome, routed, signedInApi, unique } from "./sign-in.ts";

// A page's start handing its run a file of the App (GRA-885; the
// threat note is on the issue): the file read as the person may read it
// now, copied into the run's own files, the run reading it by the same
// `{ id }`, and every other file, or a start that may not hand one,
// refused before any run is admitted.

const idp = mockIdp();

/**
 * The Reviews App: its files permission of `operations`, its `review`
 * workflow taking a `doc` of type `doc`, and the `workflows` beside it.
 */
const files = ({
  operations = '["upload", "read", "delete"]',
  doc = "v.file()",
  workflows = [],
}: {
  operations?: string;
  doc?: string;
  workflows?: readonly string[];
} = {}): Record<string, string> => ({
  ...appDefinition({
    name: "Reviews",
    tables: {
      notes: {
        fields: { title: "v.string()" },
        access: { read: "appMembers", write: "appMembers" },
      },
    },
    permissions: [
      `permission.files({ operations: ${operations} })`,
      `permission.workflow("review", { input: v.object({ doc: ${doc} }), output: v.object({ status: v.string() }) })`,
      ...workflows,
    ],
  }),
  "server/review.ts": `import { v } from "@grasp-os/sdk";
import { action, mutation } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const review = permissions.review;

/** Starts the review now, with the file the page names. */
export const startReview = action({
  args: { file: v.string() },
  returns: v.object({ startId: v.string(), runId: v.string().nullable(), version: v.number().integer() }),
  handler: async (ctx, args) => await ctx.workflows.review.start({ doc: { id: args.file } }),
});

/** Notes the file, and has the review started once that commits. */
export const stageReview = mutation({
  args: { file: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("notes", { title: args.file });
    await ctx.workflows.review.start({ doc: { id: args.file } });
    return null;
  },
});
`,

  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Desk() {
  return <main>Reviews</main>;
}

export const Route = createFileRoute("/")({ component: Desk });
`,
});

/** A workflow taking a file, whose run says which file it was handed. */
const definition = JSON.stringify({
  $schema: workflowSchemaUrl,
  input: {
    type: "object",
    properties: { doc: { type: "object", "x-grasp-value": { kind: "file" } } },
    required: ["doc"],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: "object",
      properties: { status: { type: "string" } },
      required: ["status"],
      additionalProperties: false,
    },
    value: { status: { $expr: "input.doc.id" } },
  },
  steps: [],
});

/** Someone signed in, and as core's own calls take them. */
const signedIn = async (role: Role) => {
  const session = await signedInApi(idp, role);
  const acting: Acting & Identity = {
    userId: session.userId,
    email: z.string().parse(session.person.email),
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  return { ...session, acting };
};

type Person = Awaited<ReturnType<typeof signedIn>>;

/**
 * The Reviews App sealed and current, `review` bound
 * to a workflow taking a file, with the App's `start` grant.
 */
const reviewsApp = async () => {
  const admin = await signedIn("admin");
  const builder = await signedIn("builder");
  const workflow = await createWorkflowResource(
    env,
    builder.acting,
    `review-${unique()}`
  );
  await publishWorkflowVersion(env, builder.acting, workflow.id, {
    definition,
    basedOn: null,
  });
  const fixture = await appWith(files(), "Reviews", builder.acting);
  await bindWorkflowToApp(env, builder.acting, workflow.id, {
    app: fixture.app,
    alias: "review",
    version: 1,
  });
  await seal(fixture);
  await publishVersion(env, builder.acting, fixture.app, 1);
  const asked = await requestPermission(
    env,
    builder.acting,
    {
      subject: { type: "app", appId: fixture.app },
      object: { type: "workflow", workflowId: workflow.id },
      actions: ["start"],
      binding: "REVIEW",
    },
    {
      app: async (named: string, role: "user" | "builder") =>
        await appFor(env, builder.acting, named, role),
      resource: async (ref, needed) => {
        await requireResourceRole(env, builder.acting, ref, needed);
      },
    }
  );
  await grantPermission(env, admin.acting, asked.id, { version: 1 });
  const release = await loadRelease(env, fixture.app, 1);
  const declared = declaredWorkflows(release.app, release.workflows).find(
    ({ alias }) => alias === "review"
  );
  if (declared === undefined) {
    throw new Error("No review workflow");
  }
  return {
    admin,
    builder,
    app: fixture.app,
    workflow: workflow.id,
    release,
    reference: {
      resourceId: release.manifest.resourceId,
      resourceVersion: release.manifest.resourceVersion,
      contractId: "workflows.review",
      fingerprint: await workflowFingerprint(declared),
      kind: "workflow",
    },
  };
};

/** `person`'s open page of `app`: its lease, and its file channel. */
const pageOf = async (person: Person, app: string) => {
  const { lease } = await person.api.pages.open(app);
  const fetch = async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    headers.set("origin", clientOrigin);
    headers.set("cookie", person.session);
    headers.set(pagePersonHeader, person.userId);
    return await routed(path, { ...init, headers });
  };
  const named = async () => await Promise.resolve(person.userId);
  return {
    lease,
    fetch,
    channel: fileChannel({ app, lease, person: named, fetch }),
  };
};

type Page = Awaited<ReturnType<typeof pageOf>>;

/** A PNG's bytes: its signature, then `size` bytes in all. */
const png = (size = 64): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let at = 8; at < size; at += 1) {
    bytes[at] = at % 251;
  }
  return bytes;
};

/** Uploads `bytes` as a PNG through `page`: its file's ID. */
const uploaded = async (
  page: Page,
  bytes: Uint8Array<ArrayBuffer>
): Promise<string> =>
  await page.channel.upload(
    "files",
    new Blob([bytes], { type: "image/png" }),
    "scan.png",
    {
      cancel: new AbortController().signal,
      onProgress: () => {
        // Nothing to show.
      },
    }
  );

/** The page's start of `review` with `doc`: its run's ID, or its refusal's code. */
const started = async (
  page: Page,
  fixture: Awaited<ReturnType<typeof reviewsApp>>,
  doc: string,
  key = crypto.randomUUID().replaceAll("-", "")
): Promise<{ runId: string } | { refused: string }> => {
  const response = await page.fetch(`${appFunctionPath}/${fixture.app}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [pageLeaseHeader]: page.lease,
    },
    body: JSON.stringify({
      workflow: fixture.reference,
      command: "start",
      input: { doc: { id: doc } },
      idempotencyKey: key,
    }),
  });
  const answer: unknown = await response.json();
  if (!response.ok) {
    return { refused: errorPayloadSchema.parse(answer).code };
  }
  const { result } = z
    .object({
      result: z.union([
        z.object({
          ok: z.literal(true),
          value: z.object({ runId: z.string() }),
        }),
        z.object({
          ok: z.literal(false),
          error: z.object({ code: z.string() }),
        }),
      ]),
    })
    .parse(answer);
  return result.ok
    ? { runId: result.value.runId }
    : { refused: result.error.code };
};

/** Run `runId`'s files as core keeps them. */
const runFiles = async (runId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT id, name, type, size, sha256, state FROM workflow_run_files WHERE run_id = ? ORDER BY created_at"
  )
    .bind(runId)
    .all<{
      id: string;
      name: string;
      type: string;
      size: number;
      sha256: string | null;
      state: string;
    }>();
  return results;
};

/** The bytes run file `fileId` holds, its chunks in order. */
const bytesOf = async (fileId: string): Promise<Uint8Array> => {
  const { results } = await env.DB.prepare(
    'SELECT key FROM workflow_run_file_chunks WHERE file_id = ? ORDER BY "index"'
  )
    .bind(fileId)
    .all<{ key: string }>();
  const parts = await Promise.all(
    results.map(async ({ key }) => {
      const object = await env.FILES.get(key);
      return object === null ? new Uint8Array() : await object.bytes();
    })
  );
  return new Uint8Array(parts.flatMap((part) => [...part]));
};

/** What run `runId` was started with and returned, once it completed. */
const endOf = async (runId: string) =>
  await vi.waitFor(
    async () => {
      const row = await runOf(env, runId);
      if (row?.status !== "completed") {
        throw new Error(`Run ${runId} is ${row?.status ?? "missing"}`);
      }
      const receipt = await env.DB.prepare(
        "SELECT input FROM workflow_start_receipts WHERE id = ?"
      )
        .bind(runId)
        .first<{ input: string }>();
      const { output } = await resultOf(env, row);
      return {
        input: z.json().parse(JSON.parse(receipt?.input ?? "null")),
        output,
      };
    },
    { timeout: 30_000, interval: 100 }
  );

/** Calls `path` of the fixture's App as `by`: its answer, or its refusal's code. */
const calledAs = async (
  by: Person,
  fixture: Awaited<ReturnType<typeof reviewsApp>>,
  path: string,
  input: Json
): Promise<unknown> => {
  const { release } = fixture;
  const { result } = await callAppFunction(
    env,
    by.acting,
    release.manifest.resourceId,
    JSON.stringify({
      reference: { name: path, kind: release.app.operations[path]?.kind },
      input,
    })
  );
  return result.ok ? result.value : { refused: result.error.code };
};

/** Dispatches the App store's staged starts, as its outbox does. */
const dispatched = async (
  fixture: Awaited<ReturnType<typeof reviewsApp>>
): Promise<{ undeliverable: string | null }[]> => {
  const storeId = fixture.release.store?.storeId ?? "";
  return await runInDurableObject(
    env.DATA_STORES.getByName(storeId),
    async (_instance, state) => {
      await new StoreHost(state, env).drainOutbox(storeOutboxConsumers(env), {
        now: new Date(),
      });
      return state.storage.sql
        .exec<{ undeliverable: string | null }>(
          "SELECT undeliverable FROM sdk_change_outbox ORDER BY rowid"
        )
        .toArray();
    }
  );
};

describe("a page's start handing its run a file", { timeout: 120_000 }, () => {
  it("copies a file the person may read into the run, which reads it by the same shape, audited once, and copies nothing more for the same start sent again", async () => {
    const fixture = await reviewsApp();
    const page = await pageOf(fixture.builder, fixture.app);
    const bytes = png(300);
    const file = await uploaded(page, bytes);
    const key = crypto.randomUUID().replaceAll("-", "");

    const first = await started(page, fixture, file, key);
    const again = await started(page, fixture, file, key);
    if (!("runId" in first)) {
      throw new Error(`Refused: ${first.refused}`);
    }
    const ended = await endOf(first.runId);
    const [kept, ...more] = await runFiles(first.runId);
    const events = await allEvents();
    const sent = events.filter(
      ({ action, target }) =>
        action === "file.sent_to_run" && target?.id === file
    );

    expect({
      again,
      ended,
      kept: {
        ...kept,
        id: kept?.id === file ? "the App's file" : "its own",
      },
      more,
      sameBytes:
        kept === undefined
          ? false
          : (await sha256HexOfBytes(await bytesOf(kept.id))) ===
            (await sha256HexOfBytes(bytes)),
      sent: sent.map(({ actor, detail }) => ({
        actor,
        run: detail?.run,
        workflow: detail?.workflow,
        uploadedBy: detail?.uploadedBy,
        via: detail?.via,
      })),
    }).toStrictEqual({
      again: first,
      // The run's input names its own copy, in the shape the App sent, and
      // the run read it so.
      ended: {
        input: { doc: { id: kept?.id } },
        output: { status: kept?.id },
      },
      kept: {
        id: "its own",
        name: "scan.png",
        type: "image/png",
        size: 300,
        sha256: await sha256HexOfBytes(bytes),
        state: "done",
      },
      more: [],
      sameBytes: true,
      sent: [
        {
          actor: { type: "person", userId: fixture.builder.userId },
          run: first.runId,
          workflow: fixture.workflow,
          uploadedBy: fixture.builder.userId,
          via: "page",
        },
      ],
    });
  });

  it("refuses a file the person may not read now, or no file at all, admitting no run and keeping no copy", async () => {
    const fixture = await reviewsApp();
    const builderPage = await pageOf(fixture.builder, fixture.app);
    // The builder's own upload, attached to nothing: theirs alone to read.
    const theirs = await uploaded(builderPage, png(120));
    const colleague = await signedIn("user");
    await fixture.builder.api.apps.members.add(fixture.app, {
      type: "person",
      id: colleague.userId,
      role: "user",
    });
    const colleaguePage = await pageOf(colleague, fixture.app);
    const before = await env.DB.prepare(
      "SELECT count(*) AS runs FROM workflow_resource_runs WHERE workflow_resource_id = ?"
    )
      .bind(fixture.workflow)
      .first<{ runs: number }>();

    const refused = {
      anotherPersons: await started(colleaguePage, fixture, theirs),
      madeUp: await started(colleaguePage, fixture, crypto.randomUUID()),
      notAnId: await started(colleaguePage, fixture, "not-a-file"),
    };
    const after = await env.DB.prepare(
      "SELECT count(*) AS runs FROM workflow_resource_runs WHERE workflow_resource_id = ?"
    )
      .bind(fixture.workflow)
      .first<{ runs: number }>();
    const copies = await env.DB.prepare(
      "SELECT count(*) AS files FROM workflow_run_files WHERE workflow_resource_id = ? AND state <> 'deleted'"
    )
      .bind(fixture.workflow)
      .first<{ files: number }>();

    expect({
      refused,
      runs: after?.runs,
      copies: copies?.files,
    }).toStrictEqual({
      refused: {
        anotherPersons: { refused: "file.not_found" },
        madeUp: { refused: "file.not_found" },
        notAnId: { refused: "file.not_found" },
      },
      runs: before?.runs,
      copies: 0,
    });
  });

  it("refuses a file larger than a run's, and one past the run's room, before any byte is copied", async () => {
    const workflowId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const source = {
      name: "big.pdf",
      type: "application/pdf",
      size: runFileLimits.fileBytes + 1,
      chunks: [],
    };
    const tooLarge = await outcome(
      copyIntoRun(env, { runId, workflowId }, 0, source)
    );
    // The run full already: as many files as it may keep.
    await env.DB.batch(
      Array.from({ length: runFileLimits.runFiles }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO workflow_run_files (id, run_id, workflow_resource_id, opened_by, open_key, name, type, size, state, created_at) VALUES (?, ?, ?, 'step', ?, 'a.txt', 'text/plain', 1, 'done', ?)"
        ).bind(
          crypto.randomUUID(),
          runId,
          workflowId,
          `full:${runId}:${index}`,
          Date.now()
        )
      )
    );
    const full = await outcome(
      copyIntoRun(env, { runId, workflowId }, 0, { ...source, size: 10 })
    );
    const objects = await env.FILES.list({ prefix: `run-files/${runId}/` });

    expect({ tooLarge, full, objects: objects.objects.length }).toStrictEqual({
      tooLarge: "file.run_too_large",
      full: "file.run_full",
      objects: 0,
    });
  });

  it("reads each file again once all are copied, refusing the start and dropping its copies when one was hidden meanwhile", async () => {
    const runId = crypto.randomUUID();
    const workflowId = crypto.randomUUID();
    const bytes = png(90);
    const key = `app-files/test/${crypto.randomUUID()}`;
    await env.FILES.put(key, bytes);
    const file: StartFile = {
      id: crypto.randomUUID(),
      name: "scan.png",
      type: "image/png",
      size: bytes.length,
      chunks: [{ key, sha256: await sha256HexOfBytes(bytes) }],
    };
    let reads = 0;
    const field = {
      descriptorVersion: 1,
      nullable: false,
      presence: "required",
    } as const;
    const refused = await outcome(
      handFiles(
        env,
        {
          ...field,
          kind: "object",
          fields: { doc: { ...field, kind: "file" } },
        },
        JSON.stringify({ doc: { id: file.id } }),
        { runId, workflowId },
        {
          // Readable as it is copied, hidden by the time it is read again.
          read: async () => {
            reads += 1;
            if (reads > 1) {
              throw new Error("file.not_found");
            }
            return await Promise.resolve(file);
          },
          sent: () => {
            throw new Error("Never audited: never admitted");
          },
        }
      )
    );

    expect({ refused, reads, kept: await runFiles(runId) }).toMatchObject({
      refused: "Error: file.not_found",
      reads: 2,
      kept: [{ state: "deleted" }],
    });
  });

  it("hands a text, number, boolean or null under a union that allows a file as it is, and refuses an object there", async () => {
    const field = {
      descriptorVersion: 1,
      nullable: false,
      presence: "required",
    } as const;
    const descriptor = {
      ...field,
      kind: "object",
      fields: {
        doc: {
          ...field,
          kind: "union",
          members: [
            { ...field, kind: "file" },
            { ...field, kind: "string", trim: false, email: false },
          ],
        },
      },
    } as const;
    const handed = async (doc: unknown) => {
      const start = handFiles(
        env,
        descriptor,
        JSON.stringify({ doc }),
        {
          runId: crypto.randomUUID(),
          workflowId: crypto.randomUUID(),
        },
        {
          // Nothing is a file to read: a text is handed as it is, and an
          // object under the union is refused before any read.
          read: () => {
            throw new Error("Never read");
          },
          sent: () => {
            throw new Error("Never audited");
          },
        }
      );
      const refused = await outcome(start);
      if (refused !== "ok") {
        return refused;
      }
      const { input, runId } = await start;
      return { input, runId };
    };

    expect({
      text: await handed("a note"),
      number: await handed(3),
      yes: await handed(true),
      nothing: await handed(null),
      file: await handed({ id: crypto.randomUUID() }),
    }).toStrictEqual({
      text: { input: '{"doc":"a note"}', runId: undefined },
      number: { input: '{"doc":3}', runId: undefined },
      yes: { input: '{"doc":true}', runId: undefined },
      nothing: { input: '{"doc":null}', runId: undefined },
      file: "file.start_files",
    });
  });

  it("counts no dropped copy against the workflow's bytes, and sweeps a copy no start admitted within the hour", async () => {
    const workflowId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const other = crypto.randomUUID();
    const insert = (row: {
      openedBy: string;
      size: number;
      state: string;
      at: number;
    }) =>
      env.DB.prepare(
        "INSERT INTO workflow_run_files (id, run_id, workflow_resource_id, opened_by, open_key, name, type, size, state, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, 'a.txt', 'text/plain', ?, ?, ?, ?)"
      ).bind(
        crypto.randomUUID(),
        other,
        workflowId,
        row.openedBy,
        `${row.openedBy}:${crypto.randomUUID()}`,
        row.size,
        row.state,
        row.at,
        row.state === "deleted" ? row.at : null
      );
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    await env.DB.batch([
      // A dropped copy as large as the workflow's whole quota.
      insert({
        openedBy: `start:${other}`,
        size: runFileLimits.workflowBytes,
        state: "deleted",
        at: Date.now(),
      }),
      // A copy no start admitted, and a task's file, both two hours old.
      insert({
        openedBy: `start:${other}`,
        size: 1,
        state: "writing",
        at: twoHoursAgo,
      }),
      insert({
        openedBy: `${other}:task:write`,
        size: 1,
        state: "writing",
        at: twoHoursAgo,
      }),
    ]);
    const bytes = png(70);
    const key = `app-files/test/${crypto.randomUUID()}`;
    await env.FILES.put(key, bytes);
    const copied = await outcome(
      copyIntoRun(env, { runId, workflowId }, 0, {
        name: "scan.png",
        type: "image/png",
        size: bytes.length,
        chunks: [{ key, sha256: await sha256HexOfBytes(bytes) }],
      })
    );
    await sweepRunFiles(env);
    const { results } = await env.DB.prepare(
      "SELECT opened_by, state FROM workflow_run_files WHERE run_id = ? AND size = 1 ORDER BY opened_by"
    )
      .bind(other)
      .all<{ opened_by: string; state: string }>();

    expect({
      copied,
      swept: results.map(({ opened_by: by, state }) => [
        by.startsWith("start:") ? "start copy" : "task file",
        state,
      ]),
    }).toStrictEqual({
      copied: "ok",
      swept: [
        ["task file", "writing"],
        ["start copy", "deleted"],
      ],
    });
  });

  it("hands a run the person's file from an action's start and from a commit's start dispatched later, as each reads it then", async () => {
    const fixture = await reviewsApp();
    const page = await pageOf(fixture.builder, fixture.app);
    const bytes = png(150);
    const file = await uploaded(page, bytes);

    const now = z.object({ runId: z.string() }).parse(
      await calledAs(fixture.builder, fixture, "review.startReview", {
        file,
      })
    );
    const fromAction = await endOf(now.runId);
    await calledAs(fixture.builder, fixture, "review.stageReview", { file });
    const entries = await dispatched(fixture);
    const staged = await env.DB.prepare(
      "SELECT id FROM workflow_start_receipts WHERE invoker_id = ? AND idempotency_key LIKE '%after-commit:%'"
    )
      .bind(fixture.app)
      .first<{ id: string }>();
    const fromCommit = await endOf(staged?.id ?? "");
    const copies = [
      ...(await runFiles(now.runId)),
      ...(await runFiles(staged?.id ?? "")),
    ];

    const logged = await allEvents();
    const vias = logged
      .filter(
        ({ action, target }) =>
          action === "file.sent_to_run" && target?.id === file
      )
      .map(({ actor, detail }) => [actor, detail?.via]);
    expect({
      vias,
      entries,
      fromAction: fromAction.output,
      fromCommit: fromCommit.output,
      copies: copies.map(({ sha256, state, id }) => ({
        sha256,
        state,
        own: id !== file,
      })),
    }).toStrictEqual({
      // The person each acts for, and which code chose the file.
      vias: [
        [{ type: "person", userId: fixture.builder.userId }, "action"],
        [{ type: "person", userId: fixture.builder.userId }, "commit"],
      ],
      entries: [{ undeliverable: null }],
      fromAction: { status: copies[0]?.id },
      fromCommit: { status: copies[1]?.id },
      copies: [
        { sha256: await sha256HexOfBytes(bytes), state: "done", own: true },
        { sha256: await sha256HexOfBytes(bytes), state: "done", own: true },
      ],
    });
  });

  it("refuses an action's start with another person's file, and a commit's start whose file was deleted before its dispatch, settling it undeliverable", async () => {
    const fixture = await reviewsApp();
    const builderPage = await pageOf(fixture.builder, fixture.app);
    const theirs = await uploaded(builderPage, png(110));
    const colleague = await signedIn("user");
    await fixture.builder.api.apps.members.add(fixture.app, {
      type: "person",
      id: colleague.userId,
      role: "user",
    });

    const anotherPersons = await calledAs(
      colleague,
      fixture,
      "review.startReview",
      { file: theirs }
    );
    // Staged while the file is there, deleted before it is dispatched.
    await calledAs(fixture.builder, fixture, "review.stageReview", {
      file: theirs,
    });
    await builderPage.channel.delete("files", theirs);
    const entries = await dispatched(fixture);
    const runs = await env.DB.prepare(
      "SELECT count(*) AS runs FROM workflow_resource_runs WHERE workflow_resource_id = ?"
    )
      .bind(fixture.workflow)
      .first<{ runs: number }>();
    const events = await allEvents();

    expect({
      anotherPersons,
      entries,
      runs: runs?.runs,
      refusal: events
        .filter(
          ({ action, target }) =>
            action === "workflow.start_intent.refused" &&
            target?.id === fixture.app
        )
        .map(({ detail }) => detail?.reason),
    }).toStrictEqual({
      // App code learns only that the input names no file it can hand.
      anotherPersons: { refused: "resource.invalid_args" },
      entries: [{ undeliverable: "file.not_found" }],
      runs: 0,
      refusal: ["file.not_found"],
    });
  });

  it("tells the version's reviewer it may hand files people can read to its bound workflows, and no longer once it can't read files", async () => {
    const fixture = await reviewsApp();
    const handing = await fixture.builder.api.apps.versions.review(
      fixture.app,
      1
    );
    const withoutRead = files({ operations: '["upload", "delete"]' });
    const { version } = await fixture.builder.api.apps.files.commit(
      fixture.app,
      withoutRead,
      "Uploads only"
    );
    const notHanding = await fixture.builder.api.apps.versions.review(
      fixture.app,
      version
    );

    expect({
      handing: handing.handsFilesToWorkflows,
      notHanding: notHanding.handsFilesToWorkflows,
    }).toStrictEqual({ handing: true, notHanding: false });
  });

  it("tells the reviewer it may hand files when the App declares a plain object where its bound workflow takes a file", async () => {
    const fixture = await reviewsApp();
    // The same `{ id }` reaches the bound workflow, which takes it as a
    // file: copied all the same (`handFiles`).
    const aliased = files({ doc: "v.object({ id: v.string() })" });
    const { version } = await fixture.builder.api.apps.files.commit(
      fixture.app,
      aliased,
      "Doc as an object"
    );
    const review = await fixture.builder.api.apps.versions.review(
      fixture.app,
      version
    );

    expect(review.handsFilesToWorkflows).toBeTruthy();
  });

  it("tells the reviewer so for an App that names more workflows than one query takes parameters", async () => {
    const fixture = await reviewsApp();
    // 120 more workflows, none of them taking a file, beside `review`,
    // declared as a plain object, whose bound workflow takes one.
    const extras = Array.from({ length: 120 }, (_, at) => `extra${at}`);
    const many = files({
      doc: "v.object({ id: v.string() })",
      workflows: extras.map(
        (name) =>
          `permission.workflow("${name}", { input: v.object({ note: v.string() }), output: v.null() })`
      ),
    });
    const { version } = await fixture.builder.api.apps.files.commit(
      fixture.app,
      many,
      "Many workflows"
    );
    const review = await fixture.builder.api.apps.versions.review(
      fixture.app,
      version
    );

    expect(review.handsFilesToWorkflows).toBeTruthy();
  });

  it("refuses a commit's start once the person it acts for left the App before its dispatch, their file read as missing, never as the App", async () => {
    const fixture = await reviewsApp();
    const colleague = await signedIn("user");
    const member = {
      type: "person" as const,
      id: colleague.userId,
      role: "user" as const,
    };
    await fixture.builder.api.apps.members.add(fixture.app, member);
    const page = await pageOf(colleague, fixture.app);
    const own = await uploaded(page, png(100));
    await calledAs(colleague, fixture, "review.stageReview", { file: own });
    // Out of the App before the start is dispatched.
    await fixture.builder.api.apps.members.remove(fixture.app, {
      type: "person",
      id: colleague.userId,
    });

    const entries = await dispatched(fixture);
    // Read as they are now, should their role go between the start's
    // decision and its read: a missing file, never the App.
    const read = await outcome(
      appStartFiles(env, colleague.userId, fixture.app, fixture.release, {
        kind: "commit",
        agent: null,
      }).read(own)
    );

    expect({ entries, read }).toStrictEqual({
      // Refused as the start is decided: they may no longer use the App.
      entries: [{ undeliverable: "workflow.start_denied" }],
      read: "file.not_found",
    });
  });
});
