import type { PendingAction } from "@grasp-os/shared/connect";
import {
  connectionIdSchema,
  permissionIdSchema,
  runIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { stepIdempotencyKey } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { callConnection } from "../src/bindings.ts";
import { personOf } from "../src/connections.ts";
import { confirmPendingAction } from "../src/pending-actions.ts";
import { revokePermission } from "../src/permissions.ts";
import { terminateResourceRun } from "../src/workflows/resource-runs.ts";
import { repairWakes } from "../src/workflows/wakes.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { liveStatus, resumed, stopped, whileEngineRefuses } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import {
  chooseModel,
  ended,
  endOf,
  heldFor,
  identityOf,
  mailingWorkflow,
  person,
  settledCode,
  startingApp,
  waiting,
} from "./workflow-calls.ts";

// The calls of grasp-workflow/1 workflows on the run host (sealed-run.ts,
// resource-calls.ts and resource-authority.ts), from their threat model:
// a call reaches only the target its start froze; authority revoked while
// a run runs stops its next call; a replay repeats no effect; a sensitive
// parameter reaches connect as a connector argument and nothing the run
// records; and a run's model calls stay within its ceiling. Everything runs for
// real, through the dispatcher, the engine, connect and the App's own
// code; only the mail server and the model provider behind connect are
// faked.

const idp = mockIdp();

/** Holds a run asleep for longer than any test takes. */
const longHold = { id: "asleep", type: "wait", for: "1 hour" };

/**
 * Runs `test` with a held call's timed checks a long way apart: its first
 * wait outlasts how long a test waits for a run to end, so only a wake
 * (workflows/wakes.ts) lets a run go on within it.
 */
const withSlowChecks = async (test: () => Promise<void>): Promise<void> => {
  const wait = env.WORKFLOW_OFF_WAIT_MS;
  env.WORKFLOW_OFF_WAIT_MS = "120000";
  try {
    await test();
  } finally {
    env.WORKFLOW_OFF_WAIT_MS = wait;
  }
};

/** The wakes owed to independent run `runId`, still waiting to be sent. */
const wakesOwed = async (runId: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM workflow_run_wakes WHERE resource_run_id = ?"
  )
    .bind(runId)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

/**
 * Holds `by`'s send through workflow `workflowId`'s mail binding, made in
 * its run `runId` (restricted, so connect holds it), under the key of
 * step `send:task` of run `keyRun`: a held call whose key names whichever
 * run the test says.
 */
const heldSend = async (
  by: Identity,
  sending: { workflowId: string; mailId: string; permissionId: string },
  runId: string,
  keyRun: string
): Promise<PendingAction> => {
  const workflowId = workflowResourceIdSchema.parse(sending.workflowId);
  const refused = await settledCode(
    callConnection(
      env,
      {
        subject: { type: "workflow", workflowId },
        onBehalfOf: by.userId,
        mode: "workflow",
      },
      { type: "workflowRun", workflowId, runId: runIdSchema.parse(runId) },
      {
        type: "connection",
        connectionId: connectionIdSchema.parse(sending.mailId),
      },
      {
        action: "mail.send",
        input: { to: "Ada", subject: "Hello" },
        idempotencyKey: stepIdempotencyKey(keyRun, "send:task"),
      },
      permissionIdSchema.parse(sending.permissionId)
    )
  );
  expect(refused).toBe("connect.held");
  const waitingFor = await env.CONNECT.listPendingActions(
    await personOf(env, by)
  );
  const held = waitingFor.find(
    ({ idempotencyKey }) =>
      idempotencyKey === stepIdempotencyKey(keyRun, "send:task")
  );
  if (held === undefined) {
    throw new Error("Nothing held");
  }
  return held;
};

describe("runs started by a restricted App, waiting on a held call", () => {
  beforeAll(chooseModel);
  afterEach(async () => {
    vi.restoreAllMocks();
    // A test that times out leaves its run waiting on its held call.
    await endLiveResourceRuns();
  });

  it("go on as soon as their person decides it, long before the next timed check: confirmed, it is sent once; declined, the run ends", async () => {
    await withSlowChecks(async () => {
      const admin = await person("admin");
      const signedIn = await signedInApi(idp, "builder");
      const ada = identityOf(signedIn.userId, "builder");
      const confirmed = await mailingWorkflow(ada, admin);
      const declined = await mailingWorkflow(ada, admin);
      const confirmedStarter = await startingApp(
        ada,
        admin,
        confirmed.workflow.id,
        { restricted: true }
      );
      const declinedStarter = await startingApp(
        ada,
        admin,
        declined.workflow.id,
        { restricted: true }
      );
      const confirmedRun = await confirmedStarter.start(confirmed.serving);
      const declinedRun = await declinedStarter.start(declined.serving);
      const toConfirm = await heldFor(ada, confirmedRun);
      const toDecline = await heldFor(ada, declinedRun);
      await waiting(confirmedRun);
      await waiting(declinedRun);

      await signedIn.api.pendingActions.confirm(
        toConfirm.id,
        toConfirm.inputHash
      );
      await signedIn.api.pendingActions.decline(toDecline.id);
      const confirmedEnd = await ended(
        ada,
        confirmed.workflow.id,
        confirmedRun
      );
      const declinedEnd = await ended(ada, declined.workflow.id, declinedRun);
      const confirmedMail = await confirmed.mail.did();
      const declinedMail = await declined.mail.did();

      expect({
        confirmed: endOf(confirmedEnd),
        declined: endOf(declinedEnd),
        sent: [confirmedMail.calls, declinedMail.calls],
      }).toStrictEqual({
        confirmed: { status: "completed", output: { status: "message-1" } },
        declined: { status: "failed", code: "connect.declined" },
        sent: [1, 0],
      });
    });
  });

  it("go on once their person confirms, though the run was stopped and replayed while it waited", async () => {
    await withSlowChecks(async () => {
      const admin = await person("admin");
      const ada = await person("builder");
      const { workflow, mail, serving } = await mailingWorkflow(ada, admin);
      const starter = await startingApp(ada, admin, workflow.id, {
        restricted: true,
      });
      const runId = await starter.start(serving);
      const held = await heldFor(ada, runId);
      await waiting(runId);
      // A crash or a deploy while it waits: resumed, it replays its held
      // step and its first check from the journal, asking nobody again.
      await stopped(runId);
      await resumed(runId);
      await waiting(runId);

      await confirmPendingAction(env, ada, held.id, held.inputHash);
      const run = await ended(ada, workflow.id, runId);
      const sent = await mail.did();

      expect({
        end: endOf(run),
        sent: sent.calls,
      }).toStrictEqual({
        end: { status: "completed", output: { status: "message-1" } },
        sent: 1,
      });
    });
  });

  it("go on once their person confirms, though the engine refused the wake: the repair sends it", async () => {
    // Who sent the wake is on the record, so this holds however the run's
    // own timed checks fall: the repair's `workflow.wake.repaired` names
    // the wake the refused request owed.
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin);
    const starter = await startingApp(ada, admin, workflow.id, {
      restricted: true,
    });
    const runId = await starter.start(serving);
    const held = await heldFor(ada, runId);
    await waiting(runId);
    // Confirmed while the engine takes no event: the wake stays owed.
    await whileEngineRefuses(
      (method) => method === "sendEvent",
      async () => {
        await confirmPendingAction(env, ada, held.id, held.inputHash);
      }
    );
    const owed = await env.DB.prepare(
      "SELECT id FROM workflow_run_wakes WHERE resource_run_id = ?"
    )
      .bind(runId)
      .all<{ id: string }>();
    await repairWakes(env, new Date(Date.now() + 60_000));
    const run = await ended(ada, workflow.id, runId);
    const sent = await mail.did();
    const events = await allEvents();
    const repaired = events
      .filter(
        ({ action, target }) =>
          action === "workflow.wake.repaired" && target?.id === runId
      )
      .map(({ actor, detail }) => ({ actor, wake: detail.wake }));

    expect({
      owed: owed.results.length,
      repaired,
      left: await wakesOwed(runId),
      end: endOf(run),
      sent: sent.calls,
    }).toStrictEqual({
      owed: 1,
      repaired: [{ actor: { type: "system" }, wake: owed.results[0]?.id }],
      left: 0,
      end: { status: "completed", output: { status: "message-1" } },
      sent: 1,
    });
  });

  it("shows a held call in its run's trace as its task's step waiting for its person, then reached once confirmed or failed once declined", async () => {
    await withSlowChecks(async () => {
      const admin = await person("admin");
      const signedIn = await signedInApi(idp, "builder");
      const ada = identityOf(signedIn.userId, "builder");
      const confirmed = await mailingWorkflow(ada, admin);
      const declined = await mailingWorkflow(ada, admin);
      const confirmedStarter = await startingApp(
        ada,
        admin,
        confirmed.workflow.id,
        { restricted: true }
      );
      const confirmedRun = await confirmedStarter.start(confirmed.serving);
      const declinedStarter = await startingApp(
        ada,
        admin,
        declined.workflow.id,
        { restricted: true }
      );
      const declinedRun = await declinedStarter.start(declined.serving);
      const toConfirm = await heldFor(ada, confirmedRun);
      const toDecline = await heldFor(ada, declinedRun);
      await waiting(confirmedRun);
      await waiting(declinedRun);
      /** The send's steps in the run's trace, as the builder reads it. */
      const sendOf = async (id: string, runId: string) => {
        const { steps } = await signedIn.api.workflowResources.runTrace(
          id,
          runId
        );
        return steps
          .filter(({ task }) => task === "send")
          .map(
            ({ state, attempts, endedAt, errorCode }) =>
              `${state} ${attempts} ${endedAt === null ? "open" : "ended"} ${errorCode ?? "-"}`
          );
      };
      const whileHeld = await sendOf(confirmed.workflow.id, confirmedRun);

      await signedIn.api.pendingActions.confirm(
        toConfirm.id,
        toConfirm.inputHash
      );
      await signedIn.api.pendingActions.decline(toDecline.id);
      await ended(ada, confirmed.workflow.id, confirmedRun);
      await ended(ada, declined.workflow.id, declinedRun);

      expect({
        whileHeld,
        confirmed: await sendOf(confirmed.workflow.id, confirmedRun),
        declined: await sendOf(declined.workflow.id, declinedRun),
      }).toStrictEqual({
        // One step: its first attempt held, then waiting for its person.
        whileHeld: ["waiting 1 open -"],
        // Run again once they decided: an attempt more.
        confirmed: ["reached 2 ended -"],
        declined: ["failed 2 ended connect.declined"],
      });
    });
  });

  it("go on once their person confirms, though connect couldn't say for a moment whether it still waited", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin);
    const starter = await startingApp(ada, admin, workflow.id, {
      restricted: true,
    });
    const runId = await starter.start(serving);
    const held = await heldFor(ada, runId);
    // Connect fails the run's first question of whether it still waits:
    // the check is asked again, never taken as an answer.
    const { CONNECT: connect } = env;
    let failures = 1;
    env.CONNECT = new Proxy(connect, {
      get: (target, name) => {
        if (name === "anyPending" && failures > 0) {
          failures -= 1;
          return async () => {
            await Promise.resolve();
            throw new Error("Connect didn't answer");
          };
        }
        const real: unknown = Reflect.get(target, name);
        return real;
      },
    });
    try {
      await waiting(runId);
      await confirmPendingAction(env, ada, held.id, held.inputHash);
      const run = await ended(ada, workflow.id, runId);
      const sent = await mail.did();
      expect({ failures, end: endOf(run), sent: sent.calls }).toStrictEqual({
        failures: 0,
        end: { status: "completed", output: { status: "message-1" } },
        sent: 1,
      });
    } finally {
      env.CONNECT = connect;
    }
  });

  it("go on as soon as connect decided their person's confirmation, though its answer was lost", async () => {
    await withSlowChecks(async () => {
      const admin = await person("admin");
      const signedIn = await signedInApi(idp, "builder");
      const ada = identityOf(signedIn.userId, "builder");
      const { workflow, mail, serving } = await mailingWorkflow(ada, admin);
      const starter = await startingApp(ada, admin, workflow.id, {
        restricted: true,
      });
      const runId = await starter.start(serving);
      const held = await heldFor(ada, runId);
      await waiting(runId);
      // Connect confirms and sends, and its answer never reaches core.
      const { CONNECT: connect } = env;
      env.CONNECT = new Proxy(connect, {
        get: (target, name) => {
          const real: unknown = Reflect.get(target, name);
          if (name !== "confirmAction" || typeof real !== "function") {
            return real;
          }
          return async (...args: unknown[]): Promise<never> => {
            await Reflect.apply(real, target, args);
            throw new Error("Connect's answer was lost");
          };
        },
      });
      let confirmed: unknown;
      try {
        confirmed = await settledCode(
          signedIn.api.pendingActions.confirm(held.id, held.inputHash)
        );
      } finally {
        env.CONNECT = connect;
      }
      // Only the wake core owed before it asked connect ends the wait
      // within the test: its next timed check is minutes away.
      const run = await ended(ada, workflow.id, runId);
      const sent = await mail.did();
      expect({ confirmed, end: endOf(run), sent: sent.calls }).toStrictEqual({
        confirmed: "internal.unexpected",
        end: { status: "completed", output: { status: "message-1" } },
        sent: 1,
      });
    });
  });

  it("wake nothing on a confirmation that is refused, however often it is asked, so the run keeps its steps", async () => {
    await withSlowChecks(async () => {
      const admin = await person("admin");
      const signedIn = await signedInApi(idp, "builder");
      const ada = identityOf(signedIn.userId, "builder");
      const { workflow, mail, serving, permissionId } = await mailingWorkflow(
        ada,
        admin
      );
      const starter = await startingApp(ada, admin, workflow.id, {
        restricted: true,
      });
      const runId = await starter.start(serving);
      const held = await heldFor(ada, runId);
      await waiting(runId);
      await revokePermission(env, admin, permissionId);
      // Enough confirmations, each refused, that the run's steps (60 in
      // tests) would run out did each wake it: none of them is a decision,
      // so none wakes the step.
      const confirmations = 40;
      const refused = new Set<unknown>();
      for (let tries = 0; tries < confirmations; tries += 1) {
        refused.add(
          // oxlint-disable-next-line no-await-in-loop -- one at a time
          await settledCode(
            signedIn.api.pendingActions.confirm(held.id, held.inputHash)
          )
        );
      }
      const stillWaiting = await liveStatus(runId);
      const owed = await wakesOwed(runId);
      await signedIn.api.pendingActions.decline(held.id);
      const run = await ended(ada, workflow.id, runId);
      const sent = await mail.did();

      expect({
        refused,
        stillWaiting,
        owed,
        end: endOf(run),
        sent: sent.calls,
      }).toStrictEqual({
        refused: new Set(["workflow.call_denied"]),
        stillWaiting: "waiting",
        owed: 0,
        // Its step runs again once declined, and its call is refused.
        end: { status: "failed", code: "workflow.call_denied" },
        sent: 0,
      });
    });
  });
});

describe("the wakes a held call's decision owes", () => {
  beforeAll(chooseModel);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("go to the run its key names only if that run is of the held call's own workflow and hasn't ended", async () => {
    const admin = await person("admin");
    const signedIn = await signedInApi(idp, "builder");
    const ada = identityOf(signedIn.userId, "builder");
    const own = await mailingWorkflow(ada, admin, { before: [longHold] });
    const other = await mailingWorkflow(ada, admin, { before: [longHold] });
    const ownStarter = await startingApp(ada, admin, own.workflow.id, {
      restricted: true,
    });
    const otherStarter = await startingApp(ada, admin, other.workflow.id, {
      restricted: true,
    });
    // Runs asleep before their sends: going, not yet held.
    const ownRun = await ownStarter.start(own.serving);
    const endedRun = await ownStarter.start(own.serving);
    const otherRun = await otherStarter.start(other.serving);
    const sending = {
      workflowId: own.workflow.id,
      mailId: own.mail.id,
      permissionId: own.permissionId,
    };
    const forOwn = await heldSend(ada, sending, ownRun, ownRun);
    // The own workflow's call, under a key naming another workflow's run.
    const forOther = await heldSend(ada, sending, ownRun, otherRun);
    const forEnded = await heldSend(ada, sending, endedRun, endedRun);
    await terminateResourceRun(env, ada, own.workflow.id, endedRun);

    // Decided while the engine takes no event: what was owed stays owed.
    await whileEngineRefuses(
      (method) => method === "sendEvent",
      async () => {
        for (const held of [forOwn, forOther, forEnded]) {
          // oxlint-disable-next-line no-await-in-loop -- one decision at a time
          await signedIn.api.pendingActions.decline(held.id);
        }
      }
    );

    expect({
      own: await wakesOwed(ownRun),
      otherWorkflowsRun: await wakesOwed(otherRun),
      ended: await wakesOwed(endedRun),
    }).toStrictEqual({ own: 1, otherWorkflowsRun: 0, ended: 0 });
  });
});
