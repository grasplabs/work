import { appIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { callApp } from "../src/app.ts";
import { allEvents } from "./audit-events.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import {
  aroundEngine,
  endLiveRuns,
  finished,
  runObject,
  sleeping,
  woken,
} from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// Pausing, resuming and cancelling a run from an App's screens, as the
// host admits each request with a durable receipt (controls.ts). What
// could go wrong, tried below: a request answered before it is durable,
// one sent twice making two, a pause and a resume overlapping, a pause
// that outlives a cancel and brings the run back, a request the run's
// lifecycle doesn't allow, someone who doesn't build the App, another
// App's run, a request whose answer from the engine was lost, and a pause
// that stops time. Runs are real, on the engine; the App's counters show
// what really ran.

const idp = mockIdp();

const personApi = async (role: "admin" | "builder" | "user") =>
  await signedInApi(idp, role);

/** A step, a sleep of a day, and a step that counts that it ran. */
const napper = workflowFiles(
  "napper",
  `  await step.do("first", { description: "First" }, async () => null);
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return await step.do("after", { description: "After" }, async () => await env.APP.call("hit", "after"));`,
  { first: null, after: 1 }
);

/**
 * As `napper`, its first step held open until the App counts `gate`: a
 * pause asked for meanwhile waits for it.
 */
const gated = workflowFiles(
  "gated",
  `  await step.do("first", { description: "First" }, async () => {
    await env.APP.call("hit", "entered");
    while ((await env.APP.call("hits", "gate")) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  });
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return await step.do("after", { description: "After" }, async () => await env.APP.call("hit", "after"));`,
  { first: null, after: 1 }
);

/** How often the App counted `name`. */
const hitsOf = async (
  app: string,
  userId: string,
  name: string
): Promise<number> => {
  const hits = await callApp(
    env,
    appIdSchema.parse(app),
    { userId, mode: "interactive" },
    "hits",
    [name]
  );
  return Number(hits);
};

/** Lets the gated run's first step end. */
const openGate = async (app: string, userId: string): Promise<void> => {
  await callApp(
    env,
    appIdSchema.parse(app),
    { userId, mode: "interactive" },
    "hit",
    ["gate"]
  );
};

/** The run's receipts, oldest first. */
const receiptsOf = async (run: string) => {
  const { results } = await env.DB.prepare(
    "SELECT id, kind, state FROM workflow_run_controls WHERE run_id = ? ORDER BY created_at, id"
  )
    .bind(run)
    .all<{ id: string; kind: string; state: string }>();
  return results;
};

/** The run's receipts, oldest first, as their kind and state. */
const receiptStates = async (run: string): Promise<string[][]> => {
  const receipts = await receiptsOf(run);
  return receipts.map(({ kind, state }) => [kind, state]);
};

/** The run's status as a screen of `app` shows it to `person`. */
const shown = async (
  person: Awaited<ReturnType<typeof personApi>>,
  app: string,
  run: string
): Promise<string> => {
  const { status } = await person.api.screens.run(app, run);
  return status;
};

/** Once `check` holds, polling. */
const until = async (check: () => Promise<boolean>): Promise<void> => {
  await vi.waitFor(
    async () => {
      await expect(check()).resolves.toBeTruthy();
    },
    { timeout: 15_000, interval: 100 }
  );
};

/** The journaled deadline of the run's sleep `go`. */
const sleepDeadline = async (run: string): Promise<number | undefined> =>
  await runInDurableObject(
    runObject(run),
    (_object, state) =>
      state.storage.sql
        .exec<{ deadline: number }>(
          "SELECT deadline FROM steps WHERE type = 'sleep' AND name = 'go'"
        )
        .toArray()[0]?.deadline
  );

/** The control requests of `run` the audit log has, with where from. */
const requested = async (run: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        target?.id === run &&
        (action === "workflow.run.pause_requested" ||
          action === "workflow.run.resume_requested" ||
          action === "workflow.run.cancelled")
    )
    .map(({ action, detail }) => `${action} ${String(detail.via)}`);
};

describe(
  "controls of a run from its App's screens",
  { timeout: 60_000 },
  () => {
    afterEach(endLiveRuns);

    it("pause a waiting run at once and resume it, with a receipt each, its deadline where it was", async () => {
      const builder = await personApi("builder");
      const app = await appWith(builder, napper);
      const { id: run } = await builder.api.screens.startRun(app, "napper");
      await sleeping(run, "go");
      await until(async () => (await sleepDeadline(run)) !== undefined);
      const deadline = await sleepDeadline(run);

      const paused = await builder.api.screens.control(app, run, "pause");
      await until(async () => (await shown(builder, app, run)) === "paused");
      await scheduler.wait(50);
      const resumed = await builder.api.screens.control(app, run, "resume");
      const kept = await sleepDeadline(run);
      await woken(run);
      await finished(run);

      expect({
        paused: { kind: paused.kind, state: paused.state },
        resumed: { kind: resumed.kind, state: resumed.state },
        kept: kept === deadline,
        status: await shown(builder, app, run),
        after: await hitsOf(app, builder.userId, "after"),
        receipts: await receiptStates(run),
        requested: await requested(run),
      }).toStrictEqual({
        paused: { kind: "pause", state: "applied" },
        resumed: { kind: "resume", state: "applied" },
        // Time didn't stop while it was paused.
        kept: true,
        status: "completed",
        after: 1,
        receipts: [
          ["pause", "applied"],
          ["resume", "applied"],
        ],
        requested: [
          "workflow.run.pause_requested screen",
          "workflow.run.resume_requested screen",
        ],
      });
    });

    it("join a pause asked for again while it waits for a step, refuse a resume beside it, and settle it once the engine paused", async () => {
      const builder = await personApi("builder");
      const app = await appWith(builder, gated);
      const { id: run } = await builder.api.screens.startRun(app, "gated");
      await until(
        async () => (await hitsOf(app, builder.userId, "entered")) > 0
      );

      // Twice at once, then once more: one request.
      const [first, second] = await Promise.all([
        builder.api.screens.control(app, run, "pause"),
        builder.api.screens.control(app, run, "pause"),
      ]);
      const again = await builder.api.screens.control(app, run, "pause");
      const resume = await outcome(
        builder.api.screens.control(app, run, "resume")
      );
      await openGate(app, builder.userId);
      await until(async () => (await shown(builder, app, run)) === "paused");
      await until(async () => {
        const receipts = await receiptsOf(run);
        return receipts.every(({ state }) => state === "applied");
      });

      expect({
        first: first.state,
        same: [second.id, again.id].every((id) => id === first.id),
        resume,
        receipts: await receiptStates(run),
        requested: await requested(run),
        after: await hitsOf(app, builder.userId, "after"),
      }).toStrictEqual({
        first: "admitted",
        same: true,
        resume: "workflow.control_conflict",
        receipts: [["pause", "applied"]],
        requested: ["workflow.run.pause_requested screen"],
        after: 0,
      });
    });

    it("cancel over a pause still waiting for a step, which then never comes back, and refuse a pause after", async () => {
      const builder = await personApi("builder");
      const app = await appWith(builder, gated);
      const { id: run } = await builder.api.screens.startRun(app, "gated");
      await until(
        async () => (await hitsOf(app, builder.userId, "entered")) > 0
      );

      const pause = await builder.api.screens.control(app, run, "pause");
      const cancel = await builder.api.screens.control(app, run, "cancel");
      // The step its activation had out ends, late: it starts nothing more.
      await openGate(app, builder.userId);
      await finished(run);
      const late = await outcome(
        builder.api.screens.control(app, run, "pause")
      );
      const again = await builder.api.screens.control(app, run, "cancel");

      expect({
        pause: pause.state,
        cancel: cancel.state,
        late,
        again: { kind: again.kind, state: again.state },
        status: await shown(builder, app, run),
        receipts: await receiptStates(run),
        after: await hitsOf(app, builder.userId, "after"),
      }).toStrictEqual({
        pause: "admitted",
        cancel: "applied",
        late: "workflow.control_refused",
        // Cancelled already: acknowledged.
        again: { kind: "cancel", state: "applied" },
        status: "cancelled",
        receipts: [
          ["pause", "superseded"],
          ["cancel", "applied"],
          ["cancel", "applied"],
        ],
        after: 0,
      });
    });

    it("are for the App's builders, and for its own runs only", async () => {
      const builder = await personApi("builder");
      const user = await personApi("user");
      const app = await appWith(builder, napper);
      const other = await appWith(builder, napper);
      await builder.api.apps.members.add(app, {
        type: "person",
        id: user.userId,
        role: "user",
      });
      const { id: run } = await builder.api.screens.startRun(app, "napper");
      await sleeping(run, "go");

      expect({
        user: await outcome(user.api.screens.control(app, run, "cancel")),
        otherApp: await outcome(
          builder.api.screens.control(other, run, "cancel")
        ),
        unknownKind: await outcome(
          builder.api.screens.control(
            app,
            run,
            // SAFETY: a kind the types refuse, as any page can send.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            "restart" as never
          )
        ),
        receipts: await receiptsOf(run),
      }).toMatchObject({
        user: "role.forbidden",
        otherApp: "workflow.run_not_found",
        unknownKind: "workflow.invalid",
        receipts: [],
      });
    });

    it("send a receipt again whose answer from the engine was lost, once it has waited, and settle it", async () => {
      const builder = await personApi("builder");
      const app = await appWith(builder, napper);
      const { id: run } = await builder.api.screens.startRun(app, "napper");
      await sleeping(run, "go");
      await until(async () => (await sleepDeadline(run)) !== undefined);

      // The engine doesn't take the pause: the request fails, its receipt
      // admitted all the same.
      const lost = await aroundEngine(
        async (method, call) => {
          if (method === "pause") {
            throw new Error("The engine is unavailable");
          }
          return await call();
        },
        async () =>
          await outcome(builder.api.screens.control(app, run, "pause"))
      );
      const admitted = await receiptsOf(run);
      await env.DB.prepare(
        "UPDATE workflow_run_controls SET created_at = ? WHERE run_id = ?"
      )
        .bind(Date.now() - 60_000, run)
        .run();
      await runCron();
      await until(async () => (await shown(builder, app, run)) === "paused");

      expect({
        lost,
        admitted: admitted.map(({ kind, state }) => [kind, state]),
        settled: await receiptStates(run),
      }).toStrictEqual({
        lost: "internal.unexpected",
        admitted: [["pause", "admitted"]],
        settled: [["pause", "applied"]],
      });
    });
  }
);
