/* oxlint-disable no-template-curly-in-string -- workflow expressions, and text that looks like one, are written as ${ … } strings */
import {
  connectionIdSchema,
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { createTriggerResource } from "../src/trigger-resources.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import {
  deliverConnectorEvent,
  listenersOf,
} from "../src/workflows/connector-events.ts";
import { maxHeldMs } from "../src/workflows/connector-triggers.ts";
import { stampedMail } from "../src/workflows/mail-stamps.ts";
import {
  resourceRunFor,
  terminateResourceRun,
} from "../src/workflows/resource-runs.ts";
import { triggeredRunsPerHour } from "../src/workflows/runs.ts";
import { allEvents } from "./audit-events.ts";
import { outcome, unique } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// Connector triggers (workflows/connector-triggers.ts), from their threat
// model: an event starts each trigger that takes it once, however often
// it is delivered, and a run cancelled since stays cancelled; only a
// trigger of the event's connection, type and part, granted to hear it,
// takes it; its input is a mapping of JSON Pointers and literals, never
// code; a revoked grant to hear starts nothing, and a refusal for good is
// audited; a connection its creator may not use, and a grant on any
// connection but its own, are refused; and connect listens where it does.

const person = async (role: Role): Promise<Identity> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return {
    userId,
    email: `${userId}@acme.test`,
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
};

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A workflow of `admin`'s taking `{ subject, folder }` and handing it back. */
const filing = async (admin: Identity) => {
  const workflow = await createWorkflowResource(env, admin, `file-${unique()}`);
  const fields = { subject: { type: "string" }, folder: { type: "string" } };
  await publishWorkflowVersion(env, admin, workflow.id, {
    definition: JSON.stringify({
      document: {
        dsl: "1.0.3",
        namespace: workflowNamespace,
        name: workflow.name,
        version: "1.0.0",
        title: workflow.name,
        metadata: {
          grasp: {
            profile: "grasp-open-workflow/1",
            params: {},
            bindings: {},
          },
        },
      },
      input: { schema: objectSchema(fields) },
      output: { schema: objectSchema(fields) },
      do: [
        {
          finish: {
            set: {
              subject: "${ $workflow.input.subject }",
              folder: "${ $workflow.input.folder }",
            },
          },
        },
      ],
    }),
    basedOn: null,
  });
  return workflow;
};

/** A mail connection in connect's registry: shared, or `owner`'s own. */
const connection = async ({
  owner,
  status = "active",
  account = `watched-${unique()}@acme.test`,
}: {
  owner?: string;
  status?: string;
  account?: string;
} = {}): Promise<string> => {
  const id = `connection-${unique()}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, tools, account_name, account_email, created_at, updated_at) VALUES (?, 'microsoft', ?, ?, ?, 'native', 'microsoft-365', '[]', ?, ?, ?, ?)"
    )
    .bind(
      id,
      owner === undefined ? "shared" : "personal",
      owner ?? null,
      status,
      account,
      account,
      now,
      now
    )
    .run();
  return id;
};

/** The account a connection `connection()` made is of. */
const accountOf = async (connectionId: string): Promise<string> => {
  const row = await connectDb()
    .prepare("SELECT account_email AS email FROM connections WHERE id = ?")
    .bind(connectionId)
    .first<{ email: string }>();
  return row?.email ?? "";
};

/**
 * The stamp of mail run `run` (an independent workflow's, or an App's)
 * sends from `mailbox` to it, through `connectionId`, as its step's call
 * records it (mail-stamps.ts).
 */
const mailFrom = async (
  run: string,
  kind: "app" | "resource",
  connectionId: string,
  mailbox: string
): Promise<string> => {
  const { stamp } = await stampedMail(
    env,
    { run, stepKey: `step-${unique()}`, kind },
    {
      connectionId,
      action: "mail.send",
      input: { mailbox, to: [mailbox], subject: "Again", body: "Again." },
    }
  );
  if (stamp === undefined) {
    throw new Error("Expected the mail stamped");
  }
  return stamp;
};

/** `request`, asked for and granted by `admin`: the permission's ID. */
const granted = async (
  admin: Identity,
  request: Omit<PermissionRequest, "binding">
): Promise<string> => {
  const { id } = await requestPermission(
    env,
    admin,
    {
      ...request,
      binding: `GRANT_${unique().toUpperCase().replaceAll("-", "_")}`,
    },
    {
      app: () => {
        throw new Error("No App here");
      },
      resource: async (ref, needed) => {
        await requireResourceRole(env, admin, ref, needed);
      },
    }
  );
  await grantPermission(env, admin, id, { version: null });
  return id;
};

const mapping = {
  fields: { subject: "/payload/subject", folder: "/payload/folder" },
  defaults: { folder: "inbox" },
};

/**
 * A connector trigger of `owner`'s on workflow `id`, on mail received at
 * `connectionId` (in `resource`, when given), granted by `admin` to start
 * the workflow and to hear the connection unless told otherwise.
 */
const connectorTrigger = async (
  admin: Identity,
  id: string,
  connectionId: string,
  {
    owner = admin,
    resource,
    hears = true,
  }: { owner?: Identity; resource?: string; hears?: boolean } = {}
) => {
  const trigger = await createTriggerResource(env, owner, {
    kind: "connector",
    workflowId: id,
    version: 1,
    config: {
      connection: {
        connectionId,
        ...(resource === undefined ? {} : { resource }),
      },
      event: "m365.mail.received",
      input: mapping,
    },
  });
  const subject = {
    type: "trigger",
    triggerId: triggerIdSchema.parse(trigger.id),
  } as const;
  const start = await granted(admin, {
    subject,
    object: {
      type: "workflow",
      workflowId: workflowResourceIdSchema.parse(id),
    },
    actions: ["start"],
  });
  const hear = hears
    ? await granted(admin, {
        subject,
        object: {
          type: "connection",
          connectionId: connectionIdSchema.parse(connectionId),
          ...(resource === undefined ? {} : { resource }),
        },
        actions: ["mail.list"],
      })
    : undefined;
  return { ...trigger, start, hear };
};

/** A mail event at `connectionId`, as connect reports it. */
const mailEvent = (
  connectionId: string,
  changes: {
    id?: string;
    type?: string;
    resource?: string;
    owner?: string;
    payload?: unknown;
    stamp?: string;
  } = {}
) => ({
  id: changes.id ?? crypto.randomUUID(),
  connection: connectionId,
  owner: changes.owner ?? null,
  ...(changes.resource === undefined ? {} : { resource: changes.resource }),
  ...(changes.stamp === undefined ? {} : { stamp: changes.stamp }),
  action: "mail.list",
  type: changes.type ?? "m365.mail.received",
  payload: changes.payload ?? { subject: "Invoice INV-7", folder: "archive" },
});

/** The runs trigger `trigger` started, with each one's key. */
const runsOf = async (trigger: string) => {
  const rows = await env.DB.prepare(
    "SELECT run.id, receipt.idempotency_key AS key, receipt.input FROM workflow_resource_runs AS run JOIN workflow_start_receipts AS receipt ON receipt.id = run.id WHERE receipt.invoker_type = 'trigger' AND receipt.invoker_id = ? ORDER BY receipt.created_at"
  )
    .bind(trigger)
    .all<{ id: string; key: string; input: string | null }>();
  return rows.results;
};

/** Fills the hour of the trigger whose receipt `receipt` is: copies of it, each under a key of its own. */
const fillHour = async (receipt: string): Promise<void> => {
  const columns = await env.DB.prepare(
    "SELECT name FROM pragma_table_info('workflow_start_receipts')"
  ).all<{ name: string }>();
  const names = columns.results.map(({ name }) => name);
  const copied = names.map((name) => {
    if (name === "id") {
      return "?1";
    }
    return name === "idempotency_key" ? "?2" : name;
  });
  await env.DB.batch(
    Array.from({ length: triggeredRunsPerHour }, () =>
      env.DB.prepare(
        `INSERT INTO workflow_start_receipts (${names.join(", ")}) SELECT ${copied.join(", ")} FROM workflow_start_receipts WHERE id = ?3`
      ).bind(crypto.randomUUID(), `filler-${unique()}`, receipt)
    )
  );
};

/** Each policy a test sets, under a generation higher than any before. */
let generations = 3000;

/** The limits the tests' deployment sets (vite.config.ts). */
const configuredLimits = quotaLimitsSchema.parse(env.QUOTA_LIMITS).limits;

describe("connector triggers", { timeout: 120_000 }, () => {
  it("start one run per event with the mapped input, however often it is delivered, and never again once cancelled", async () => {
    const admin = await person("admin");
    const workflow = await filing(admin);
    const shared = await connection();
    const trigger = await connectorTrigger(admin, workflow.id, shared);
    const event = mailEvent(shared);

    const first = await deliverConnectorEvent(env, event);
    const again = await deliverConnectorEvent(env, event);
    const [started] = await runsOf(trigger.id);
    const run = await vi.waitFor(
      async () => {
        const found = await resourceRunFor(
          env,
          admin,
          workflow.id,
          started?.id
        );
        expect(found.endedAt).not.toBeNull();
        return found;
      },
      { timeout: 30_000, interval: 100 }
    );
    // A second event without a folder: the default fills it. Its run is
    // cancelled, then the event delivered again.
    const second = mailEvent(shared, { payload: { subject: "Order 12" } });
    await deliverConnectorEvent(env, second);
    const [, secondRun] = await runsOf(trigger.id);
    await terminateResourceRun(env, admin, workflow.id, secondRun?.id);
    await deliverConnectorEvent(env, second);
    const runs = await runsOf(trigger.id);
    const cancelled = await resourceRunFor(
      env,
      admin,
      workflow.id,
      secondRun?.id
    );

    expect({
      first,
      again,
      output: run.output,
      keys: runs.map(({ key }) =>
        /^grasp:connector:[\w-]+:[0-9a-f]{64}$/u.test(key)
      ),
      inputs: runs.map(({ input }): unknown => JSON.parse(input ?? "null")),
      cancelled: cancelled.status,
    }).toStrictEqual({
      first: { runs: 1 },
      again: { runs: 1 },
      output: { subject: "Invoice INV-7", folder: "archive" },
      keys: [true, true],
      inputs: [
        { subject: "Invoice INV-7", folder: "archive" },
        { subject: "Order 12", folder: "inbox" },
      ],
      cancelled: "cancelled",
    });
  });

  it("reach only triggers of the event's connection, type and part, granted to hear it", async () => {
    const admin = await person("admin");
    const workflow = await filing(admin);
    const shared = await connection();
    const other = await connection();
    const ofOther = await connectorTrigger(admin, workflow.id, other);
    const mailbox = await connectorTrigger(admin, workflow.id, shared, {
      resource: "mailbox-ben",
    });
    const deaf = await connectorTrigger(admin, workflow.id, shared, {
      hears: false,
    });
    const whole = await connectorTrigger(admin, workflow.id, shared);

    await deliverConnectorEvent(env, mailEvent(shared));
    await deliverConnectorEvent(
      env,
      mailEvent(shared, { type: "m365.file.created" })
    );
    await deliverConnectorEvent(
      env,
      mailEvent(shared, { resource: "mailbox-ann" })
    );
    const counts = await Promise.all(
      [ofOther, mailbox, deaf, whole].map(async ({ id }) => {
        const runs = await runsOf(id);
        return runs.length;
      })
    );

    expect(counts).toStrictEqual([0, 0, 0, 1]);
  });

  it("hear a personal connection only for its owner, who alone may make one on it", async () => {
    const admin = await person("admin");
    const ann = await person("builder");
    const workflow = await filing(admin);
    const annsMail = await connection({ owner: ann.userId });
    const gone = await connection({ status: "disconnected" });

    const create = async (connectionId: string) =>
      await outcome(
        createTriggerResource(env, admin, {
          kind: "connector",
          workflowId: workflow.id,
          version: 1,
          config: {
            connection: { connectionId },
            event: "m365.mail.received",
            input: mapping,
          },
        })
      );

    expect({
      notTheirs: await create(annsMail),
      disconnected: await create(gone),
      unknown: await create(`connection-${unique()}`),
    }).toStrictEqual({
      notTheirs: "workflow.resource_invalid",
      disconnected: "workflow.resource_invalid",
      unknown: "workflow.resource_invalid",
    });
  });

  it("build their input from pointers and literals, never code", async () => {
    const admin = await person("admin");
    const workflow = await filing(admin);
    const shared = await connection();
    const trigger = await connectorTrigger(admin, workflow.id, shared);
    const create = async (input: unknown) =>
      await outcome(
        createTriggerResource(env, admin, {
          kind: "connector",
          workflowId: workflow.id,
          version: 1,
          config: {
            connection: { connectionId: shared },
            event: "m365.mail.received",
            input,
          },
        })
      );
    const expression = "${ $secrets }";

    await deliverConnectorEvent(
      env,
      mailEvent(shared, {
        payload: { subject: expression, folder: "{{ env.KEY }}" },
      })
    );
    const [run] = await runsOf(trigger.id);

    expect({
      expressionField: await create({ fields: { subject: expression } }),
      jqField: await create({ fields: { subject: ".payload.subject" } }),
      otherKey: await create({ fields: {}, defaults: {}, eval: "1" }),
      eventKind: await outcome(
        createTriggerResource(env, admin, {
          kind: "connector",
          workflowId: workflow.id,
          version: 1,
          config: {
            connection: { connectionId: shared },
            event: "m365.anything",
            input: mapping,
          },
        })
      ),
      // What the event says is data: taken as it is.
      input: z.json().parse(JSON.parse(run?.input ?? "null")),
    }).toStrictEqual({
      expressionField: "workflow.resource_invalid",
      jqField: "workflow.resource_invalid",
      otherKey: "workflow.resource_invalid",
      eventKind: "workflow.resource_invalid",
      input: { subject: expression, folder: "{{ env.KEY }}" },
    });
  });

  it("start nothing once a grant to hear is revoked, and audit a start refused for good", async () => {
    const admin = await person("admin");
    const workflow = await filing(admin);
    const shared = await connection();
    const deafened = await connectorTrigger(admin, workflow.id, shared);
    const unstartable = await connectorTrigger(admin, workflow.id, shared);
    await revokePermission(env, admin, deafened.hear);
    await revokePermission(env, admin, unstartable.start);

    const delivered = await deliverConnectorEvent(env, mailEvent(shared));
    const deafenedRuns = await runsOf(deafened.id);
    const unstartableRuns = await runsOf(unstartable.id);
    const logged = await allEvents();
    const refusals = logged.filter(
      ({ action, target }) =>
        action === "workflow.event.refused" &&
        (target?.id === deafened.id || target?.id === unstartable.id)
    );

    expect({
      delivered,
      runs: [deafenedRuns.length, unstartableRuns.length],
      refusals: refusals.map(({ target, detail }) => ({
        trigger: target?.id,
        detail,
      })),
    }).toStrictEqual({
      delivered: { runs: 0 },
      runs: [0, 0],
      refusals: [
        {
          trigger: unstartable.id,
          detail: {
            event: "m365.mail.received",
            version: 1,
            code: "workflow.start_denied",
          },
        },
      ],
    });
  });

  it("start at most the hourly limit of runs, the rest delivered again later", async () => {
    const admin = await person("admin");
    const workflow = await filing(admin);
    const shared = await connection();
    const trigger = await connectorTrigger(admin, workflow.id, shared);
    await deliverConnectorEvent(env, mailEvent(shared));
    const [started] = await runsOf(trigger.id);
    await fillHour(started?.id ?? "");
    const logged = vi.spyOn(console, "warn").mockReturnValue();

    const over = await outcome(deliverConnectorEvent(env, mailEvent(shared)));
    logged.mockRestore();
    const runs = await runsOf(trigger.id);

    expect({ over: over === "ok", runs: runs.length }).toStrictEqual({
      over: false,
      runs: 1,
    });
  });

  it("end a workflow mailing its own watched mailbox at its lineage's limit, each run under the last", async () => {
    const admin = await person("admin");
    const workflow = await filing(admin);
    const shared = await connection();
    const mailbox = await accountOf(shared);
    const trigger = await connectorTrigger(admin, workflow.id, shared);
    generations += 1;
    env.QUOTA_LIMITS = {
      generation: generations,
      limits: { workflowNestingLevels: 3 },
    };
    try {
      // Mail from outside: a root.
      await deliverConnectorEvent(env, mailEvent(shared));
      // Each new run mails the mailbox again; its copy arrives stamped.
      let mailed = 0;
      for (let hop = 0; hop < 5; hop += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one hop after another
        const runs = await runsOf(trigger.id);
        const last = runs.at(-1);
        if (last === undefined || runs.length === mailed) {
          break;
        }
        mailed = runs.length;
        // oxlint-disable-next-line no-await-in-loop -- one hop after another
        const stamp = await mailFrom(last.id, "resource", shared, mailbox);
        // oxlint-disable-next-line no-await-in-loop -- one hop after another
        await deliverConnectorEvent(
          env,
          mailEvent(shared, {
            stamp,
            payload: {
              subject: "Again",
              folder: "inbox",
              from: { address: mailbox },
            },
          })
        );
      }
    } finally {
      generations += 1;
      env.QUOTA_LIMITS = { generation: generations, limits: configuredLimits };
    }
    const lineage = await env.DB.prepare(
      "SELECT run.depth, run.root_run_id AS root FROM workflow_resource_runs AS run JOIN workflow_start_receipts AS receipt ON receipt.id = run.id WHERE receipt.invoker_id = ? ORDER BY run.depth"
    )
      .bind(trigger.id)
      .all<{ depth: number; root: string | null }>();
    const [first] = lineage.results;
    const logged = await allEvents();
    const refused = logged.filter(
      ({ action, target }) =>
        action === "workflow.event.refused" && target?.id === trigger.id
    );

    expect({
      depths: lineage.results.map(({ depth }) => depth),
      oneLineage: lineage.results
        .slice(1)
        .every(
          ({ root }) => root !== null && root === lineage.results[1]?.root
        ),
      rootFirst: first?.depth,
      refused: refused.map(({ detail }) => detail.code),
    }).toStrictEqual({
      // The root, then two levels under it: the third is past the limit.
      depths: [0, 1, 2],
      oneLineage: true,
      rootFirst: 0,
      refused: ["workflow.lineage_limit"],
    });
  });

  it("refuse an App run's own mail, audited, rather than start it as a new root", async () => {
    const admin = await person("admin");
    const workflow = await filing(admin);
    const shared = await connection();
    const mailbox = await accountOf(shared);
    const trigger = await connectorTrigger(admin, workflow.id, shared);
    // An App's run that mails the trigger's mailbox (the App, in turn,
    // watching the mailbox the trigger's workflow mails).
    const app = `app-${unique()}`;
    const appRun = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Echo', '', ?, ?)"
      ).bind(app, admin.userId, Date.now()),
      env.DB.prepare(
        "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) VALUES (?, ?, 'echo', 1, NULL, 'running', ?, NULL)"
      ).bind(appRun, app, Date.now()),
    ]);
    const stamp = await mailFrom(appRun, "app", shared, mailbox);

    const delivered = await deliverConnectorEvent(
      env,
      mailEvent(shared, {
        stamp,
        payload: {
          subject: "Again",
          folder: "inbox",
          from: { address: mailbox },
        },
      })
    );
    const runs = await runsOf(trigger.id);
    const logged = await allEvents();
    const refused = logged.filter(
      ({ action, target }) =>
        action === "workflow.event.refused" && target?.id === trigger.id
    );

    expect({
      delivered,
      runs: runs.length,
      refused: refused.map(({ detail }) => detail.code),
    }).toStrictEqual({
      delivered: { runs: 0 },
      runs: 0,
      refused: ["lineage.unjoinable"],
    });
  });

  it("drop an event held back at the hourly limit for over a day, audited", async () => {
    const admin = await person("admin");
    const workflow = await filing(admin);
    const shared = await connection();
    const trigger = await connectorTrigger(admin, workflow.id, shared);
    await deliverConnectorEvent(env, mailEvent(shared));
    const [started] = await runsOf(trigger.id);
    await fillHour(started?.id ?? "");
    const held = mailEvent(shared);
    const logged = vi.spyOn(console, "warn").mockReturnValue();

    const firstTry = await outcome(deliverConnectorEvent(env, held));
    // A day and more on.
    await env.DB.prepare(
      "UPDATE connector_trigger_holds SET held_since = ? WHERE trigger_id = ?"
    )
      .bind(Date.now() - maxHeldMs - 1000, trigger.id)
      .run();
    const dayOn = await outcome(deliverConnectorEvent(env, held));
    logged.mockRestore();
    const runsAfter = await runsOf(trigger.id);
    const events = await allEvents();
    const dropped = events.filter(
      ({ action, target }) =>
        action === "workflow.event.dropped" && target?.id === trigger.id
    );

    expect({
      firstTry: firstTry === "ok",
      dayOn,
      runs: runsAfter.length,
      dropped: dropped.map(({ detail }) => detail.reason),
    }).toStrictEqual({
      firstTry: false,
      dayOn: "ok",
      runs: 1,
      dropped: ["hourly_limit"],
    });
  });

  it("are granted only their own connection, for their event's read, and connect listens where they do", async () => {
    const admin = await person("admin");
    const workflow = await filing(admin);
    const shared = await connection();
    const other = await connection();
    const trigger = await connectorTrigger(admin, workflow.id, shared, {
      hears: false,
    });
    const subject = {
      type: "trigger",
      triggerId: triggerIdSchema.parse(trigger.id),
    } as const;
    const ask = async (connectionId: string, actions: string[]) =>
      await outcome(
        granted(admin, {
          subject,
          object: {
            type: "connection",
            connectionId: connectionIdSchema.parse(connectionId),
          },
          actions,
        })
      );
    const before = await listenersOf(env);
    const refused = {
      otherConnection: await ask(other, ["mail.list"]),
      otherAction: await ask(shared, ["mail.send"]),
      more: await ask(shared, ["mail.list", "mail.send"]),
    };
    const own = await ask(shared, ["mail.list"]);
    const after = await listenersOf(env);
    // A grant it can no longer use (another action than its event reads):
    // connect listens there no more.
    await env.DB.prepare(
      "UPDATE permissions SET actions = '[\"mail.send\"]' WHERE subject_type = 'trigger' AND subject_id = ?"
    )
      .bind(trigger.id)
      .run();
    const unusable = await listenersOf(env);
    const listening = (listeners: typeof after) =>
      listeners.some(
        (listener) =>
          listener.connection === shared &&
          listener.owner === admin.userId &&
          listener.type === "m365.mail.received" &&
          listener.resource === null
      );

    expect({
      refused,
      own,
      before: listening(before),
      after: listening(after),
      unusable: listening(unusable),
    }).toStrictEqual({
      refused: {
        otherConnection: "permission.invalid",
        otherAction: "permission.invalid",
        more: "permission.invalid",
      },
      own: "ok",
      before: false,
      after: true,
      unusable: false,
    });
  });
});
