import { signCapability } from "@grasp-os/shared/capability";
import { appIdSchema } from "@grasp-os/shared/ids";
import { workContextSchema } from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appHost } from "../src/durable-objects.ts";
import { waitKeyOf } from "../src/workflows/host.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { runQuarterHourCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { endLiveRuns, finished, liveStatus, runInstance } from "./runs.ts";
import { outcome as codeOf } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";
import {
  day,
  connectShared,
  mailboxOf,
  sentFrom,
  receiptsFrom,
  exportedObligations,
  mailer,
  withResolvedDone,
  resolutions,
  callReceipts,
  listedFor,
  statusOf,
  asleep,
  unknownOutcomesOf,
} from "./unknown-outcome-runs.ts";
import {
  appWith,
  invoiceMail,
  runEvents,
  workflowFiles,
} from "./workflow-apps.ts";

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

// Here: what its person, or anyone else, says of it, and what each answer
// does; how a hold ends by its deadline or by connect's recovery is
// unknown-outcome-holds.test.ts's.

const idp = mockIdp();
const { personApi, staffExport, lostRun, waitingRun } = unknownOutcomesOf(idp);

describe("a run's side effect of unknown outcome", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("wakes the waiting step as soon as its person says what became of it, not at its next check", async () => {
    const admin = await personApi("admin");
    const { run } = await lostRun(admin);
    const unknownWait = `$grasp:wait:${await waitKeyOf("send")}:unknown:`;
    using events = await runInstance(run.id).subscribe({
      filter: ["wait_started", "wait_completed", "wait_timed_out"],
    });
    const report = async () => {
      const { done, value } = await events.next();
      if (done === true) {
        throw new Error(`Run ${run.id} ended while it waited`);
      }
      return value;
    };
    // Its checks come further apart each time (from 250 ms in tests): the
    // fourth waits two seconds, which only a wake ends early.
    let waits = 0;
    await vi.waitFor(
      async () => {
        const value = await report();
        if (
          value.type === "wait_started" &&
          value.stepName.startsWith(unknownWait)
        ) {
          waits += 1;
        }
        expect(waits).toBeGreaterThanOrEqual(4);
      },
      { timeout: 20_000, interval: 0 }
    );
    const [unknown] = await admin.api.unknownOutcomes.list();
    if (unknown === undefined) {
      throw new Error("Expected a call of unknown outcome");
    }
    await admin.api.unknownOutcomes.resolve(
      unknown.key,
      "happened",
      unknown.claim
    );
    let ended: string | undefined;
    while (ended === undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one report at a time
      const value = await report();
      if (
        (value.type === "wait_completed" || value.type === "wait_timed_out") &&
        value.stepName.startsWith(unknownWait)
      ) {
        ended = value.type;
      }
    }
    await finished(run.id);

    expect({
      ended,
      run: await admin.api.workflows.status(run.id),
    }).toMatchObject({
      ended: "wait_completed",
      run: { status: "completed", output: { resolved: true } },
    });
  });

  it("holds the run, retries unspent, until its person says it happened: then the step completes without sending it again", async () => {
    const admin = await personApi("admin");
    const { mailbox, connectionId, app, run, unknown } =
      await waitingRun(admin);
    // Asleep between its checks, with nothing of it running.
    await vi.waitFor(
      async () => {
        await expect(liveStatus(run.id)).resolves.toBe("waiting");
      },
      { timeout: 10_000, interval: 100 }
    );
    const before = await sentFrom(mailbox);
    // The receipt Graph's message carries, as an auditor reads it.
    const [receipt] = await receiptsFrom(mailbox);
    const openBefore = await exportedObligations(admin.api);
    await admin.api.unknownOutcomes.resolve(
      unknown.key,
      "happened",
      unknown.claim
    );
    await finished(run.id);
    const openAfter = await exportedObligations(admin.api);
    const ofThisCall = (
      open: Awaited<ReturnType<typeof exportedObligations>>
    ) =>
      open?.obligations.filter(
        ({ effectKeyHash }) => effectKeyHash === receipt
      ) ?? [];
    expect({
      unknown,
      before,
      run: await admin.api.workflows.status(run.id),
      sent: await sentFrom(mailbox),
      listed: await admin.api.unknownOutcomes.list(),
      resolutions: await resolutions(connectionId),
      calls: await callReceipts(connectionId),
      exportedBefore: ofThisCall(openBefore),
      exportedAfter: ofThisCall(openAfter),
      audited: await runEvents(run.id, "workflow.run.completed"),
    }).toMatchObject({
      unknown: {
        key: {
          subject: { type: "app", appId: app },
          connectionId,
          action: "mail.send",
          idempotencyKey: `${run.id}:send`,
        },
        description: { title: "Send an email" },
        origin: { mode: "workflow", appVersion: 1 },
      },
      before: 1,
      run: { status: "completed", output: { resolved: true } },
      // The one mail, and no other.
      sent: 1,
      listed: [],
      // The call, the obligation and its resolution, all by the receipt
      // the provider's record carries: tied together without the run.
      resolutions: [
        {
          action: "connection.call.resolved",
          actor: "person",
          choice: "happened",
          reason: undefined,
          effectKeyHash: receipt,
        },
      ],
      calls: [
        { outcome: "unknown", effectKeyHash: receipt },
        // The step again, refused as resolved: nothing sent.
        { outcome: "refused", effectKeyHash: receipt },
      ],
      exportedBefore: [
        {
          effectKeyHash: receipt,
          onBehalfOf: admin.userId,
          subject: { type: "app", appId: app },
          connectionId,
          action: "mail.send",
          resource: null,
        },
      ],
      exportedAfter: [],
      audited: [
        "workflow.run.completed",
        "workflow.run.started",
        "workflow.run.waiting outcome_unknown",
        "workflow.step.completed $params",
        "workflow.step.completed send",
      ],
    });
    // Never what was sent, nor its key, in what leaves the platform.
    expect(
      Object.keys(ofThisCall(openBefore)[0] ?? {}).toSorted()
    ).toStrictEqual([
      "action",
      "connectionId",
      "connectionName",
      "effectKeyHash",
      "onBehalfOf",
      "resource",
      "sentAt",
      "subject",
      "title",
    ]);
  });

  it("sends it once more, under the same key, once its person says it didn't happen", async () => {
    const admin = await personApi("admin");
    const { mailbox, run, unknown } = await waitingRun(admin);
    await admin.api.unknownOutcomes.resolve(
      unknown.key,
      "not_happened",
      unknown.claim
    );
    await finished(run.id);
    expect({
      run: await admin.api.workflows.status(run.id),
      sent: await sentFrom(mailbox),
      again: await codeOf(
        admin.api.unknownOutcomes.resolve(
          unknown.key,
          "happened",
          unknown.claim
        )
      ),
    }).toMatchObject({
      run: { status: "completed", output: { mailbox, sent: true } },
      sent: 2,
      again: "connect.outcome_not_found",
    });
  });

  it("can't be resolved once the App's permission is revoked, nor by anyone else, nor as a send it wasn't shown, and keeps the run waiting", async () => {
    const admin = await personApi("admin");
    const { mailbox, connectionId, permission, run, unknown } =
      await waitingRun(admin);
    const other = await personApi("admin");
    const stranger = await codeOf(
      other.api.unknownOutcomes.resolve(
        unknown.key,
        "not_happened",
        unknown.claim
      )
    );
    // A claim of its key other than the one it was shown.
    const otherClaim = await codeOf(
      admin.api.unknownOutcomes.resolve(
        unknown.key,
        "not_happened",
        unknown.claim + 1
      )
    );
    await admin.api.permissions.revoke(permission);
    const revoked = await codeOf(
      admin.api.unknownOutcomes.resolve(
        unknown.key,
        "not_happened",
        unknown.claim
      )
    );
    expect({
      stranger,
      otherClaim,
      revoked,
      badCursor: await codeOf(admin.api.unknownOutcomes.list("not-a-cursor")),
      othersList: await other.api.unknownOutcomes.list(),
      stillListed: await listedFor(admin),
      // Between its checks (every `WORKFLOW_OFF_WAIT_MS`), as it went on
      // waiting: a check itself shows it running for a moment.
      live: await asleep(run.id),
      sent: await sentFrom(mailbox),
      resolutions: await resolutions(connectionId),
    }).toStrictEqual({
      stranger: "connect.outcome_not_found",
      otherClaim: "connect.outcome_not_found",
      revoked: "permission.denied",
      badCursor: "connect.invalid",
      othersList: [],
      stillListed: 1,
      live: "waiting",
      sent: 1,
      // None names the call's receipt (`resolutions` keeps it only where
      // an event has one): the stranger's names a key of no call of
      // theirs, and the others were refused before the call was read.
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

  it("can't be said not to have happened once what it sent is no longer kept, only that it happened", async () => {
    const admin = await personApi("admin");
    const { mailbox, connectionId, run, unknown } = await waitingRun(admin);
    // Past connect's retention, its input goes; the obligation stays.
    await connectDb()
      .prepare(
        "UPDATE idempotent_calls SET input = NULL WHERE connection_id = ?1"
      )
      .bind(connectionId)
      .run();
    const [removed] = await admin.api.unknownOutcomes.list();
    const notHappened = await codeOf(
      admin.api.unknownOutcomes.resolve(
        unknown.key,
        "not_happened",
        unknown.claim
      )
    );
    // Still waiting, between its checks (`asleep`).
    const live = await asleep(run.id);
    await admin.api.unknownOutcomes.resolve(
      unknown.key,
      "happened",
      unknown.claim
    );
    await finished(run.id);
    expect({
      input: removed?.input,
      notHappened,
      live,
      run: await admin.api.workflows.status(run.id),
      sent: await sentFrom(mailbox),
      resolutions: await resolutions(connectionId),
    }).toMatchObject({
      input: null,
      notHappened: "connect.outcome_not_kept",
      live: "waiting",
      run: { status: "completed", output: { resolved: true } },
      sent: 1,
      resolutions: [
        {
          action: "connection.call.resolve_refused",
          actor: "person",
          choice: "not_happened",
          reason: "connect.outcome_not_kept",
        },
        {
          action: "connection.call.resolved",
          actor: "person",
          choice: "happened",
          reason: undefined,
        },
      ],
    });
  });

  it("is listed for the organization's other admins, read only and without what was sent, who can't resolve it; refused to anyone else", async () => {
    const admin = await personApi("admin");
    const { mailbox, connectionId, app, run, unknown } =
      await waitingRun(admin);
    const other = await personApi("admin");
    const member = await personApi("builder");
    // Asleep between its checks once it has gone quiet, with nothing of it
    // running: a parked run suspends once every call it has out is parked.
    await asleep(run.id);
    const listed = await other.api.unknownOutcomes.listAll();
    const [receipt] = await receiptsFrom(mailbox);
    const theirs = listed.filter(
      ({ onBehalfOf }) => onBehalfOf === admin.userId
    );
    const { items } = await admin.api.workflows.history(run.id, {
      pageSize: 100,
    });
    // Who read everyone's, and how many: recorded as a read.
    const events = await allEvents();
    const reads = events
      .filter(
        ({ action, actor }) =>
          action === "connection.call.unknown_listed" &&
          "userId" in actor &&
          actor.userId === other.userId
      )
      .map(({ actor, detail }) => ({ actor: actor.type, count: detail.count }));
    expect({
      theirs,
      reads,
      shown: theirs.map((listing) => Object.keys(listing).toSorted()),
      // Even with its key and claim, as its person was shown them.
      resolved: await codeOf(
        other.api.unknownOutcomes.resolve(
          unknown.key,
          "happened",
          unknown.claim
        )
      ),
      memberAll: await codeOf(member.api.unknownOutcomes.listAll()),
      // Grasp staff export the log as admins, without anyone's obligations.
      staffExport: await staffExport(),
      memberOwn: await member.api.unknownOutcomes.list(),
      stillListed: await listedFor(admin),
      // Asleep again between its checks: a check that came due meanwhile
      // runs, and the run waits on.
      live: await asleep(run.id),
      sent: await sentFrom(mailbox),
      waitsOnOutcome: items.some(
        (entry) =>
          entry.kind === "wait" &&
          entry.waitKind === "outcome_unknown" &&
          entry.state === "opened"
      ),
    }).toMatchObject({
      theirs: [
        {
          // The receipt the log and Graph's message name the call by.
          effectKeyHash: receipt,
          onBehalfOf: admin.userId,
          subject: { type: "app", appId: app },
          connectionId,
          action: "mail.send",
          title: "Send an email",
          resource: null,
        },
      ],
      // Never the input, its description, its key, its claim or its origin.
      shown: [
        [
          "action",
          "connectionId",
          "connectionName",
          "cursor",
          "effectKeyHash",
          "id",
          "onBehalfOf",
          "resource",
          "sentAt",
          "subject",
          "title",
        ],
      ],
      reads: [{ actor: "person", count: listed.length }],
      resolved: "connect.outcome_not_found",
      memberAll: "role.forbidden",
      staffExport: null,
      memberOwn: [],
      stillListed: 1,
      live: "waiting",
      sent: 1,
      // The run's page says why it waits.
      waitsOnOutcome: true,
    });
  });

  it("wakes the waiting run once its person resolves it, rather than leaving it to its next check", async () => {
    const admin = await personApi("admin");
    const wait = env.WORKFLOW_OFF_WAIT_MS;
    // Its first wait alone outlasts how long the run is given to finish.
    env.WORKFLOW_OFF_WAIT_MS = "50000";
    try {
      const { mailbox, run } = await lostRun(admin);
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
      await vi.waitFor(
        async () => {
          await expect(liveStatus(run.id)).resolves.toBe("waiting");
        },
        { timeout: 10_000, interval: 100 }
      );
      await admin.api.unknownOutcomes.resolve(
        unknown.key,
        "happened",
        unknown.claim
      );
      await finished(run.id);
      expect({
        run: await admin.api.workflows.status(run.id),
        sent: await sentFrom(mailbox),
      }).toMatchObject({
        run: { status: "completed", output: { resolved: true } },
        sent: 1,
      });
    } finally {
      env.WORKFLOW_OFF_WAIT_MS = wait;
    }
  });

  it("stays an obligation of its person when the run is cancelled, and past the run's retention keeps its receipt, its events and its refusal to send again", async () => {
    const admin = await personApi("admin");
    const { mailbox, connectionId, app, run, unknown } =
      await waitingRun(admin);
    await admin.api.workflows.cancel(run.id);
    await finished(run.id);
    const listed = await admin.api.unknownOutcomes.list();
    const [receipt] = await receiptsFrom(mailbox);
    const receiptRow = async () =>
      await connectDb()
        .prepare(
          "SELECT state, input_hash AS inputHash, origin FROM idempotent_calls WHERE idempotency_key = ?"
        )
        .bind(unknown.key.idempotencyKey)
        .first<{ state: string; inputHash: string; origin: string }>();
    const before = await receiptRow();
    // Past the run's retention its input goes; the obligation stays.
    await runQuarterHourCron({}, new Date(Date.now() + 31 * day));
    const row = await receiptRow();
    const origin = z
      .object({
        mode: z.enum(["interactive", "workflow"]),
        appVersion: z.int().positive(),
        permissionId: z.string(),
        context: workContextSchema,
      })
      .parse(JSON.parse(row?.origin ?? "null"));
    // The same call made again, as the run's step made it, now its details
    // are gone: connect still knows it, and sends nothing.
    const capability = await signCapability(
      env.CAPABILITY_SIGNING_KEY,
      {
        subject: { type: "app", appId: appIdSchema.parse(app) },
        onBehalfOf: admin.userId,
        mode: origin.mode,
        appVersion: origin.appVersion,
      },
      {
        connectionId,
        action: "mail.send",
        idempotencyKey: unknown.key.idempotencyKey,
        origin: {
          permissionId: origin.permissionId,
          context: origin.context,
        },
        context: origin.context,
      }
    );
    const repeated = await codeOf(
      env.CONNECT.call({
        capability,
        connectionId,
        action: "mail.send",
        idempotencyKey: unknown.key.idempotencyKey,
        input: {
          mailbox,
          subject: invoiceMail.subject,
          body: "Attached.",
          to: [invoiceMail.to],
        },
      })
    );
    const events = await allEvents();
    expect({
      run: await statusOf(admin, run.id),
      listed,
      afterRetention: await admin.api.unknownOutcomes.list(),
      receiptKept: row?.state,
      // What a repeat is checked against: the input's hash outlives it.
      inputHashKept:
        row?.inputHash !== undefined && row.inputHash === before?.inputHash,
      repeated,
      sent: await sentFrom(mailbox),
      // The call's event, and the repeat's, by the receipt Graph's message
      // carries: the evidence outlives the run's.
      calls: await callReceipts(connectionId),
      undone: events.some(
        ({ action, target }) =>
          (target?.id === connectionId || target?.id === run.id) &&
          (action.startsWith("connection.call.resolve") ||
            /undo|rollback|revert/u.test(action))
      ),
    }).toMatchObject({
      run: "cancelled",
      listed: [unknown],
      afterRetention: [{ key: unknown.key, input: null }],
      receiptKept: "unknown",
      inputHashKept: true,
      repeated: "connect.outcome_unknown",
      sent: 1,
      calls: [
        { outcome: "unknown", effectKeyHash: receipt },
        { outcome: "unknown", effectKeyHash: receipt },
      ],
      undone: false,
    });
  });

  it("fails the step as declined, sending nothing, when its one more send is held for its person and they decline it", async () => {
    const admin = await personApi("admin");
    const { mailbox, app, run, unknown } = await waitingRun(admin);
    // Restricted meanwhile: the send its person lets go waits for them.
    await appHost(env, appIdSchema.parse(app)).restrict();
    await admin.api.unknownOutcomes.resolve(
      unknown.key,
      "not_happened",
      unknown.claim
    );
    const held = await vi.waitFor(
      async () => {
        const [waiting] = await admin.api.pendingActions.list();
        if (waiting === undefined) {
          throw new Error("Nothing held yet");
        }
        return waiting;
      },
      { timeout: 15_000, interval: 100 }
    );
    await admin.api.pendingActions.decline(held.id);
    await finished(run.id);
    expect({
      run: await admin.api.workflows.status(run.id),
      waiting: await admin.api.pendingActions.list(),
      sent: await sentFrom(mailbox),
    }).toMatchObject({
      run: {
        status: "failed",
        failure: { error: { code: "connect.declined" } },
      },
      waiting: [],
      // The lost send only.
      sent: 1,
    });
  });

  it("fails as before on a Composio tool's error, which stays listed for its person", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection(["lost"]);
    const app = await appWith(
      admin,
      workflowFiles(
        "composio",
        `  return await step.do("send", { description: "Send", sideEffect: true, input: ${JSON.stringify(invoiceMail)}, retries: { limit: 0 } }, async ({ idempotencyKey, input }) => JSON.parse(((await env.MAIL.call("mail.send", input, { idempotencyKey })) as { output: string }).output));`,
        { send: null }
      )
    );
    await requestGranted(idp, admin, {
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.send"],
      binding: "MAIL",
    });
    const run = await admin.api.workflows.start(app, "composio");
    await finished(run.id);
    expect({
      run: await admin.api.workflows.status(run.id),
      listed: await admin.api.unknownOutcomes.list(),
    }).toMatchObject({
      run: {
        status: "failed",
        failure: { error: { code: "connect.outcome_unknown" } },
      },
      listed: [{ key: { connectionId: mail.id, action: "mail.send" } }],
    });
  });

  it("can't be resolved once the resource binding its App's call came through no longer serves it", async () => {
    const admin = await personApi("admin");
    const connectionId = await connectShared(admin);
    const app = await appWith(admin, withResolvedDone(mailer(mailboxOf())));
    const permission = await requestGranted(idp, admin, {
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId },
      actions: ["mail.send"],
      binding: "MAIL",
    });
    // Sent through a binding since revoked, its answer lost.
    const hash = "0".repeat(64);
    const now = Date.now();
    await connectDb()
      .prepare(
        "INSERT INTO idempotent_calls (subject_type, subject_id, on_behalf_of, connection_id, action, idempotency_key, input_hash, state, created_at, claimed_at, resource, input, origin) VALUES ('app', ?, ?, ?, 'mail.send', ?, ?, 'unknown', ?, ?, NULL, '{}', ?)"
      )
      .bind(
        app,
        admin.userId,
        connectionId,
        `run-${crypto.randomUUID()}:send`,
        hash,
        now,
        now,
        JSON.stringify({
          mode: "workflow",
          appVersion: 1,
          permissionId: permission,
          context: { type: "app", appId: app },
          restricted: false,
          binding: {
            id: `binding-${crypto.randomUUID()}`,
            declarationHash: hash,
            fingerprint: hash,
          },
        })
      )
      .run();
    const [unknown] = await admin.api.unknownOutcomes.list();
    if (unknown === undefined) {
      throw new Error("Expected the call of unknown outcome");
    }
    expect({
      resolved: await codeOf(
        admin.api.unknownOutcomes.resolve(
          unknown.key,
          "happened",
          unknown.claim
        )
      ),
      stillListed: await listedFor(admin),
    }).toStrictEqual({ resolved: "resource.unavailable", stillListed: 1 });
  });
});
