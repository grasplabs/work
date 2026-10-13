import type { Role } from "@grasp-os/shared/roles";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { runQuarterHourCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { endLiveRuns, finished, liveStatus } from "./runs.ts";
import { openRpc, outcome as codeOf, signedInWithRole } from "./sign-in.ts";
import {
  appWith,
  invoiceMail,
  runEvents,
  workflowFiles,
} from "./workflow-apps.ts";

// A run's side effect whose answer was lost, so nobody can tell whether it
// took effect (spec 14.3), on a Composio connection connect never recovers
// on its own: the run waits, using none of its step's retries, until the
// person it acted for says what became of it, then runs the step again
// under the same key. The ways it can fail come first: the run fails, or
// spends its retries, on the same answer; "it happened" sends it again;
// "it didn't happen" sends it twice; someone whose permission is gone
// resolves it; cancelling the run drops the obligation, or records it as
// undone. (Apart from held-runs.test.ts: one file holds only so many runs'
// worth of workers.)

const idp = mockIdp();

const day = 24 * 60 * 60 * 1000;

/** A signed-in person's API, on a connection of their own. */
const personApi = async (role: Role) => {
  const person = await signedInWithRole(idp, role);
  const { core } = await openRpc(person.session);
  return { ...person, api: core.authenticate() };
};

type Api = Awaited<ReturnType<typeof personApi>>;

/**
 * A workflow `mailer` that sends the invoice mail in its side-effect step,
 * under the step's key, with no retries; a call its person said happened
 * answers `{ resolved: true }`, as it has no answer of its own.
 */
const mailer = workflowFiles(
  "mailer",
  `  return await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify(invoiceMail)}, retries: { limit: 0 } },
    async ({ idempotencyKey, input: mail }) => {
      try {
        return JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);
      } catch (error) {
        if (error.code === "connect.resolved_done") {
          return { resolved: true };
        }
        throw error;
      }
    }
  );`,
  { send: { messageId: "mocked" } }
);

/**
 * An App with `mailer`, allowed to send on a mail connection whose server
 * answers its calls as `plan` says, started: the run, waiting on its
 * lost answer, and the permission's ID.
 */
const waitingRun = async (admin: Api, plan: ("lost" | "sent")[]) => {
  const mail = await mailConnection(plan);
  const app = await appWith(admin, mailer);
  const permission = await requestGranted(idp, admin, {
    subject: { type: "app", appId: app },
    object: { type: "connection", connectionId: mail.id },
    actions: ["mail.send"],
    binding: "MAIL",
  });
  const run = await admin.api.workflows.start(app, "mailer");
  await runEvents(run.id, "workflow.run.waiting");
  const [unknown, ...others] = await admin.api.unknownOutcomes.list();
  if (unknown === undefined || others.length > 0) {
    throw new Error("Expected one call of unknown outcome");
  }
  return { mail, app, permission, run, unknown };
};

/** The resolution events of the log, for the connection `connectionId`. */
const resolutions = async (connectionId: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action.startsWith("connection.call.resolve") &&
        target?.id === connectionId
    )
    .map(({ action, actor, detail }) => ({
      action,
      actor: actor.type,
      choice: detail.choice,
      reason: detail.reason,
    }));
};

/** How many calls of unknown outcome are listed for `person`. */
const listedFor = async (person: Api) => {
  const listed = await person.api.unknownOutcomes.list();
  return listed.length;
};

/** How the run `run` stands, as its person sees it. */
const statusOf = async (person: Api, run: string) => {
  const { status } = await person.api.workflows.status(run);
  return status;
};

/** The mail server's calls that reached `mail.send`. */
const callsOf = async (mail: { did: () => Promise<{ calls: number }> }) => {
  const { calls } = await mail.did();
  return calls;
};

describe("a run's side effect of unknown outcome", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("holds the run, retries unspent, until its person says it happened: then the step completes without sending it again", async () => {
    const admin = await personApi("admin");
    const { mail, app, run, unknown } = await waitingRun(admin, ["lost"]);
    // Asleep between its checks, with nothing of it running.
    await vi.waitFor(
      async () => {
        await expect(liveStatus(run.id)).resolves.toBe("waiting");
      },
      { timeout: 10_000, interval: 100 }
    );
    const before = await mail.did();
    await admin.api.unknownOutcomes.resolve(unknown.key, "happened");
    await finished(run.id);
    expect({
      unknown,
      before: before.calls,
      run: await admin.api.workflows.status(run.id),
      server: await mail.did(),
      listed: await admin.api.unknownOutcomes.list(),
      resolutions: await resolutions(mail.id),
      audited: await runEvents(run.id, "workflow.run.completed"),
    }).toMatchObject({
      unknown: {
        key: {
          subject: { type: "app", appId: app },
          connectionId: mail.id,
          action: "mail.send",
          idempotencyKey: `${run.id}:send`,
        },
        input: JSON.stringify(invoiceMail),
        origin: { mode: "workflow", appVersion: 1 },
      },
      before: 1,
      run: { status: "completed", output: { resolved: true } },
      // The one call, and no other.
      server: { calls: 1 },
      listed: [],
      resolutions: [
        {
          action: "connection.call.resolved",
          actor: "person",
          choice: "happened",
          reason: undefined,
        },
      ],
      audited: [
        "workflow.run.completed",
        "workflow.run.started",
        "workflow.run.waiting held",
        "workflow.step.completed $params",
        "workflow.step.completed send",
      ],
    });
  });

  it("sends it once more, under the same key, once its person says it didn't happen", async () => {
    const admin = await personApi("admin");
    const { mail, run, unknown } = await waitingRun(admin, ["lost", "sent"]);
    await admin.api.unknownOutcomes.resolve(unknown.key, "not_happened");
    await finished(run.id);
    expect({
      run: await admin.api.workflows.status(run.id),
      server: await callsOf(mail),
      again: await codeOf(
        admin.api.unknownOutcomes.resolve(unknown.key, "happened")
      ),
    }).toMatchObject({
      run: { status: "completed", output: { messageId: "message-2" } },
      server: 2,
      again: "connect.outcome_not_found",
    });
  });

  it("can't be resolved once the App's permission is revoked, nor by anyone else, and keeps the run waiting", async () => {
    const admin = await personApi("admin");
    const { mail, permission, run, unknown } = await waitingRun(admin, [
      "lost",
    ]);
    const other = await personApi("admin");
    const stranger = await codeOf(
      other.api.unknownOutcomes.resolve(unknown.key, "not_happened")
    );
    await admin.api.permissions.revoke(permission);
    const revoked = await codeOf(
      admin.api.unknownOutcomes.resolve(unknown.key, "not_happened")
    );
    expect({
      stranger,
      revoked,
      othersList: await other.api.unknownOutcomes.list(),
      stillListed: await listedFor(admin),
      live: await liveStatus(run.id),
      server: await callsOf(mail),
      resolutions: await resolutions(mail.id),
    }).toStrictEqual({
      stranger: "connect.outcome_not_found",
      revoked: "permission.denied",
      othersList: [],
      stillListed: 1,
      live: "waiting",
      server: 1,
      resolutions: [
        {
          action: "connection.call.resolve_refused",
          actor: "person",
          choice: "not_happened",
          reason: "connect.outcome_not_found",
        },
        {
          action: "connection.call.resolve_refused",
          actor: "person",
          choice: "not_happened",
          reason: "permission.denied",
        },
      ],
    });
  });

  it("stays an obligation of its person when the run is cancelled: only the run's wait goes, and nothing says it was undone", async () => {
    const admin = await personApi("admin");
    const { mail, run, unknown } = await waitingRun(admin, ["lost"]);
    await admin.api.workflows.cancel(run.id);
    await finished(run.id);
    const listed = await admin.api.unknownOutcomes.list();
    // Past the run's retention its input goes; the obligation stays.
    await runQuarterHourCron({}, new Date(Date.now() + 31 * day));
    const events = await allEvents();
    expect({
      run: await statusOf(admin, run.id),
      listed,
      afterRetention: await admin.api.unknownOutcomes.list(),
      undone: events.some(
        ({ action, target }) =>
          (target?.id === mail.id || target?.id === run.id) &&
          (action.startsWith("connection.call.resolve") ||
            /undo|rollback|revert/u.test(action))
      ),
    }).toStrictEqual({
      run: "cancelled",
      listed: [unknown],
      afterRetention: [{ ...unknown, input: null }],
      undone: false,
    });
  });
});
