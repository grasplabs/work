import { applyOperation, readDefinition } from "@grasp-os/runtime/definition";
import type { DefinitionOperation } from "@grasp-os/runtime/definition";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { editWorkflowDraft, workflowDraft } from "../src/workflow-drafts.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import {
  candidateRunFor,
  startCandidateRun,
} from "../src/workflows/candidate-runs.ts";
import { appOf, commitApp, testApp, withFiles } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import {
  moduleOf,
  newerEngine,
  ranAs,
  refusedAs,
} from "./sealed-run-harness.ts";
import { refusal, signedInApi, unique } from "./sign-in.ts";

// A grasp-workflow/2 workflow calling an App's functions through
// `ctx.apps.<alias>.<path>` (GRA-1663), through its public interfaces:
// published, granted, started and read as a builder does. Starts from the
// ways it can fail: a function the workflow didn't declare or wasn't
// granted, one its App no longer gives, a rename between publishing the
// workflow and running it, and a test run reaching the App.

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

/** The Notes App: its functions get their IDs as it is committed. */
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

/** The ID App `app`'s latest version gives function `name`. */
const idOf = async (app: string, name: string): Promise<string> => {
  const { functions = [] } = await committed(app);
  const found = functions.find((fn) => fn.name === name);
  if (found === undefined) {
    throw new Error(`No function ${name}`);
  }
  return found.id;
};

/**
 * `source` with `files` changed, over App `app`'s latest definition as
 * `operations` change it: a rename as the definition tools say it.
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
 * Commits `app` over App `id` and makes it current, as an admin (made
 * current by its builder, the App's grants would be asked for again).
 */
const published = async (
  builder: Builder,
  id: string,
  app: TestApp
): Promise<unknown> => {
  const { version } = await commitApp(builder.api.apps.files, id, app, "Next");
  const admin = await signedInApi(idp, "admin");
  return await refusal(admin.api.apps.versions.setCurrent(id, version));
};

/**
 * A workflow that writes a note through the Notes App's `create`, then
 * reads every title through `titles`, answering both; with `pause`, it
 * waits an hour first, so a run stands waiting.
 */
const writingNotes = (
  app: string,
  create: string,
  titles: string,
  pause = false
) =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: {
      kind: "object",
      fields: { title: { kind: "string" } },
    },
    returns: {
      kind: "object",
      fields: {
        note: { kind: "string" },
        titles: { kind: "array", item: { kind: "string" } },
      },
    },
    result: {
      note: { $expr: "made" },
      titles: { $expr: "listed" },
    },
    permissions: {
      apps: {
        notes: {
          app,
          functions: { [create]: "notes.create", [titles]: "notes.titles" },
        },
      },
    },
    steps: [
      ...(pause ? [{ id: "pause", type: "wait", for: "1 hour" }] : []),
      {
        id: "made",
        type: "call",
        app: "notes",
        function: create,
        args: { title: { $expr: "args.title" } },
      },
      { id: "listed", type: "call", app: "notes", function: titles },
    ],
  });

/** The request for workflow `workflowId` to call function `fn` of App `app`. */
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

/** A builder's current Notes App, and a workflow of theirs calling it. */
const setUp = async (source: TestApp = notes()) => {
  const builder = await signedInApi(idp, "builder");
  const { id: app } = await builder.api.apps.create({ name: "Notes" });
  await published(builder, app, source);
  const acting = {
    userId: builder.userId,
    role: "builder" as const,
    teams: [],
    staff: false,
  };
  const workflow = await createWorkflowResource(
    env,
    acting,
    `notes-${unique()}`
  );
  const create = await idOf(app, "notes.create");
  const titles = await idOf(app, "notes.titles");
  return { builder, acting, app, workflow, create, titles, source };
};

/** Run `runId` of workflow `id` once it ended, as `builder` reads it. */
const ended = async (
  builder: Builder,
  id: string,
  runId: string
): Promise<WorkflowResourceRun> =>
  await vi.waitFor(
    async () => {
      const run = await builder.api.workflowResources.run(id, runId);
      if (run.endedAt === null) {
        throw new Error(`The run is ${run.status}`);
      }
      return run;
    },
    { timeout: 30_000, interval: 100 }
  );

/** A run of version 1 of workflow `id` writing `title`, once it ended. */
const ranWith = async (builder: Builder, id: string, title: string) => {
  const { runId } = await builder.api.workflowResources.start(id, {
    version: 1,
    args: { title },
    key: unique(),
  });
  const run = await ended(builder, id, runId);
  if (run.status !== "completed") {
    return { status: run.status, code: run.error?.code };
  }
  // The note's ID is the App's to choose: only that it answered one.
  const output = z
    .object({ note: z.string().min(1), titles: z.array(z.string()) })
    .parse(run.result);
  return { status: run.status, titles: output.titles };
};

/** The code and pointer of each problem a refused publication names. */
const problemsOf = (error: unknown): unknown =>
  z
    .object({
      code: z.string(),
      details: z.object({
        problems: z.array(z.object({ code: z.string(), pointer: z.string() })),
      }),
    })
    .transform(({ code, details }) => ({
      code,
      problems: details.problems.map((each) => `${each.code} ${each.pointer}`),
    }))
    .parse(error);

/** The function path hints of App permission `notes` in document `text`. */
const hintsOf = (text: string): unknown =>
  z
    .object({
      permissions: z.object({
        apps: z.object({
          notes: z.object({ functions: z.record(z.string(), z.string()) }),
        }),
      }),
    })
    .parse(JSON.parse(text)).permissions.apps.notes.functions;

/**
 * Waiting run `runId` going on past its wait: its `made` call of function
 * `create`, as its code makes it, in an activation of its own.
 */
const resumed = async (runId: string, create: string) =>
  await ranAs(
    runId,
    moduleOf(
      `return await step.do("made", { key: "task", description: "made" }, async () => ({ output: await env.notes.call(${JSON.stringify(create)}, { title: "Later" }) }));`
    )
  );

/** A waiting run of a workflow whose `create` is granted, and its setting. */
const waitingRun = async () => {
  const set = await setUp();
  await publishWorkflowVersion(env, set.acting, set.workflow.id, {
    definition: writingNotes(set.app, set.create, set.titles, true),
    basedOn: null,
  });
  const grant = await requestGranted(
    idp,
    set.builder,
    callRequest(set.workflow.id, set.app, set.create)
  );
  const { runId } = await set.builder.api.workflowResources.start(
    set.workflow.id,
    { version: 1, args: { title: "Later" }, key: unique() }
  );
  return { ...set, grant, runId };
};

/** What `resumed` ends with: a note's ID it wrote, or the code it failed with. */
const endOf = (ran: unknown): unknown =>
  z
    .union([
      z
        .object({ ended: z.object({ output: z.string().min(1) }) })
        .transform(() => "wrote"),
      z.object({ ended: z.string() }).transform((failed) => failed.ended),
    ])
    .parse(ran);

describe("a workflow calling an App's functions", () => {
  it("calls the functions it was granted by their IDs, and fails on one it wasn't", async () => {
    const { builder, acting, app, workflow, create, titles } = await setUp();
    await publishWorkflowVersion(env, acting, workflow.id, {
      definition: writingNotes(app, create, titles),
      basedOn: null,
    });
    // Only `create` granted: its call goes through, `titles` is refused.
    await requestGranted(idp, builder, callRequest(workflow.id, app, create));
    const halfway = await ranWith(builder, workflow.id, "First");
    await requestGranted(idp, builder, callRequest(workflow.id, app, titles));
    const granted = await ranWith(builder, workflow.id, "Second");

    expect({ halfway, granted }).toStrictEqual({
      halfway: { status: "failed", code: "workflow.call_denied" },
      granted: { status: "completed", titles: ["First", "Second"] },
    });
  });

  it("keeps calling the same function after the App renamed it", async () => {
    const { builder, acting, app, workflow, create, titles, source } =
      await setUp();
    await publishWorkflowVersion(env, acting, workflow.id, {
      definition: writingNotes(app, create, titles),
      basedOn: null,
    });
    await requestGranted(idp, builder, callRequest(workflow.id, app, create));
    await requestGranted(idp, builder, callRequest(workflow.id, app, titles));
    // `create` is `add` now, and an impostor took the path `create`.
    const renamed = await redefined(
      app,
      source,
      {
        "server/notes.ts": `${notesCode("add")}
export const create = mutation({
  args: { title: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx) => await ctx.db.insert("notes", { title: "impostor" }),
});
`,
      },
      { op: "renameFunction", function: "notes.create", name: "notes.add" }
    );
    await published(builder, app, renamed);

    await expect(
      ranWith(builder, workflow.id, "Renamed")
    ).resolves.toStrictEqual({
      status: "completed",
      titles: ["Renamed"],
    });
  });

  it("refuses to publish a call of a function its App doesn't give", async () => {
    const { acting, app, workflow, create } = await setUp();
    const other = await setUp();

    const refused = await refusal(
      publishWorkflowVersion(env, acting, workflow.id, {
        // `titles` of another App: an ID this App never gave.
        definition: writingNotes(app, create, other.titles),
        basedOn: null,
      })
    );

    expect(problemsOf(refused)).toStrictEqual({
      code: "workflow.definition_invalid",
      problems: [
        `workflow.app_function_unavailable /permissions/apps/notes/functions/${other.titles}`,
      ],
    });
  });

  it("answers a test run's App calls from its start, and the App keeps only what real runs wrote", async () => {
    const { builder, acting, app, workflow, create, titles } = await setUp();
    const source = writingNotes(app, create, titles);
    // What `create` answers: a record ID, as the function returns one.
    const noteId = "01890a5d-ac96-774b-bcce-b302099a8057";
    const { revision: base } = await workflowDraft(env, acting, workflow.id);
    const { revision, problems } = await editWorkflowDraft(
      env,
      acting,
      workflow.id,
      { expectedRevision: base, source }
    );
    const { runId } = await startCandidateRun(env, acting, workflow.id, {
      revision,
      args: { title: "Never written" },
      fixtures: {
        [`notes/${create}`]: { result: noteId },
        [`notes/${titles}`]: { result: ["From the test"] },
      },
    });
    const run = await vi.waitFor(
      async () => {
        const read = await candidateRunFor(env, acting, workflow.id, runId);
        if (read.status === "starting" || read.status === "running") {
          throw new Error(`The test run is ${read.status}`);
        }
        return read;
      },
      { timeout: 30_000, interval: 100 }
    );
    // A real run of the same definition, granted, reads what the App holds.
    await publishWorkflowVersion(env, acting, workflow.id, {
      definition: source,
      basedOn: null,
    });
    await requestGranted(idp, builder, callRequest(workflow.id, app, create));
    await requestGranted(idp, builder, callRequest(workflow.id, app, titles));
    const real = await ranWith(builder, workflow.id, "Real");

    expect({
      problems,
      tested: { status: run.status, output: run.result },
      real,
    }).toStrictEqual({
      problems: [],
      tested: {
        status: "completed",
        output: { note: noteId, titles: ["From the test"] },
      },
      real: { status: "completed", titles: ["Real"] },
    });
  });

  it("reads the Apps a draft names only once it passes the format's check and limits", async () => {
    const { acting, app, workflow, create, titles } = await setUp();
    // Core's database, counting each read of the Apps table.
    let appReads = 0;
    const counting: D1Database = {
      prepare: (query) => {
        if (/from "apps"/u.test(query)) {
          appReads += 1;
        }
        return env.DB.prepare(query);
      },
      batch: async (statements) => await env.DB.batch(statements),
      exec: async (query) => await env.DB.exec(query),
      // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
      dump: async () => await env.DB.dump(),
      withSession: (constraint) => env.DB.withSession(constraint),
    };
    const saved = async (text: string) => {
      appReads = 0;
      const { revision } = await workflowDraft(env, acting, workflow.id);
      const draft = await editWorkflowDraft(
        { ...env, DB: counting },
        acting,
        workflow.id,
        { expectedRevision: revision, source: text }
      );
      return { codes: draft.problems.map(({ code }) => code), appReads };
    };
    const document = z
      .looseObject({
        permissions: z.object({ apps: z.record(z.string(), z.unknown()) }),
      })
      .parse(JSON.parse(writingNotes(app, create, titles)));
    // Past the limit: 64 event permissions beside the App's functions.
    const overLimit = JSON.stringify({
      ...document,
      permissions: {
        ...document.permissions,
        events: Object.fromEntries(
          Array.from({ length: 64 }, (_, index) => [
            `replies${index}`,
            { contract: "grasp.replies@1" },
          ])
        ),
      },
    });
    // The same App under a second alias.
    const repeated = JSON.stringify({
      ...document,
      permissions: {
        apps: {
          ...document.permissions.apps,
          again: { app, functions: { [titles]: "notes.titles" } },
        },
      },
    });

    const valid = await saved(JSON.stringify(document));
    expect({
      over: await saved(overLimit),
      repeated: await saved(repeated),
      validRead: valid.appReads > 0,
      validCodes: valid.codes,
    }).toStrictEqual({
      over: { codes: ["workflow.out_of_bounds"], appReads: 0 },
      repeated: { codes: ["workflow.duplicate"], appReads: 0 },
      validRead: true,
      validCodes: [],
    });
  });

  it("names a renamed function by its new path when the draft is saved again", async () => {
    const { builder, acting, app, workflow, create, titles, source } =
      await setUp();
    const save = async (text: string) => {
      const { revision } = await workflowDraft(env, acting, workflow.id);
      return await editWorkflowDraft(env, acting, workflow.id, {
        expectedRevision: revision,
        source: text,
      });
    };
    const before = await save(writingNotes(app, create, titles));
    await published(
      builder,
      app,
      await redefined(
        app,
        source,
        { "server/notes.ts": notesCode("add") },
        { op: "renameFunction", function: "notes.create", name: "notes.add" }
      )
    );
    const after = await save(writingNotes(app, create, titles));

    expect({
      before: hintsOf(before.source),
      after: hintsOf(after.source),
      problems: after.problems,
    }).toStrictEqual({
      before: { [create]: "notes.create", [titles]: "notes.titles" },
      after: { [create]: "notes.add", [titles]: "notes.titles" },
      problems: [],
    });
  });

  it("fails a waiting run's next call once its grant is revoked, or its App removed", async () => {
    const revoked = await waitingRun();
    const admin = await signedInApi(idp, "admin");
    await admin.api.permissions.revoke(revoked.grant);
    const removed = await waitingRun();
    await removed.builder.api.apps.archive(removed.app);
    await removed.builder.api.apps.remove(removed.app);

    expect({
      revoked: await resumed(revoked.runId, revoked.create),
      removed: await resumed(removed.runId, removed.create),
    }).toMatchObject({
      revoked: { ended: "workflow.call_denied", tampered: [] },
      removed: { ended: "workflow.call_denied", tampered: [] },
    });
  });

  it("keeps a waiting run's call working through an App rolled back, and keeps its function from being removed", async () => {
    // Rolled back past a rename while the run waits: the ID is the
    // function it always was.
    const rolled = await waitingRun();
    await published(
      rolled.builder,
      rolled.app,
      await redefined(
        rolled.app,
        rolled.source,
        { "server/notes.ts": notesCode("add") },
        { op: "renameFunction", function: "notes.create", name: "notes.add" }
      )
    );
    const admin = await signedInApi(idp, "admin");
    const rolledBack = await refusal(
      admin.api.apps.versions.setCurrent(rolled.app, 1)
    );
    // A new version without the function the waiting run calls: refused
    // while the workflow holds its grant, so the run still reaches it.
    const removing = await waitingRun();
    const removal = await published(
      removing.builder,
      removing.app,
      withFiles(removing.source, {
        "server/notes.ts": notesCode().replace(
          /export const create[\s\S]*?\}\);\n/u,
          ""
        ),
      })
    );

    expect({
      rolledBack,
      rolled: endOf(await resumed(rolled.runId, rolled.create)),
      removal: z.object({ code: z.string() }).parse(removal).code,
      removing: endOf(await resumed(removing.runId, removing.create)),
    }).toStrictEqual({
      rolledBack: "ok",
      rolled: "wrote",
      removal: "version.functions_in_use",
      removing: "wrote",
    });
  });

  it("writes once when its step is run again after the App wrote, its answer lost", async () => {
    const { builder, acting, app, workflow, create, titles } = await setUp();
    await publishWorkflowVersion(env, acting, workflow.id, {
      definition: writingNotes(app, create, titles, true),
      basedOn: null,
    });
    await requestGranted(idp, builder, callRequest(workflow.id, app, create));
    await requestGranted(idp, builder, callRequest(workflow.id, app, titles));
    const { runId } = await builder.api.workflowResources.start(workflow.id, {
      version: 1,
      args: { title: "Once" },
      key: unique(),
    });
    const code = moduleOf(`
const made = await step.do("made", { key: "task", description: "made" }, async () => ({ output: await env.notes.call(${JSON.stringify(create)}, { title: "Once" }) }));
const listed = await step.do("listed", { key: "task", description: "listed" }, async () => ({ output: await env.notes.call(${JSON.stringify(titles)}, {}) }));
return { note: made.output, titles: listed.output };`);
    // The App wrote the note, then the activation died before the step's
    // result was journaled: the next activation runs the step again.
    const fresh = newerEngine();
    const lostAfterMade: typeof fresh = {
      leaseOf: fresh.leaseOf,
      step: {
        ...fresh.step,
        do: async (name, config, fn) => {
          const value = await fresh.step.do(name, config, fn);
          if (name === "made:task") {
            throw new Error("The activation was evicted");
          }
          return value;
        },
      },
    };
    await ranAs(runId, code, { engine: lostAfterMade });
    const again = await ranAs(runId, code);

    // Both activations called the App (two receipts of `made` done), and
    // the App holds the note once.
    const events = await allEvents();
    const madeDone = events.filter(
      ({ action, target, detail }) =>
        action === "workflow.run.called" &&
        target?.id === runId &&
        detail?.task === "made" &&
        detail.outcome === "done"
    ).length;

    expect({ madeDone, again }).toMatchObject({
      madeDone: 2,
      again: { ended: { titles: ["Once"] }, tampered: [] },
    });
  });

  it("refuses code that calls a function its step doesn't seal, of its own App or another", async () => {
    const { builder, acting, app, workflow, create, titles } = await setUp();
    const other = await setUp();
    await publishWorkflowVersion(env, acting, workflow.id, {
      definition: writingNotes(app, create, titles, true),
      basedOn: null,
    });
    // Both of the App's functions granted: the build, never the grant,
    // decides what a step calls.
    await requestGranted(idp, builder, callRequest(workflow.id, app, create));
    await requestGranted(idp, builder, callRequest(workflow.id, app, titles));
    const tampered = async (fn: string) => {
      const { runId } = await builder.api.workflowResources.start(workflow.id, {
        version: 1,
        args: { title: "Forged" },
        key: unique(),
      });
      return await ranAs(
        runId,
        moduleOf(
          `return await step.do("made", { key: "task", description: "Its task" }, async () => await env.notes.call(${JSON.stringify(fn)}, { title: "Forged" }));`
        )
      );
    };

    expect({
      sibling: await tampered(titles),
      otherApp: await tampered(other.create),
    }).toStrictEqual({
      sibling: refusedAs(`Step "made:task" calls only ${create}.`),
      otherApp: refusedAs(`Step "made:task" calls only ${create}.`),
    });
  });
});
