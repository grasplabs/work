import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appHost } from "../src/durable-objects.ts";
import { waitKeyOf } from "../src/workflows/host.ts";
import { requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { endLiveRuns, finished, runInstance } from "./runs.ts";
import { openRpc, outcome, signedInWithRole } from "./sign-in.ts";
import { appWith, invoiceMail, workflowFiles } from "./workflow-apps.ts";

// The wakes a held side effect's decision owes the step waiting on it
// (src/workflows/wakes.ts): a wake a crash left between connect deciding
// and core's record of it is sent again by the repair, wakes only its own
// step, and is given up after a day. It checks what the engine says ended
// the step's wait: a wake (`wait_completed`), or its timed check
// (`wait_timed_out`). Kept as an App run until a JSON run's held call
// shows the same: a wake sent again waking no later step, and none sent
// after a day. The rest of the held wakes are covered on JSON runs
// (workflow-calls.test.ts).

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
 * A restricted App with `two`, allowed to send mail on a
 * connection of its own, so every mail waits for its person: the App,
 * its connection and the permission's ID.
 */
const heldApp = async (admin: Api) => {
  const mail = await mailConnection();
  const app = await appWith(admin, {
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
    await runMinuteTasks({}, new Date(Date.now() + minute));
    const firstEnded = await waits.nextEnd("first");
    await waits.started("second", 5);
    const stillOwed = await owed(run.id);
    // Sent again, as connect's decision isn't known to have happened: it
    // wakes nothing of the second step, which waits on its own decision.
    await runMinuteTasks({}, new Date(Date.now() + 3 * minute));
    const secondEnded = await waits.nextEnd("second");
    // A day on, nothing more is sent.
    await runMinuteTasks({}, new Date(Date.now() + day + minute));
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
