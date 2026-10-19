import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appHost } from "../src/durable-objects.ts";
import { waitKeyOf } from "../src/workflows/host.ts";
import { requestGranted } from "./apps.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { endLiveRuns, finished, runInstance } from "./runs.ts";
import { openRpc, outcome, signedInWithRole } from "./sign-in.ts";
import {
  appWith,
  invoiceMail,
  mailer,
  runEvents,
  workflowFiles,
} from "./workflow-apps.ts";

// The wakes a held side effect's decision owes the step waiting on it
// (src/workflows/wakes.ts), from their threat model: a crash between
// connect deciding and core's record of the wake loses it; a lost answer
// from connect loses it; a stale wake ends another step's wait; a wake a
// crash left is sent forever; a confirmation connect refuses, asked again
// and again, wakes the run each time and spends its steps. Each checks
// what the engine says ended the step's wait: a wake (`wait_completed`),
// or its timed check (`wait_timed_out`). Its checks come further apart
// each time, from 250 ms in tests: the fifth waits nearly four seconds,
// which only a wake ends early. (Apart from held-runs.test.ts: one file
// holds only so many runs' worth of workers.)

const idp = mockIdp();

const minute = 60_000;

const day = 24 * 60 * minute;

/** A signed-in person's API, on a connection of their own. */
const personApi = async (role: Role) => {
  const person = await signedInWithRole(idp, role);
  const { core } = await openRpc(person.session);
  return { ...person, api: core.authenticate() };
};

type Api = Awaited<ReturnType<typeof personApi>>;

/** The second mail of `twoMails`. */
const secondMail = { to: "ben@acme.test", subject: "Invoice INV-8" };

/** A workflow `two` that sends `invoiceMail`, then `secondMail`. */
const twoMails = workflowFiles(
  "two",
  `  const send = async (name: string, mail: { to: string; subject: string }) => await step.do(name, { description: "Send", sideEffect: true, input: mail, retries: { limit: 0 } }, async ({ idempotencyKey, input }) => JSON.parse(((await env.MAIL.call("mail.send", input, { idempotencyKey })) as { output: string }).output));
  return [await send("first", ${JSON.stringify(invoiceMail)}), await send("second", ${JSON.stringify(secondMail)})];`,
  { first: { messageId: "mocked" }, second: { messageId: "mocked" } }
);

/**
 * A restricted App with `mailer` and `two`, allowed to send mail on a
 * connection of its own, so every mail waits for its person: the App,
 * its connection and the permission's ID.
 */
const heldApp = async (admin: Api) => {
  const mail = await mailConnection();
  const app = await appWith(admin, {
    ...mailer(`retries: { limit: 0 }`),
    ...twoMails,
  });
  const permission = await requestGranted(idp, admin, {
    subject: { type: "app", appId: app },
    object: { type: "connection", connectionId: mail.id },
    actions: ["mail.send"],
    binding: "MAIL",
  });
  await appHost(env, appIdSchema.parse(app)).restrict();
  return { app, mail, permission };
};

/** Whether a wait's step name is of a held wait of step `step`. */
const ofStep = async (name: string, step: string) =>
  name.startsWith(`$grasp:wait:${await waitKeyOf(step)}:held:`);

/**
 * The engine's reports of the run's waits, from its start: how many of a
 * step's held waits began, and what ended the next one.
 */
const waitsOf = async (run: string) => {
  const events = await runInstance(run).subscribe({
    filter: ["wait_started", "wait_completed", "wait_timed_out"],
  });
  const started = new Map<string, number>();
  const report = async () => {
    const { done, value } = await events.next();
    if (done === true) {
      throw new Error(`Run ${run} ended while it waited`);
    }
    return value;
  };
  return {
    [Symbol.dispose]: () => {
      events[Symbol.dispose]();
    },
    /** Once step `step` began `count` held waits. */
    started: async (step: string, count: number) => {
      await vi.waitFor(
        async () => {
          if ((started.get(step) ?? 0) < count) {
            const value = await report();
            if (
              value.type === "wait_started" &&
              (await ofStep(value.stepName, step))
            ) {
              started.set(step, (started.get(step) ?? 0) + 1);
            }
          }
          expect(started.get(step) ?? 0).toBeGreaterThanOrEqual(count);
        },
        { timeout: 20_000, interval: 0 }
      );
    },
    /** What ended step `step`'s next held wait to end. */
    nextEnd: async (step: string): Promise<string> => {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- one report at a time
        const value = await report();
        if (
          (value.type === "wait_completed" ||
            value.type === "wait_timed_out") &&
          // oxlint-disable-next-line no-await-in-loop -- one report at a time
          (await ofStep(value.stepName, step))
        ) {
          return value.type;
        }
        if (
          value.type === "wait_started" &&
          // oxlint-disable-next-line no-await-in-loop -- one report at a time
          (await ofStep(value.stepName, step))
        ) {
          started.set(step, (started.get(step) ?? 0) + 1);
        }
      }
    },
  };
};

/** The one side effect held for `person` now. */
const heldOne = async (person: Api) => {
  const [held, ...others] = await person.api.pendingActions.list();
  if (held === undefined || others.length > 0) {
    throw new Error("Expected one held side effect");
  }
  return held;
};

/**
 * Runs `run` with connect's `method` replaced by `around` (given the real
 * one), as connect would be failing or slow.
 */
const aroundConnect = async <T>(
  method: string,
  around: (real: (...args: unknown[]) => Promise<unknown>) => unknown,
  run: () => Promise<T>
): Promise<T> => {
  const { CONNECT: connect } = env;
  env.CONNECT = new Proxy(connect, {
    get: (target, name) => {
      const real: unknown = Reflect.get(target, name);
      if (name !== method || typeof real !== "function") {
        return real;
      }
      return around(
        async (...args: unknown[]): Promise<unknown> =>
          await Reflect.apply(real, target, args)
      );
    },
  });
  try {
    return await run();
  } finally {
    env.CONNECT = connect;
  }
};

/**
 * Runs `run` with core's database failing every batch while `down` says
 * so, as a crash at that moment would leave it: nothing of the batch is
 * written.
 */
const whileBatchesFail = async <T>(
  down: () => boolean,
  run: () => Promise<T>
): Promise<T> => {
  const { DB: real } = env;
  env.DB = new Proxy(real, {
    get: (target, name) => {
      if (name === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (down()) {
            throw new Error("D1 is unavailable");
          }
          return await target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, name);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, target, args);
        return result;
      };
    },
  });
  try {
    return await run();
  } finally {
    env.DB = real;
  }
};

/** How many wakes core still owes run `run`. */
const owed = async (run: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS owed FROM workflow_run_wakes WHERE run_id = ?"
  )
    .bind(run)
    .first<{ owed: number }>();
  return row?.owed ?? 0;
};

describe("a held side effect's decision", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("wakes the waiting step when the person declines it", async () => {
    const admin = await personApi("admin");
    const { app } = await heldApp(admin);
    const run = await admin.api.workflows.start(app, "mailer");
    using waits = await waitsOf(run.id);
    await waits.started("send", 5);
    const held = await heldOne(admin);
    await admin.api.pendingActions.decline(held.id);
    const ended = await waits.nextEnd("send");
    await finished(run.id);
    const { status, failure } = await admin.api.workflows.status(run.id);

    expect({ ended, status, code: failure?.error.code }).toStrictEqual({
      ended: "wait_completed",
      status: "failed",
      code: "connect.declined",
    });
  });

  it("wakes the waiting step when connect decided, though its answer was lost", async () => {
    const admin = await personApi("admin");
    const { app, mail } = await heldApp(admin);
    const run = await admin.api.workflows.start(app, "mailer");
    using waits = await waitsOf(run.id);
    await waits.started("send", 5);
    const held = await heldOne(admin);
    const confirmed = await aroundConnect(
      "confirmAction",
      (real) =>
        async (...args: unknown[]): Promise<never> => {
          await real(...args);
          throw new Error("Connect's answer was lost");
        },
      async () =>
        await outcome(admin.api.pendingActions.confirm(held.id, held.inputHash))
    );
    const ended = await waits.nextEnd("send");
    await finished(run.id);

    expect({
      confirmed,
      ended,
      run: await admin.api.workflows.status(run.id),
      server: await mail.did(),
    }).toMatchObject({
      confirmed: "internal.unexpected",
      ended: "wait_completed",
      run: { status: "completed", output: { messageId: "message-1" } },
      server: { calls: 1, sent: [invoiceMail] },
    });
  });

  it("wakes nothing on a confirmation connect refuses, however often it is asked, so the run keeps its steps", async () => {
    const admin = await personApi("admin");
    const { app, permission } = await heldApp(admin);
    const run = await admin.api.workflows.start(app, "mailer");
    await runEvents(run.id, "workflow.run.waiting");
    const held = await heldOne(admin);
    await admin.api.permissions.revoke(permission);
    // More confirmations than the run has steps (60 in tests), each
    // refused: none of them is a decision, so none wakes the step.
    const refused = [];
    for (let tries = 0; tries < 40; tries += 1) {
      refused.push(
        // oxlint-disable-next-line no-await-in-loop -- one at a time
        await outcome(admin.api.pendingActions.confirm(held.id, held.inputHash))
      );
    }
    const waiting = await admin.api.workflows.status(run.id);
    await admin.api.pendingActions.decline(held.id);
    await finished(run.id);
    const { status, failure } = await admin.api.workflows.status(run.id);

    expect({
      refused: new Set(refused),
      waiting: waiting.status,
      status,
      code: failure?.error.code,
    }).toStrictEqual({
      refused: new Set(["permission.denied"]),
      waiting: "waiting",
      status: "failed",
      // The step runs again once declined, and its call is refused.
      code: "permission.denied",
    });
  });

  it("is sent again by the repair after a crash, waking only its own step, until a day has passed", async () => {
    const admin = await personApi("admin");
    const { app, mail } = await heldApp(admin);
    const run = await admin.api.workflows.start(app, "two");
    using waits = await waitsOf(run.id);
    await waits.started("first", 5);
    const first = await heldOne(admin);
    // Core goes down as connect confirms it: connect sent the mail, and
    // core recorded nothing more of the wake it owed.
    let down = false;
    const confirmed = await whileBatchesFail(
      () => down,
      async () =>
        await aroundConnect(
          "confirmAction",
          (real) =>
            async (...args: unknown[]): Promise<unknown> => {
              const answer = await real(...args);
              down = true;
              return answer;
            },
          async () =>
            await outcome(
              admin.api.pendingActions.confirm(first.id, first.inputHash)
            )
        )
    );
    // The minute's repair sends the wake that stood from before connect
    // was asked: the first step wakes, and runs on to the second.
    await runCron({}, new Date(Date.now() + minute));
    const firstEnded = await waits.nextEnd("first");
    await waits.started("second", 5);
    const stillOwed = await owed(run.id);
    // Sent again, as connect's decision isn't known to have happened: it
    // wakes nothing of the second step, which waits on its own decision.
    await runCron({}, new Date(Date.now() + 3 * minute));
    const secondEnded = await waits.nextEnd("second");
    // A day on, nothing more is sent.
    await runCron({}, new Date(Date.now() + day + minute));
    const afterADay = await owed(run.id);
    const second = await heldOne(admin);
    await admin.api.pendingActions.confirm(second.id, second.inputHash);
    await finished(run.id);
    const ended = await admin.api.workflows.status(run.id);

    expect({
      confirmed,
      firstEnded,
      stillOwed,
      secondEnded,
      afterADay,
      run: ended.status,
      server: await mail.did(),
    }).toStrictEqual({
      confirmed: "ok",
      firstEnded: "wait_completed",
      stillOwed: 1,
      secondEnded: "wait_timed_out",
      afterADay: 0,
      run: "completed",
      server: { calls: 2, sent: [invoiceMail, secondMail] },
    });
  });
});
