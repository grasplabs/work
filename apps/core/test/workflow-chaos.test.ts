import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { statisticRowsPerDay } from "@grasp-os/shared/statistics";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { callApp } from "../src/app.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { requestGranted, serverBuilt } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import {
  mailConnection,
  mailForApps,
  mailWithSearch,
} from "./mail-connection.ts";
import {
  endLiveRuns,
  finished,
  liveStatus,
  resumed,
  runInstance,
  sleeping,
  stepDone,
  stopped,
  woken,
} from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { v1AppWith } from "./v1-app-server.ts";
import {
  appCall,
  appWith,
  bindMail,
  bindStats,
  grantMail,
  hitCall,
  hitsCall,
  hitsOf,
  invoiceMail,
  mailer,
  openGate,
  pointsOf,
  runEvents,
  workflowFiles,
} from "./workflow-apps.ts";

// Workflow runs under failure: crashes mid-step, restarts, long sleeps,
// starts delivered twice, and failures that pass or last. Runs
// are real, on the engine (Workerflow). Their side effects go
// through the real connect to a fake mail server (test/mail-server.ts)
// that counts every call that reached it, so a mail sent twice shows
// there; the App's counters (`v1HitsOf`) show how often a step really ran.
//
// How each failure is brought about, only from outside core:
// - a crash or a deploy stops a run's execution: the engine's own pause,
//   then resume, which runs the workflow again from its start, loaded
//   anew, finished steps replayed (`stopped`, test/runs.ts);
// - an isolate killed mid-step: an attempt that hangs until the engine
//   gives up on it at the step's timeout and tries again; with the call
//   still out, the mail server holds it until the test lets it go;
// - the engine losing a finished step's record: the engine's restart from
//   that step, which runs it again from scratch;
// - a long sleep: a day's sleep, cut short while the run is stopped (the
//   engine's test introspection);
// - a start delivered twice: a second create of the run's instance under
//   its ID (a trigger's duplicate events are for its own tests);
// - a failure trying again may fix: the mail server turning calls away.
// Failures trying again can't fix (a refused call, the workflow's own
// error) stop a run at once: workflows.test.ts has them, with the report
// the run's owner sees.
//
// The tests wait on conditions (a step done, a status reached, a counter
// moved), never for a set time. Step timeouts only cut off attempts made
// to hang, and give a good attempt ample time; the App's code is built
// before such a run, so a first call doesn't spend an attempt building it.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/** How often the v1 App counted `name` (its server's `hit`). */
const v1HitsOf = async (app: string, userId: string, name: string) =>
  await callApp(
    env,
    appIdSchema.parse(app),
    { userId, mode: "interactive" },
    "hits",
    [name]
  );

/**
 * The audit log's events of `action` on `target`. Read once a run has
 * ended: its events are in the outbox by then, and `allEvents` drains it.
 */
const eventsOf = async (action: string, target: string) => {
  const events = await allEvents();
  return events.filter(
    (event) => event.action === action && event.target?.id === target
  );
};

/**
 * The calls of `run` refused as stale, as the audit log has them: made by
 * an attempt the engine had given up on (host.ts, `#requireCurrent`).
 */
const staleCalls = async (run: string) => {
  const refused = await eventsOf("workflow.call.refused", run);
  return refused
    .filter(({ detail }) => detail.errorCode === "execution.stale_attempt")
    .map(({ detail }) => `${String(detail.step)} ${String(detail.call)}`);
};

/**
 * How long each attempt of a step that hangs gets before the engine gives
 * up on it: well past what a good attempt takes, a round trip through
 * connect included, and a function call's sandbox loaded for it, on a
 * runner busy with other tests.
 */
const attemptTimeout = "6 seconds";

/** How long a run here may take to end, its attempts cut off included. */
const runEnds = 60_000;

/** A step that hangs on its first attempt until the engine gives up on it. */
const hangOnFirst = (
  counter: string
) => `if ((await ${hitCall(`"${counter}"`)}) === 1) {
        await new Promise(() => {});
      }`;

/**
 * A step that calls `call`, and on its first attempt `then`, whose
 * failure it tells the mail server by name and code before throwing it
 * on: the attempt's code sees it whether or not the engine gave up on
 * the attempt first, so what it saw doesn't hang on which timer won.
 */
const cutOff = (id: string, timeout: string, call: string, then: string) =>
  workflowFiles(
    id,
    `  return await step.do(
  "count",
  { description: "Count", timeout: "${timeout}", retries: { limit: 1, delay: 10 } },
  async () => {
    try {
      const attempt = await env.APP.call(${call});
      if (attempt === 1) {
        await env.APP.call(${then});
      }
      return attempt;
    } catch (error) {
      const { name, code } = error as { name?: string; code?: string };
      await env.MAIL.call("mail.search", { query: "seen ${id} " + name + " " + code });
      throw error;
    }
  }
);`,
    { count: 1 }
  );

/** Workflow code calling the sample App's `stats.pointAfter` of `measure`. */
const pointAfter = (measure: string) =>
  appCall(
    "stats.pointAfter",
    "action",
    `{ measure: "${measure}", execution: crypto.randomUUID() }`
  );

/**
 * As `cutOff`, through the sample App's functions: a step that calls
 * `call` (code), and on its first attempt `then` (code).
 */
const sealedCutOff = (
  id: string,
  timeout: string,
  call: string,
  then: string
) =>
  workflowFiles(
    id,
    `  return await step.do(
  "count",
  { description: "Count", timeout: "${timeout}", retries: { limit: 1, delay: 10 } },
  async () => {
    try {
      const attempt = await ${call};
      if (attempt === 1) {
        await ${then};
      }
      return attempt;
    } catch (error) {
      const { name, code } = error as { name?: string; code?: string };
      await env.MAIL.call("mail.search", { query: "seen ${id} " + name + " " + code });
      throw error;
    }
  }
);`,
    { count: 1 }
  );

/**
 * A side-effect step `name` that mails `subject`, with `before` and
 * `after` around the call, and one retry.
 */
const mailStep = (
  name: string,
  subject: string,
  { before = "", after = "" }: { before?: string; after?: string }
) => `  const ${name} = await step.do(
    "${name}",
    { description: "Send", sideEffect: true, input: { to: "ben@acme.test", subject: "${subject}" }, timeout: "${attemptTimeout}", retries: { limit: 1, delay: 10 } },
    async ({ idempotencyKey, input: mail }) => {
      ${before}
      const sent = JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);
      ${after}
      return sent;
    }
  );`;

describe("workflow runs under failure", { timeout: 180_000 }, () => {
  afterEach(endLiveRuns);

  it("send each mail once when a side-effect step is killed before or after its call, and retried", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await appWith(
      admin,
      workflowFiles(
        "killed",
        `${mailStep("early", "Early", { before: hangOnFirst("early") })}
${mailStep("late", "Late", { after: hangOnFirst("late") })}
  return { early, late };`,
        { early: {}, late: {} }
      )
    );
    await grantMail(idp, admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "killed");
    await finished(run.id, runEnds);

    expect({
      run: await admin.api.workflows.status(run.id),
      attempts: {
        early: await hitsOf(admin, app, "early"),
        late: await hitsOf(admin, app, "late"),
      },
      server: await mail.did(),
    }).toMatchObject({
      // Killed before its call, the step sent on its retry; killed after,
      // its retry got the first call's answer, not a second mail.
      run: {
        status: "completed",
        output: {
          early: { messageId: "message-1" },
          late: { messageId: "message-2" },
        },
      },
      attempts: { early: 2, late: 2 },
      server: {
        calls: 2,
        sent: [
          { to: "ben@acme.test", subject: "Early" },
          { to: "ben@acme.test", subject: "Late" },
        ],
      },
    });
  });

  // The v1 App server's own: its methods' keys, its call queue and its
  // own time for a call. It goes with the server (GRA-645); the test
  // after it holds a sealed function to the same.
  it("have their App's methods mail with the step's key only, once across a retry", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await v1AppWith(
      admin,
      workflowFiles(
        "app-mailer",
        `  return await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: null, retries: { limit: 1, delay: 10 } },
    async () => {
      // A key of the method's own would send once per attempt.
      const ownKey = await env.APP.call("mail", true);
      const sent = await env.APP.call("mail", false);
      if ((await env.APP.call("hit", "app-send")) === 1) {
        // The mail went out, yet the attempt fails as if nothing was done,
        // with a failure the engine retries: the retry mustn't mail again.
        throw Object.assign(new Error("busy"), { code: "connect.server_unavailable" });
      }
      return { ownKey, sent };
    }
  );`,
        { send: {} }
      )
    );
    // A method that times out fails the run for good, so the App's first
    // call mustn't have to build its code.
    await serverBuilt(app, 1);
    await grantMail(idp, admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "app-mailer");
    await finished(run.id, runEnds);

    expect({
      run: await admin.api.workflows.status(run.id),
      attempts: await v1HitsOf(app, admin.userId, "app-send"),
      server: await mail.did(),
    }).toMatchObject({
      run: {
        status: "completed",
        output: {
          ownKey: { refused: "workflow.idempotency_key_invalid" },
          sent: { messageId: "message-1" },
        },
      },
      attempts: 2,
      server: { calls: 1, sent: [invoiceMail] },
    });
  });

  it("have their App's functions mail under keys the host derives from the step's only, once across a retry", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection([], mailForApps);
    const app = await appWith(
      admin,
      workflowFiles(
        "app-mailer",
        `  return await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: null, retries: { limit: 1, delay: 10 } },
    async () => {
      // A key of the function's own would send once per attempt.
      const ownKey = JSON.parse(await ${appCall("mail.mailOwnKey", "action", "{}")});
      const sent = JSON.parse(await ${appCall("mail.mail", "action", "{}")});
      if ((await ${hitCall(`"app-send"`)}) === 1) {
        // The mail went out, yet the attempt fails as if nothing was done,
        // with a failure the engine retries: the retry mustn't mail again.
        throw Object.assign(new Error("busy"), { code: "connect.server_unavailable" });
      }
      return { ownKey, sent };
    }
  );`,
        { send: {} }
      )
    );
    await bindMail(idp, admin, app, mail.id, "send");
    const run = await admin.api.workflows.start(app, "app-mailer");
    await finished(run.id, runEnds);

    expect({
      run: await admin.api.workflows.status(run.id),
      attempts: await hitsOf(admin, app, "app-send"),
      server: await mail.did(),
    }).toMatchObject({
      // A key of App code's own is refused; the mail went once, the first
      // attempt's, and the retry got its answer.
      run: {
        status: "completed",
        output: {
          ownKey: { refused: "resource.not_allowed" },
          sent: { messageId: "message-1" },
        },
      },
      attempts: 2,
      server: { calls: 1, sent: [invoiceMail] },
    });
  });

  it("never send again when the engine loses a finished side-effect step and runs it anew", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await appWith(
      admin,
      workflowFiles(
        "forgetful",
        `  const sent = await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify(invoiceMail)} },
    async ({ idempotencyKey, input: mail }) => {
      await ${hitCall(`"send"`)};
      return JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);
    }
  );
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return sent;`,
        { send: { messageId: "mocked" } }
      )
    );
    await grantMail(idp, admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "forgetful");
    await stepDone(run.id, "send");
    // Runs the step again from scratch, as if its result had never been
    // stored: only its idempotency key stands between it and a second mail.
    const instance = runInstance(run.id);
    await instance.restart({ from: { name: "send" } });
    await vi.waitFor(
      async () => {
        await expect(hitsOf(admin, app, "send")).resolves.toBeGreaterThan(1);
      },
      { timeout: 30_000, interval: 100 }
    );
    await woken(run.id);
    await finished(run.id, runEnds);

    expect({
      run: await admin.api.workflows.status(run.id),
      attempts: await hitsOf(admin, app, "send"),
      server: await mail.did(),
    }).toMatchObject({
      run: { status: "completed", output: { messageId: "message-1" } },
      attempts: 2,
      server: { calls: 1, sent: [invoiceMail] },
    });
  });

  it("add a step's statistics points up once, as it completes: never an abandoned attempt's, nor when the engine runs the step anew, nor past the day's rows, and keep none for an ended run", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      // The first attempt hangs at the mail server, outside the App, until
      // the engine gave up on it and the second began; then it calls on,
      // late.
      ...workflowFiles(
        "late",
        `  return await step.do(
    "count",
    { description: "Count", timeout: "${attemptTimeout}", retries: { limit: 1, delay: 10 } },
    async () => {
      const attempt = await ${hitCall(`"late"`)};
      await ${appCall("stats.point", "action", `{ measures: ["tried"] }`)};
      if (attempt === 1) {
        await env.MAIL.call("mail.search", { query: "hold late" });
        await ${appCall("stats.point", "action", `{ measures: ["late"] }`)};
        return "first";
      }
      return "second";
    }
  );`,
        { count: "second" }
      ),
      ...workflowFiles(
        "forgetful",
        `  const attempt = await step.do("count", { description: "Count" }, async () => {
    await ${appCall("stats.point", "action", `{ measures: ["kept", "kept"] }`)};
    return await ${hitCall(`"forgetful"`)};
  });
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return attempt;`,
        { count: 1 }
      ),
      // Records nothing the first time it runs, and a point when run anew.
      ...workflowFiles(
        "silent",
        `  const attempt = await step.do("count", { description: "Count" }, async () => {
    const attempt = await ${hitCall(`"silent"`)};
    if (attempt > 1) {
      await ${appCall("stats.point", "action", `{ measures: ["anew"] }`)};
    }
    return attempt;
  });
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return attempt;`,
        { count: 1 }
      ),
      // The first attempt's App call waits at the mail server past the
      // attempt's time: its code is stopped then, and the second
      // attempt's call, waiting for the App behind it, runs.
      ...workflowFiles(
        "outlived",
        `  return await step.do(
    "count",
    { description: "Count", timeout: "${attemptTimeout}", retries: { limit: 1, delay: 10 } },
    async () => {
      if ((await ${hitCall(`"outlived"`)}) === 1) {
        await ${appCall("stats.pointAfter", "action", `{ measure: "outlived", execution: crypto.randomUUID() }`)};
      }
      return null;
    }
  );`,
        { count: null }
      ),
      // No timeout: its App call waits at the mail server while the run is
      // cancelled, and records a point once let go, after the run ended.
      ...workflowFiles(
        "ended",
        `  return await step.do("count", { description: "Count" }, async () => {
    await ${appCall("stats.pointAfter", "action", `{ measure: "ended", execution: crypto.randomUUID() }`)};
    return null;
  });`,
        { count: null }
      ),
      ...workflowFiles(
        "bounded",
        `  return await step.do("count", { description: "Count" }, async () => {
    await ${appCall("stats.point", "action", `{ measures: ["over", "known", "fits"] }`)};
    return null;
  });`,
        { count: null }
      ),
    });
    // A shared connection's search, where a call is held until let go.
    const mail = await mailConnection([], mailForApps);
    await requestGranted(idp, builder, {
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.search"],
      binding: "MAIL",
    });
    await bindMail(idp, builder, app, mail.id, "search");
    await bindStats(app);
    const count = async (measure: string) =>
      await pointsOf(builder, app, measure);

    const late = await builder.api.workflows.start(app, "late");
    // The first attempt held, and the second begun.
    await vi.waitFor(
      async () => {
        await expect(mail.searched()).resolves.toStrictEqual(["hold late"]);
        await expect(hitsOf(builder, app, "late")).resolves.toBe(2);
      },
      { timeout: 30_000, interval: 100 }
    );
    await mail.release();
    await finished(late.id, runEnds);
    const abandoned = {
      status: await builder.api.workflows.status(late.id),
      attempts: await hitsOf(builder, app, "late"),
      tried: await count("tried"),
      late: await count("late"),
    };

    const forgetful = await builder.api.workflows.start(app, "forgetful");
    await stepDone(forgetful.id, "count");
    const once = await count("kept");
    // Runs the step again from scratch, as if its result had never been
    // stored, after its points were added up.
    const instance = runInstance(forgetful.id);
    await instance.restart({ from: { name: "count" } });
    await vi.waitFor(
      async () => {
        await expect(
          hitsOf(builder, app, "forgetful")
        ).resolves.toBeGreaterThan(1);
      },
      { timeout: 30_000, interval: 100 }
    );
    await woken(forgetful.id);
    await finished(forgetful.id, runEnds);
    const anew = {
      attempts: await hitsOf(builder, app, "forgetful"),
      once,
      kept: await count("kept"),
    };

    const silent = await builder.api.workflows.start(app, "silent");
    await stepDone(silent.id, "count");
    const silentInstance = runInstance(silent.id);
    await silentInstance.restart({ from: { name: "count" } });
    await vi.waitFor(
      async () => {
        await expect(hitsOf(builder, app, "silent")).resolves.toBeGreaterThan(
          1
        );
      },
      { timeout: 30_000, interval: 100 }
    );
    await woken(silent.id);
    await finished(silent.id, runEnds);

    const outlived = await builder.api.workflows.start(app, "outlived");
    await finished(outlived.id, runEnds);
    // The run has ended; the search its first attempt's code left waiting
    // goes, but that code was stopped.
    await mail.release();
    const { status: outlivedStatus } = await builder.api.workflows.status(
      outlived.id
    );
    const outlivedEnded = {
      status: outlivedStatus,
      recorded: await hitsOf(builder, app, "outlived:recorded"),
      refused: await hitsOf(builder, app, "outlived:refused"),
    };

    const ended = await builder.api.workflows.start(app, "ended");
    await vi.waitFor(
      async () => {
        await expect(mail.searched()).resolves.toContain("hold ended");
      },
      { timeout: 30_000, interval: 100 }
    );
    await builder.api.workflows.cancel(ended.id);
    await finished(ended.id, runEnds);
    // The run has ended: the call it left waiting goes on, but its
    // attempt holds no more, so the point it records is refused, and so is
    // the mark of that refusal: the attempt's every request and commit is
    // (app-functions.ts, `runInvocationFor`), each refusal audited.
    await mail.release();
    await vi.waitFor(
      async () => {
        await expect(staleCalls(ended.id)).resolves.toContain("count APP");
      },
      { timeout: 30_000, interval: 100 }
    );
    const endedMarks = {
      recorded: await hitsOf(builder, app, "ended:recorded"),
      refused: await hitsOf(builder, app, "ended:refused"),
    };
    const { results: kept } = await env.DB.prepare(
      "SELECT step_key, measure FROM app_statistic_steps WHERE app_id = ?"
    )
      .bind(app)
      .all();

    // A day's rows, but for one, with those the runs above made: today's
    // and tomorrow's, should the run cross midnight. `known` has its row,
    // holding no point yet.
    const days = [0, 1].map((ahead) =>
      new Date(Date.now() + ahead * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10)
    );
    for (const day of days) {
      // oxlint-disable-next-line no-await-in-loop -- one day at a time
      const held = await env.DB.prepare(
        "SELECT count(*) AS held FROM app_statistics WHERE app_id = ? AND day = ?"
      )
        .bind(app, day)
        .first<number>("held");
      // oxlint-disable-next-line no-await-in-loop -- one day's batch at a time
      await env.DB.batch(
        Array.from(
          { length: statisticRowsPerDay - 1 - (held ?? 0) },
          (_, index) =>
            env.DB.prepare(
              "INSERT INTO app_statistics (app_id, measure, day, dimensions, count, sum, min, max) VALUES (?, ?, ?, ?, 0, 0, 0, 0)"
            ).bind(
              app,
              index === 0 ? "known" : "filled",
              day,
              index === 0 ? "{}" : JSON.stringify({ n: String(index) })
            )
        )
      );
    }
    const bounded = await builder.api.workflows.start(app, "bounded");
    await finished(bounded.id, runEnds);

    expect({
      abandoned,
      anew,
      silent: await count("anew"),
      outlived: { ...outlivedEnded, counted: await count("outlived"), kept },
      ended: { counted: await count("ended"), ...endedMarks },
      bounded: {
        status: await builder.api.workflows.status(bounded.id),
        known: await count("known"),
        fits: await count("fits"),
        over: await count("over"),
      },
    }).toMatchObject({
      // Both attempts recorded `tried`: only the second's counts. The
      // first, given up on, records no `late`: its App call ends with it.
      abandoned: {
        status: { status: "completed", output: "second" },
        attempts: 2,
        tried: 1,
        late: 0,
      },
      // Two points alike, added up when the step first completed, and not
      // again when it ran anew.
      anew: { attempts: 2, once: 2, kept: 2 },
      // Completed without a point: what it records when run anew isn't
      // added either.
      silent: 0,
      // Its first attempt's code stopped with the attempt, before it got
      // to its point; the second completed the run.
      outlived: {
        status: "completed",
        recorded: 0,
        refused: 0,
        counted: 0,
        kept: [],
      },
      // Asked for once its run had been cancelled: refused, as its
      // attempt holds no more (`kept` above holds no row of it either).
      ended: { counted: 0, recorded: 0, refused: 0 },
      // The point in a row the day has, and the first new row, which
      // fits; the next is left out, and the step completes all the same.
      bounded: { status: { status: "completed" }, known: 1, fits: 1, over: 0 },
    });
  });

  it("refuse what an App function a step's attempt started does once another activation ran the step again", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      // The first attempt's App call waits at the mail server while the
      // run is restarted from the step, which runs again and completes.
      workflowFiles(
        "restarted",
        `  const attempt = await step.do("count", { description: "Count" }, async () => {
    const attempt = await ${hitCall(`"restarted"`)};
    if (attempt === 1) {
      await ${appCall("stats.pointAfter", "action", `{ measure: "restarted", execution: crypto.randomUUID() }`)};
    }
    return attempt;
  });
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return attempt;`,
        { count: 2 }
      )
    );
    const mail = await mailConnection([], mailForApps);
    await bindMail(idp, builder, app, mail.id, "search");
    await bindStats(app);
    const run = await builder.api.workflows.start(app, "restarted");
    await vi.waitFor(
      async () => {
        await expect(mail.searched()).resolves.toContain("hold restarted");
      },
      { timeout: 30_000, interval: 100 }
    );
    await runInstance(run.id).restart({ from: { name: "count" } });
    // Let go, the held call records its point, as the first attempt, which
    // holds no more: refused, and so is the mark of that refusal, each
    // refusal audited; the new attempt runs.
    await mail.release();
    await vi.waitFor(
      async () => {
        await expect(staleCalls(run.id)).resolves.toContain("count APP");
        await expect(
          hitsOf(builder, app, "restarted")
        ).resolves.toBeGreaterThan(1);
      },
      { timeout: 30_000, interval: 100 }
    );

    expect({
      recorded: await hitsOf(builder, app, "restarted:recorded"),
      refused: await hitsOf(builder, app, "restarted:refused"),
      counted: await pointsOf(builder, app, "restarted"),
    }).toStrictEqual({ recorded: 0, refused: 0, counted: 0 });
  });

  // The v1 App server's call queue, which sealed functions don't have: it
  // goes with the server (GRA-645).
  it("give up a step's App call that waits behind another past its attempt's time, never running it", async () => {
    const builder = await personApi("builder");
    const app = await v1AppWith(
      builder,
      workflowFiles(
        "queued",
        `  return await step.do(
    "count",
    { description: "Count", timeout: "${attemptTimeout}", retries: { limit: 0 } },
    async () => await env.APP.call("hit", "queued")
  );`,
        { count: 1 }
      )
    );
    const mail = await mailConnection([], mailWithSearch);
    await requestGranted(idp, builder, {
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.search"],
      binding: "MAIL",
    });
    await serverBuilt(app, 1);
    // A screen's call holds the App, waiting at the mail server.
    const holding = callApp(
      env,
      appIdSchema.parse(app),
      { userId: builder.userId, mode: "interactive" },
      "pointAfter",
      ["held"]
    ).catch(() => null);
    let status: unknown;
    try {
      await vi.waitFor(
        async () => {
          await expect(mail.holding()).resolves.toBeTruthy();
        },
        { timeout: 30_000, interval: 100 }
      );
      const run = await builder.api.workflows.start(app, "queued");
      await finished(run.id, runEnds);
      ({ status } = await builder.api.workflows.status(run.id));
    } finally {
      await mail.release();
      await holding;
    }
    expect({
      status,
      // The step's call gave up with its attempt, before the App was free.
      queued: await v1HitsOf(app, builder.userId, "queued"),
    }).toStrictEqual({ status: "failed", queued: 0 });
  });

  // The v1 App server's own: its methods' keys, its call queue and its
  // own time for a call. It goes with the server (GRA-645); the test
  // after it holds a sealed function to the same.
  it("retry a step whose App call its attempt's time cut off, running or waiting its turn, and stop the run when the App's own time cuts it off", async () => {
    const builder = await personApi("builder");
    const app = await v1AppWith(builder, {
      // Its first attempt's second call holds the App, at the mail server,
      // past the attempt's time.
      ...cutOff(
        "running",
        attemptTimeout,
        `"hit", "running"`,
        `"pointAfter", "running"`
      ),
      // Its call waits for the App, held by a screen's call, past the
      // attempt's time.
      ...cutOff(
        "waiting",
        attemptTimeout,
        `"hit", "waiting"`,
        `"hit", "after"`
      ),
      // Its first attempt's second call holds the App past the App's own
      // time for a call (`APP_CALL_TIMEOUT_MS`, ten seconds), well within
      // the attempt's.
      ...cutOff(
        "limited",
        "40 seconds",
        `"hit", "limited"`,
        `"pointAfter", "limited"`
      ),
    });
    const mail = await mailConnection([], mailWithSearch);
    await requestGranted(idp, builder, {
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.search"],
      binding: "MAIL",
    });
    await serverBuilt(app, 1);
    const statusOf = async (id: string) => {
      const { status, output } = await builder.api.workflows.status(id);
      return { status, output };
    };

    // Cut off running: the attempt timed out, and the next one completed.
    const running = await builder.api.workflows.start(app, "running");
    await finished(running.id, runEnds);
    await mail.release();
    const ranOut = {
      status: await statusOf(running.id),
      hits: await v1HitsOf(app, builder.userId, "running"),
      // The first attempt's code went on past its time: the answer to its
      // App call came after that, and was refused as it returned, as an
      // attempt the engine had given up on, and so was what it called next.
      stale: await staleCalls(running.id),
    };

    // Cut off waiting: the attempt timed out, and the next one, once the
    // screen's call let go of the App, completed.
    const holding = callApp(
      env,
      appIdSchema.parse(app),
      { userId: builder.userId, mode: "interactive" },
      "pointAfter",
      ["held"]
    ).catch(() => null);
    let waited: unknown;
    let released = false;
    try {
      await vi.waitFor(
        async () => {
          await expect(mail.holding()).resolves.toBeTruthy();
        },
        { timeout: 30_000, interval: 100 }
      );
      const waiting = await builder.api.workflows.start(app, "waiting");
      // Once the first attempt was cut off: the answer to its App call,
      // which came after its time, refused as it returned.
      await vi.waitFor(
        async () => {
          await expect(staleCalls(waiting.id)).resolves.toStrictEqual([
            "count APP",
          ]);
        },
        { timeout: 30_000, interval: 100 }
      );
      await mail.release();
      released = true;
      await holding;
      await finished(waiting.id, runEnds);
      waited = {
        status: await statusOf(waiting.id),
        hits: await v1HitsOf(app, builder.userId, "waiting"),
        stale: await staleCalls(waiting.id),
      };
    } finally {
      if (!released) {
        await mail.release();
      }
      await holding;
    }

    // Cut off by the App's own time: an outcome nobody knows, which no
    // retry may repeat.
    const limited = await builder.api.workflows.start(app, "limited");
    await finished(limited.id, runEnds);
    await mail.release();
    const { status: limitedStatus } = await statusOf(limited.id);
    const cutShort = {
      status: limitedStatus,
      hits: await v1HitsOf(app, builder.userId, "limited"),
    };
    const searched = await mail.searched();

    expect({
      seen: searched.filter((query) => query.startsWith("seen ")),
      ranOut,
      waited,
      cutShort,
    }).toStrictEqual({
      // Only the attempt cut off by the App's own time, within its own,
      // still reached the mail server once it was cut off.
      seen: ["seen limited Error app.timed_out"],
      ranOut: {
        status: { status: "completed", output: 2 },
        hits: 2,
        stale: ["count APP"],
      },
      waited: {
        status: { status: "completed", output: 1 },
        hits: 1,
        stale: ["count APP"],
      },
      cutShort: { status: "failed", hits: 1 },
    });
  });

  it("retry a step whose App function call its attempt's time cut off, and stop the run when the call's own time cuts it off", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      // Its first attempt's second call waits at the mail server past the
      // attempt's time.
      ...sealedCutOff(
        "running",
        attemptTimeout,
        hitCall(`"running"`),
        pointAfter("running")
      ),
      // Its first attempt's second call waits past a function call's own
      // time (`APP_CALL_TIMEOUT_MS`, ten seconds), well within the
      // attempt's.
      ...sealedCutOff(
        "limited",
        "40 seconds",
        hitCall(`"limited"`),
        pointAfter("limited")
      ),
    });
    const mail = await mailConnection([], mailForApps);
    await requestGranted(idp, builder, {
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.search"],
      binding: "MAIL",
    });
    await bindMail(idp, builder, app, mail.id, "search");
    await bindStats(app);
    const statusOf = async (id: string) => {
      const { status, output } = await builder.api.workflows.status(id);
      return { status, output };
    };

    // Cut off running: the attempt timed out, and the next one completed.
    const running = await builder.api.workflows.start(app, "running");
    await finished(running.id, runEnds);
    await mail.release();
    await vi.waitFor(
      async () => {
        await expect(staleCalls(running.id)).resolves.not.toStrictEqual([]);
      },
      { timeout: 30_000, interval: 100 }
    );
    const ranOut = {
      status: await statusOf(running.id),
      hits: await hitsOf(builder, app, "running"),
      // The first attempt's call went on past its time: what it asked for
      // after that was refused, as an attempt the engine had given up on.
      stale: await staleCalls(running.id),
    };

    // Cut off by the call's own time: an outcome nobody knows, which no
    // retry may repeat.
    const limited = await builder.api.workflows.start(app, "limited");
    await finished(limited.id, runEnds);
    await mail.release();
    const { status: limitedStatus } = await statusOf(limited.id);
    const cutShort = {
      status: limitedStatus,
      hits: await hitsOf(builder, app, "limited"),
    };
    const searched = await mail.searched();

    expect({
      seen: searched.filter((query) => query.startsWith("seen ")),
      ranOut,
      cutShort,
    }).toStrictEqual({
      // Only the attempt cut off by the call's own time, within its own,
      // still reached the mail server once it was cut off, told so in the
      // operation host's words (the v1 server's were app.timed_out).
      seen: ["seen limited Error operation.deadline_exceeded"],
      ranOut: {
        status: { status: "completed", output: 2 },
        hits: 2,
        stale: ["count APP"],
      },
      cutShort: { status: "failed", hits: 1 },
    });
  });

  it("go on after a crash without running finished steps again, also when resumed at once, and retry a step killed mid-way", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "durable",
        `  await step.do("before", { description: "Before" }, async () => await ${hitCall(`"before"`)});
  try {
    await step.sleep("go", { description: "Wait", duration: "1 day" });
  } finally {
    // Winds down slowly: the stopped execution is still ending when the
    // run, resumed at once, goes on in the next.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const attempt = await step.do(
    "work",
    { description: "Work", sideEffect: true, input: null, timeout: "${attemptTimeout}", retries: { limit: 1, delay: 10 } },
    async ({ idempotencyKey }) => {
      const attempt = await ${hitCall(`"work:" + idempotencyKey`)};
      if (attempt === 1) {
        // Hangs until the engine gives up on this attempt.
        await new Promise(() => {});
      }
      return attempt;
    }
  );
  await step.do("after", { description: "After" }, async () => await ${hitCall(`"after"`)});
  return attempt;`,
        { before: 1, work: 2, after: 1 }
      )
    );
    const run = await builder.api.workflows.start(app, "durable");
    await stepDone(run.id, "before");
    await stopped(run.id);
    await woken(run.id);
    await finished(run.id, runEnds);

    expect({
      status: await builder.api.workflows.status(run.id),
      before: await hitsOf(builder, app, "before"),
      work: await hitsOf(builder, app, `work:${run.id}:work`),
      after: await hitsOf(builder, app, "after"),
    }).toMatchObject({
      status: { status: "completed", output: 2 },
      before: 1,
      work: 2,
      after: 1,
    });
  });

  it("go on past a sleep after a crash during it, without running finished steps again", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "sleeper",
        `  await step.do("before", { description: "Before" }, async () => await ${hitCall(`"before"`)});
  await step.sleep("nap", { description: "Wait a day", duration: "1 day" });
  return await step.do("after", { description: "After" }, async () => await ${hitCall(`"after"`)});`,
        { before: 1, after: 1 }
      )
    );
    const run = await builder.api.workflows.start(app, "sleeper");
    // Stopped once the engine says the run is asleep; `asleep` shows the
    // sleep hadn't ended.
    await sleeping(run.id, "nap");
    await stopped(run.id);
    const asleep = await hitsOf(builder, app, "after");
    // The sleep is cut short while the run is stopped (whether the engine
    // keeps its deadline is the engine's to test): the resumed execution
    // replays the sleep it began, which then ends at once.
    await woken(run.id, "nap");
    await finished(run.id, runEnds);

    expect({
      asleep,
      status: await builder.api.workflows.status(run.id),
      before: await hitsOf(builder, app, "before"),
      after: await hitsOf(builder, app, "after"),
    }).toMatchObject({
      asleep: 0,
      status: { status: "completed", output: 1 },
      before: 1,
      after: 1,
    });
  });

  it("record a step paused mid-way once, as completed, not as failed", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "blocking",
        `  const blocked = await step.do("block", { description: "Block" }, async () => {
    await ${hitCall(`"entered"`)};
    while ((await ${hitsCall(`"gate"`)}) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return "done";
  });
  return await step.do("after", { description: "After" }, async () => blocked);`,
        { block: "done", after: "done" }
      )
    );
    const run = await builder.api.workflows.start(app, "blocking");
    await vi.waitFor(
      async () => {
        await expect(hitsOf(builder, app, "entered")).resolves.toBeGreaterThan(
          0
        );
      },
      { timeout: 30_000, interval: 100 }
    );
    // Paused while the step runs: the engine lets it end, then lets go of
    // the run at that safe boundary, its activation's later calls fenced.
    const instance = runInstance(run.id);
    await instance.pause();
    await openGate(builder, app);
    await vi.waitFor(
      async () => {
        await expect(liveStatus(run.id)).resolves.toBe("paused");
      },
      { timeout: 30_000, interval: 100 }
    );
    await resumed(run.id);
    await finished(run.id, runEnds);
    const { status, output } = await builder.api.workflows.status(run.id);

    expect({
      status,
      output,
      audited: await runEvents(run.id, "workflow.run.completed"),
    }).toStrictEqual({
      status: "completed",
      output: "done",
      audited: [
        "workflow.run.completed",
        "workflow.run.started",
        "workflow.step.completed $params",
        "workflow.step.completed after",
        "workflow.step.completed block",
      ],
    });
  });

  it("record a step failure the workflow caught once, not again on every later execution", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "caught",
        // A failure trying again may fix, out of retries: the engine goes
        // on (it ends a run at a failure that can't be retried).
        `  try {
    await step.do("flaky", { description: "Fail", retries: { limit: 0 } }, async () => {
      throw Object.assign(new Error("busy"), { code: "connect.server_unavailable" });
    });
  } catch {}
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return await step.do("after", { description: "After" }, async () => "done");`,
        { after: "done" }
      )
    );
    const run = await builder.api.workflows.start(app, "caught");
    await runEvents(run.id, "workflow.step.failed");
    // Stopped and resumed while it waits: the new execution replays the
    // caught failure.
    await stopped(run.id);
    await woken(run.id);
    await finished(run.id, runEnds);
    const audited = await runEvents(run.id, "workflow.run.completed");
    expect(
      audited.filter((event) => event.startsWith("workflow.step."))
    ).toStrictEqual([
      "workflow.step.completed $params",
      "workflow.step.completed after",
      "workflow.step.failed flaky",
    ]);
  });

  it("take a start delivered again under the run's ID as the run it is, sending once", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await appWith(
      admin,
      workflowFiles(
        "started",
        `  const sent = await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify(invoiceMail)} },
    async ({ idempotencyKey, input: mail }) => {
      await ${hitCall(`"send"`)};
      return JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);
    }
  );
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return sent;`,
        { send: { messageId: "mocked" } }
      )
    );
    await grantMail(idp, admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "started");
    await stepDone(run.id, "send");
    // The same start again, under the run's ID: the engine takes it as the
    // run it already has. No second run and no second mail.
    await expect(
      runEngine(env).create({
        id: run.id,
        pinned: { app: run.app, workflow: run.workflow, version: run.version },
        input: undefined,
      })
    ).resolves.toBeUndefined();
    await woken(run.id);
    await finished(run.id, runEnds);
    const completed = await eventsOf("workflow.run.completed", run.id);

    expect({
      run: await admin.api.workflows.status(run.id),
      attempts: await hitsOf(admin, app, "send"),
      completed: completed.length,
      server: await mail.did(),
    }).toMatchObject({
      run: { status: "completed", output: { messageId: "message-1" } },
      attempts: 1,
      completed: 1,
      server: { calls: 1, sent: [invoiceMail] },
    });
  });

  it("send once when a side-effect step is killed while its call is still out, and retried until that call's answer is in", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection(["slow"]);
    const app = await appWith(
      admin,
      workflowFiles(
        "patient",
        `  return await step.do(
    "send",
    // Retried while the first call is still out: each retry is told so
    // (connect.call_in_progress), until the answer is in.
    { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify(invoiceMail)}, timeout: "${attemptTimeout}", retries: { limit: 4, delay: 250, backoff: "constant" } },
    async ({ idempotencyKey, input: mail }) => {
      await ${hitCall(`"send"`)};
      return JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);
    }
  );`,
        { send: { messageId: "mocked" } }
      )
    );
    await grantMail(idp, admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "patient");
    // The first attempt timed out with its call held at the server, and a
    // retry has come and found it still out.
    try {
      await vi.waitFor(
        async () => {
          await expect(mail.holding()).resolves.toBeTruthy();
          await expect(hitsOf(admin, app, "send")).resolves.toBeGreaterThan(1);
        },
        { timeout: 30_000, interval: 100 }
      );
    } finally {
      // Released whatever the wait saw, so no call stays held.
      await mail.release();
    }
    await finished(run.id, runEnds);

    expect({
      run: await admin.api.workflows.status(run.id),
      server: await mail.did(),
    }).toMatchObject({
      run: { status: "completed", output: { messageId: "message-1" } },
      server: { calls: 1, sent: [invoiceMail] },
    });
  });

  it("retry a call the connection's server took nothing of, with the step's key, until it goes through", async () => {
    const admin = await personApi("admin");
    // As a native connector's 429 comes back from connect: nothing done
    // (connect's own tests run that end to end).
    const mail = await mailConnection(["unavailable", "unavailable"]);
    const app = await appWith(
      admin,
      mailer(`retries: { limit: 3, delay: 10, backoff: "constant" }`)
    );
    await grantMail(idp, admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "mailer");
    await finished(run.id, runEnds);
    // Each attempt is audited with the version whose code made it.
    const calls = await eventsOf("connection.call", mail.id);

    expect({
      run: await admin.api.workflows.status(run.id),
      server: await mail.did(),
      outcomes: calls.map(({ detail }) => detail.outcome),
      auditedVersions: new Set(calls.map(({ detail }) => detail.appVersion)),
    }).toMatchObject({
      run: { status: "completed", output: { messageId: "message-1" } },
      server: { calls: 1, sent: [invoiceMail] },
      // Two attempts the server took nothing of, then the one that went through.
      outcomes: ["failed", "failed", "ok"],
      auditedVersions: new Set([1]),
    });
  });

  it("fail, reported at the step, when the server stays away past the step's retries, having sent nothing", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    const app = await appWith(
      admin,
      mailer(`retries: { limit: 2, delay: 10, backoff: "constant" }`)
    );
    await grantMail(idp, admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "mailer");
    await finished(run.id, runEnds);
    const calls = await eventsOf("connection.call", mail.id);

    expect({
      run: await admin.api.workflows.status(run.id),
      outcomes: calls.map(({ detail }) => detail.outcome),
      server: await mail.did(),
    }).toMatchObject({
      run: {
        status: "failed",
        failure: {
          step: "send",
          error: { code: "connect.server_unavailable" },
        },
      },
      outcomes: ["failed", "failed", "failed"],
      server: { calls: 0, sent: [] },
    });
  });
});
