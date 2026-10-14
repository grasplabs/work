import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appHost } from "../src/durable-objects.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import {
  consentCode,
  graphDraftsUrl,
  graphLoseUrl,
  graphSentUrl,
} from "./connect-providers.ts";
import { runQuarterHourCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { endLiveRuns, finished, liveStatus } from "./runs.ts";
import { acmeTenant } from "./sign-in-config.ts";
import {
  openRpc,
  outcome as codeOf,
  routed,
  signedInWithRole,
} from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";
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

const idp = mockIdp();

const day = 24 * 60 * 60 * 1000;

/** A signed-in person's API, on a connection of their own. */
const personApi = async (role: Role) => {
  const person = await signedInWithRole(idp, role);
  const { core } = await openRpc(person.session);
  return { ...person, api: core.authenticate() };
};

type Api = Awaited<ReturnType<typeof personApi>>;

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** The outside systems connect reaches (test/connect-providers.ts). */
const providers = (): Fetcher => {
  const fetcher = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(fetcher)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return fetcher;
};

/** A shared Microsoft 365 account, connected by `admin`: its ID. */
const connectShared = async (admin: Api): Promise<string> => {
  const { url } = await admin.api.connections.start({
    provider: "microsoft",
    scope: "shared",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(authorization, acmeTenant, `team-${crypto.randomUUID()}`),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: admin.session },
  });
  const listed = await admin.api.connections.list();
  const shared = listed.find((connection) => connection.scope === "shared");
  if (shared === undefined) {
    throw new Error("Expected the shared connection");
  }
  return shared.id;
};

/** A mailbox of each test's own, so what Graph does for it is the test's. */
const mailboxOf = (): string => `invoices-${crypto.randomUUID()}@acme.test`;

/** Has Graph lose the answers of the mailbox's next `writes` writes. */
const loseAnswers = async (mailbox: string, writes = 1): Promise<void> => {
  await providers().fetch(graphLoseUrl, {
    method: "POST",
    body: JSON.stringify({ mailbox, writes }),
  });
};

/** How many mails Graph sent from `mailbox`. */
const sentFrom = async (mailbox: string): Promise<number> => {
  const response = await providers().fetch(graphSentUrl);
  const sent = z
    .array(z.object({ mailbox: z.string() }))
    .parse(await response.json());
  return sent.filter((message) => message.mailbox === mailbox).length;
};

/** How many drafts Graph made in `mailbox`. */
const draftsIn = async (mailbox: string): Promise<number> => {
  const response = await providers().fetch(
    `${graphDraftsUrl}?mailbox=${encodeURIComponent(mailbox)}`
  );
  return z.object({ drafts: z.number() }).parse(await response.json()).drafts;
};

/**
 * A workflow `mailer` that calls `action` in its side-effect step, from
 * `mailbox`, under the step's key, with no retries; a call its person said
 * happened answers `{ resolved: true }`, as it has no answer of its own.
 */
const mailer = (mailbox: string, action = "mail.send") =>
  workflowFiles(
    "mailer",
    `  return await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify({ mailbox, subject: invoiceMail.subject, body: "Attached.", to: [invoiceMail.to] })}, retries: { limit: 0 } },
    async ({ idempotencyKey, input: mail }) => {
      try {
        return JSON.parse((await env.MAIL.call(${JSON.stringify(action)}, mail, { idempotencyKey })).output);
      } catch (error) {
        if (error.code === resolvedDone) {
          return { resolved: true };
        }
        throw error;
      }
    }
  );`,
    { send: { mailbox, sent: true } }
  );

/** The workflow file, importing what it catches from the SDK. */
const withResolvedDone = (files: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(files).map(([path, source]) => [
      path,
      path.endsWith("mailer.ts")
        ? source.replace(
            "import { workflow, z }",
            "import { resolvedDone, workflow, z }"
          )
        : source,
    ])
  );

/**
 * An App with `mailer`, allowed `action` on a shared Microsoft 365
 * connection, whose first write from its mailbox Graph carries out and
 * then loses the answer of: the run, started, and the permission's ID.
 */
const lostRun = async (admin: Api, action = "mail.send") => {
  const mailbox = mailboxOf();
  const connectionId = await connectShared(admin);
  const app = await appWith(admin, withResolvedDone(mailer(mailbox, action)));
  const permission = await requestGranted(idp, admin, {
    subject: { type: "app", appId: app },
    object: { type: "connection", connectionId },
    actions: [action],
    binding: "MAIL",
  });
  await loseAnswers(mailbox);
  const run = await admin.api.workflows.start(app, "mailer");
  return { mailbox, connectionId, app, permission, run };
};

/** `lostRun`, once its run waits, with the one call of unknown outcome. */
const waitingRun = async (admin: Api, action = "mail.send") => {
  const lost = await lostRun(admin, action);
  await runEvents(lost.run.id, "workflow.run.waiting");
  const [unknown, ...others] = await admin.api.unknownOutcomes.list();
  if (unknown === undefined || others.length > 0) {
    throw new Error("Expected one call of unknown outcome");
  }
  return { ...lost, unknown };
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

/** How many calls the log records on the connection `connectionId`. */
const callsOn = async (connectionId: string): Promise<number> => {
  const events = await allEvents();
  return events.filter(
    ({ action, target }) =>
      action === "connection.call" && target?.id === connectionId
  ).length;
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

/** Waits `ms` of real time. */
const elapse = async (ms: number): Promise<void> => {
  await scheduler.wait(ms);
};

describe("a run's side effect of unknown outcome", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

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
    await admin.api.unknownOutcomes.resolve(
      unknown.key,
      "happened",
      unknown.claim
    );
    await finished(run.id);
    expect({
      unknown,
      before,
      run: await admin.api.workflows.status(run.id),
      sent: await sentFrom(mailbox),
      listed: await admin.api.unknownOutcomes.list(),
      resolutions: await resolutions(connectionId),
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

  it("can't be resolved once the App's permission is revoked, nor by anyone else, and keeps the run waiting", async () => {
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
      revoked,
      othersList: await other.api.unknownOutcomes.list(),
      stillListed: await listedFor(admin),
      live: await liveStatus(run.id),
      sent: await sentFrom(mailbox),
      resolutions: await resolutions(connectionId),
    }).toStrictEqual({
      stranger: "connect.outcome_not_found",
      revoked: "permission.denied",
      othersList: [],
      stillListed: 1,
      live: "waiting",
      sent: 1,
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
    const { connectionId, run, unknown } = await waitingRun(admin);
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
          (target?.id === connectionId || target?.id === run.id) &&
          (action.startsWith("connection.call.resolve") ||
            /undo|rollback|revert/u.test(action))
      ),
    }).toMatchObject({
      run: "cancelled",
      listed: [unknown],
      afterRetention: [{ key: unknown.key, input: null }],
      undone: false,
    });
  });

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
        if (name === "anyPending") {
          return async () => await Promise.resolve(false);
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

  it("fails as before on a Composio tool's error, which stays listed for its person", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection(["lost"]);
    const app = await appWith(
      admin,
      workflowFiles(
        "composio",
        `  return await step.do("send", { description: "Send", sideEffect: true, input: ${JSON.stringify(invoiceMail)}, retries: { limit: 0 } }, async ({ idempotencyKey, input }) => JSON.parse((await env.MAIL.call("mail.send", input, { idempotencyKey })).output));`,
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
