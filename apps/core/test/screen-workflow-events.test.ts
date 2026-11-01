/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import {
  declaredWorkflows,
  eventFingerprint,
  GraspClient,
  readWorkflowReference,
  workflowChannel,
  workflowFingerprint,
} from "@grasp-os/sdk/host";
import type { ClientTransport } from "@grasp-os/sdk/host";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import {
  appFunctionPath,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appFor, setCurrentVersion } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { appHost } from "../src/durable-objects.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { readWorkflowWatch } from "../src/screen-workflows.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { mockIdp } from "./idp.ts";
import { liveStatus } from "./runs.ts";
import { appWith, seal } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { auditedDuring, routed, signedInApi, unique } from "./sign-in.ts";

// A screen's typed `send` (spec 10.4.6; screen-workflows.ts, and the run
// inbox it admits to, workflows/run-events.ts) through the real host, from
// its threat model: only a run the screen shows takes a send, through an
// event its release declares, with data its contract takes, under the
// App's own `send` grant, which `start` doesn't imply; the host mints the
// envelope, and a request carrying any of it is refused; each call is one
// event and a resend under its key the same one; an ended run takes none,
// and no send starts a run.

const idp = mockIdp();

const files = (): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  invoices: defineTable({ amount: v.number() }),
});
`,
  "operations/invoices.ts": `import { resource, v } from "@grasp-os/sdk";

export const review = resource.workflow("review", {
  input: v.object({ jobId: v.string() }),
  output: v.object({ status: v.string() }),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { review } from "./operations/invoices.ts";
import schema from "./schema.ts";

export default app({
  name: "Invoices",
  schema,
  access: { tables: { invoices: { read: "appMembers", write: "appMembers" } } },
  operations: {},
  screens: [{ name: "desk", path: "/", source: "screens/desk.tsx" }],
  uses: [review],
});
`,
  "screens/desk.tsx": `export default function Desk() {
  return <main>Invoices</main>;
}
`,
});

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

const completed = "grasp.job.completed";

/** A job's events: the completion a screen sends, and a timeout it doesn't. */
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
 * A workflow waiting, in `await-job`, for its job's completion through
 * `jobEvents`, then ending with the event's source and job.
 */
const definitionOf = (name: string, contract: string): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
          params: {},
          bindings: { jobEvents: { kind: "event", contract } },
        },
      },
    },
    input: { schema: objectSchema({ jobId: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      {
        "await-job": {
          listen: {
            to: {
              one: { with: { type: completed } },
            },
            read: "envelope",
          },
          timeout: { after: { hours: 1 } },
          metadata: { grasp: { binding: "jobEvents" } },
        },
      },
      {
        finish: {
          set: { status: '${ .[0].source + " " + .[0].data.jobId }' },
        },
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

/** The reference to `alias` as `#grasp` generates it from `release`. */
const workflowReference = async (release: Release, alias: string) => {
  const declared = declaredWorkflows(release.app, release.workflows).find(
    (workflow) => workflow.alias === alias
  );
  if (declared === undefined) {
    throw new Error(`No workflow ${alias}`);
  }
  const identity = {
    resourceId: release.manifest.resourceId,
    resourceVersion: release.manifest.resourceVersion,
  };
  const contractId = `workflows.${alias}`;
  const fingerprint = await workflowFingerprint(declared);
  const events: Record<string, unknown> = {};
  for (const [name, event] of Object.entries(declared.events)) {
    events[name] = {
      kind: "workflowEvent",
      ...identity,
      workflow: contractId,
      workflowFingerprint: fingerprint,
      alias: name,
      type: event.type,
      // oxlint-disable-next-line no-await-in-loop -- one event
      fingerprint: await eventFingerprint(event),
      data: event.data,
    };
  }
  return {
    kind: "workflow",
    visibility: "public",
    ...identity,
    alias,
    contractId,
    fingerprint,
    input: declared.input,
    output: declared.output,
    events,
    listens: declared.listens,
    decisions: {},
  };
};

type Reference = Awaited<ReturnType<typeof workflowReference>>;

/** A reference as the SDK sends it. */
const wireOf = (reference: Reference) => ({
  resourceId: reference.resourceId,
  resourceVersion: reference.resourceVersion,
  contractId: reference.contractId,
  fingerprint: reference.fingerprint,
  kind: "workflow",
});

/** What a send names of `jobEvents`, as the SDK sends it. */
const eventOf = (reference: Reference) =>
  z
    .object({ alias: z.string(), type: z.string(), fingerprint: z.string() })
    .parse(reference.events.jobEvents);

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
 * The Invoices App sealed and current, its screen approved, `review` bound
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
    definition: definitionOf(workflow.name, contract),
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
  await setCurrentVersion(env, builder.acting, fixture.app, 1);
  const grants: string[] = [];
  for (const each of actions) {
    // oxlint-disable-next-line no-await-in-loop -- one grant after the other
    grants.push(await granted(admin, builder, fixture.app, workflow.id, each));
  }
  const review = await admin.api.screenTrust.review(fixture.app);
  await admin.api.screenTrust.approve(fixture.app, {
    version: review.version,
    generation: review.generation,
    artifacts: builtArtifacts(review.screens),
  });
  const release = await loadRelease(env, fixture.app, 1);
  return {
    admin,
    builder,
    app: fixture.app,
    workflow: workflow.id,
    grants,
    reference: await workflowReference(release, "review"),
  };
};

/** A screen of `person`'s on the App, opened: its frame's lease. */
const screenOf = async (person: Person, app: string): Promise<string> => {
  const { lease } = await person.api.screens.open(app, "desk");
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
      [screenLeaseHeader]: lease,
      [screenPersonHeader]: person.userId,
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

/** A session client of `person`'s screen: its calls over core's route. */
const screenClient = (
  person: Person,
  app: string,
  lease: string
): GraspClient => {
  const transport: ClientTransport = {
    call: async (request) => await called(person, app, lease, request),
    watch: () => {
      throw new Error("A send follows nothing.");
    },
  };
  return new GraspClient(transport);
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

/** A fresh command key, as the SDK makes one. */
const keyOf = (): string => crypto.randomUUID().replaceAll("-", "");

/** The code `work` was refused with, or "ok". */
const refusalOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return "ok";
  } catch (error) {
    const code: unknown =
      error instanceof Error ? Reflect.get(error, "code") : error;
    return code;
  }
};

/** Starts a run of `review` on job `jobId` from `person`'s screen: its ID. */
const startedRun = async (
  person: Person,
  app: string,
  lease: string,
  reference: Reference,
  jobId = "job-1"
): Promise<string> => {
  const handle = await workflowChannel(screenClient(person, app, lease)).start(
    readWorkflowReference(reference),
    { jobId }
  );
  await vi.waitFor(
    async () => {
      await expect(liveStatus(handle.runId)).resolves.toBe("waiting");
    },
    { timeout: 30_000, interval: 100 }
  );
  return handle.runId;
};

/** A raw send's text: `fields` over a well-formed one's. */
const sendText = (
  reference: Reference,
  runId: string,
  fields: Record<string, unknown> = {}
): string =>
  JSON.stringify({
    workflow: wireOf(reference),
    command: "send",
    runId,
    event: eventOf(reference),
    data: { jobId: "job-1" },
    idempotencyKey: keyOf(),
    ...fields,
  });

/** A raw send's text `text`, under its key, with `data` instead. */
const withData = (text: string, data: unknown): string =>
  JSON.stringify({
    ...z.record(z.string(), z.unknown()).parse(JSON.parse(text)),
    data,
  });

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

describe("a screen's typed send", { timeout: 180_000 }, () => {
  it("delivers one event per call to the run it shows, with the host's source, the same event for a resend under its key, and none once the run ended", async () => {
    const { builder, app, workflow, reference } = await invoicesApp([
      ["start"],
      ["send"],
    ]);
    const lease = await screenOf(builder, app);
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
    const { output } = await resourceRunFor(
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
    const late = await refusalOf(
      workflowChannel(screenClient(builder, app, lease)).send(
        readWorkflowReference(reference),
        runId,
        reference.events.jobEvents,
        { jobId: "job-1" }
      )
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
        via: "screen",
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

  it("refuses a send carrying any envelope field, a made-up or stale event, data its contract refuses, or a run the screen doesn't show, and the run takes only the host's envelope", async () => {
    const { admin, builder, app, workflow, reference } = await invoicesApp([
      ["start"],
      ["send"],
    ]);
    const lease = await screenOf(builder, app);
    const runId = await startedRun(builder, app, lease, reference);
    const event = eventOf(reference);
    const send = async (fields: Record<string, unknown>) =>
      outcomeOf(
        await called(builder, app, lease, sendText(reference, runId, fields))
      );
    const adminLease = await screenOf(admin, app);

    const refused = {
      source: await send({ source: "urn:grasp:app:forged" }),
      id: await send({ id: "evt_forged" }),
      time: await send({ time: "2020-01-01T00:00:00Z" }),
      subject: await send({ subject: "job-2" }),
      specversion: await send({ specversion: "1.0" }),
      eventSource: await send({
        event: { ...event, source: "urn:grasp:app:forged" },
      }),
      dataSource: await send({
        data: { jobId: "job-1", source: "urn:grasp:app:forged" },
      }),
      malformed: await send({ data: { jobId: 1 } }),
      fingerprint: await send({
        event: { ...event, fingerprint: "0".repeat(64) },
      }),
      notBrowser: await send({
        event: { ...event, type: "grasp.job.timeout" },
      }),
      unknownAlias: await send({ event: { ...event, alias: "otherEvents" } }),
      noSuchRun: await send({ runId: crypto.randomUUID() }),
      anotherPerson: outcomeOf(
        await called(admin, app, adminLease, sendText(reference, runId))
      ),
      // The SDK refuses a reference that isn't one of the workflow's own
      // before anything is sent.
      madeUp: await refusalOf(
        workflowChannel(screenClient(builder, app, lease)).send(
          readWorkflowReference(reference),
          runId,
          {
            ...z
              .record(z.string(), z.unknown())
              .parse(reference.events.jobEvents),
            type: "grasp.job.timeout",
          },
          { jobId: "job-1" }
        )
      ),
    };
    const sent = isEvent(await send({}));
    await runStatus(runId);
    const { output } = await resourceRunFor(
      env,
      builder.acting,
      workflow,
      runId
    );

    expect({ refused, sent, output }).toStrictEqual({
      refused: {
        source: "contract.invalid_request",
        id: "contract.invalid_request",
        time: "contract.invalid_request",
        subject: "contract.invalid_request",
        specversion: "contract.invalid_request",
        eventSource: "contract.invalid_request",
        dataSource: "contract.invalid_args",
        malformed: "contract.invalid_args",
        fingerprint: "version.mismatch",
        notBrowser: "version.mismatch",
        unknownAlias: "operation.not_found",
        noSuchRun: "workflow.run_unavailable",
        anotherPerson: "workflow.run_unavailable",
        madeUp: "contract.invalid_request",
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
    const lease = await screenOf(builder, app);
    const first = await startedRun(builder, app, lease, reference);
    const send = async (runId: string) =>
      outcomeOf(await called(builder, app, lease, sendText(reference, runId)));

    const withoutSend = await send(first);
    const grant = await granted(admin, builder, app, workflow, ["send"]);
    const accepted = sendText(reference, first);
    const withSend = outcomeOf(await called(builder, app, lease, accepted));
    const second = await startedRun(builder, app, lease, reference, "job-2");
    await revokePermission(env, admin.acting, grant);
    const revoked = await send(second);
    // A send the run took before the revocation, its answer lost: still
    // the event it was.
    const resent = outcomeOf(await called(builder, app, lease, accepted));
    const resentOther = outcomeOf(
      await called(builder, app, lease, withData(accepted, { jobId: "job-9" }))
    );

    expect({
      withoutSend,
      withSend: isEvent(withSend),
      revoked,
      resent,
      resentOther,
    }).toStrictEqual({
      withoutSend: "workflow.event_denied",
      withSend: true,
      revoked: "workflow.event_denied",
      resent: withSend,
      resentOther: "workflow.event_conflict",
    });
  });

  it("shows a screen following a run that it may send it nothing once the App is restricted, under a revision of its own", async () => {
    const { builder, app, reference } = await invoicesApp([
      ["start"],
      ["send"],
    ]);
    const lease = await screenOf(builder, app);
    const runId = await startedRun(builder, app, lease, reference);
    /** The run's snapshot as its screen follows it, once it waits. */
    const followed = async () =>
      await vi.waitFor(
        async () => {
          const { value, revision } = await readWorkflowWatch(
            env,
            builder.acting,
            app,
            {
              workflow: { ...wireOf(reference), kind: "workflow" },
              watch: "run",
              runId,
            }
          );
          const [wait] = z
            .object({ waits: z.array(z.object({ canSend: z.boolean() })) })
            .parse(value).waits;
          expect(wait).toBeDefined();
          return { canSend: wait?.canSend, revision };
        },
        { timeout: 30_000, interval: 100 }
      );
    const open = await followed();
    await appHost(env, appIdSchema.parse(app)).restrict();
    const restricted = await followed();

    expect({
      open: open.canSend,
      restricted: restricted.canSend,
      // A revision of its own: pushed to the screen, never the same one.
      movedOn: (restricted.revision ?? 0) > (open.revision ?? 0),
    }).toStrictEqual({ open: true, restricted: false, movedOn: true });
  });

  it("sends nothing from an App in restricted mode to a run that isn't restricted, and sends to one started restricted", async () => {
    const { builder, app, reference } = await invoicesApp([
      ["start"],
      ["send"],
    ]);
    const lease = await screenOf(builder, app);
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
          const { value: snapshot } = await readWorkflowWatch(
            env,
            builder.acting,
            app,
            {
              workflow: { ...wireOf(reference), kind: "workflow" },
              watch: "run",
              runId,
            }
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
});
