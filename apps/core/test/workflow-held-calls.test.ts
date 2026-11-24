import { brainOf } from "@grasp-os/brain-next/contract";
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
import { erasePersonShared, eraseSource } from "../src/brain-next.ts";
import type { SourceRef } from "../src/brain-next.ts";
import { personOf } from "../src/connections.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import {
  confirmPendingAction,
  PendingActionsRpc,
} from "../src/pending-actions.ts";
import { revokePermission } from "../src/permissions.ts";
import { resolveUnknownOutcome } from "../src/unknown-outcomes.ts";
import { terminateResourceRun } from "../src/workflows/resource-runs.ts";
import { repairWakes } from "../src/workflows/wakes.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { liveStatus, resumed, stopped, whileEngineRefuses } from "./runs.ts";
import { signedInApi, unique } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";
import {
  chooseModel,
  ended,
  endOf,
  granted,
  heldFor,
  identityOf,
  mailingWorkflow,
  person,
  settledCode,
  started,
  startingApp,
  waiting,
} from "./workflow-calls.ts";

// The calls of grasp-workflow/2 workflows on the run host (sealed-run.ts,
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
    await personOf(env, by),
    "grasp"
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

// What a run's held call, and its call of unknown outcome, show the run's
// person (GRA-1999, the threat model on the issue): their input can carry
// what the run read. Once the run may no longer read that (a source
// erased, a person's erasure), every list of them shows it withheld, and
// nothing lets it go out: a held call is only declined, a lost one only
// said to have happened.

const brainStore = () => brainOf(inJurisdiction(env, env.BRAIN_STORE));

/** A grant of the Brain to workflow `workflowId`, asked by `by`, given by `admin`: its ID. */
const brainGrant = async (
  by: Identity,
  admin: Identity,
  workflowId: string
): Promise<string> =>
  await granted(by, admin, {
    subject: {
      type: "workflow",
      workflowId: workflowResourceIdSchema.parse(workflowId),
    },
    object: { type: "platform" },
    actions: ["brain"],
    binding: `BRAIN_${unique().toUpperCase().replaceAll("-", "_")}`,
  });

/** A source everyone in the company may read, at version 1. */
const companySource = async (): Promise<SourceRef> => {
  const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
  await brainStore().addSource({
    source: `${source.producer}:${source.id}`,
    change: crypto.randomUUID(),
    text: `Invoice ${unique()} is due.`,
    access: { kind: "audience", group: "company" },
  });
  return source;
};

/** A fact about Anna, known by her address, for everyone: what her erasure takes. */
const annasFact = async () => {
  const personId = crypto.randomUUID();
  const address = `anna.${crypto.randomUUID()}@acme.test`;
  const name = `Anna ${unique()}`;
  const added = await brainStore().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group: "company" },
    entities: [
      {
        key: "a",
        kind: "person",
        names: [name],
        identifiers: [{ type: "email", value: address }],
      },
    ],
    memories: [
      {
        about: "a",
        type: "fact",
        statement: `${name} leads finance`,
        speaker: { kind: "system" },
        basis: { kind: "writer", writer: "app:people" },
      },
    ],
  });
  return { personId, address, memory: added.memories[0] ?? "" };
};

/**
 * Keeps that run `runId` read `read` through grant `permissionId`: version
 * 1 of a source its recall handed it, or a memory its entity read rested
 * on, as the run keeps them (run-evidence.ts).
 */
const hasRead = async (
  runId: string,
  permissionId: string,
  read: { source: SourceRef } | { memory: string }
): Promise<void> => {
  await (
    "source" in read
      ? env.DB.prepare(
          "INSERT INTO run_brain_versions (run_id, producer, source_id, version, permission_id, recorded_at) VALUES (?, ?, ?, 1, ?, ?)"
        ).bind(
          runId,
          read.source.producer,
          read.source.id,
          permissionId,
          Date.now()
        )
      : env.DB.prepare(
          "INSERT INTO run_brain_memories (run_id, memory_id, permission_id, recorded_at) VALUES (?, ?, ?, ?)"
        ).bind(runId, read.memory, permissionId, Date.now())
  ).run();
};

/** The statements of a run's evidence check: its tables and its grants. */
const evidenceStatement =
  /"(?:run_brain_versions|run_brain_memories|run_chat_sources|permissions)"/u;

/**
 * What `read` costs of the check of runs' evidence: its statements on
 * D1, and its calls to the Brain's stores, as the spies see them in the
 * whole isolate.
 */
const evidenceCostOf = async (
  read: () => Promise<unknown>
): Promise<{ statements: number; brainCalls: number }> => {
  const prepared = vi.spyOn(env.DB, "prepare");
  const stores = vi.spyOn(env.BRAIN_STORE, "getByName");
  try {
    await read();
    return {
      statements: prepared.mock.calls.filter(([query]) =>
        evidenceStatement.test(query)
      ).length,
      brainCalls: stores.mock.calls.length,
    };
  } finally {
    prepared.mockRestore();
    stores.mockRestore();
  }
};

describe("what a run's held or lost call sent, once the run may no longer read what it read", () => {
  beforeAll(chooseModel);
  afterEach(async () => {
    vi.restoreAllMocks();
    await endLiveResourceRuns();
  });

  it("is withheld from its person on every list after a source's erasure and a person's, and the held call is only declined", async () => {
    await withSlowChecks(async () => {
      const admin = await person("admin");
      const signedIn = await signedInApi(idp, "builder");
      const ada = identityOf(signedIn.userId, "builder");
      const marker = `to-${unique()}`;
      const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
        to: marker,
      });
      const starter = await startingApp(ada, admin, workflow.id, {
        restricted: true,
      });
      const grant = await brainGrant(ada, admin, workflow.id);
      const source = await companySource();
      const anna = await annasFact();
      const recalling = await starter.start(serving);
      const reading = await starter.start(serving);
      const held = [await heldFor(ada, recalling), await heldFor(ada, reading)];
      await waiting(recalling);
      await waiting(reading);
      await hasRead(recalling, grant, { source });
      await hasRead(reading, grant, { memory: anna.memory });
      const ids = held.map(({ id }) => id);
      /** What the lists show of the two held calls. */
      const shown = async () => {
        const listed = await signedIn.api.pendingActions.list();
        const feed = await signedIn.api.waiting.list();
        const actions = ids.map((id) => listed.find((each) => each.id === id));
        const items = ids.map((id) =>
          feed.items.find(
            (item) => item.kind === "heldWrite" && item.action.id === id
          )
        );
        return {
          listed: actions.map((action) => ({
            withheld: action?.withheld,
            input: action?.input === "" ? "none" : "shown",
            hash: action?.inputHash === "" ? "none" : "shown",
          })),
          verdicts: items.map((item) => item?.verdicts),
          carries: JSON.stringify([actions, items]).includes(marker),
        };
      };
      const before = await shown();

      await eraseSource(env, {
        source,
        readers: { kind: "none" },
        reason: "deleted",
      });
      await erasePersonShared(env, {
        personId: anna.personId,
        email: anna.address,
      });
      const after = await shown();
      const confirmed = [];
      for (const each of held) {
        confirmed.push(
          // oxlint-disable-next-line no-await-in-loop -- one at a time
          await settledCode(
            signedIn.api.pendingActions.confirm(each.id, each.inputHash)
          )
        );
      }
      const events = await allEvents();
      const refusals = events.filter(
        ({ action, detail }) =>
          action === "connection.action.confirm_refused" &&
          ids.some((id) => JSON.stringify(detail).includes(id))
      );
      for (const id of ids) {
        // oxlint-disable-next-line no-await-in-loop -- one at a time
        await signedIn.api.pendingActions.decline(id);
      }
      const ends = [
        endOf(await ended(ada, workflow.id, recalling)),
        endOf(await ended(ada, workflow.id, reading)),
      ];
      const sent = await mail.did();

      const open = { withheld: undefined, input: "shown", hash: "shown" };
      const closed = { withheld: "revoked", input: "none", hash: "none" };
      expect({
        before,
        after,
        confirmed,
        refusals: refusals.map(({ detail }) => detail?.reason),
        ends,
        sent: sent.calls,
      }).toStrictEqual({
        before: {
          listed: [open, open],
          verdicts: [
            ["approve", "decline"],
            ["approve", "decline"],
          ],
          carries: true,
        },
        after: {
          listed: [closed, closed],
          verdicts: [["decline"], ["decline"]],
          carries: false,
        },
        confirmed: ["brain.revoked", "brain.revoked"],
        refusals: ["brain.revoked", "brain.revoked"],
        // Declined, the step runs again, and its own check stops the run.
        ends: [
          { status: "failed", code: "brain.revoked" },
          { status: "failed", code: "brain.revoked" },
        ],
        sent: 0,
      });
    });
  });

  it("is withheld from its person once lost, and only said to have happened", async () => {
    const admin = await person("admin");
    const signedIn = await signedInApi(idp, "builder");
    const ada = identityOf(signedIn.userId, "builder");
    const marker = `to-${unique()}`;
    // The server sends the mail, and its answer is lost on the way back.
    const { workflow, serving } = await mailingWorkflow(ada, admin, {
      plan: ["lost"],
      to: marker,
      subject: "Hello",
    });
    const grant = await brainGrant(ada, admin, workflow.id);
    const source = await companySource();
    const runId = await started(ada, workflow.id, serving);
    await ended(ada, workflow.id, runId);
    await hasRead(runId, grant, { source });
    /** What the lists show of the run's lost call. */
    const shown = async () => {
      const listed = await signedIn.api.unknownOutcomes.list();
      const feed = await signedIn.api.waiting.list();
      const ours = (key: { subject: { type: string } } & object) =>
        JSON.stringify(key).includes(workflow.id);
      const outcome = listed.find(({ key }) => ours(key));
      const item = feed.items.find(
        (each) => each.kind === "unknownOutcome" && ours(each.outcome.key)
      );
      return {
        withheld: outcome?.withheld,
        input: outcome?.input === null ? "none" : "shown",
        verdicts: item?.verdicts,
        carries: JSON.stringify([outcome, item]).includes(marker),
        outcome,
      };
    };
    const { outcome: _before, ...before } = await shown();

    await eraseSource(env, {
      source,
      readers: { kind: "none" },
      reason: "deleted",
    });
    const { outcome, ...after } = await shown();
    if (outcome === undefined) {
      throw new Error("Nothing lost");
    }
    const notHappened = await settledCode(
      resolveUnknownOutcome(
        env,
        ada,
        outcome.key,
        "not_happened",
        outcome.claim
      )
    );
    const events = await allEvents();
    const refusals = events.filter(
      ({ action, detail }) =>
        action.startsWith("connection.call.resolve") &&
        detail?.subjectId === workflow.id
    );
    // Where it came from no longer read: the run its key names decides.
    const call = connectDb().prepare(
      "SELECT origin FROM idempotent_calls WHERE idempotency_key = ?"
    );
    const origin = await call
      .bind(outcome.key.idempotencyKey)
      .first<string>("origin");
    const setOrigin = connectDb().prepare(
      "UPDATE idempotent_calls SET origin = ? WHERE idempotency_key = ?"
    );
    await setOrigin.bind("not JSON", outcome.key.idempotencyKey).run();
    const { outcome: _unread, ...unread } = await shown();
    await setOrigin.bind(origin, outcome.key.idempotencyKey).run();
    const happened = await settledCode(
      resolveUnknownOutcome(env, ada, outcome.key, "happened", outcome.claim)
    );
    const { outcome: left } = await shown();

    expect({
      before,
      after,
      notHappened,
      refusals: refusals.map(({ action, detail }) => [action, detail?.reason]),
      unread,
      happened,
      left,
    }).toStrictEqual({
      before: {
        withheld: undefined,
        input: "shown",
        verdicts: ["happened", "notHappened"],
        carries: true,
      },
      after: {
        withheld: "revoked",
        input: "none",
        verdicts: ["happened"],
        carries: false,
      },
      notHappened: "brain.revoked",
      refusals: [["connection.call.resolve_refused", "brain.revoked"]],
      unread: {
        withheld: "revoked",
        input: "none",
        verdicts: ["happened"],
        carries: false,
      },
      happened: undefined,
      left: undefined,
    });
  });

  it("is checked for a whole list at once, at a cost that doesn't grow with how many calls it lists, and shows nothing while it can't be checked", async () => {
    await withSlowChecks(async () => {
      const admin = await person("admin");
      const ada = await person("builder");
      const { workflow, serving } = await mailingWorkflow(ada, admin);
      const starter = await startingApp(ada, admin, workflow.id, {
        restricted: true,
      });
      const grant = await brainGrant(ada, admin, workflow.id);
      const source = await companySource();
      const list = new PendingActionsRpc(
        env,
        async () => await Promise.resolve(ada)
      );
      /** `count` more runs that recalled `source`, each holding its send. */
      const holding = async (count: number) => {
        for (let each = 0; each < count; each += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one run at a time
          const runId = await starter.start(serving);
          // oxlint-disable-next-line no-await-in-loop -- once it holds
          await heldFor(ada, runId);
          // Parked on it, so none of its own checks runs while measured.
          // oxlint-disable-next-line no-await-in-loop -- once it waits
          await waiting(runId);
          // oxlint-disable-next-line no-await-in-loop -- as it read it
          await hasRead(runId, grant, { source });
        }
      };
      /** This workflow's held calls, as its person's list shows them. */
      const ours = async () => {
        const listed = await list.list();
        return listed.filter(({ subject }) =>
          JSON.stringify(subject).includes(workflow.id)
        );
      };
      /**
       * What reading the list costs: the least of three reads, as a run's
       * own check running meanwhile (the run host's) only ever adds to
       * what the spies count.
       */
      const listCost = async () => {
        const costs = [];
        for (let each = 0; each < 3; each += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one read at a time
          costs.push(await evidenceCostOf(async () => await list.list()));
        }
        return {
          statements: Math.min(...costs.map(({ statements }) => statements)),
          brainCalls: Math.min(...costs.map(({ brainCalls }) => brainCalls)),
        };
      };
      await holding(2);
      const fewCost = await listCost();
      await holding(4);
      const manyCost = await listCost();
      const shown = await ours();
      vi.spyOn(env.BRAIN_STORE, "getByName").mockImplementation(() => {
        throw new Error("The Brain is away");
      });
      const away = await ours();
      const [first] = away;
      const confirmedAway = await settledCode(
        confirmPendingAction(env, ada, first?.id, shown[0]?.inputHash)
      );
      vi.restoreAllMocks();
      const back = await ours();

      expect({
        askedTheBrain: fewCost.brainCalls > 0,
        manyCost,
        shown: shown.map(({ withheld }) => withheld ?? "shown"),
        away: away.map(({ withheld, input }) => [withheld, input]),
        confirmedAway: confirmedAway === undefined ? "sent" : "refused",
        back: back.map(({ withheld }) => withheld ?? "shown"),
      }).toStrictEqual({
        askedTheBrain: true,
        manyCost: fewCost,
        shown: Array.from({ length: 6 }, () => "shown"),
        away: Array.from({ length: 6 }, () => ["unchecked", ""]),
        confirmedAway: "refused",
        back: Array.from({ length: 6 }, () => "shown"),
      });
    });
  });
});
