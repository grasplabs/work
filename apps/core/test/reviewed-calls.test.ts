import {
  appIdSchema,
  connectionIdSchema,
  permissionIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { stepIdempotencyKey } from "@grasp-os/shared/workflows";
import type { WorkflowCalls } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runBindingsFor } from "../src/bindings.ts";
import type { AttemptHost } from "../src/workflows/attempt-host.ts";
import type { Settled } from "../src/workflows/code.ts";
import { RunHost } from "../src/workflows/host.ts";
import type { HostHooks } from "../src/workflows/host.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { engineOfTest } from "./run-host.ts";
import { endLiveRuns, finished } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import {
  appWith,
  grantMail,
  hitCall,
  hitsOf,
  invoiceMail,
  mailer,
  sampleApp,
  workflowFiles,
} from "./workflow-apps.ts";

// A run's calls of its App's bindings are held to what the review of its
// version shows its workflow calling (`app_versions.workflow_calls`): each
// step to its own, or, when its steps can't be read, every step to all
// the workflow's code calls. A call the review doesn't show is refused,
// audited once per attempt, and fails its step; a run of a workflow its
// version's row keeps nothing for fails before any step; a version whose
// calls can't be read at all isn't committed. Real runs on the Workflows engine,
// and, for what code in a run's isolate would have to get past the SDK to
// try, the host a run's isolate calls, with an engine of the test's own
// that runs each step once, as the platform's does.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/** What version 1 of `app` keeps of what its workflows call. */
const storedCalls = async (app: string): Promise<unknown> => {
  const row = await env.DB.prepare(
    "SELECT workflow_calls FROM app_versions WHERE app_id = ? AND version = 1"
  )
    .bind(app)
    .first<{ workflow_calls: string }>();
  return row === null ? null : JSON.parse(row.workflow_calls);
};

/** Keeps `calls` as what version `version` (1 by default) of `app`'s review showed. */
const describedAs = async (
  app: string,
  calls: Record<string, WorkflowCalls>,
  version = 1
): Promise<void> => {
  await env.DB.prepare(
    "UPDATE app_versions SET workflow_calls = ? WHERE app_id = ? AND version = ?"
  )
    .bind(JSON.stringify(calls), app, version)
    .run();
};

/** A run's refusals of calls, as the audit log has them. */
const refusals = async (run: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action === "workflow.call.refused" && target?.id === run
    )
    .map(({ detail }) => ({
      step: detail.step,
      call: detail.call,
      errorCode: detail.errorCode,
    }));
};

/**
 * A run's status and output, the step and error code its failure report
 * names, and whether that error's message says `says`.
 */
const outcomeOf = async (
  person: Awaited<ReturnType<typeof personApi>>,
  run: string,
  says = ""
) => {
  const { status, failure, output } = await person.api.workflows.status(run);
  return {
    status,
    output,
    step: failure?.step,
    code: failure?.error.code,
    says: failure?.error.message.includes(says) ?? false,
  };
};

/**
 * A host for a run of a new App held to `calls`, whose calls of its App's
 * functions are counted in `appCalls`, by contract, with a connection
 * permission as `CRM` when it has no real App (`of`); what it says fails
 * the run as tampering is in `tampered`.
 */
const hostHeldTo = async (
  calls: WorkflowCalls,
  {
    db = env.DB,
    of,
  }: {
    db?: D1Database;
    /** A real App and the person the run acts for, with its connections. */
    of?: { app: string; userId: string };
  } = {}
) => {
  const builder = of === undefined ? await personApi("builder") : undefined;
  const userId = of?.userId ?? builder?.userId ?? "";
  const app = appIdSchema.parse(of?.app ?? crypto.randomUUID());
  const runId = runIdSchema.parse(crypto.randomUUID());
  const authority = authoritySchema.parse({
    subject: { type: "app", appId: app },
    onBehalfOf: userId,
    mode: "workflow",
    appVersion: 1,
  });
  if (of !== undefined) {
    // The run's row, which its work context names.
    await env.DB.prepare(
      "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at) VALUES (?, ?, 'tidy', 1, ?, 'running', ?)"
    )
      .bind(runId, app, userId, Date.now())
      .run();
  }
  const { connections } =
    of === undefined
      ? {
          connections: {
            CRM: {
              context: { type: "run" as const, appId: app, runId },
              permissionId: permissionIdSchema.parse(crypto.randomUUID()),
              connection: {
                type: "connection" as const,
                connectionId: connectionIdSchema.parse(crypto.randomUUID()),
              },
            },
          },
        }
      : await runBindingsFor(env, authority, {
          type: "run",
          appId: app,
          runId,
        });
  const appCalls: string[] = [];
  const tampered: string[] = [];
  const models: string[] = [];
  const { step, leaseOf, leases } = engineOfTest();
  const hooks: HostHooks = {
    stepFailed: () => {},
    busyRefusals: new Map(),
    leaseOf,
    tampered: (error) => {
      tampered.push(error.code ?? error.message);
    },
    waiting: async () => {
      await Promise.resolve();
    },
    callFunction: async (_caller, reference) => {
      appCalls.push(
        typeof reference === "object" &&
          reference !== null &&
          "contractId" in reference
          ? String(reference.contractId)
          : "?"
      );
      return await Promise.resolve({ ok: true, value: null });
    },
    // Records the model binding a call got past the host's checks with,
    // then stops it: no gateway here.
    modelBinding: (alias) => {
      models.push(alias);
      throw new Error("No model step here");
    },
  };
  const host = new RunHost(
    { ...env, DB: db },
    step,
    {
      app,
      workflow: workflowIdSchema.parse("tidy"),
      version: 1,
      runId,
      shareSubject: `trigger:${app}`,
      authority,
      collections: {},
      connections,
      calls,
    },
    hooks
  );
  return { host, runId, appCalls, tampered, models, userId, leases };
};

/** The App's counter's `hit`, as a step calls it. */
const hit = { contractId: "counter.hit", kind: "action" } as const;

/** A step function that answers 1 at once. */
const ranOne = async (): Promise<Settled<unknown>> =>
  await Promise.resolve({ ok: true, value: 1 });

/** Asks a decision's recipients from inside a step. */
const recipients = async (attempt: AttemptHost) =>
  await attempt.decisionRecipients(crypto.randomUUID(), false);

/** A refusal inside a step that caught it and returned: the step failed. */
const failedStep = (refused: ReturnType<typeof tamperedWith>) => ({
  ...refused,
  step: "workflow.step_not_reviewed",
});

/** What a step run as another kind than its review keeps leaves behind. */
const tamperedWith = (step: string, call: string | null = null) => ({
  code: "workflow.step_not_reviewed",
  tampered: ["workflow.step_not_reviewed"],
  audited: [{ step, call, errorCode: "workflow.step_not_reviewed" }],
});

/** A settled call's error code, or `ok`. */
const codeOf = (settled: Settled<unknown>): string =>
  settled.ok ? "ok" : (settled.error.code ?? settled.error.message);

describe("a run's binding calls", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("run a call a step's review shows, and refuse and audit it from a step whose review doesn't", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const shown = await appWith(admin, mailer(""));
    const hidden = await appWith(admin, mailer(""));
    for (const app of [shown, hidden]) {
      // oxlint-disable-next-line no-await-in-loop -- one grant at a time
      await grantMail(idp, admin, app, mail.id);
    }
    const kept = await storedCalls(shown);
    await describedAs(hidden, {
      mailer: {
        steps: { send: [] },
        kinds: { send: "exact" },
        models: {},
        keyed: [],
        all: [],
      },
    });

    const sent = await admin.api.workflows.start(shown, "mailer");
    const refused = await admin.api.workflows.start(hidden, "mailer");
    await Promise.all([finished(sent.id), finished(refused.id)]);

    expect({
      kept,
      sent: await outcomeOf(admin, sent.id),
      refused: await outcomeOf(admin, refused.id, 'Step "send" called MAIL'),
      audited: await refusals(refused.id),
      server: await mail.did(),
    }).toMatchObject({
      // What the reader shows the review, kept as the version is committed.
      kept: {
        mailer: {
          steps: { send: ["MAIL"] },
          kinds: { send: "exact" },
          models: {},
          keyed: [],
          all: ["MAIL"],
        },
      },
      sent: { status: "completed" },
      refused: {
        status: "failed",
        step: "send",
        code: "workflow.call_not_reviewed",
        says: true,
      },
      audited: [
        { step: "send", call: "MAIL", errorCode: "workflow.call_not_reviewed" },
      ],
      // Only the run whose review shows the call reached the mail server.
      server: { calls: 1, sent: [invoiceMail] },
    });
  });

  it("show a review of what the version's row keeps, and fail a run of a workflow it keeps nothing for before it calls anything", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const { id: app } = await admin.api.apps.create({ name: "Invoices" });
    const { version } = await admin.api.apps.files.commit(
      app,
      { ...sampleApp(), ...mailer("") },
      "Mailer"
    );
    const reviewedKept = await admin.api.apps.versions.review(app, version);
    // Nothing is read from the version's files in its place.
    await describedAs(app, {});
    const reviewedUnkept = await admin.api.apps.versions.review(app, version);
    await admin.api.apps.versions.setCurrent(app, version);
    await grantMail(idp, admin, app, mail.id);

    const run = await admin.api.workflows.start(app, "mailer");
    await finished(run.id);
    const events = await allEvents();

    expect({
      reviewed: [reviewedKept, reviewedUnkept].map(({ workflows }) =>
        workflows.map(({ id, calls }) => ({ id, calls }))
      ),
      run: await outcomeOf(admin, run.id),
      audited: events
        .filter(
          ({ action, target }) =>
            action === "workflow.run.failed" && target?.id === run.id
        )
        .map(({ detail }) => detail.error),
      kept: await storedCalls(app),
      server: await mail.did(),
    }).toMatchObject({
      reviewed: [
        [{ id: "mailer", calls: ["MAIL"] }],
        [{ id: "mailer", calls: [] }],
      ],
      run: { status: "failed", step: null, code: "workflow.calls_not_kept" },
      audited: ["workflow.calls_not_kept"],
      kept: {},
      server: { calls: 0 },
    });
  });

  it("hold every step of a workflow whose steps can't be read to all its code calls, shown in its review", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    // A step in a `try` can't be read as a step list.
    const files = workflowFiles(
      "guarded",
      `  try {
    return await step.do(
      "send",
      { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify(invoiceMail)} },
      async ({ idempotencyKey, input: mail }) =>
        JSON.parse(((await env.MAIL.call("mail.send", mail, { idempotencyKey })) as { output: string }).output)
    );
  } catch (error) {
    throw error;
  }`,
      { send: { messageId: "mocked" } }
    );
    const { id: app } = await admin.api.apps.create({ name: "Invoices" });
    const { version } = await admin.api.apps.files.commit(
      app,
      { ...sampleApp(), ...files },
      "Guarded"
    );
    const { workflows } = await admin.api.apps.versions.review(app, version);
    await admin.api.apps.versions.setCurrent(app, version);
    await grantMail(idp, admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "guarded");
    await finished(run.id);

    expect({
      reviewed: workflows.map(({ id, steps, calls }) => ({ id, steps, calls })),
      kept: await storedCalls(app),
      run: await outcomeOf(admin, run.id),
      server: await mail.did(),
    }).toMatchObject({
      reviewed: [{ id: "guarded", steps: null, calls: ["MAIL"] }],
      kept: {
        guarded: {
          steps: null,
          kinds: {},
          models: {},
          keyed: [],
          all: ["MAIL"],
        },
      },
      run: { status: "completed", output: { messageId: "message-1" } },
      server: { calls: 1, sent: [invoiceMail] },
    });
  });

  it("hold a workflow whose calls can't be read to none, such as a stub made in one step and called in another", async () => {
    const admin = await personApi("admin");
    const files = workflowFiles(
      "tidy",
      `  let app!: typeof env.APP;
  await step.do("prepare", { description: "Prepare" }, async () => {
    app = env.APP;
  });
  return await step.do("tidy-up", { description: "Tidy" }, async () => {
    await app.callFunction({ contractId: "counter.hit", kind: "action" }, { name: "tidied", execution: crypto.randomUUID() });
    return "tidied";
  });`,
      { prepare: null, "tidy-up": null }
    );
    const { id: app } = await admin.api.apps.create({ name: "Invoices" });
    const { version } = await admin.api.apps.files.commit(
      app,
      { ...sampleApp(), ...files },
      "Tidy"
    );
    const { workflows } = await admin.api.apps.versions.review(app, version);
    await admin.api.apps.versions.setCurrent(app, version);
    const run = await admin.api.workflows.start(app, "tidy");
    await finished(run.id);

    expect({
      reviewed: workflows.map(({ id, steps, calls }) => ({ id, steps, calls })),
      kept: await storedCalls(app),
      run: await outcomeOf(admin, run.id, 'Step "tidy-up" called APP'),
      audited: await refusals(run.id),
      hits: await hitsOf(admin, app, "tidied"),
    }).toMatchObject({
      // The reader refuses a stub kept in a variable: the review shows the
      // workflow's steps as unreadable, calling none of the App's bindings.
      reviewed: [{ id: "tidy", steps: null, calls: [] }],
      kept: {
        tidy: { steps: null, kinds: {}, models: {}, keyed: [], all: [] },
      },
      run: {
        status: "failed",
        step: "tidy-up",
        code: "workflow.call_not_reviewed",
        says: true,
      },
      audited: [
        {
          step: "tidy-up",
          call: "APP",
          errorCode: "workflow.call_not_reviewed",
        },
      ],
      hits: 0,
    });
  });

  it("run the workflow its review shows, though its module tries to put another run in its place", async () => {
    const admin = await personApi("admin");
    const files = workflowFiles(
      "tidy",
      `  return await step.do("tidy", { description: "Tidy" }, async () => {
    await ${hitCall(`"tidied"`)};
    return "tidied";
  });`,
      { tidy: null }
    );
    // The workflow's module imports itself, and once it has loaded puts a
    // run of its own on the definition: one that runs a step under a name
    // the review shows, calling what that step may, with other arguments.
    const swaps = `import me from "./tidy.ts";

queueMicrotask(() => {
  try {
    Object.assign(me, {
      run: async (engine: { do: <T>(name: string, options: object, fn: () => Promise<T>) => Promise<T>; env: { APP: { callFunction: (...args: object[]) => Promise<unknown> } } }) => {
        await engine.do("tidy:x1", {}, async () => await engine.env.APP.callFunction({ contractId: "counter.hit", kind: "action" }, { name: "swapped", execution: "swapped" }));
        return "swapped";
      },
    });
  } catch {}
});
`;
    const source = (files["workflows/tidy.ts"] ?? "").replace(
      '} from "@grasp-os/sdk/workflow";\n',
      `} from "@grasp-os/sdk/workflow";\n${swaps}`
    );
    const app = await appWith(admin, {
      ...files,
      "workflows/tidy.ts": source,
    });

    const run = await admin.api.workflows.start(app, "tidy");
    await finished(run.id);

    expect({
      kept: await storedCalls(app),
      run: await outcomeOf(admin, run.id),
      tidied: await hitsOf(admin, app, "tidied"),
      swapped: await hitsOf(admin, app, "swapped"),
    }).toMatchObject({
      kept: {
        tidy: {
          steps: { tidy: ["APP"] },
          kinds: { tidy: "exact" },
          models: {},
          keyed: [],
          all: ["APP"],
        },
      },
      run: { status: "completed", output: "tidied" },
      tidied: 1,
      swapped: 0,
    });
  });

  it("refuse a call made through a step attempt's host once that attempt is over, while another step runs, and a step whose name the review doesn't show", async () => {
    const { host, runId, appCalls } = await hostHeldTo({
      steps: { arm: [], send: ["APP"] },
      kinds: { arm: "exact", send: "exact" },
      models: {},
      keyed: [],
      all: ["APP"],
    });
    let armed: AttemptHost | undefined;
    await host.do("arm", {}, async (attempt) => {
      armed = attempt;
      return await Promise.resolve({ ok: true, value: null });
    });
    let leftBehind: Settled<unknown> = { ok: true, value: null };
    const sent = await host.do("send", {}, async () => {
      // As code `arm` left behind would, through the host `arm` was handed.
      if (armed !== undefined) {
        leftBehind = await armed.callFunction(hit, { name: "armed" });
      }
      return { ok: true, value: null };
    });
    // Last: a step the review doesn't show ends the run.
    const unnamed = await host.do(
      "evil",
      {},
      async () => await Promise.resolve({ ok: true, value: null })
    );

    expect({
      leftBehind: codeOf(leftBehind),
      // Its own code made no call it may not: `arm`'s call was `arm`'s.
      sent: codeOf(sent),
      unnamed: codeOf(unnamed),
      appCalls,
      audited: await refusals(runId),
    }).toStrictEqual({
      leftBehind: "execution.stale_attempt",
      sent: "ok",
      unnamed: "workflow.step_not_reviewed",
      appCalls: [],
      audited: [
        { step: "arm", call: "APP", errorCode: "execution.stale_attempt" },
        { step: "evil", call: null, errorCode: "workflow.step_not_reviewed" },
      ],
    });
  });

  it("send no connection call whose attempt the engine gave up on while it was authorized and signed", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await appWith(admin, {});
    await grantMail(idp, admin, app, mail.id);
    let giveUp: (() => void) | undefined;
    // Core's database, giving the attempt up once the call is checked
    // against the run's permissions.
    const db = new Proxy(env.DB, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key);
        if (key === "prepare" && typeof value === "function") {
          return (query: string) => {
            if (query.includes("permission")) {
              giveUp?.();
            }
            return target.prepare(query);
          };
        }
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
    const { host, leases, runId } = await hostHeldTo(
      {
        steps: { tidy: ["MAIL"] },
        kinds: { tidy: "exact" },
        models: {},
        keyed: [],
        all: ["MAIL"],
      },
      { db, of: { app, userId: admin.userId } }
    );
    let sent = "";
    await host.do(
      "tidy",
      { sideEffect: true, input: null },
      async (attempt) => {
        giveUp = () => {
          leases.delete("key:tidy");
        };
        sent = codeOf(
          await attempt.callConnection("MAIL", [
            "mail.send",
            invoiceMail,
            { idempotencyKey: stepIdempotencyKey(runId, "tidy") },
          ])
        );
        return { ok: true, value: null };
      }
    );

    const { calls } = await mail.did();
    expect({ sent, server: calls }).toStrictEqual({
      sent: "execution.stale_attempt",
      server: 0,
    });
  });

  it("refuse a call unless the step running now and the step whose host it came through both call it, failing both", async () => {
    const { host, runId, appCalls } = await hostHeldTo({
      steps: { arm: ["APP"], send: [] },
      kinds: { arm: "exact", send: "exact" },
      models: {},
      keyed: [],
      all: ["APP"],
    });
    let passed: Settled<unknown> = { ok: true, value: null };
    let sent: Settled<unknown> = { ok: true, value: null };
    // `arm`'s code hands its host to `send`'s, running inside it, which
    // calls APP with it: `arm`'s review shows APP, `send`'s doesn't.
    const armed = await host.do("arm", {}, async (arm) => {
      sent = await host.do("send", {}, async () => {
        passed = await arm.callFunction(hit, { name: "passed" });
        return { ok: true, value: null };
      });
      return { ok: true, value: null };
    });

    expect({
      passed: codeOf(passed),
      sent: codeOf(sent),
      armed: codeOf(armed),
      appCalls,
      audited: await refusals(runId),
    }).toStrictEqual({
      passed: "workflow.call_not_reviewed",
      sent: "workflow.call_not_reviewed",
      armed: "workflow.call_not_reviewed",
      appCalls: [],
      audited: [
        { step: "send", call: "APP", errorCode: "workflow.call_not_reviewed" },
      ],
    });
  });

  it("refuse, as stale, an attempt's calls of every kind once the engine gave up on it, and audit the first", async () => {
    const { host, runId, appCalls, leases, userId } = await hostHeldTo({
      steps: { tidy: ["APP", "CRM", "HANDBOOK"] },
      kinds: { tidy: "exact" },
      models: {},
      keyed: [],
      all: ["APP", "CRM", "HANDBOOK"],
    });
    const codes: Record<string, string> = {};
    await host.do("tidy", {}, async (attempt) => {
      // The engine gives up on it: it timed out, the run was cancelled or
      // paused, or another activation took over.
      leases.delete("key:tidy");
      codes.model = codeOf(
        await attempt.callModel({
          step: "tidy",
          model: "default",
          instructions: "Summarise the invoice",
          input: "Invoice INV-7",
          outputSchema: { type: "string" },
        })
      );
      codes.collection = codeOf(
        await attempt.callCollection("HANDBOOK", "search", ["invoices"])
      );
      codes.connection = codeOf(
        await attempt.callConnection("CRM", ["find", {}])
      );
      codes.app = codeOf(await attempt.callFunction(hit, { name: "late" }));
      codes.openDecision = codeOf(
        await attempt.openDecision({
          step: "tidy",
          from: `person:${userId}`,
          description: "Approve the invoice",
          timeout: 60_000,
        })
      );
      codes.decisionRecipients = codeOf(
        await attempt.decisionRecipients(crypto.randomUUID(), false)
      );
      return { ok: true, value: null };
    });

    expect({ codes, appCalls, audited: await refusals(runId) }).toStrictEqual({
      codes: {
        model: "execution.stale_attempt",
        collection: "execution.stale_attempt",
        connection: "execution.stale_attempt",
        app: "execution.stale_attempt",
        openDecision: "execution.stale_attempt",
        decisionRecipients: "execution.stale_attempt",
      },
      appCalls: [],
      audited: [
        { step: "tidy", call: "model", errorCode: "execution.stale_attempt" },
      ],
    });
  });

  it("refuse, as stale, every call of an attempt the engine gave up on while its code ran on, and audit the first", async () => {
    const { host, runId, appCalls, leases } = await hostHeldTo({
      steps: { tidy: ["APP"] },
      kinds: { tidy: "exact" },
      models: {},
      keyed: [],
      all: ["APP"],
    });
    const codes: string[] = [];
    await host.do("tidy", {}, async (attempt) => {
      // The engine gives up on it: it timed out, or its activation is over.
      leases.delete("key:tidy");
      for (let tries = 0; tries < 2; tries += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one call at a time
        codes.push(codeOf(await attempt.callFunction(hit, { name: "late" })));
      }
      return { ok: true, value: "tidied" };
    });

    expect({ codes, appCalls, audited: await refusals(runId) }).toStrictEqual({
      codes: ["execution.stale_attempt", "execution.stale_attempt"],
      appCalls: [],
      audited: [
        { step: "tidy", call: "APP", errorCode: "execution.stale_attempt" },
      ],
    });
  });

  it("audit only an attempt's first refused call, and refuse every later one of it at once, one its review shows too", async () => {
    const { host, runId, appCalls } = await hostHeldTo({
      steps: { tidy: ["APP"] },
      kinds: { tidy: "exact" },
      models: {},
      keyed: [],
      all: ["APP"],
    });
    const codes: string[] = [];
    const done = await host.do("tidy", {}, async (attempt) => {
      for (let tries = 0; tries < 3; tries += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one call at a time
        codes.push(codeOf(await attempt.callConnection("CRM", ["find", {}])));
      }
      codes.push(codeOf(await attempt.callFunction(hit, { name: "tidied" })));
      // The code carries on as if nothing was refused.
      return { ok: true, value: "tidied" };
    });

    expect({
      codes,
      done: codeOf(done),
      appCalls,
      audited: await refusals(runId),
    }).toStrictEqual({
      codes: [
        "workflow.call_not_reviewed",
        "workflow.call_not_reviewed",
        "workflow.call_not_reviewed",
        "workflow.call_not_reviewed",
      ],
      done: "workflow.call_not_reviewed",
      appCalls: [],
      audited: [
        { step: "tidy", call: "CRM", errorCode: "workflow.call_not_reviewed" },
      ],
    });
  });

  it("review each step's calls, and whether its steps can be read, as the version's row keeps them, not as its source reads now", async () => {
    const admin = await personApi("admin");
    const { id: app } = await admin.api.apps.create({ name: "Invoices" });
    const { version } = await admin.api.apps.files.commit(
      app,
      { ...sampleApp(), ...mailer("") },
      "Mailer"
    );
    // Its source reads as one step, `send`, calling MAIL.
    const reviewedAs = async (calls: Record<string, WorkflowCalls>) => {
      await describedAs(app, calls);
      const { workflows } = await admin.api.apps.versions.review(app, version);
      return workflows.map((workflow) => ({
        id: workflow.id,
        steps:
          workflow.steps?.map(({ name, calls: stepCalls }) => ({
            name,
            calls: stepCalls,
          })) ?? null,
        calls: workflow.calls,
        sideEffect: workflow.sideEffect,
      }));
    };

    expect({
      // Kept as steps that can't be read, as an earlier describer may
      // have: every step may call MAIL, whatever the source reads as now.
      unread: await reviewedAs({
        mailer: {
          steps: null,
          kinds: {},
          models: {},
          keyed: [],
          all: ["MAIL"],
        },
      }),
      // Kept as more than the source reads, a step it doesn't show too.
      more: await reviewedAs({
        mailer: {
          steps: { send: ["MAIL", "CRM"], notify: ["APP"] },
          kinds: { send: "exact", notify: "exact" },
          models: {},
          keyed: [],
          all: ["APP", "CRM", "MAIL"],
        },
      }),
      // Kept as calling nothing: its runs may call nothing.
      none: await reviewedAs({
        mailer: {
          steps: { send: [] },
          kinds: { send: "exact" },
          models: {},
          keyed: [],
          all: [],
        },
      }),
    }).toStrictEqual({
      unread: [
        { id: "mailer", steps: null, calls: ["MAIL"], sideEffect: true },
      ],
      more: [
        {
          id: "mailer",
          steps: [
            { name: "notify", calls: ["APP"] },
            { name: "send", calls: ["MAIL", "CRM"] },
          ],
          calls: ["APP", "CRM", "MAIL"],
          sideEffect: true,
        },
      ],
      none: [
        {
          id: "mailer",
          steps: [{ name: "send", calls: [] }],
          calls: [],
          sideEffect: true,
        },
      ],
    });
  });

  it("show a workflow's change when its source changed in a way the outline can't attribute to the steps its row keeps, and say its steps can't be read when its source can't be read", async () => {
    const admin = await personApi("admin");
    const { id: app } = await admin.api.apps.create({ name: "Invoices" });
    const files: Record<string, string> = {
      ...sampleApp(),
      ...mailer(""),
    };
    const { version: first } = await admin.api.apps.files.commit(
      app,
      files,
      "Mailer"
    );
    await admin.api.apps.versions.setCurrent(app, first);
    // Code outside any step the outline reads changes.
    const edited = `// Mails the invoice.\n${files["workflows/mailer.ts"] ?? ""}`;
    const { version: second } = await admin.api.apps.files.commit(
      app,
      { ...files, "workflows/mailer.ts": edited },
      "Mailer, noted"
    );
    // Both rows keep the same steps and calls, one of them a step the
    // outline doesn't show.
    const kept: Record<string, WorkflowCalls> = {
      mailer: {
        steps: { send: ["MAIL"], notify: ["APP"] },
        kinds: { send: "exact", notify: "exact" },
        models: {},
        keyed: [],
        all: ["APP", "MAIL"],
      },
    };
    await describedAs(app, kept, first);
    await describedAs(app, kept, second);
    const attributed = await admin.api.apps.versions.review(app, second);
    // Its source can't be read as steps (one sits in a `try`), though the
    // row keeps them.
    const guarded = edited
      .replace("  return await step.do(", "  try {\n    return await step.do(")
      .replace(
        "\n  );\n});",
        "\n  );\n  } catch (error) {\n    throw error;\n  }\n});"
      );
    const { version: third } = await admin.api.apps.files.commit(
      app,
      { ...files, "workflows/mailer.ts": guarded },
      "Mailer, guarded"
    );
    await describedAs(app, kept, third);
    const unread = await admin.api.apps.versions.review(app, third);

    expect({
      attributed: attributed.workflows.map(({ id, change, steps }) => ({
        id,
        change,
        steps: steps?.map(({ name, change: stepChange }) => ({
          name,
          change: stepChange,
        })),
      })),
      unread: unread.workflows.map(({ id, steps }) => ({ id, steps })),
    }).toStrictEqual({
      attributed: [
        {
          id: "mailer",
          change: "modified",
          // `send` reads the same; `notify`, which the outline doesn't
          // show, may be anywhere in the file that changed.
          steps: [{ name: "notify", change: "modified" }],
        },
      ],
      unread: [{ id: "mailer", steps: null }],
    });
  });

  it("hold a workflow whose step takes an option from its input to its steps by name, and refuse one its review doesn't show", async () => {
    const admin = await personApi("admin");
    const files = workflowFiles(
      "paced",
      `  await step.do("evil", { description: "Evil" }, async () => "evil");
  await step.sleep("pause", {
    description: "Pause as long as asked",
    duration: typeof input === "number" ? input : 1,
  });
  return "done";`,
      { evil: "evil" }
    );
    const app = await appWith(admin, files);
    // Its review reads every step, the pause's duration as chosen at run
    // time: before, one such option left the whole workflow unread.
    const kept = await storedCalls(app);
    // As a describer that missed `evil` would have kept it.
    await describedAs(app, {
      paced: {
        steps: { pause: [] },
        kinds: { pause: "wait" },
        models: {},
        keyed: [],
        all: [],
        dynamic: { pause: ["duration"] },
      },
    });

    const run = await admin.api.workflows.start(app, "paced", 1);
    await finished(run.id);

    expect({
      kept,
      run: await outcomeOf(admin, run.id),
      audited: await refusals(run.id),
    }).toMatchObject({
      kept: {
        paced: {
          steps: { evil: [], pause: [] },
          kinds: { evil: "exact", pause: "wait" },
          models: {},
          keyed: [],
          all: [],
          dynamic: { pause: ["duration"] },
        },
      },
      run: { status: "failed", code: "workflow.step_not_reviewed" },
      audited: [
        { step: "evil", call: null, errorCode: "workflow.step_not_reviewed" },
      ],
    });
  });

  it("fail a run whose code catches the refusal of a step its review doesn't show, audit it once, and refuse every later step", async () => {
    const admin = await personApi("admin");
    const files = workflowFiles(
      "tidy",
      `  for (let tries = 0; tries < 2; tries += 1) {
    try {
      await step.do("evil", { description: "Evil" }, async () => "evil");
    } catch {}
  }
  let later = "carried on";
  try {
    later = await step.do("tidy", { description: "Tidy" }, async () => {
      await ${hitCall(`"tidied"`)};
      return "tidied";
    });
  } catch (error) {
    later = String((error as { code?: string }).code);
  }
  return later;`,
      { evil: "evil", tidy: "tidied" }
    );
    const app = await appWith(admin, files);
    // Its review shows `tidy` alone, as a describer that missed `evil`
    // would have kept it.
    await describedAs(app, {
      tidy: {
        steps: { tidy: ["APP"] },
        kinds: { tidy: "exact" },
        models: {},
        keyed: [],
        all: ["APP"],
      },
    });

    const run = await admin.api.workflows.start(app, "tidy");
    await finished(run.id);

    expect({
      run: await outcomeOf(admin, run.id),
      audited: await refusals(run.id),
      tidied: await hitsOf(admin, app, "tidied"),
    }).toMatchObject({
      run: { status: "failed", code: "workflow.step_not_reviewed" },
      audited: [
        { step: "evil", call: null, errorCode: "workflow.step_not_reviewed" },
      ],
      tidied: 0,
    });
  });

  it("refuse running a reviewed step as another kind than its review keeps, as tampering, and run each as its kind", async () => {
    const calls: WorkflowCalls = {
      steps: { tidy: [], pause: [], ask: [], write: [] },
      kinds: { tidy: "exact", pause: "wait", ask: "decision", write: "ai" },
      models: {},
      keyed: [],
      all: [],
    };
    const refusedAs = async (
      run: (
        host: Awaited<ReturnType<typeof hostHeldTo>>["host"],
        userId: string
      ) => Promise<Settled<unknown>>
    ) => {
      const { host, runId, tampered, userId } = await hostHeldTo(calls);
      const settled = await run(host, userId);
      return {
        code: codeOf(settled),
        tampered,
        audited: await refusals(runId),
      };
    };
    const inStep = async (
      step: string,
      inside: (
        attempt: AttemptHost,
        userId: string
      ) => Promise<Settled<unknown>>
    ) => {
      const { host, runId, tampered, userId } = await hostHeldTo(calls);
      let within: Settled<unknown> = { ok: true, value: null };
      // The step catches the refusal and returns: it fails all the same.
      const done = await host.do(step, {}, async (attempt) => {
        within = await inside(attempt, userId);
        return { ok: true, value: null };
      });
      return {
        code: codeOf(within),
        step: codeOf(done),
        tampered,
        audited: await refusals(runId),
      };
    };
    const refused = {
      // A wait's name run as code.
      waitAsCode: await refusedAs(
        async (host) => await host.do("pause", {}, ranOne)
      ),
      // Code's name as a wait, and as a decision's wait and part.
      codeAsWait: await refusedAs(async (host) => await host.sleep("tidy", 1)),
      codeAsDecisionWait: await refusedAs(
        async (host) =>
          await host.waitForDecision("tidy#answer", {
            decision: crypto.randomUUID(),
            timeout: 1000,
            last: true,
          })
      ),
      codeAsDecisionPart: await refusedAs(
        async (host) => await host.do("tidy#ask", {}, ranOne)
      ),
      // A decision's parts only as the SDK runs each.
      unknownPart: await refusedAs(
        async (host) => await host.do("ask#bogus", {}, ranOne)
      ),
      answerAsCode: await refusedAs(
        async (host) => await host.do("ask#answer", {}, ranOne)
      ),
      askedAsWait: await refusedAs(
        async (host) =>
          await host.waitForDecision("ask#asked", {
            decision: crypto.randomUUID(),
            timeout: 1000,
            last: true,
          })
      ),
      codeAsksPeople: await inStep("tidy", recipients),
      // An AI step's host, borrowed by an exact step nested in it.
      borrowedModel: await (async () => {
        const { host, runId, tampered } = await hostHeldTo(calls);
        let within: Settled<unknown> = { ok: true, value: null };
        let nested: Settled<unknown> = { ok: true, value: null };
        const done = await host.do("write", {}, async (outer) => {
          nested = await host.do("tidy", {}, async () => {
            within = await outer.callModel({
              step: "write",
              model: "default",
              instructions: "Summarise the invoice",
              input: "Invoice INV-7",
              outputSchema: { type: "string" },
            });
            return { ok: true, value: null };
          });
          return { ok: true, value: null };
        });
        return {
          code: codeOf(within),
          nested: codeOf(nested),
          step: codeOf(done),
          tampered,
          audited: await refusals(runId),
        };
      })(),
      // Two steps live at once, which the SDK never runs (it runs steps
      // one after another): the AI step's model call, made while an
      // exact step started next to it runs, is refused, and both fail.
      parallelModel: await (async () => {
        const { host, runId, tampered } = await hostHeldTo(calls);
        const tidyRuns = Promise.withResolvers<null>();
        const asked = Promise.withResolvers<null>();
        let within: Settled<unknown> = { ok: true, value: null };
        const [write, tidy] = await Promise.all([
          host.do("write", {}, async (attempt) => {
            await tidyRuns.promise;
            within = await attempt.callModel({
              step: "write",
              model: "default",
              instructions: "Summarise the invoice",
              input: "Invoice INV-7",
              outputSchema: { type: "string" },
            });
            asked.resolve(null);
            return { ok: true, value: null };
          }),
          host.do("tidy", {}, async () => {
            tidyRuns.resolve(null);
            await asked.promise;
            return { ok: true, value: null };
          }),
        ]);
        return {
          code: codeOf(within),
          nested: codeOf(tidy),
          step: codeOf(write),
          tampered,
          audited: await refusals(runId),
        };
      })(),
      // A wait run as code from inside a step, caught there: the step fails.
      nestedWaitAsCode: await (async () => {
        const { host, runId, tampered } = await hostHeldTo(calls);
        let within: Settled<unknown> = { ok: true, value: null };
        const done = await host.do("tidy", {}, async () => {
          within = await host.do("pause", {}, ranOne);
          return { ok: true, value: null };
        });
        return {
          code: codeOf(within),
          step: codeOf(done),
          tampered,
          audited: await refusals(runId),
        };
      })(),
      askedAsksPeople: await inStep("ask#asked", recipients),
      // Code asking a model, or opening a decision.
      codeAsksModel: await inStep(
        "tidy",
        async (attempt) =>
          await attempt.callModel({
            step: "tidy",
            model: "default",
            instructions: "Summarise the invoice",
            input: "Invoice INV-7",
            outputSchema: { type: "string" },
          })
      ),
      codeOpensDecision: await inStep(
        "tidy",
        async (attempt, userId) =>
          await attempt.openDecision({
            step: "tidy",
            from: `person:${userId}`,
            description: "Approve the invoice",
            timeout: 60_000,
          })
      ),
    };
    // Each as its kind: code runs, a decision's part runs, a wait waits.
    const asKind = await hostHeldTo(calls);
    const ran = codeOf(await asKind.host.do("tidy", {}, ranOne));
    const part = codeOf(await asKind.host.do("ask#asked", {}, ranOne));

    expect({
      refused,
      asKind: { ran, part, tampered: asKind.tampered },
    }).toStrictEqual({
      refused: {
        waitAsCode: tamperedWith("pause"),
        codeAsWait: tamperedWith("tidy"),
        codeAsDecisionWait: tamperedWith("tidy#answer"),
        codeAsDecisionPart: tamperedWith("tidy#ask"),
        unknownPart: tamperedWith("ask#bogus"),
        answerAsCode: tamperedWith("ask#answer"),
        askedAsWait: tamperedWith("ask#asked"),
        codeAsksPeople: failedStep(tamperedWith("tidy", "decision")),
        nestedWaitAsCode: failedStep(tamperedWith("pause")),
        borrowedModel: {
          ...failedStep(tamperedWith("tidy", "model")),
          nested: "workflow.step_not_reviewed",
        },
        parallelModel: {
          ...failedStep(tamperedWith("tidy", "model")),
          nested: "workflow.step_not_reviewed",
        },
        askedAsksPeople: failedStep(tamperedWith("ask#asked", "decision")),
        codeAsksModel: failedStep(tamperedWith("tidy", "model")),
        codeOpensDecision: failedStep(tamperedWith("tidy", "decision")),
      },
      asKind: { ran: "ok", part: "ok", tampered: [] },
    });
  });

  it("let a workflow whose steps can't be read ask a model only if its code has an AI step", async () => {
    const asked = async (kinds: WorkflowCalls["kinds"]) => {
      const { host, tampered } = await hostHeldTo({
        steps: null,
        kinds,
        models: {},
        keyed: [],
        all: [],
      });
      let model: Settled<unknown> = { ok: true, value: null };
      await host.do("tidy", {}, async (attempt) => {
        model = await attempt.callModel({
          step: "tidy",
          model: "default",
          instructions: "Summarise the invoice",
          input: "Invoice INV-7",
          outputSchema: { type: "string" },
        });
        return { ok: true, value: null };
      });
      return {
        refused: codeOf(model) === "workflow.step_not_reviewed",
        tampered,
      };
    };

    expect({
      none: await asked({}),
      // Past the kind: refused later, by this test's host, for another reason.
      some: await asked({ $ai: "ai" }),
    }).toStrictEqual({
      none: { refused: true, tampered: ["workflow.step_not_reviewed"] },
      some: { refused: false, tampered: [] },
    });
  });

  it("hold an AI step's model call to the binding its review shows it naming, as tampering otherwise", async () => {
    const asked = async (calls: WorkflowCalls, binding: string) => {
      const { host, runId, tampered, models } = await hostHeldTo(calls);
      let model: Settled<unknown> = { ok: true, value: null };
      // The step catches the refusal and returns: it fails all the same.
      const done = await host.do("write", {}, async (attempt) => {
        model = await attempt.callModel({
          step: "write",
          binding,
          instructions: "Summarise the invoice",
          input: "Invoice INV-7",
          outputSchema: { type: "string" },
        });
        return { ok: true, value: null };
      });
      const refused = codeOf(model) === "workflow.step_not_reviewed";
      return {
        refused,
        step: codeOf(done),
        // The binding the call got past every check with, if any.
        reached: models,
        tampered,
        audited: await refusals(runId),
      };
    };
    const read: WorkflowCalls = {
      steps: { write: [], draft: [] },
      kinds: { write: "ai", draft: "ai" },
      models: { write: ["WRITER"], draft: ["DRAFTER"] },
      keyed: [],
      all: [],
    };
    // Its steps unread: held to the bindings its code's AI steps name.
    const unread: WorkflowCalls = {
      steps: null,
      kinds: { $ai: "ai" },
      models: { $ai: ["WRITER"] },
      keyed: [],
      all: [],
    };
    const refusedWith = {
      refused: true,
      step: "workflow.step_not_reviewed",
      reached: [],
      tampered: ["workflow.step_not_reviewed"],
      audited: [
        {
          step: "write",
          call: "model",
          errorCode: "workflow.step_not_reviewed",
        },
      ],
    };

    // The host of `write`, reviewed asking WRITER, borrowed by `draft`
    // nested in it, reviewed asking DRAFTER: both must ask it.
    const borrowed = await (async () => {
      const { host, runId, tampered, models } = await hostHeldTo(read);
      let within: Settled<unknown> = { ok: true, value: null };
      let nested: Settled<unknown> = { ok: true, value: null };
      const done = await host.do("write", {}, async (outer) => {
        nested = await host.do("draft", {}, async () => {
          within = await outer.callModel({
            step: "write",
            binding: "WRITER",
            instructions: "Summarise the invoice",
            input: "Invoice INV-7",
            outputSchema: { type: "string" },
          });
          return { ok: true, value: null };
        });
        return { ok: true, value: null };
      });
      return {
        code: codeOf(within),
        nested: codeOf(nested),
        step: codeOf(done),
        reached: models,
        tampered,
        audited: await refusals(runId),
      };
    })();

    expect({
      borrowed,
      // Another step's model, and one no step names.
      anotherStepsModel: await asked(read, "DRAFTER"),
      unreviewedModel: await asked(read, "PRICEY"),
      unreadOtherModel: await asked(unread, "PRICEY"),
      // A row kept without models allows none.
      noneKept: await asked({ ...read, models: {} }, "WRITER"),
      reviewed: await asked(read, "WRITER"),
      unreadReviewed: await asked(unread, "WRITER"),
    }).toMatchObject({
      borrowed: {
        code: "workflow.step_not_reviewed",
        nested: "workflow.step_not_reviewed",
        step: "workflow.step_not_reviewed",
        reached: [],
        tampered: ["workflow.step_not_reviewed"],
        audited: [
          {
            step: "draft",
            call: "model",
            errorCode: "workflow.step_not_reviewed",
          },
        ],
      },
      anotherStepsModel: refusedWith,
      unreviewedModel: refusedWith,
      unreadOtherModel: refusedWith,
      noneKept: refusedWith,
      reviewed: {
        refused: false,
        reached: ["WRITER"],
        tampered: [],
        audited: [],
      },
      unreadReviewed: {
        refused: false,
        reached: ["WRITER"],
        tampered: [],
        audited: [],
      },
    });
  });

  it("refuse, as tampering, a key on a step its review shows written without one, of every kind, and run a keyed step under its keys", async () => {
    const calls: WorkflowCalls = {
      steps: { tidy: [], each: [], pause: [], ask: [], write: [] },
      kinds: {
        tidy: "exact",
        each: "exact",
        pause: "wait",
        ask: "decision",
        write: "ai",
      },
      models: { write: ["WRITER"] },
      keyed: ["each"],
      all: [],
    };
    const refusedAs = async (
      run: (
        host: Awaited<ReturnType<typeof hostHeldTo>>["host"]
      ) => Promise<Settled<unknown>>
    ) => {
      const { host, runId, tampered } = await hostHeldTo(calls);
      const settled = await run(host);
      return {
        code: codeOf(settled),
        tampered,
        audited: await refusals(runId),
      };
    };
    const refused = {
      code: await refusedAs(
        async (host) => await host.do("tidy:k1", {}, ranOne)
      ),
      ai: await refusedAs(
        async (host) => await host.do("write:k1", {}, ranOne)
      ),
      wait: await refusedAs(async (host) => await host.sleep("pause:k1", 1)),
      decisionPart: await refusedAs(
        async (host) => await host.do("ask:k1#asked", {}, ranOne)
      ),
      decisionWait: await refusedAs(
        async (host) =>
          await host.waitForDecision("ask:k1#answer", {
            decision: crypto.randomUUID(),
            timeout: 1000,
            last: true,
          })
      ),
    };
    const keyed = await hostHeldTo(calls);
    const ran = {
      first: codeOf(await keyed.host.do("each:k1", {}, ranOne)),
      second: codeOf(await keyed.host.do("each:k2", {}, ranOne)),
      unkeyed: codeOf(await keyed.host.do("tidy", {}, ranOne)),
    };
    // A row kept without keys allows none.
    const noneKept = await hostHeldTo({ ...calls, keyed: [] });
    const unkept = codeOf(await noneKept.host.do("each:k1", {}, ranOne));

    expect({ refused, ran, tampered: keyed.tampered, unkept }).toStrictEqual({
      refused: {
        code: tamperedWith("tidy:k1"),
        ai: tamperedWith("write:k1"),
        wait: tamperedWith("pause:k1"),
        decisionPart: tamperedWith("ask:k1#asked"),
        decisionWait: tamperedWith("ask:k1#answer"),
      },
      ran: { first: "ok", second: "ok", unkeyed: "ok" },
      tampered: [],
      unkept: "workflow.step_not_reviewed",
    });
  });

  it("refuse, as tampering and audited, every step of a version kept without kinds", async () => {
    const admin = await personApi("admin");
    const files = workflowFiles(
      "tidy",
      `  return await step.do("tidy", { description: "Tidy" }, async () => "tidied");`,
      { tidy: "tidied" }
    );
    const app = await appWith(admin, files);
    // As a row kept before kinds were.
    await env.DB.prepare(
      "UPDATE app_versions SET workflow_calls = ? WHERE app_id = ? AND version = 1"
    )
      .bind(JSON.stringify({ tidy: { steps: { tidy: [] }, all: [] } }), app)
      .run();

    const run = await admin.api.workflows.start(app, "tidy");
    await finished(run.id);

    expect({
      run: await outcomeOf(admin, run.id),
      audited: await refusals(run.id),
    }).toMatchObject({
      run: { status: "failed", code: "workflow.step_not_reviewed" },
      audited: [
        { step: "tidy", call: null, errorCode: "workflow.step_not_reviewed" },
      ],
    });
  });

  it("refuse a decision a step opens under another step's name, whose reviewer the review read as fixed", async () => {
    const { host, userId, runId, tampered } = await hostHeldTo({
      steps: { ask: [], "sign-off": [] },
      kinds: { ask: "decision", "sign-off": "decision" },
      models: {},
      keyed: [],
      all: [],
      // `ask` takes its reviewer from the run's input; `sign-off` names it.
      dynamic: { ask: ["from"] },
    });
    let opened: Settled<unknown> = { ok: true, value: null };
    const done = await host.do("ask", {}, async (attempt) => {
      opened = await attempt.openDecision({
        step: "sign-off",
        from: `person:${userId}`,
        description: "Approve the invoice",
        timeout: 60_000,
      });
      return { ok: true, value: null };
    });

    expect({
      opened: codeOf(opened),
      // Caught and returned from, the step still fails.
      done: codeOf(done),
      tampered,
      audited: await refusals(runId),
    }).toStrictEqual({
      opened: "workflow.invalid",
      done: "workflow.invalid",
      tampered: ["workflow.invalid"],
      audited: [
        { step: "ask", call: "decision", errorCode: "workflow.invalid" },
      ],
    });
  });

  it("refuse an attempt's model, attachment and decision calls once it had a call refused", async () => {
    const { host, userId } = await hostHeldTo({
      steps: { tidy: [] },
      kinds: { tidy: "exact" },
      models: {},
      keyed: [],
      all: [],
    });
    const codes: string[] = [];
    const done = await host.do("tidy", {}, async (attempt) => {
      const refused = await attempt.callFunction(hit, { name: "tidied" });
      const model = await attempt.callModel({
        step: "tidy",
        model: "default",
        instructions: "Summarise the invoice",
        input: "Invoice INV-7",
        outputSchema: { type: "string" },
      });
      const attachment = await attempt.readAttachment(crypto.randomUUID(), 0);
      const decision = await attempt.openDecision({
        step: "tidy",
        from: `person:${userId}`,
        description: "Approve the invoice",
        timeout: 60_000,
      });
      codes.push(
        codeOf(refused),
        codeOf(model),
        codeOf(attachment),
        codeOf(decision)
      );
      return { ok: true, value: null };
    });

    expect({ codes, done: codeOf(done) }).toStrictEqual({
      codes: [
        "workflow.call_not_reviewed",
        "workflow.call_not_reviewed",
        "workflow.call_not_reviewed",
        "workflow.call_not_reviewed",
      ],
      done: "workflow.call_not_reviewed",
    });
  });
});
