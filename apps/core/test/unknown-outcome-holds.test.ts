import type { PendingKey } from "@grasp-os/shared/connect";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appHost } from "../src/durable-objects.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished, liveStatus } from "./runs.ts";
import { connectDb } from "./test-env.ts";
import {
  day,
  loseAnswers,
  sentFrom,
  draftsIn,
  callsOn,
  listedFor,
  statusOf,
  elapse,
  unknownOutcomesOf,
} from "./unknown-outcome-runs.ts";

// A run's side effect whose answer was lost, so nobody can tell whether it
// took effect (spec 14.3), on a native connector (Microsoft 365, against
// Graph's answers): the run waits, using none of its step's retries, until
// the person it acted for says what became of it, then runs the step again
// under the same key; or until its deadline, when the step fails, saying
// so. The ways it can fail come first: the run fails, or spends its
// retries, on the same answer; it runs the step again at once, again and
// again, when connect and the step's call disagree on whether it may be
// recovered; it waits for good; "it happened" sends it again; "it didn't
// happen" sends it twice; someone whose permission is gone resolves it;
// cancelling the run drops the obligation, or records it as undone. A
// Composio tool's error, whose text nobody is shown yet, fails the step as
// before. (Apart from held-runs.test.ts: one file holds only so many runs'
// worth of workers.)

// Here: how a hold ends by its deadline, or by connect's recovery, with
// nobody resolving it; what its person says of it is
// unknown-outcome-resolutions.test.ts's.

const { personApi, lostRun, waitingRun } = unknownOutcomesOf(mockIdp());

describe("a run's side effect of unknown outcome", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("fails the step, saying so, once nobody resolved it by its deadline", async () => {
    const admin = await personApi("admin");
    const deadline = env.WORKFLOW_UNKNOWN_HOLD_MS;
    env.WORKFLOW_UNKNOWN_HOLD_MS = "1000";
    try {
      const { mailbox, run } = await lostRun(admin);
      await finished(run.id);
      expect({
        run: await admin.api.workflows.status(run.id),
        sent: await sentFrom(mailbox),
        // Still theirs to resolve.
        listed: await listedFor(admin),
      }).toMatchObject({
        run: {
          status: "failed",
          failure: {
            error: { code: "connect.outcome_unknown_unresolved" },
          },
        },
        sent: 1,
        listed: 1,
      });
    } finally {
      env.WORKFLOW_UNKNOWN_HOLD_MS = deadline;
    }
  });

  it("runs the step again as its person said, when they resolve it during the last wait before its deadline", async () => {
    const admin = await personApi("admin");
    const { WORKFLOW_UNKNOWN_HOLD_MS: deadline, WORKFLOW_OFF_WAIT_MS: wait } =
      env;
    // Its deadline passes during its first wait, two seconds long: the
    // person resolves it then, and the check after it is past the deadline.
    env.WORKFLOW_UNKNOWN_HOLD_MS = "1";
    env.WORKFLOW_OFF_WAIT_MS = "2000";
    try {
      const outcomes = [];
      for (const choice of ["happened", "not_happened"] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one run at a time
        const { mailbox, run } = await lostRun(admin);
        // oxlint-disable-next-line no-await-in-loop -- once it is listed
        const unknown = await vi.waitFor(
          async () => {
            const [listed] = await admin.api.unknownOutcomes.list();
            if (listed === undefined) {
              throw new Error("Not listed yet");
            }
            return listed;
          },
          { timeout: 10_000, interval: 50 }
        );
        // oxlint-disable-next-line no-await-in-loop -- one run at a time
        await admin.api.unknownOutcomes.resolve(
          unknown.key,
          choice,
          unknown.claim
        );
        // oxlint-disable-next-line no-await-in-loop -- one run at a time
        await finished(run.id);
        // oxlint-disable-next-line no-await-in-loop -- one run at a time
        const { status, output } = await admin.api.workflows.status(run.id);
        // oxlint-disable-next-line no-await-in-loop -- one run at a time
        outcomes.push({ status, output, sent: await sentFrom(mailbox) });
      }
      expect(outcomes).toMatchObject([
        { status: "completed", output: { resolved: true }, sent: 1 },
        { status: "completed", output: { sent: true }, sent: 2 },
      ]);
    } finally {
      env.WORKFLOW_UNKNOWN_HOLD_MS = deadline;
      env.WORKFLOW_OFF_WAIT_MS = wait;
    }
  });

  it("ends by its deadline, not the run's step allowance, however many rounds the hold takes", async () => {
    const admin = await personApi("admin");
    const { CONNECT: connect } = env;
    const deadline = env.WORKFLOW_UNKNOWN_HOLD_MS;
    // Each round runs the step again (connect says nothing waits), some
    // four steps every first wait: past the tests' allowance of 60 steps
    // long before the deadline.
    env.WORKFLOW_UNKNOWN_HOLD_MS = "8000";
    env.CONNECT = new Proxy(connect, {
      get: (target, name) => {
        // Asked past the deadline, connect answers as it is.
        if (name === "anyPending") {
          return async (request: PendingKey) =>
            request.orRecoverable === true
              ? await target.anyPending(request)
              : false;
        }
        const real: unknown = Reflect.get(target, name);
        return real;
      },
    });
    try {
      const { mailbox, run } = await lostRun(admin);
      await finished(run.id);
      expect({
        run: await admin.api.workflows.status(run.id),
        sent: await sentFrom(mailbox),
      }).toMatchObject({
        run: {
          status: "failed",
          failure: { error: { code: "connect.outcome_unknown_unresolved" } },
        },
        sent: 1,
      });
    } finally {
      env.CONNECT = connect;
      env.WORKFLOW_UNKNOWN_HOLD_MS = deadline;
    }
  });

  it("gives each call of unknown outcome on a step its own deadline, however long the step's last one waited", async () => {
    const admin = await personApi("admin");
    const deadline = env.WORKFLOW_UNKNOWN_HOLD_MS;
    env.WORKFLOW_UNKNOWN_HOLD_MS = "6000";
    try {
      const { mailbox, run, unknown } = await waitingRun(admin);
      // Its one more send loses its answer too.
      await loseAnswers(mailbox);
      await elapse(3000);
      await admin.api.unknownOutcomes.resolve(
        unknown.key,
        "not_happened",
        unknown.claim
      );
      const second = await vi.waitFor(
        async () => {
          const listed = await admin.api.unknownOutcomes.list();
          await expect(sentFrom(mailbox)).resolves.toBe(2);
          expect(listed).toHaveLength(1);
          return listed[0];
        },
        { timeout: 15_000, interval: 100 }
      );
      // Past the first's deadline, well within its own.
      await elapse(5000);
      if (second !== undefined) {
        await admin.api.unknownOutcomes.resolve(
          second.key,
          "happened",
          second.claim
        );
      }
      await finished(run.id);
      expect({
        run: await admin.api.workflows.status(run.id),
        sent: await sentFrom(mailbox),
      }).toMatchObject({
        run: { status: "completed", output: { resolved: true } },
        sent: 2,
      });
    } finally {
      env.WORKFLOW_UNKNOWN_HOLD_MS = deadline;
    }
  });

  it("runs the step again once connect may recover its call, with nobody resolving it, and completes it as connect recovered it", async () => {
    const admin = await personApi("admin");
    // A draft, which connect recovers by looking it up.
    const { mailbox, connectionId, run } = await waitingRun(
      admin,
      "mail.createDraft"
    );
    // Its call's claim is past the claim timeout: connect may recover it.
    await connectDb()
      .prepare(
        "UPDATE idempotent_calls SET claimed_at = claimed_at - ?1, created_at = created_at - ?1 WHERE connection_id = ?2"
      )
      .bind(6 * 60 * 1000, connectionId)
      .run();
    await finished(run.id);
    expect({
      run: await statusOf(admin, run.id),
      // Connect looked the draft up, and Graph here finds none: so it
      // made it once more, under the same key, as a call that didn't
      // happen.
      drafts: await draftsIn(mailbox),
      listed: await listedFor(admin),
    }).toStrictEqual({ run: "completed", drafts: 2, listed: 0 });
  });

  it("ends a hold by its deadline once connect can no longer recover the call, a day after its first claim", async () => {
    const admin = await personApi("admin");
    const deadline = env.WORKFLOW_UNKNOWN_HOLD_MS;
    env.WORKFLOW_UNKNOWN_HOLD_MS = "4000";
    try {
      const { mailbox, connectionId, run } = await waitingRun(
        admin,
        "mail.createDraft"
      );
      // First claimed more than a day ago: past connect's recovery
      // horizon, so nothing clears the hold but its person.
      await connectDb()
        .prepare(
          "UPDATE idempotent_calls SET claimed_at = claimed_at - ?1, created_at = created_at - ?1 WHERE connection_id = ?2"
        )
        .bind(day + 6 * 60 * 1000, connectionId)
        .run();
      await finished(run.id);
      expect({
        run: await admin.api.workflows.status(run.id),
        drafts: await draftsIn(mailbox),
        listed: await listedFor(admin),
      }).toMatchObject({
        run: {
          status: "failed",
          failure: { error: { code: "connect.outcome_unknown_unresolved" } },
        },
        drafts: 1,
        listed: 1,
      });
    } finally {
      env.WORKFLOW_UNKNOWN_HOLD_MS = deadline;
    }
  });

  it("never runs the step again at once, even when connect says it may be recovered and the call says otherwise", async () => {
    const admin = await personApi("admin");
    const { CONNECT: connect } = env;
    // Connect always says nothing waits: the step comes back held each
    // time it runs.
    env.CONNECT = new Proxy(connect, {
      get: (target, name) => {
        if (name === "anyPending") {
          return async () => await Promise.resolve(false);
        }
        const real: unknown = Reflect.get(target, name);
        return real;
      },
    });
    try {
      const { mailbox, connectionId, run } = await lostRun(admin);
      await vi.waitFor(
        async () => {
          await expect(callsOn(connectionId)).resolves.toBeGreaterThan(0);
        },
        { timeout: 15_000, interval: 200 }
      );
      await elapse(1500);
      const live = await liveStatus(run.id);
      expect({
        live: live === "waiting" || live === "running",
        sent: await sentFrom(mailbox),
        // A first wait of 250 ms before each run of the step: a handful,
        // never the run's steps used up at once.
        calls: (await callsOn(connectionId)) <= 8,
      }).toStrictEqual({ live: true, sent: 1, calls: true });
    } finally {
      env.CONNECT = connect;
    }
  });

  it("keeps waiting, without running the step again and again, when its App turns restricted and its recovery would need the person to confirm it", async () => {
    const admin = await personApi("admin");
    // A draft, which connect recovers by looking it up.
    const { mailbox, connectionId, app, run } = await waitingRun(
      admin,
      "mail.createDraft"
    );
    await appHost(env, appIdSchema.parse(app)).restrict();
    // Its call can no longer be out: connect may recover it, but only for
    // a call nobody must confirm.
    await connectDb()
      .prepare(
        "UPDATE idempotent_calls SET claimed_at = claimed_at - ?1, created_at = created_at - ?1 WHERE connection_id = ?2"
      )
      .bind(6 * 60 * 1000, connectionId)
      .run();
    // Run again once, refused for the confirmation it now needs.
    await vi.waitFor(
      async () => {
        await expect(callsOn(connectionId)).resolves.toBeGreaterThanOrEqual(2);
      },
      { timeout: 15_000, interval: 200 }
    );
    await elapse(2000);
    expect({
      live: await liveStatus(run.id),
      drafts: await draftsIn(mailbox),
      calls: await callsOn(connectionId),
    }).toStrictEqual({ live: "waiting", drafts: 1, calls: 2 });
  });
});
