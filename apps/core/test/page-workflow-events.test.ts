import { v } from "@grasp-os/runtime/app";
import { declaredWorkflows } from "@grasp-os/runtime/host";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import {
  appFunctionPath,
  pageLeaseHeader,
  pagePersonHeader,
} from "@grasp-os/shared/pages";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { publishVersion } from "../src/app-publish.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appFor } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { appHost } from "../src/durable-objects.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { commitDefined } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  mutationCall,
  objectSchema,
  queryCall,
  settles,
} from "./json-workflow-apps.ts";
import { liveStatus } from "./runs.ts";
import { appWith, seal } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { auditedDuring, routed, signedInApi, unique } from "./sign-in.ts";

// A page's typed `send` (spec 10.4.6; page-workflows.ts, and the run
// inbox it admits to, workflows/run-events.ts) through the real host, from
// its threat model: only a run the page shows takes a send, through an
// event its release declares, with data its contract takes, under the
// App's own `send` grant, which `start` doesn't imply; the host mints the
// envelope, and a request carrying any of it is refused; each call is one
// event and a resend under its key the same one; an ended run takes none,
// and no send starts a run.

const idp = mockIdp();

/**
 * The event the workflow takes, and the task waiting on it, as the bound
 * version has them.
 */
const declaresJobEvents =
  'events: { jobEvents: { type: "grasp.job.completed", data: v.object({ jobId: v.string() }) } },\n  listens: { job: ["jobEvents"] },';

/** The Invoices App, declaring `declares` of `review` besides its args and returns. */
const files = (declares = declaresJobEvents): TestApp =>
  testApp(
    {
      name: "Invoices",
      tables: {
        invoices: {
          fields: { amount: "v.number()" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
      permissions: [
        `permission.workflow("review", {\n  args: v.object({ jobId: v.string() }),\n  returns: v.object({ status: v.string() }),\n  ${declares}\n})`,
      ],
    },
    {
      "server/invoices.ts": `import { v } from "@grasp-os/sdk";
import { permissions } from "../grasp.config.ts";

export const review = permissions.review;
`,

      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Desk() {
  return <main>Invoices</main>;
}

export const Route = createFileRoute("/")({ component: Desk });
`,
    }
  );

const completed = "grasp.job.completed";

/** A job's events: the completion a page sends, and a timeout it doesn't. */
const jobEvents = {
  [completed]: {
    data: JSON.stringify(v.object({ jobId: v.string() }).descriptor),
    browser: true,
  },
  "grasp.job.timeout": {
    data: JSON.stringify(v.object({ jobId: v.string() }).descriptor),
    browser: false,
  },
};

/**
 * A workflow waiting, in `job`, for its job's completion through
 * `jobEvents`, then ending with the event's source and job.
 */
const definitionOf = (contract: string): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ jobId: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: {
      status: {
        $expr:
          'job.timedOut ? "" : job.event.source + " " + job.event.data.jobId',
      },
    },
    permissions: { events: { jobEvents: { contract } } },
    steps: [
      {
        id: "job",
        type: "waitForEvent",
        events: "jobEvents",
        eventType: completed,
        timeout: "1 hour",
      },
    ],
  });

/** Someone signed in, and as core's own calls take them. */
const signedIn = async (role: Role) => {
  const session = await signedInApi(idp, role);
  const acting: Acting & Identity = {
    userId: session.userId,
    email: z.string().parse(session.person.email),
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  return { ...session, acting };
};

type Person = Awaited<ReturnType<typeof signedIn>>;

/** What `by` may hand a permission request: their App and resource roles. */
const rolesOf = (by: Identity) => ({
  app: async (named: string, role: "user" | "builder") =>
    await appFor(env, by, named, role),
  resource: async (
    ref: Parameters<typeof requireResourceRole>[2],
    needed: Parameters<typeof requireResourceRole>[3]
  ) => {
    await requireResourceRole(env, by, ref, needed);
  },
});

/**
 * The reference to `alias` as `@server/_generated/api` generates it from
 * `release`, as much of it as a page's calls name: its functions' path,
 * and that `jobEvents` is an event it declares.
 */
const workflowReference = (release: Release, alias: string) => {
  const declared = declaredWorkflows(release.app, release.workflows).find(
    (workflow) => workflow.alias === alias
  );
  if (declared?.events.jobEvents === undefined) {
    throw new Error(`No workflow ${alias} that takes jobEvents`);
  }
  return { name: `workflows.${alias}` };
};

type Reference = ReturnType<typeof workflowReference>;

/** The App's grant of `actions` on `workflow`, requested and granted. */
const granted = async (
  admin: Person,
  builder: Person,
  app: string,
  workflow: string,
  actions: string[]
): Promise<string> => {
  const asked = await requestPermission(
    env,
    builder.acting,
    {
      subject: { type: "app", appId: app },
      object: { type: "workflow", workflowId: workflow },
      actions,
      binding: `REVIEW_${actions.join("_").toUpperCase()}`,
    },
    rolesOf(builder.acting)
  );
  await grantPermission(env, admin.acting, asked.id, { version: 1 });
  return asked.id;
};

/**
 * The Invoices App sealed and current, `review` bound
 * to a workflow waiting for its job's completion through `jobEvents`
 * (approved), with the App's grants of `actions` on it, each its own.
 */
const invoicesApp = async (actions: readonly string[][]) => {
  const admin = await signedIn("admin");
  const builder = await signedIn("builder");
  const contract = `job-events-${unique()}`;
  await publishCatalogContract(env, admin.acting, {
    key: contract,
    kind: "event",
    events: jobEvents,
  });
  const workflow = await createWorkflowResource(
    env,
    builder.acting,
    `review-${unique()}`
  );
  await publishWorkflowVersion(env, builder.acting, workflow.id, {
    definition: definitionOf(contract),
    basedOn: null,
  });
  await approveWorkflowBinding(env, admin.acting, workflow.id, {
    alias: "jobEvents",
    target: { kind: "event" },
    reviewed: { version: 1 },
  });
  const fixture = await appWith(files(), "Invoices", builder.acting);
  await bindWorkflowToApp(env, builder.acting, workflow.id, {
    app: fixture.app,
    alias: "review",
    version: 1,
  });
  await seal(fixture);
  await publishVersion(env, builder.acting, fixture.app, 1);
  const grants: string[] = [];
  for (const each of actions) {
    // oxlint-disable-next-line no-await-in-loop -- one grant after the other
    grants.push(await granted(admin, builder, fixture.app, workflow.id, each));
  }
  const release = await loadRelease(env, fixture.app, 1);
  return {
    admin,
    builder,
    fixture,
    app: fixture.app,
    workflow: workflow.id,
    grants,
    reference: workflowReference(release, "review"),
  };
};

/** A page of `person`'s on the App, opened: its frame's lease. */
const pageOf = async (person: Person, app: string): Promise<string> => {
  const { lease } = await person.api.pages.open(app);
  return lease;
};

/** A call of the page's, relayed to core's function route: its answer. */
const called = async (
  person: Person,
  app: string,
  lease: string,
  request: string
): Promise<unknown> => {
  const response = await routed(`${appFunctionPath}/${app}`, {
    method: "POST",
    headers: {
      origin: clientOrigin,
      "content-type": "application/json",
      cookie: person.session,
      [pageLeaseHeader]: lease,
      [pagePersonHeader]: person.userId,
    },
    body: request,
  });
  const answer: unknown = await response.json();
  if (response.ok) {
    return answer;
  }
  const payload = errorPayloadSchema.parse(answer);
  throw Object.assign(new Error(payload.message), { code: payload.code });
};

const resultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
]);

/** What a raw call answered: its value, or its refusal's code. */
const outcomeOf = (answer: unknown): unknown => {
  const { result } = z.object({ result: resultSchema }).parse(answer);
  return result.ok ? result.value : result.error.code;
};

/** Whether a send's answer is an event ID the host minted. */
const isEvent = (answer: unknown): boolean =>
  z
    .object({ eventId: z.string().regex(/^evt_[0-9a-f]{48}$/u) })
    .safeParse(answer).success;

/** Starts a run of `review` on job `jobId` from `person`'s page: its ID. */
const startedRun = async (
  person: Person,
  app: string,
  lease: string,
  reference: Reference,
  jobId = "job-1"
): Promise<string> => {
  const handle = z
    .object({ runId: z.string() })
    .parse(
      outcomeOf(
        await called(
          person,
          app,
          lease,
          mutationCall(reference, "start", { args: { jobId } })
        )
      )
    );
  await vi.waitFor(
    async () => {
      await expect(liveStatus(handle.runId)).resolves.toBe("waiting");
    },
    { timeout: 30_000, interval: 100 }
  );
  return handle.runId;
};

/**
 * A page's call of `send`: `args` over a well-formed one's
 * (`jobEvents`, job-1), under a fresh key.
 */
const sendText = (
  reference: Reference,
  runId: string,
  args: Record<string, unknown> = {}
): string =>
  mutationCall(reference, "send", {
    runId,
    event: "jobEvents",
    data: { jobId: "job-1" },
    ...args,
  });

/** A send's call `text`, under its key, with `data` instead. */
const withData = (text: string, data: unknown): string => {
  const call = z
    .looseObject({ args: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(text));
  return JSON.stringify({ ...call, args: { ...call.args, data } });
};

/** The run `runId`'s snapshot, as its page's `run` query reads it. */
const snapshotOf = async (
  person: Person,
  app: string,
  lease: string,
  reference: Reference,
  runId: string
): Promise<unknown> =>
  outcomeOf(
    await called(person, app, lease, queryCall(reference, "run", { runId }))
  );

/** The refused sends `events` recorded, as the audit names them. */
const refusals = (events: Awaited<ReturnType<typeof auditedDuring>>) =>
  events
    .filter(({ action }) => action === "workflow.event.refused")
    .map(({ actor, target, detail }) => ({
      actor,
      target,
      code: detail?.code,
      via: detail?.via,
    }));

/** The status run `runId` ended with. */
const runStatus = async (runId: string): Promise<unknown> =>
  await vi.waitFor(
    async () => {
      const row = await env.DB.prepare(
        "SELECT status FROM workflow_resource_runs WHERE id = ?"
      )
        .bind(runId)
        .first<{ status: string }>();
      expect(row?.status).not.toMatch(/^(?:starting|running)$/u);
      return row?.status;
    },
    { timeout: 30_000, interval: 100 }
  );

describe("a page's typed send", { timeout: 180_000 }, () => {
  it("delivers one event per call to the run it shows, with the host's source, the same event for a resend under its key, and none once the run ended", async () => {
    const { builder, app, workflow, reference } = await invoicesApp([
      ["start"],
      ["send"],
    ]);
    const lease = await pageOf(builder, app);
    const runId = await startedRun(builder, app, lease, reference);
    const text = sendText(reference, runId);

    let ended: unknown;
    const audited = await auditedDuring(async () => {
      const first = outcomeOf(await called(builder, app, lease, text));
      // Its answer lost, the same send again: the same event, at once and
      // once the run took it and ended.
      const again = outcomeOf(await called(builder, app, lease, text));
      ended = await runStatus(runId);
      const afterEnd = outcomeOf(await called(builder, app, lease, text));
      // Its key again with other data, once the run ended: another event
      // under a key already used, never the first one's ID.
      const otherData = outcomeOf(
        await called(builder, app, lease, withData(text, { jobId: "job-2" }))
      );
      expect({
        again,
        afterEnd,
        otherData,
        minted: isEvent(first),
      }).toStrictEqual({
        again: first,
        afterEnd: first,
        otherData: "workflow.event_conflict",
        minted: true,
      });
    });
    const { result: output } = await resourceRunFor(
      env,
      builder.acting,
      workflow,
      runId
    );
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS runs FROM workflow_resource_runs WHERE workflow_resource_id = ?"
    )
      .bind(workflow)
      .first<{ runs: number }>();
    // A fresh send, under a key of its own.
    const late = outcomeOf(
      await called(builder, app, lease, sendText(reference, runId))
    );
    const runs = await env.DB.prepare(
      "SELECT COUNT(*) AS runs FROM workflow_resource_runs WHERE workflow_resource_id = ?"
    )
      .bind(workflow)
      .first<{ runs: number }>();

    expect({
      sent: audited
        .filter(({ action }) => action === "workflow.event.sent")
        .map(({ actor, target, detail }) => ({
          actor,
          target,
          via: detail?.via,
          type: detail?.type,
          redelivered: detail?.redelivered,
        })),
      ended,
      output,
      late,
      runs: [before?.runs, runs?.runs],
    }).toStrictEqual({
      sent: [false, true, true].map((redelivered) => ({
        actor: { type: "person", userId: builder.userId },
        target: { type: "workflow_run", id: runId },
        via: "page",
        type: completed,
        redelivered,
      })),
      // Taken once, its source the App, release and person who sent it.
      ended: "completed",
      output: {
        status: `urn:grasp:app:${app}:version:1:person:${builder.userId} job-1`,
      },
      // An ended run takes nothing, and no send starts another.
      late: "workflow.run_ended",
      runs: [1, 1],
    });
  });

  it("refuses a send carrying any envelope field, an event the workflow doesn't declare, data its contract refuses, or a run the page doesn't show, and the run takes only the host's envelope", async () => {
    const { admin, builder, app, workflow, reference } = await invoicesApp([
      ["start"],
      ["send"],
    ]);
    const lease = await pageOf(builder, app);
    const runId = await startedRun(builder, app, lease, reference);
    const send = async (fields: Record<string, unknown>) =>
      outcomeOf(
        await called(builder, app, lease, sendText(reference, runId, fields))
      );
    const adminLease = await pageOf(admin, app);

    const refused = {
      source: await send({ source: "urn:grasp:app:forged" }),
      id: await send({ id: "evt_forged" }),
      time: await send({ time: "2020-01-01T00:00:00Z" }),
      subject: await send({ subject: "job-2" }),
      specversion: await send({ specversion: "1.0" }),
      // The event is named by its alias alone: never a type or a source.
      eventSource: await send({
        event: { alias: "jobEvents", source: "urn:grasp:app:forged" },
      }),
      eventType: await send({ type: "grasp.job.timeout" }),
      dataSource: await send({
        data: { jobId: "job-1", source: "urn:grasp:app:forged" },
      }),
      malformed: await send({ data: { jobId: 1 } }),
      unknownAlias: await send({ event: "otherEvents" }),
      noSuchRun: await send({ runId: crypto.randomUUID() }),
      anotherPerson: outcomeOf(
        await called(admin, app, adminLease, sendText(reference, runId))
      ),
    };
    const sent = isEvent(await send({}));
    await runStatus(runId);
    const { result: output } = await resourceRunFor(
      env,
      builder.acting,
      workflow,
      runId
    );

    expect({ refused, sent, output }).toStrictEqual({
      refused: {
        source: "contract.invalid_args",
        id: "contract.invalid_args",
        time: "contract.invalid_args",
        subject: "contract.invalid_args",
        specversion: "contract.invalid_args",
        eventSource: "contract.invalid_args",
        eventType: "contract.invalid_args",
        dataSource: "contract.invalid_args",
        malformed: "contract.invalid_args",
        unknownAlias: "contract.invalid_args",
        noSuchRun: "workflow.run_unavailable",
        anotherPerson: "workflow.run_unavailable",
      },
      sent: true,
      output: {
        status: `urn:grasp:app:${app}:version:1:person:${builder.userId} job-1`,
      },
    });
  });

  it("needs the App's own send grant, which its start and read grants don't imply, and refuses the next send once it is revoked", async () => {
    const { admin, builder, app, workflow, reference } = await invoicesApp([
      ["start", "read"],
    ]);
    const lease = await pageOf(builder, app);
    const first = await startedRun(builder, app, lease, reference);
    const send = async (runId: string) =>
      outcomeOf(await called(builder, app, lease, sendText(reference, runId)));

    const refusedWithout = await auditedDuring(async () => {
      await expect(send(first)).resolves.toBe("workflow.event_denied");
    });
    const grant = await granted(admin, builder, app, workflow, ["send"]);
    const accepted = sendText(reference, first);
    const withSend = outcomeOf(await called(builder, app, lease, accepted));
    const second = await startedRun(builder, app, lease, reference, "job-2");
    await revokePermission(env, admin.acting, grant);
    const refusedRevoked = await auditedDuring(async () => {
      await expect(send(second)).resolves.toBe("workflow.event_denied");
    });
    // A send the run took before the revocation, its answer lost: still
    // the event it was.
    const resent = outcomeOf(await called(builder, app, lease, accepted));
    const resentOther = outcomeOf(
      await called(builder, app, lease, withData(accepted, { jobId: "job-9" }))
    );

    expect({
      withSend: isEvent(withSend),
      resent,
      resentOther,
      // Every refused send is recorded with why, as every taken one is.
      refused: [refusals(refusedWithout), refusals(refusedRevoked)],
    }).toStrictEqual({
      withSend: true,
      resent: withSend,
      resentOther: "workflow.event_conflict",
      refused: [first, second].map((runId) => [
        {
          actor: { type: "person", userId: builder.userId },
          target: { type: "workflow_run", id: runId },
          code: "workflow.event_denied",
          via: "page",
        },
      ]),
    });
  });

  it("pushes a page following a run that it may send it nothing once the App is restricted", async () => {
    const { builder, app, reference } = await invoicesApp([
      ["start"],
      ["send"],
    ]);
    const lease = await pageOf(builder, app);
    const runId = await startedRun(builder, app, lease, reference);
    // The run's `run` query, live on the page, as `useWorkflow` follows it:
    // whether each push says its event may be sent.
    const pushed: (boolean | undefined)[] = [];
    const callback = Object.assign(
      (push: unknown): void => {
        const { result } = z
          .object({ result: z.object({ value: z.unknown() }) })
          .parse(push);
        const snapshot = z
          .object({ waits: z.array(z.object({ canSend: z.boolean() })) })
          .safeParse(result.value);
        pushed.push(snapshot.data?.waits[0]?.canSend);
      },
      {
        [Symbol.dispose]: (): void => {
          // Let go of: nothing more arrives.
        },
      }
    );
    const subscription = await builder.api.pages
      .frame(app, lease)
      .watchQuery(queryCall(reference, "run", { runId }), callback);
    await vi.waitFor(() => {
      expect(pushed.at(-1)).toBeTruthy();
    }, settles);
    await appHost(env, appIdSchema.parse(app)).restrict();
    // Pushed again, never left to the page's next read.
    await vi.waitFor(() => {
      expect(pushed.at(-1)).toBeFalsy();
    }, settles);
    await subscription.release();

    expect({ first: pushed[0], last: pushed.at(-1) }).toStrictEqual({
      first: true,
      last: false,
    });
  });

  it("sends nothing from an App in restricted mode to a run that isn't restricted, and sends to one started restricted", async () => {
    const { builder, app, reference } = await invoicesApp([
      ["start"],
      ["send"],
    ]);
    const lease = await pageOf(builder, app);
    const before = await startedRun(builder, app, lease, reference);
    await appHost(env, appIdSchema.parse(app)).restrict();
    const after = await startedRun(builder, app, lease, reference, "job-2");
    const send = async (runId: string) =>
      outcomeOf(await called(builder, app, lease, sendText(reference, runId)));

    // What each run's snapshot says of sending it its event: as a send
    // goes, once the run waits for it.
    const canSend = async (runId: string) =>
      await vi.waitFor(
        async () => {
          const snapshot = await snapshotOf(
            builder,
            app,
            lease,
            reference,
            runId
          );
          const [wait] = z
            .object({ waits: z.array(z.object({ canSend: z.boolean() })) })
            .parse(snapshot).waits;
          expect(wait).toBeDefined();
          return wait?.canSend;
        },
        { timeout: 30_000, interval: 100 }
      );
    // Read before sending: the event a send delivers ends the wait.
    const shown = {
      unrestrictedRun: await canSend(before),
      restrictedRun: await canSend(after),
    };

    expect({
      unrestrictedRun: await send(before),
      restrictedRun: isEvent(await send(after)),
      shown,
    }).toStrictEqual({
      unrestrictedRun: "permission.restricted",
      restrictedRun: true,
      shown: { unrestrictedRun: false, restrictedRun: true },
    });
  });

  it("shows a run's event wait only for an event its release declares, and a page follows a run another App version started only when that version declared the same workflow", async () => {
    const { admin, builder, fixture, app, grants, reference } =
      await invoicesApp([["start"], ["send"]]);
    /**
     * Makes version `version` of the App, declaring `declares` of `review`,
     * the one that runs, its grants, asked for again, granted for it: a
     * page opened now is of it.
     */
    const current = async (version: number, declares: string) => {
      await commitDefined(
        env,
        builder.acting,
        app,
        files(declares),
        `Version ${version}`
      );
      await seal(fixture, version);
      await publishVersion(env, builder.acting, app, version);
      for (const grant of grants) {
        // oxlint-disable-next-line no-await-in-loop -- one grant after the other
        await grantPermission(env, admin.acting, grant, { version });
      }
      return await pageOf(builder, app);
    };
    /** What a page's `run` query shows of run `runId`'s waits, or its refusal. */
    const waitsOn = async (lease: string, runId: string): Promise<unknown> => {
      const snapshot = await snapshotOf(builder, app, lease, reference, runId);
      const read = z
        .object({
          waits: z.array(
            z.looseObject({ kind: z.string(), event: z.unknown().optional() })
          ),
        })
        .safeParse(snapshot);
      return read.success
        ? read.data.waits.map(({ kind, event }) => ({ kind, event }))
        : snapshot;
    };
    const firstLease = await pageOf(builder, app);
    const firstRun = await startedRun(builder, app, firstLease, reference);
    const first = await waitsOn(firstLease, firstRun);

    // Version 2 declares the workflow without its event: its pages type
    // no event, so they follow no run version 1 started, and show no
    // event wait in a run of their own.
    const secondLease = await current(2, "");
    const secondRun = await startedRun(
      builder,
      app,
      secondLease,
      reference,
      "job-2"
    );
    const second = {
      ownRun: await waitsOn(secondLease, secondRun),
      firstVersionsRun: await waitsOn(secondLease, firstRun),
    };

    // Version 3 declares it as version 1 did: it follows version 1's run.
    const thirdLease = await current(3, declaresJobEvents);
    const third = {
      firstVersionsRun: await waitsOn(thirdLease, firstRun),
      secondVersionsRun: await waitsOn(thirdLease, secondRun),
    };

    const eventWait = {
      kind: "event",
      event: { kind: "workflowEvent", alias: "jobEvents" },
    };
    expect({ first, second, third }).toStrictEqual({
      first: [eventWait],
      // A run of another contract: not shown, as a run that doesn't exist.
      second: { ownRun: [], firstVersionsRun: null },
      third: { firstVersionsRun: [eventWait], secondVersionsRun: null },
    });
  });
});
