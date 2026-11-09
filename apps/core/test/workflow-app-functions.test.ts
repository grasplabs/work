import { applyOperation, readDefinition } from "@grasp-os/sdk/definition";
import type { DefinitionOperation } from "@grasp-os/sdk/definition";
import type { Json } from "@grasp-os/shared/json";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import { executionErrors } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { publishVersion } from "../src/app-publish.ts";
import { appHost } from "../src/durable-objects.ts";
import { createWorkflowResource } from "../src/workflow-resources.ts";
import { appCallKey } from "../src/workflows/app-calls.ts";
import type { CallingRun } from "../src/workflows/resource-authority.ts";
import { makeCall } from "../src/workflows/resource-calls.ts";
import {
  appOf,
  commitApp,
  testApp,
  withFiles,
  withSensitive,
} from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { commitDefined, racingDb, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { holdingBuilds } from "./build-holds.ts";
import { mockIdp } from "./idp.ts";
import { outcome, refusal, signedInApi, unique } from "./sign-in.ts";

// A workflow's run calling one of an App's functions by the stable ID the
// App's definition gives it (GRA-1663: workflows/app-calls.ts,
// app-function-bindings.ts). Starts from the ways it can fail: a workflow
// calling a function it wasn't granted; a forged or stale ID, or one from
// another App; a rename that would swap what an ID means; `__proto__`
// for a name or an ID; a replayed call; and a publish, or a rollback,
// taking away or changing what a bound workflow calls.

const idp = mockIdp();

/** The Notes App's functions, as code exports them. */
const notesCode = (
  create = "create"
): string => `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";

export const ${create} = mutation({
  args: { title: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map((note) => note.title),
});
`;

/** The Notes App: its functions get their IDs as they are committed. */
const notes = (): TestApp =>
  testApp(
    {
      name: "Notes",
      tables: {
        notes: {
          fields: { title: "v.string().min(1).max(200)" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
    },
    { "server/notes.ts": notesCode() }
  );

/** The definition App `app`'s latest version was committed with. */
const committed = async (app: string) => {
  const row = await env.DB.prepare(
    "SELECT definition FROM app_versions WHERE app_id = ? ORDER BY version DESC LIMIT 1"
  )
    .bind(app)
    .first<{ definition: string }>();
  return readDefinition(JSON.parse(row?.definition ?? "null"));
};

/** The IDs App `app`'s latest version gives its functions, by path. */
const idsOf = async (app: string): Promise<Map<string, string>> => {
  const { functions = [] } = await committed(app);
  return new Map(functions.map(({ id, name }) => [name, id]));
};

/** The ID App `app`'s latest version gives function `name`. */
const idOf = async (app: string, name: string): Promise<string> => {
  const ids = await idsOf(app);
  const id = ids.get(name);
  if (id === undefined) {
    throw new Error(`No function ${name}`);
  }
  return id;
};

/**
 * `source` with `files` changed, over App `app`'s latest definition as
 * `operations` change it: a rename said as the definition tools say it.
 */
const redefined = async (
  app: string,
  source: TestApp,
  files: Readonly<Record<string, string | null>>,
  ...operations: DefinitionOperation[]
): Promise<TestApp> => {
  let definition = await committed(app);
  for (const operation of operations) {
    definition = applyOperation(definition, operation);
  }
  return appOf(definition, withFiles(source, files).files);
};

type Builder = Awaited<ReturnType<typeof signedInApi>>;

/**
 * Commits `app` over App `id` and makes it current: the App it answers,
 * or what refused it.
 */
const published = async (
  builder: Builder,
  id: string,
  app: TestApp,
  /** Who makes it current: the builder, or an admin. */
  by: Builder = builder
): Promise<unknown> => {
  const { version } = await commitApp(builder.api.apps.files, id, app, "Next");
  return await by.api.apps.versions.setCurrent(id, version).then(
    (current) => current,
    (error: unknown) => error
  );
};

/** A builder's App of `app`, current, and an independent workflow of theirs. */
const setUp = async (app: TestApp = notes()) => {
  const builder = await signedInApi(idp, "builder");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  await expect(published(builder, id, app)).resolves.toStrictEqual(
    expect.objectContaining({ id })
  );
  const workflow = await createWorkflowResource(
    env,
    { userId: builder.userId, role: "builder", teams: [], staff: false },
    `weekly-notes-${unique()}`
  );
  return { builder, app: id, workflow };
};

/** The request for the workflow to call function `fn` of App `app`. */
const callRequest = (
  workflowId: string,
  app: string,
  fn: string
): PermissionRequest => ({
  subject: { type: "workflow", workflowId },
  object: { type: "app", appId: app, function: fn },
  actions: ["call"],
  binding: `NOTES_${unique().toUpperCase()}`,
});

/** A run of workflow `workflowId` acting for `principal`, as its calls know it. */
const runOf = (
  workflowId: string,
  principal: string,
  restricted = false
): CallingRun => {
  const runId = crypto.randomUUID();
  return {
    runId,
    rootRunId: runId,
    accountRunId: runId,
    workflowId,
    version: 1,
    principal,
    invoker: { type: "person", id: principal, appVersion: null },
    bindings: new Map(),
    restricted,
  };
};

/** Run `run`'s call of `fn` of App `app` with `args`, under step key `key`. */
const called = async (
  run: CallingRun,
  app: string,
  fn: string,
  args: Json,
  key = crypto.randomUUID()
): Promise<Json> =>
  await makeCall(
    env,
    run,
    "write-note",
    { name: "grasp.app", app, function: fn, arguments: args },
    {
      key,
      deadline: Date.now() + 30_000,
      requireHolds: () => {
        // Holds.
      },
    }
  );

/** The receipts run `runId`'s App calls left: function and outcome. */
const receiptsOf = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      (event) =>
        event.action === "workflow.run.called" && event.target?.id === runId
    )
    .map(({ detail }) => [detail?.function, detail?.outcome]);
};

/** The titles the Notes App `app` holds now, as the run reads them. */
const titlesOf = async (
  run: CallingRun,
  app: string,
  id: string
): Promise<string[]> =>
  z.array(z.string()).parse(await called(run, app, id, {}));

describe("a workflow calling an App's functions", () => {
  it("reaches only the function it was granted, of the App it was granted on, by its ID", async () => {
    const source = notes();
    const { builder, app, workflow } = await setUp(source);
    const other = await builder.api.apps.create({ name: "Other notes" });
    await expect(published(builder, other.id, source)).resolves.toStrictEqual(
      expect.objectContaining({ id: other.id })
    );
    const create = await idOf(app, "notes.create");
    const titles = await idOf(app, "notes.titles");
    await requestGranted(idp, builder, callRequest(workflow.id, app, create));
    const run = runOf(workflow.id, builder.userId);

    const attempts = {
      // Not granted: another function of the same App.
      ungranted: await outcome(called(run, app, titles, {})),
      // A forged ID, and IDs that are no ID at all.
      forged: await outcome(called(run, app, crypto.randomUUID(), {})),
      proto: await outcome(called(run, app, "__proto__", {})),
      constructor: await outcome(called(run, app, "constructor", {})),
      // The granted ID, on another App that gives a function that ID too.
      otherApp: await outcome(called(run, other.id, create, { title: "x" })),
      // The granted ID, on an App ID that is no App's.
      noApp: await outcome(called(run, "nope", create, { title: "x" })),
      granted: await outcome(called(run, app, create, { title: "Hello" })),
    };

    expect(attempts).toStrictEqual({
      ungranted: "workflow.call_denied",
      forged: "workflow.call_denied",
      proto: "workflow.call_denied",
      constructor: "workflow.call_denied",
      otherApp: "workflow.call_denied",
      noApp: "workflow.call_denied",
      granted: "ok",
    });
    await expect(receiptsOf(run.runId)).resolves.toStrictEqual([
      [titles, "started"],
      [titles, "workflow.call_denied"],
      [expect.any(String), "started"],
      [expect.any(String), "workflow.call_denied"],
      ["__proto__", "started"],
      ["__proto__", "workflow.call_denied"],
      ["constructor", "started"],
      ["constructor", "workflow.call_denied"],
      [create, "started"],
      [create, "workflow.call_denied"],
      [create, "started"],
      [create, "workflow.call_denied"],
      [create, "started"],
      [create, "done"],
    ]);
  });

  it("asks for one function of an App, by an ID the App gives it, for a workflow alone", async () => {
    const source = notes();
    const { builder, app, workflow } = await setUp(source);
    const create = await idOf(app, "notes.create");
    const request = callRequest(workflow.id, app, create);
    const refused = async (changed: PermissionRequest): Promise<string> =>
      await outcome(builder.api.permissions.request(changed));

    expect({
      wholeApp: await refused({
        ...request,
        object: { type: "app", appId: app },
      }),
      readOne: await refused({ ...request, actions: ["read"] }),
      callAndRead: await refused({ ...request, actions: ["call", "read"] }),
      unknownId: await refused({
        ...request,
        object: { type: "app", appId: app, function: crypto.randomUUID() },
      }),
      protoId: await refused({
        ...request,
        object: { type: "app", appId: app, function: "__proto__" },
      }),
      byName: await refused({
        ...request,
        object: { type: "app", appId: app, function: "notes.create()" },
      }),
      forAnApp: await refused({
        ...request,
        subject: { type: "app", appId: app },
      }),
    }).toStrictEqual({
      wholeApp: "permission.invalid",
      readOne: "permission.invalid",
      callAndRead: "permission.invalid",
      unknownId: "permission.invalid",
      protoId: "permission.invalid",
      byName: "permission.invalid",
      forAnApp: "permission.invalid",
    });
    const asked = await builder.api.permissions.request(request);
    expect(asked.object).toStrictEqual({
      type: "app",
      appId: app,
      function: create,
    });
  });

  it("keeps calling a renamed function by its ID, never the one that takes its old path", async () => {
    const first = notes();
    const { builder, app, workflow } = await setUp(first);
    const create = await idOf(app, "notes.create");
    await requestGranted(idp, builder, callRequest(workflow.id, app, create));
    await requestGranted(
      idp,
      builder,
      callRequest(workflow.id, app, await idOf(app, "notes.titles"))
    );
    // `create` renamed `add`, and a new `create` at its old path that
    // writes something else: the swap a name would fall for.
    const renamed = await redefined(
      app,
      first,
      {
        "server/notes.ts": `${notesCode("add")}
export const create = mutation({
  args: { title: v.string() },
  returns: v.id("notes"),
  handler: async (ctx) => await ctx.db.insert("notes", { title: "impostor" }),
});
`,
      },
      { op: "renameFunction", function: "notes.create", name: "notes.add" }
    );
    // Made current by an admin, the grants stand (see "asks again").
    const admin = await signedInApi(idp, "admin");
    await expect(
      published(builder, app, renamed, admin)
    ).resolves.toStrictEqual(expect.objectContaining({ id: app }));
    const ids = await idsOf(app);
    expect(ids.get("notes.add")).toBe(create);
    expect(ids.get("notes.create")).not.toBe(create);
    const run = runOf(workflow.id, builder.userId);

    await called(run, app, create, { title: "Still mine" });
    // Rolled back past the rename, the ID is `create` at its old path
    // again: the function it always was.
    const rolledBack = await admin.api.apps.versions.setCurrent(app, 1).then(
      ({ currentVersion }) => currentVersion,
      (error: unknown) => error
    );
    await called(run, app, create, { title: "Mine again" });

    expect({
      rolledBack,
      titles: await titlesOf(run, app, await idOf(app, "notes.titles")),
    }).toStrictEqual({ rolledBack: 1, titles: ["Still mine", "Mine again"] });
  });

  it("answers a retried or replayed mutation from its receipt, writing once", async () => {
    const source = notes();
    const { builder, app, workflow } = await setUp(source);
    const create = await idOf(app, "notes.create");
    const titles = await idOf(app, "notes.titles");
    await requestGranted(idp, builder, callRequest(workflow.id, app, create));
    await requestGranted(idp, builder, callRequest(workflow.id, app, titles));
    const run = runOf(workflow.id, builder.userId);
    const key = `${run.runId}:write-note`;

    const once = await called(run, app, create, { title: "Once" }, key);
    const again = await called(run, app, create, { title: "Once" }, key);

    expect(again).toBe(once);
    await expect(titlesOf(run, app, titles)).resolves.toStrictEqual(["Once"]);
  });

  it("stops at a revoked grant, and keeps restricted data from an unrestricted run", async () => {
    const source = notes();
    const { builder, app, workflow } = await setUp(source);
    const create = await idOf(app, "notes.create");
    const grant = await requestGranted(
      idp,
      builder,
      callRequest(workflow.id, app, create)
    );
    await requestGranted(
      idp,
      builder,
      callRequest(workflow.id, app, await idOf(app, "notes.titles"))
    );
    const restrictedRun = runOf(workflow.id, builder.userId, true);
    const run = runOf(workflow.id, builder.userId);

    // A restricted run's query keeps none of what it sends: the App stays
    // as it was.
    await titlesOf(restrictedRun, app, await idOf(app, "notes.titles"));
    await expect(appHost(env, app).isRestricted()).resolves.toBeFalsy();
    // A restricted run's mutation restricts the App before its arguments
    // reach it; from then on the App answers an unrestricted run nothing.
    await expect(
      outcome(called(restrictedRun, app, create, { title: "Secret" }))
    ).resolves.toBe("ok");
    await expect(appHost(env, app).isRestricted()).resolves.toBeTruthy();
    await expect(
      outcome(called(run, app, create, { title: "x" }))
    ).resolves.toBe("permission.restricted");
    const admin = await signedInApi(idp, "admin");
    await admin.api.permissions.revoke(grant);
    await expect(
      outcome(called(restrictedRun, app, create, { title: "x" }))
    ).resolves.toBe("workflow.call_denied");
  });

  it("refuses a publish or rollback that takes away or breaks a function a workflow calls, naming the workflow", async () => {
    // Version 1 has no `create`; version 2 brings it, and its ID.
    const second = notes();
    const bare = withFiles(second, {
      "server/notes.ts": notesCode()
        .slice(notesCode().indexOf("export const titles"))
        .replace(
          /^/u,
          `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";

`
        ),
    });
    const { builder, app, workflow } = await setUp(bare);
    await expect(published(builder, app, second)).resolves.toStrictEqual(
      expect.objectContaining({ currentVersion: 2 })
    );
    const create = await idOf(app, "notes.create");
    const grant = await requestGranted(
      idp,
      builder,
      callRequest(workflow.id, app, create)
    );
    const withCreate = (code: string): TestApp =>
      withFiles(second, {
        "server/notes.ts": notesCode().replace(
          "args: { title: v.string().min(1).max(200) },",
          code
        ),
      });
    const removed = withFiles(second, {
      "server/notes.ts": notesCode("write"),
    });
    const removal = await published(builder, app, removed);
    const required = await published(
      builder,
      app,
      withCreate(
        "args: { title: v.string().min(1).max(200), due: v.string() },"
      )
    );
    const rollback = await refusal(
      builder.api.apps.versions.setCurrent(app, 1)
    );

    // A new optional argument serves every call the workflow makes.
    const optional = await published(
      builder,
      app,
      withCreate(
        "args: { title: v.string().min(1).max(200), note: v.string().optional() },"
      )
    );
    // Once its grant is revoked, nothing calls it: it may go.
    const admin = await signedInApi(idp, "admin");
    await admin.api.permissions.revoke(grant);
    const unbound = await published(builder, app, removed);

    expect({ removal, required, rollback }).toMatchObject({
      removal: {
        code: "version.functions_in_use",
        details: {
          issues: [
            `The workflow \`${workflow.name}\` (${workflow.id}) calls \`notes.create\`, which is gone in this version.`,
          ],
        },
      },
      required: {
        code: "version.functions_in_use",
        details: {
          issues: [expect.stringContaining("no longer takes the arguments")],
        },
      },
      rollback: { code: "version.functions_in_use" },
    });
    expect({ optional, unbound }).toMatchObject({
      optional: { id: app, currentVersion: 5 },
      unbound: { id: app, currentVersion: 6 },
    });
  });

  it("fails a call clearly once nothing serves its function, whose ID went with it", async () => {
    const source = notes();
    const { builder, app, workflow } = await setUp(source);
    const create = await idOf(app, "notes.create");
    // Asked for, not granted, while the next version takes it away.
    const { id: asked } = await builder.api.permissions.request(
      callRequest(workflow.id, app, create)
    );
    // `create` gone from the code: its ID goes with it, and `write`, new,
    // gets one of its own.
    const removed = withFiles(source, {
      "server/notes.ts": notesCode("write"),
    });
    await expect(published(builder, app, removed)).resolves.toStrictEqual(
      expect.objectContaining({ id: app })
    );
    const ids = await idsOf(app);
    expect([...ids.values()]).not.toContain(create);
    expect(ids.has("notes.write")).toBeTruthy();
    const admin = await signedInApi(idp, "admin");

    await expect(
      outcome(admin.api.permissions.grant(asked, { version: null }))
    ).resolves.toBe("permission.invalid");
    // Granted around the check, as only a write around the platform
    // could: the run's call finds nothing serving the ID.
    await env.DB.prepare(
      "UPDATE permissions SET status = 'active', granted_by = ?, granted_at = ? WHERE id = ?"
    )
      .bind(admin.userId, Date.now(), asked)
      .run();
    const run = runOf(workflow.id, builder.userId);
    await expect(
      outcome(called(run, app, create, { title: "x" }))
    ).resolves.toBe("workflow.app_function_unavailable");
  });

  it("answers a mutation retried across a rename from its receipt, writing once", async () => {
    const first = notes();
    const { builder, app, workflow } = await setUp(first);
    const create = await idOf(app, "notes.create");
    const titles = await idOf(app, "notes.titles");
    await requestGranted(idp, builder, callRequest(workflow.id, app, create));
    await requestGranted(idp, builder, callRequest(workflow.id, app, titles));
    const run = runOf(workflow.id, builder.userId);
    const key = `${run.runId}:write-note`;
    const once = await called(run, app, create, { title: "Once" }, key);
    // Its answer lost, the step retries after `create` was renamed `add`.
    const renamed = await redefined(
      app,
      first,
      { "server/notes.ts": notesCode("add") },
      { op: "renameFunction", function: "notes.create", name: "notes.add" }
    );
    await published(builder, app, renamed, await signedInApi(idp, "admin"));

    const again = await called(run, app, create, { title: "Once" }, key);

    expect({ again, titles: await titlesOf(run, app, titles) }).toStrictEqual({
      again: once,
      titles: ["Once"],
    });
  });

  it("gives an App's actions no ID, so no workflow reaches one, and a bound mutation turned into one is gone", async () => {
    const stamps = `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

export const stamp = action({
  args: {},
  returns: v.string(),
  handler: async () => "stamped",
});
`;
    const source = withFiles(notes(), { "server/stamps.ts": stamps });
    const { builder, app, workflow } = await setUp(source);
    const create = await idOf(app, "notes.create");
    const given = await idsOf(app);
    const ids = [...given.keys()];
    await requestGranted(idp, builder, callRequest(workflow.id, app, create));

    const turned = await published(
      builder,
      app,
      withFiles(source, {
        "server/notes.ts": notesCode()
          .replace(
            'export const create = mutation({\n  args: { title: v.string().min(1).max(200) },\n  returns: v.id("notes"),\n  handler: async (ctx, args) => await ctx.db.insert("notes", args),',
            'export const create = action({\n  args: { title: v.string().min(1).max(200) },\n  returns: v.id("notes"),\n  handler: async () => { throw new Error("no"); },'
          )
          .replace(
            "import { mutation, query }",
            "import { action, mutation, query }"
          ),
      })
    );

    expect({ ids, turned }).toMatchObject({
      ids: ["notes.create", "notes.titles"],
      turned: {
        code: "version.functions_in_use",
        details: { issues: [expect.stringContaining("is gone")] },
      },
    });
  });

  it("refuses a publish that takes away or breaks a function granted to a workflow as it was published", async () => {
    // Publishes the version `next` makes of the Notes App while a
    // workflow's request on `create` is granted just before the statement
    // that makes it current lands, after the publish checked what
    // workflows call: what it answers, and the version current after.
    const raced = async (nextOf: (source: TestApp) => TestApp) => {
      const source = notes();
      const { builder, app, workflow } = await setUp(source);
      const { id: asked } = await builder.api.permissions.request(
        callRequest(workflow.id, app, await idOf(app, "notes.create"))
      );
      const { version } = await commitApp(
        builder.api.apps.files,
        app,
        nextOf(source),
        "Next"
      );
      const racing = racingDb(
        async () =>
          await env.DB.prepare(
            "UPDATE permissions SET status = 'active', granted_by = requested_by, granted_at = ? WHERE id = ?"
          )
            .bind(Date.now(), asked)
            .run(),
        /update "apps" set "current_version"/u
      );
      const refused = await refusal(
        publishVersion(
          { ...env, DB: racing },
          await builder.api.whoami(),
          app,
          version
        )
      );
      const { currentVersion } = await builder.api.apps.get(app);
      return { refused, currentVersion };
    };

    const removed = await raced((source) =>
      withFiles(source, { "server/notes.ts": notesCode("write") })
    );
    const changed = await raced((source) =>
      withFiles(source, {
        "server/notes.ts": notesCode().replace(
          "args: { title: v.string().min(1).max(200) },",
          "args: { title: v.string().min(1).max(200), due: v.string() },"
        ),
      })
    );

    expect({ removed, changed }).toMatchObject({
      removed: {
        refused: { code: "version.functions_in_use" },
        currentVersion: 1,
      },
      changed: {
        refused: { code: "version.functions_in_use" },
        currentVersion: 1,
      },
    });
  });

  it("fails a bound workflow's next call, with its receipt, once its App is removed", async () => {
    const source = notes();
    const { builder, app, workflow } = await setUp(source);
    const create = await idOf(app, "notes.create");
    await requestGranted(idp, builder, callRequest(workflow.id, app, create));
    await builder.api.apps.archive(app);
    await builder.api.apps.remove(app);
    const run = runOf(workflow.id, builder.userId);

    const failed = await outcome(called(run, app, create, { title: "x" }));

    expect({ failed, receipts: await receiptsOf(run.runId) }).toStrictEqual({
      failed: "workflow.call_denied",
      receipts: [
        [create, "started"],
        [create, "workflow.call_denied"],
      ],
    });
  });

  it("makes the Apps starting a workflow sensitive again once an App it calls reaches more", async () => {
    const source = notes();
    const { builder, app, workflow } = await setUp(source);
    await requestGranted(
      idp,
      builder,
      callRequest(workflow.id, app, await idOf(app, "notes.create"))
    );
    // Another App starts the workflow, its data classified ordinary.
    const starter = await builder.api.apps.create({ name: "Starter" });
    await published(builder, starter.id, notes());
    await requestGranted(idp, builder, {
      subject: { type: "app", appId: starter.id },
      object: { type: "workflow", workflowId: workflow.id },
      actions: ["start"],
      binding: `START_${unique().toUpperCase()}`,
    });
    const admin = await signedInApi(idp, "admin");
    const { generation } = await admin.api.dataPolicy.read(starter.id);
    await admin.api.dataPolicy.classify(starter.id, "ordinary", generation);

    // The called App reaches more: what it reads comes back through the
    // workflow to the starter.
    await requestGranted(idp, builder, {
      subject: { type: "app", appId: app },
      object: { type: "platform" },
      actions: ["statistics"],
      binding: "STATISTICS_READ",
    });

    const { output } = await admin.api.dataPolicy.read(starter.id);
    expect(output).toBe("sensitive");
  });

  it("refuses moving a function's ID onto another function's path, at once or a step at a time", async () => {
    const source = notes();
    const { builder, app } = await setUp(source);
    const commitOf = async (next: TestApp) =>
      await commitApp(builder.api.apps.files, app, next, "Next").then(
        () => "ok",
        (error: unknown) => error
      );
    const listed = `${notesCode("write")}
export const list = query({
  args: {},
  returns: v.array(v.string()),
  handler: async () => [],
});
`;
    // `titles` moved to `list`, and `create`'s ID onto `titles`' path in
    // the same commit: the ID would stand for the function `titles` was.
    const swapped = await commitOf(
      await redefined(
        app,
        source,
        { "server/notes.ts": listed },
        { op: "renameFunction", function: "notes.titles", name: "notes.list" },
        { op: "renameFunction", function: "notes.create", name: "notes.titles" }
      )
    );
    // `titles`' ID renamed away to a path no code exports: the code still
    // exports `titles`, which keeps its ID, so nothing changes; then
    // `create`'s ID onto `titles`' path.
    const away = await commitOf(
      await redefined(
        app,
        source,
        {},
        { op: "renameFunction", function: "notes.titles", name: "notes.gone" }
      )
    );
    // The rename tool refuses a path held already; a definition given
    // whole to a commit names it anyway.
    const latest = await committed(app);
    const onto = await commitOf(
      appOf(
        {
          ...latest,
          functions: (latest.functions ?? []).flatMap((fn) => {
            if (fn.name === "notes.titles") {
              return [];
            }
            return fn.name === "notes.create"
              ? [{ ...fn, name: "notes.titles" }]
              : [fn];
          }),
        },
        source.files
      )
    );

    const taken = {
      code: "app.definition_invalid",
      details: {
        issues: [
          expect.stringContaining("`notes.titles` is another function's"),
        ],
      },
    };
    expect({ swapped, away, onto }).toMatchObject({
      swapped: taken,
      away: { code: "app.nothing_to_commit" },
      onto: taken,
    });
  });

  it("answers a test run's App call from its start, checked against what the function answers", async () => {
    const source = notes();
    const { builder, app, workflow } = await setUp(source);
    const titles = await idOf(app, "notes.titles");
    const key = appCallKey({ app, function: titles });
    const candidate = (answer?: Json): CallingRun => ({
      ...runOf(workflow.id, builder.userId),
      candidate: new Map([
        [key, { kind: "app", contractId: key, fingerprint: "", answer }],
      ]),
    });

    const answers = {
      fits: await called(candidate(["A note"]), app, titles, {}),
      unfit: await outcome(called(candidate([42]), app, titles, {})),
      none: await outcome(called(candidate(), app, titles, {})),
    };

    expect(answers).toStrictEqual({
      fits: ["A note"],
      unfit: "workflow.call_invalid",
      none: "workflow.candidate_unfixtured",
    });
    // A test run calls nothing: no note was written, no receipt kept.
    await expect(receiptsOf(candidate().runId)).resolves.toStrictEqual([]);
  });

  it("makes an App a workflow calls sensitive again once the workflow reaches more", async () => {
    const source = notes();
    const { builder, app, workflow } = await setUp(source);
    await requestGranted(
      idp,
      builder,
      callRequest(workflow.id, app, await idOf(app, "notes.create"))
    );
    const admin = await signedInApi(idp, "admin");
    const { generation } = await admin.api.dataPolicy.read(app);
    await admin.api.dataPolicy.classify(app, "ordinary", generation);

    // The workflow reads the Brain now: what it sends the App may hold it.
    await requestGranted(idp, builder, {
      subject: { type: "workflow", workflowId: workflow.id },
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });

    const { output } = await admin.api.dataPolicy.read(app);
    expect(output).toBe("sensitive");
  });

  it("fails as the host refused it, an attempt gone mid-call included, and as the App failed otherwise", async () => {
    const source = withFiles(notes(), {
      "server/failing.ts": `import { AppError, v } from "@grasp-os/sdk";
import { mutation } from "@server/_generated/server";

export const fail = mutation({
  args: {},
  returns: v.null(),
  handler: async () => {
    throw new AppError("note.refused", "No notes today.");
  },
});
`,
    });
    const { builder, app, workflow } = await setUp(source);
    const create = await idOf(app, "notes.create");
    const fail = await idOf(app, "failing.fail");
    await requestGranted(idp, builder, callRequest(workflow.id, app, create));
    await requestGranted(idp, builder, callRequest(workflow.id, app, fail));
    const run = runOf(workflow.id, builder.userId);
    // The attempt holds as the call is decided, and is gone as it runs.
    let holds = 1;
    const stale = await refusal(
      makeCall(
        env,
        run,
        "write-note",
        { name: "grasp.app", app, function: create, arguments: { title: "x" } },
        {
          key: crypto.randomUUID(),
          deadline: Date.now() + 30_000,
          requireHolds: () => {
            holds -= 1;
            if (holds < 0) {
              throw executionErrors.create("execution.stale_attempt");
            }
          },
        }
      )
    );
    const failed = await refusal(called(run, app, fail, {}));

    expect({ stale, failed }).toMatchObject({
      stale: { code: "execution.stale_attempt" },
      failed: {
        code: "workflow.app_call_failed",
        details: { code: "note.refused" },
      },
    });
  });

  it("names the call's request in its receipt, as the App's own evidence of it does", async () => {
    const source = withSensitive(notes(), "notes");
    const { builder, app, workflow } = await setUp(source);
    const create = await idOf(app, "notes.create");
    const titles = await idOf(app, "notes.titles");
    await requestGranted(idp, builder, callRequest(workflow.id, app, create));
    await requestGranted(idp, builder, callRequest(workflow.id, app, titles));
    const run = runOf(workflow.id, builder.userId);
    await called(run, app, create, { title: "Private" });

    await called(run, app, titles, {});

    const events = await allEvents();
    const done = events.find(
      ({ action, target, detail }) =>
        action === "workflow.run.called" &&
        target?.id === run.runId &&
        detail?.function === titles &&
        detail.outcome === "done"
    );
    const request = done?.detail?.request;
    const read = events.find(
      (event) => event.action === "app.data.read" && event.requestId === request
    );
    expect({ named: typeof request, actor: read?.actor }).toStrictEqual({
      named: "string",
      actor: { type: "person", userId: builder.userId },
    });
  });

  it("seals no version that left a new function without an ID, and gives it one on the next commit", async () => {
    const source = notes();
    const { builder, app } = await setUp(source);
    const by = await builder.api.whoami();
    const held = Promise.withResolvers<boolean>();
    // Its build doesn't answer within the build wait: the commit stands,
    // `archive` without an ID.
    const added = withFiles(source, {
      "server/archive.ts": `import { v } from "@grasp-os/sdk";
import { mutation } from "@server/_generated/server";

export const archive = mutation({ args: {}, returns: v.null(), handler: async () => null });
`,
    });
    const { version } = await commitDefined(
      {
        ...env,
        FILES: holdingBuilds(env.FILES, held.promise),
        BUILD_WAIT_MS: "50",
      },
      by,
      app,
      added,
      "Archive"
    );
    held.resolve(true);
    const before = await idsOf(app);
    const sealed = await builder.api.apps.versions
      .setCurrent(app, version)
      .then(
        () => "ok",
        (error: unknown) => error
      );
    const again = await published(
      builder,
      app,
      withFiles(added, { "AGENTS.md": "# Notes\n" })
    );
    const after = await idsOf(app);

    expect({
      unnamed: before.has("archive.archive"),
      sealed,
      again,
      named: after.has("archive.archive"),
    }).toMatchObject({
      unnamed: false,
      sealed: {
        code: "app.definition_invalid",
        details: {
          issues: [expect.stringContaining("`archive.archive` has no ID yet")],
        },
      },
      again: { id: app },
      named: true,
    });
  });

  it("asks for a workflow's grant again when someone who can't grant makes another version current, as for the App's own", async () => {
    const source = notes();
    const { builder, app, workflow } = await setUp(source);
    const create = await idOf(app, "notes.create");
    const grant = await requestGranted(
      idp,
      builder,
      callRequest(workflow.id, app, create)
    );
    const admin = await signedInApi(idp, "admin");
    const run = runOf(workflow.id, builder.userId);
    const statusOf = async () => {
      const listed = await admin.api.permissions.list();
      return listed.find(({ id }) => id === grant)?.status;
    };
    const withAgents = (agents: string) =>
      withFiles(source, { "AGENTS.md": agents });

    // An admin makes a new version current: the grant stands.
    await published(builder, app, withAgents("# One\n"), admin);
    const byAdmin = {
      status: await statusOf(),
      call: await outcome(called(run, app, create, { title: "a" })),
    };
    // The builder's review of the next version says so; then the builder
    // makes it current: it is asked for again, and the call refused
    // until an admin grants it over that version.
    const { version: two } = await commitApp(
      builder.api.apps.files,
      app,
      withAgents("# Two\n"),
      "Two"
    );
    const review = await builder.api.apps.versions.review(app, two);
    const reviewed = review.callers.find(
      ({ permission }) => permission.id === grant
    )?.askedAgain;
    await builder.api.apps.versions.setCurrent(app, two);
    const byBuilder = {
      status: await statusOf(),
      call: await outcome(called(run, app, create, { title: "b" })),
    };
    const { currentVersion } = await admin.api.apps.get(app);
    await admin.api.permissions.grant(grant, { version: currentVersion });
    const regranted = await outcome(called(run, app, create, { title: "c" }));

    // Asked for again, it still binds the workflow: a builder's version
    // taking `create` away is refused.
    await published(builder, app, withAgents("# Three\n"));
    const removal = await published(
      builder,
      app,
      withFiles(source, { "server/notes.ts": notesCode("write") })
    );

    expect({ reviewed, byAdmin, byBuilder, regranted, removal }).toMatchObject({
      reviewed: true,
      byAdmin: { status: "active", call: "ok" },
      byBuilder: { status: "requested", call: "workflow.call_denied" },
      regranted: "ok",
      removal: { code: "version.functions_in_use" },
    });
  });
});
