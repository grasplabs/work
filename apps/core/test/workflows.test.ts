import { appErrors } from "@grasp-os/shared/apps";
import type { Role } from "@grasp-os/shared/roles";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import {
  endLiveRuns,
  finished,
  liveStatus,
  stepDone,
  stopped,
  woken,
} from "./runs.ts";
import { refusal, signedInApi } from "./sign-in.ts";
import {
  appWith,
  grantMail,
  hitCall,
  hitsOf,
  invoiceMail,
  mailer,
  runEvents,
  sampleApp,
  triggered,
  workflowFiles,
} from "./workflow-apps.ts";

// Workflows are code the agent writes, run for real: committed to an App,
// tested when their version is made current, and run on the engine
// (Workerflow) by the dispatcher, each in an isolate of its own. Time is
// moved on where a run sleeps (`woken`); the outside systems faked
// here are the model provider behind AI Gateway, and a mail provider's MCP
// server behind the real connect (test/mail-server.ts).
//
// A run's audit events are in an outbox by the time the run has ended: the
// dispatcher's end step writes the run's own event with its row, and each
// step's and each connection call's event is written before the step goes
// on. `allEvents` drains the outboxes before it reads, so a test reads them
// once, after the run ended, rather than wait for them: a wait with a
// deadline adds nothing, and one read of the log can take longer than a
// short deadline on a loaded runner.
//
// The runs of workflows with AI steps are in workflow-ai-steps.test.ts,
// and those that act with what their App and person may in
// workflow-run-permissions.test.ts: apart, so CI can run them side by
// side.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/**
 * Where core's record has a run now, as the App's run list shows it: unlike
 * a run's status, the list never asks the engine.
 */
const listedStatus = async (
  person: Person,
  app: string,
  run: string
): Promise<string | undefined> => {
  const runs = await person.api.workflows.list(app);
  return runs.find(({ id }) => id === run)?.status;
};

describe("workflow runs", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("sleep durably", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "sleeper",
        `  await step.sleep("nap", { description: "Wait a day", duration: "1 day" });
  return "slept";`
      )
    );
    const run = await builder.api.workflows.start(app, "sleeper");
    await woken(run.id, "nap");
    await finished(run.id);
    const { status, output } = await builder.api.workflows.status(run.id);
    expect({ status, output }).toStrictEqual({
      status: "completed",
      output: "slept",
    });
  });

  it("can't be made current while their tests fail or are missing", async () => {
    const builder = await personApi("builder");
    const { id: app } = await builder.api.apps.create({ name: "Untested" });
    const failing = workflowFiles("failing", `  return 1;`);
    failing["workflows/failing.workflow-tests.ts"] =
      `import { workflowTests } from "@grasp-os/sdk/testing";
import definition from "./failing.ts";
export default workflowTests(definition, [{ name: "returns two", expect: { output: 2 } }]);
`;
    const setCurrent = async (files: Record<string, string | null>) => {
      const { version } = await builder.api.apps.files.commit(
        app,
        files,
        "Try"
      );
      return await refusal(builder.api.apps.versions.setCurrent(app, version));
    };
    const outcomes = [
      await setCurrent({ ...sampleApp(), ...failing }),
      await setCurrent({ "workflows/failing.workflow-tests.ts": null }),
    ];
    expect(
      outcomes.map((outcome) => workflowErrors.codeOf(outcome))
    ).toStrictEqual(["workflow.tests_failed", "workflow.tests_failed"]);
    await expect(builder.api.apps.get(app)).resolves.toMatchObject({
      currentVersion: null,
    });
  });

  it("take shared code from a folder under workflows/, and say which files are workflows", async () => {
    const builder = await personApi("builder");
    const { id: app } = await builder.api.apps.create({ name: "Shared" });
    const helper = `export const greeting = (name: string) => \`Hello, \${name}\`;\n`;
    const greet = workflowFiles("greet", `  return greeting("Anna");`);
    const importing = (from: string) =>
      `import { greeting } from "${from}";\n${greet["workflows/greet.ts"]}`;
    const setCurrent = async (files: Record<string, string | null>) => {
      const { version } = await builder.api.apps.files.commit(
        app,
        files,
        "Try"
      );
      return await refusal(builder.api.apps.versions.setCurrent(app, version));
    };

    const directly = await setCurrent({
      ...sampleApp(),
      ...greet,
      "workflows/greet.ts": importing("./greeting.ts"),
      "workflows/greeting.ts": helper,
    });
    const inFolder = await setCurrent({
      "workflows/greet.ts": importing("./lib/greeting.ts"),
      "workflows/greeting.ts": null,
      "workflows/lib/greeting.ts": helper,
    });
    const run = await builder.api.workflows.start(app, "greet");
    await finished(run.id);

    expect({
      directly: z
        .object({ details: z.object({ failures: z.array(z.string()) }) })
        .parse(directly).details.failures,
      inFolder,
      run: await builder.api.workflows.status(run.id),
    }).toMatchObject({
      directly: [
        "greeting: has no tests (workflows/greeting.workflow-tests.ts). Only `workflows/<id>.ts` (an id without dots) is a workflow: put shared code in a folder under workflows/, such as workflows/lib/.",
      ],
      inFolder: "ok",
      run: { status: "completed", output: "Hello, Anna" },
    });
  });

  it("can't replay core's steps or take ones the engine refuses, and audit every step with only well-formed error codes", async () => {
    const admin = await personApi("admin");
    // Written by hand, past the SDK: the host is the boundary, not the SDK.
    const rogue = {
      "workflows/rogue.ts": `import type { WorkflowDefinition } from "@grasp-os/sdk/workflow";

// Past the SDK: the engine as the host hands it to a run's code.
type Engine = {
  do: <T>(name: string, options: object, fn: () => Promise<T>) => Promise<T>;
};

export default {
  metadata: { id: "rogue", params: [] },
  run: async (engine: Engine) => {
    await engine.do("$sneaky", {}, async () => "sneaked");
    // Steps the engine would refuse, which it fails the whole run for:
    // caught here, they must fail no more than their step.
    try {
      await engine.do("bell\u0007", {}, async () => null);
    } catch {}
    try {
      await engine.do("huge", { retries: { limit: 0 } }, async () => "x".repeat(1_100_000));
    } catch {}
    let hijack = "ran";
    try {
      await engine.do("$grasp:end", {}, async () => null);
    } catch (error) {
      hijack = String((error as { code?: string }).code);
    }
    try {
      await engine.do("failing", { retries: { limit: 0 } }, async () => {
        throw Object.assign(new Error("no"), { code: "x".repeat(300) });
      });
    } catch {}
    throw Object.assign(new Error("bad: " + hijack), {
      code: "Invoice for Anna de Vries",
      name: "n".repeat(300),
    });
  },
} as unknown as WorkflowDefinition<never>;
`,
      "workflows/rogue.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";
import definition from "./rogue.ts";
export default workflowTests(definition, [{ name: "fails", expect: { error: "bad" } }]);
`,
    };
    const app = await appWith(admin, rogue);
    const run = await admin.api.workflows.start(app, "rogue");
    await finished(run.id);
    const logged = await allEvents();
    const events = logged.filter(({ target }) => target?.id === run.id);
    const { status, error, failure } = await admin.api.workflows.status(run.id);
    expect({
      status,
      row: await listedStatus(admin, app, run.id),
      hijack: error?.message.includes("bad: workflow.invalid"),
      // It failed after the step it caught, outside any step.
      failure: { step: failure?.step, code: failure?.error.code },
      audited: events
        .filter(({ action }) => action !== "workflow.run.started")
        .map(({ action, detail }) =>
          [action, detail.step ?? "", detail.errorCode ?? detail.error ?? ""]
            .join(" ")
            .trim()
        )
        .toSorted(),
    }).toStrictEqual({
      status: "failed",
      row: "failed",
      hijack: true,
      failure: { step: null, code: "workflow.run_failed" },
      audited: [
        "workflow.run.failed  workflow.run_failed",
        "workflow.run.notified",
        "workflow.step.completed $sneaky",
        "workflow.step.failed failing workflow.step_failed",
        "workflow.step.failed huge workflow.step_failed",
      ],
    });
  });

  it("stop for good when cancelled, running or paused, and not run a cancelled row again", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "cancellable",
        `  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return await step.do("after", { description: "After" }, async () => await ${hitCall(`"after"`)});`,
        { after: 1 }
      )
    );
    const waiting = await builder.api.workflows.start(app, "cancellable");
    const paused = await builder.api.workflows.start(app, "cancellable");
    await stepDone(paused.id, "$params");
    await stopped(paused.id);
    const cancelled = await Promise.all(
      [waiting, paused].map(
        async ({ id }) => await builder.api.workflows.cancel(id)
      )
    );

    // A cancel whose termination failed: the row has its tombstone, and
    // the engine's run goes on. Its next activation does nothing more, and
    // the row says cancelled once the engine has ended it.
    const leftOver = await builder.api.workflows.start(app, "cancellable");
    // Stopped once it waits, so its next activation reads the row this
    // test marks cancelled.
    await stepDone(leftOver.id, "$params");
    await stopped(leftOver.id);
    await env.DB.prepare(
      "UPDATE workflow_runs SET cancel_requested_at = ? WHERE id = ?"
    )
      .bind(Date.now(), leftOver.id)
      .run();
    await woken(leftOver.id);
    await finished(leftOver.id);
    const afterLoad = await liveStatus(leftOver.id);
    const leftOverRow = await vi.waitFor(
      async () => {
        const { status } = await builder.api.workflows.status(leftOver.id);
        expect(status).toBe("cancelled");
        return status;
      },
      { timeout: 10_000, interval: 100 }
    );

    // A cancel that raced a start that failed: the engine has no instance
    // to terminate. A cancel of the row still running marks and audits it,
    // and one of the row already cancelled is done.
    const withoutInstance = async (
      status: "running" | "cancelled"
    ): Promise<string> => {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at)
         SELECT ?, app_id, workflow_id, version, started_by, ?, created_at
         FROM workflow_runs WHERE id = ?`
      )
        .bind(id, status, leftOver.id)
        .run();
      return id;
    };
    const neverRunning = await withoutInstance("running");
    const neverCancelled = await withoutInstance("cancelled");
    const raced = await Promise.all(
      [neverRunning, neverCancelled].map(async (id) => {
        const { status } = await builder.api.workflows.cancel(id);
        return status;
      })
    );

    const events = await allEvents();
    expect({
      cancelled: cancelled.map(({ status }) => status),
      live: await Promise.all(
        [waiting, paused].map(async ({ id }) => await liveStatus(id))
      ),
      audited: events.filter(
        ({ action, target }) =>
          action === "workflow.run.cancelled" &&
          (target?.id === waiting.id || target?.id === paused.id)
      ).length,
      afterLoad,
      leftOverRow,
      after: await hitsOf(builder, app, "after"),
      raced,
      racedAudited: events.filter(
        ({ action, target }) =>
          action === "workflow.run.cancelled" && target?.id === neverRunning
      ).length,
    }).toStrictEqual({
      cancelled: ["cancelled", "cancelled"],
      live: ["terminated", "terminated"],
      audited: 2,
      afterLoad: "errored",
      leftOverRow: "cancelled",
      after: 0,
      raced: ["cancelled", "cancelled"],
      racedAudited: 1,
    });
  });

  it("audit a run whose start failed as failed", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "unstartable",
        `  return await step.do("work", { description: "Work" }, async () => null);`,
        { work: null }
      )
    );
    // An ID core's record takes but Workflows refuses (over 100
    // characters), so creating the run fails after its row is written.
    const taken: ReturnType<typeof crypto.randomUUID> =
      `run-${"x".repeat(100)}-${crypto.randomUUID()}`;
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(taken);
    let refused: unknown;
    try {
      refused = await refusal(triggered(app, "unstartable"));
    } finally {
      uuid.mockRestore();
    }
    const { status, failure } = await builder.api.workflows.status(taken);
    expect({
      refused: refused !== "ok",
      row: await listedStatus(builder, app, taken),
      status,
      failure: failure && {
        step: failure.step,
        input: failure.input,
        error: failure.error,
      },
      audited: await runEvents(taken, "workflow.run.failed"),
    }).toStrictEqual({
      refused: true,
      row: "failed",
      status: "failed",
      // A report its owner sees, saying only that it didn't start.
      failure: {
        step: null,
        input: null,
        error: {
          code: "workflow.run_failed",
          message: "The workflow run couldn't be started.",
        },
      },
      audited: [
        "workflow.run.failed start_failed workflow.run_failed",
        "workflow.run.notified",
        "workflow.run.started",
      ],
    });
  });
});

/** Workflow code that sends the invoice mail with idempotency key `key`. */
const sendWith = (key: string) =>
  `await env.MAIL.call("mail.send", ${JSON.stringify(invoiceMail)}, { idempotencyKey: ${key} })`;

describe("workflow side effects and failures", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("take a connection call only inside a step, and with the step's own key", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    // Calls between steps can't be read as a step's, so the workflow that
    // makes them is held to none: they are refused as outside a step
    // first. The one that makes its calls in its step is held to them.
    const app = await appWith(admin, {
      ...workflowFiles(
        "outside",
        `  const codeOf = async (key: string) => {
    try {
      ${sendWith("key")};
      return "sent";
    } catch (error) {
      return (error as { code?: string }).code;
    }
  };
  const outside = await codeOf("keys-outside");
  // A step whose last attempt hangs: once it has settled, calls between
  // steps are refused again.
  try {
    await step.do("hang", { description: "Hang", timeout: "1 second", retries: { limit: 0 } }, async () => {
      await new Promise(() => {});
    });
  } catch {}
  const afterHang = await codeOf("keys-after-hang");
  return { outside, afterHang };`,
        { hang: null }
      ),
      ...workflowFiles(
        "keys",
        `  return await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: null },
    async ({ idempotencyKey }) => {
      // A key of each attempt's own would send once per attempt.
      let perAttempt = "sent";
      try {
        ${sendWith('idempotencyKey + ":attempt-2"')};
      } catch (error) {
        perAttempt = String((error as { code?: string }).code);
      }
      // A constant key would answer every run with the first run's mail.
      let constant = "sent";
      try {
        ${sendWith('"invoice-INV-7"')};
      } catch (error) {
        constant = String((error as { code?: string }).code);
      }
      return { perAttempt, constant };
    }
  );`,
        { send: {} }
      ),
    });
    await grantMail(idp, admin, app, mail.id);
    const outside = await admin.api.workflows.start(app, "outside");
    const keys = await admin.api.workflows.start(app, "keys");
    await Promise.all([finished(outside.id), finished(keys.id)]);

    expect({
      outside: await admin.api.workflows.status(outside.id),
      keys: await admin.api.workflows.status(keys.id),
      server: await mail.did(),
    }).toMatchObject({
      outside: {
        status: "completed",
        output: {
          outside: "workflow.outside_step",
          afterHang: "workflow.outside_step",
        },
      },
      keys: {
        status: "completed",
        output: {
          perAttempt: "workflow.idempotency_key_invalid",
          constant: "workflow.idempotency_key_invalid",
        },
      },
      server: { calls: 0, sent: [] },
    });
  });

  it("stop at a call the server answered with an error without retrying it, with a report for the run's owner", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const starter = await personApi("builder");
    const mail = await mailConnection(["invalid", "invalid"]);
    const app = await appWith(
      owner,
      mailer(`retries: { limit: 3, delay: 10, backoff: "constant" }`)
    );
    await grantMail(idp, owner, app, mail.id);
    await owner.api.apps.members.add(app, {
      type: "person",
      id: starter.userId,
      role: "user",
    });
    // One run a person started, which acts for them; one a trigger
    // started, which acts for the App's owner.
    const started = await starter.api.workflows.start(app, "mailer");
    const byTrigger = await triggered(app, "mailer");
    await Promise.all([finished(started.id), finished(byTrigger.id)]);
    const failures = async (person: Person) => {
      const runs = await person.api.workflows.list(app);
      const failureOf = (id: string) =>
        runs.find((run) => run.id === id)?.failure?.run ?? null;
      const { failure } = await person.api.workflows.status(started.id);
      return {
        status: failure?.run,
        listed: [failureOf(started.id), failureOf(byTrigger.id)],
      };
    };
    const unknownApp = await refusal(
      starter.api.workflows.list(crypto.randomUUID())
    );
    const logged = await allEvents();
    const events = logged.filter(
      ({ action, target }) =>
        action === "workflow.run.failed" && target?.id === started.id
    );

    const seen = {
      starter: await failures(starter),
      owner: await failures(owner),
      admin: await failures(admin),
    };
    // A triggered run's report goes with its App: once someone else owns
    // it, they see it, and the old owner no longer does.
    await env.DB.prepare("UPDATE apps SET owner_id = ? WHERE id = ?")
      .bind(starter.userId, app)
      .run();
    // Still sharing it, now as a user.
    await starter.api.apps.members.add(app, {
      type: "person",
      id: owner.userId,
      role: "user",
    });
    const { listed: starterLists } = await failures(starter);
    const { listed: ownerLists } = await failures(owner);
    const afterOwnerChange = { starter: starterLists, owner: ownerLists };

    expect({
      server: await mail.did(),
      report: await admin.api.workflows.status(started.id),
      seen,
      afterOwnerChange,
      audited: events.map(({ detail }) => detail.error),
      unknownApp: appErrors.codeOf(unknownApp),
    }).toMatchObject({
      // One call each, never retried: the tool may have acted.
      server: { calls: 2, sent: [] },
      report: {
        status: "failed",
        failure: {
          run: started.id,
          app,
          workflow: "mailer",
          version: 1,
          step: "send",
          // What the step works on, without the values.
          input: { to: "string", subject: "string" },
          // On Composio a tool's error can't be told from one after it
          // acted: unknown, never sent again.
          error: { code: "connect.outcome_unknown" },
        },
      },
      seen: {
        starter: { status: started.id, listed: [started.id, null] },
        owner: { status: undefined, listed: [null, byTrigger.id] },
        admin: { status: started.id, listed: [started.id, byTrigger.id] },
      },
      afterOwnerChange: {
        starter: [started.id, byTrigger.id],
        owner: [null, null],
      },
      audited: ["connect.outcome_unknown"],
      unknownApp: "app.not_found",
    });
  });

  it("stop at an error of the workflow's own without retrying it, reporting its input's shape but none of its data", async () => {
    const admin = await personApi("admin");
    const app = await appWith(
      admin,
      workflowFiles(
        "careless",
        `  await step.do(
    "check",
    {
      description: "Check the customer",
      input: { customer: "c-1", "anna@example.com": true, "INV-2026-0007": 1, lines: [1, 2], note: null },
      retries: { limit: 3, delay: 10 },
    },
    async () => {
      await ${hitCall(`"check"`)};
      throw new Error("Customer c-1 is blocked");
    }
  );`,
        { check: null }
      )
    );
    const run = await admin.api.workflows.start(app, "careless");
    await finished(run.id);

    const { failure } = await admin.api.workflows.status(run.id);
    expect({
      failure,
      attempts: await hitsOf(admin, app, "check"),
    }).toMatchObject({
      failure: {
        step: "check",
        // No values; no field whose name could be data (an address, an ID).
        input: {
          customer: "string",
          lines: "array",
          note: "null",
          "…": "2 more",
        },
        error: {
          code: "workflow.run_failed",
          message: "Customer c-1 is blocked",
        },
      },
      attempts: 1,
    });
  });

  it("fail, recorded and reported, once a run has taken as many steps as it may", async () => {
    const admin = await personApi("admin");
    // More steps than the engine takes in one execution (vite.config.ts).
    const app = await appWith(
      admin,
      workflowFiles(
        "endless",
        `  for (let i = 0; i < 100; i++) {
    await step.do("step-" + i, { description: "One more" }, async () => i);
  }`
      )
    );
    const run = await admin.api.workflows.start(app, "endless");
    await finished(run.id);

    const { status, failure } = await admin.api.workflows.status(run.id);
    expect({
      status,
      row: await listedStatus(admin, app, run.id),
      failure: failure?.error.code,
    }).toStrictEqual({
      status: "failed",
      row: "failed",
      failure: "workflow.too_many_steps",
    });
  });
});
