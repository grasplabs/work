/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import {
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { workflowWebhookHeaders } from "@grasp-os/shared/workflow-triggers";
import { workflowWebhookPath } from "@grasp-os/shared/workflow-webhook-path";
import { env } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import { describe, expect, it } from "vite-plus/test";

import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { triggeredRunsPerHour } from "../src/workflows/runs.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { outcome, routed, signedInApi, unique } from "./sign-in.ts";

// Independent workflows' webhook triggers (workflows/webhook-triggers.ts),
// from their threat model: a delivery that isn't signed with the trigger's
// secret, one replayed past its window, one too large, one that isn't
// JSON or isn't an input the workflow takes, one before an admin granted
// the trigger its start, a sender's retry of the same `webhook-id` signed
// afresh, and one whose secret is rotated as it is admitted each start
// nothing more than they should; the secret is shown once, never listed
// or audited, and rotating or revoking it stops the old one. Deliveries
// are signed by Standard Webhooks' own library, as any sender's are.

const idp = mockIdp();

/** An admin, straight in the database, to grant triggers their starts. */
const admin = async (): Promise<Identity> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Admin', ?, 1, ?, ?)"
    ).bind(userId, `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, 'admin', ?)"
    ).bind(crypto.randomUUID(), userId, Date.now()),
  ]);
  return {
    userId,
    email: `${userId}@acme.test`,
    name: "Admin",
    role: "admin",
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
};

/** A workflow taking an invoice's number and amount, answering the number. */
const definitionOf = (name: string): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings: {} },
      },
    },
    input: {
      schema: {
        format: "json",
        document: {
          type: "object",
          properties: {
            invoice: { type: "string" },
            amount: { type: "integer" },
          },
          required: ["invoice", "amount"],
          additionalProperties: false,
        },
      },
    },
    output: {
      schema: {
        format: "json",
        document: {
          type: "object",
          properties: { invoice: { type: "string" } },
          required: ["invoice"],
          additionalProperties: false,
        },
      },
    },
    do: [{ finish: { set: { invoice: "${ $workflow.input.invoice }" } } }],
  });

/** `request`, asked for and granted by `by`. */
const granted = async (
  by: Identity,
  request: Omit<PermissionRequest, "binding">
): Promise<string> => {
  const { id } = await requestPermission(
    env,
    by,
    {
      ...request,
      binding: `GRANT_${unique().toUpperCase().replaceAll("-", "_")}`,
    },
    {
      app: () => {
        throw new Error("No App here");
      },
      resource: async (ref, needed) => {
        await requireResourceRole(env, by, ref, needed);
      },
    }
  );
  await grantPermission(env, by, id, { version: null });
  return id;
};

/**
 * A builder's workflow with a webhook trigger of theirs on it, made over
 * `/rpc`: the trigger as created, its secret with it; its `start`
 * granted by an admin unless `grant` is false.
 */
const webhookTrigger = async ({ grant = true } = {}) => {
  const builder = await signedInApi(idp, "builder");
  const by = await admin();
  const { id, name } = await builder.api.workflowResources.create(
    `hook-${unique()}`
  );
  await builder.api.workflowResources.publish(id, {
    definition: definitionOf(name),
    basedOn: null,
  });
  const trigger = await builder.api.workflowResources.triggers.create({
    kind: "webhook",
    workflowId: id,
    version: 1,
    config: {},
  });
  if (grant) {
    await granted(by, {
      subject: {
        type: "trigger",
        triggerId: triggerIdSchema.parse(trigger.id),
      },
      object: {
        type: "workflow",
        workflowId: workflowResourceIdSchema.parse(id),
      },
      actions: ["start"],
    });
  }
  return { builder, admin: by, workflow: id, trigger };
};

/** How a test sends a delivery, when not as a sender holding the secret does. */
interface Sending {
  /** Its `webhook-id`: one of its own unless given. */
  id?: string;
  /** Signed with another secret than the trigger's. */
  secret?: string;
  /** Seconds from now its timestamp says. */
  skew?: number;
  /** Its `webhook-signature`, as is. */
  signature?: string;
  method?: string;
  /** Core's env the request reaches. */
  coreEnv?: Env;
}

/**
 * Sends `body` to the webhook trigger's URL at `token`, signed with
 * `secret` by Standard Webhooks' own library, as any sender of the
 * standard signs.
 */
const send = async (
  token: string,
  secret: string,
  body: string,
  sending: Sending = {}
): Promise<Response> => {
  const id = sending.id ?? `msg_${unique()}`;
  const at = new Date(Date.now() + (sending.skew ?? 0) * 1000);
  const signature =
    sending.signature ??
    new Webhook(sending.secret ?? secret).sign(id, at, body);
  return await routed(
    `${workflowWebhookPath}/${token}`,
    {
      method: sending.method ?? "POST",
      headers: {
        "content-type": "application/json",
        [workflowWebhookHeaders.id]: id,
        [workflowWebhookHeaders.timestamp]: String(
          Math.floor(at.getTime() / 1000)
        ),
        [workflowWebhookHeaders.signature]: signature,
      },
      ...(sending.method === "GET" ? {} : { body }),
    },
    sending.coreEnv
  );
};

/** The inputs of the runs trigger `trigger` started, oldest first. */
const runInputsOf = async (trigger: string): Promise<unknown[]> => {
  const rows = await env.DB.prepare(
    "SELECT receipt.input FROM workflow_resource_runs AS run JOIN workflow_start_receipts AS receipt ON receipt.id = run.id WHERE receipt.invoker_type = 'trigger' AND receipt.invoker_id = ? ORDER BY receipt.created_at"
  )
    .bind(trigger)
    .all<{ input: string | null }>();
  return rows.results.map(({ input }): unknown =>
    input === null ? null : JSON.parse(input)
  );
};

/**
 * Core's env with `first` run once, just before the first statement whose
 * query `at` matches is run: someone acting between what core read and
 * that statement.
 */
const racedAt = (at: RegExp, first: () => Promise<unknown>): Env => {
  const real = env.DB;
  let raced = false;
  const racing = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, property, receiver) => {
        if (property === "bind") {
          return (...values: unknown[]) => racing(target.bind(...values));
        }
        if (
          property === "first" ||
          property === "all" ||
          property === "raw" ||
          property === "run"
        ) {
          return async (...args: unknown[]) => {
            await first();
            const run: unknown = Reflect.get(target, property, target);
            if (typeof run !== "function") {
              throw new TypeError(`No ${property} on a statement`);
            }
            const result: unknown = await Reflect.apply(run, target, args);
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return value;
      },
    });
  const DB: D1Database = {
    prepare: (query) => {
      const statement = real.prepare(query);
      if (raced || !at.test(query)) {
        return statement;
      }
      raced = true;
      return racing(statement);
    },
    batch: async <T>(statements: D1PreparedStatement[]) =>
      await real.batch<T>(statements),
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
  return { ...env, DB };
};

/** A delivery's body: one invoice. */
const invoice = JSON.stringify({ invoice: "INV-1", amount: 120 });

describe("a workflow's webhook trigger", () => {
  it("shows its secret once, as it is created, never in its listing or the audit log", async () => {
    const { builder, workflow, trigger } = await webhookTrigger();
    const listed = await builder.api.workflowResources.triggers.list(workflow);
    const events = await allEvents();

    expect({
      secret: /^whsec_[A-Za-z0-9+/]{43}=$/u.test(trigger.secret ?? ""),
      token: /^[0-9a-f]{32}$/u.test(trigger.webhook?.token ?? ""),
      secretState: trigger.webhook?.secret,
      listed: listed.map((each) => ({
        webhook: each.webhook,
        secret: "secret" in each,
      })),
      audited: JSON.stringify(events).includes(trigger.secret ?? "-"),
      tokenAudited: JSON.stringify(events).includes(
        trigger.webhook?.token ?? "-"
      ),
    }).toStrictEqual({
      secret: true,
      token: true,
      secretState: "active",
      listed: [{ webhook: trigger.webhook, secret: false }],
      audited: false,
      tokenAudited: false,
    });
  });

  it("starts one run per webhook-id, its body the input: a retry signed afresh starts none, another ID one more", async () => {
    const { trigger } = await webhookTrigger();
    const token = trigger.webhook?.token ?? "";
    const secret = trigger.secret ?? "";
    const delivered = await send(token, secret, invoice, { id: "msg_1" });
    // The sender's retry: the same ID, a timestamp and signature of its own.
    const retried = await send(token, secret, invoice, {
      id: "msg_1",
      skew: 30,
    });
    const another = await send(
      token,
      secret,
      JSON.stringify({ invoice: "INV-2", amount: 2 }),
      { id: "msg_2" }
    );

    expect({
      statuses: [delivered.status, retried.status, another.status],
      inputs: await runInputsOf(trigger.id),
    }).toStrictEqual({
      statuses: [202, 202, 202],
      inputs: [
        { invoice: "INV-1", amount: 120 },
        { invoice: "INV-2", amount: 2 },
      ],
    });
  });

  it("refuses an unsigned, stale, oversized or malformed delivery, and one its workflow doesn't take, starting nothing", async () => {
    const { trigger } = await webhookTrigger();
    const token = trigger.webhook?.token ?? "";
    const secret = trigger.secret ?? "";
    const otherSecret = new Webhook(
      `whsec_${btoa("another-secret-of-32-bytes-long!")}`
    );
    const at = new Date();
    const refused = {
      wrongSecret: await send(token, secret, invoice, {
        signature: otherSecret.sign("msg_a", at, invoice),
        id: "msg_a",
      }),
      // Signed for another ID: the ID can't be swapped.
      swappedId: await send(token, secret, invoice, {
        signature: new Webhook(secret).sign("msg_b", at, invoice),
        id: "msg_c",
      }),
      tampered: await send(token, secret, invoice, {
        signature: new Webhook(secret).sign(
          "msg_d",
          at,
          JSON.stringify({ invoice: "INV-9", amount: 1 })
        ),
        id: "msg_d",
      }),
      unsigned: await send(token, secret, invoice, { signature: "" }),
      stale: await send(token, secret, invoice, { skew: -600 }),
      future: await send(token, secret, invoice, { skew: 600 }),
      unknown: await send("0".repeat(32), secret, invoice),
      notPost: await send(token, secret, invoice, { method: "GET" }),
      oversized: await send(
        token,
        secret,
        JSON.stringify({ invoice: "x".repeat(70 * 1024), amount: 1 })
      ),
      notJson: await send(token, secret, "invoice=INV-1"),
      notInput: await send(
        token,
        secret,
        JSON.stringify({ invoice: "INV-3", amount: "lots" })
      ),
    };
    const events = await allEvents();

    expect({
      statuses: Object.fromEntries(
        Object.entries(refused).map(([why, response]) => [why, response.status])
      ),
      inputs: await runInputsOf(trigger.id),
      audited: events
        .filter(
          ({ action, target }) =>
            action === "workflow.webhook.refused" && target?.id === trigger.id
        )
        .map(({ detail }) => detail.code),
    }).toStrictEqual({
      statuses: {
        wrongSecret: 401,
        swappedId: 401,
        tampered: 401,
        unsigned: 401,
        stale: 401,
        future: 401,
        unknown: 404,
        notPost: 405,
        oversized: 413,
        notJson: 400,
        notInput: 422,
      },
      inputs: [],
      audited: ["workflow.start_invalid"],
    });
  });

  it("tells a sender past the hour's room to try again, holding nothing back, and starts one run once it has room", async () => {
    const { trigger } = await webhookTrigger();
    const token = trigger.webhook?.token ?? "";
    const secret = trigger.secret ?? "";
    // The hour's room taken by earlier deliveries.
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: triggeredRunsPerHour }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO trigger_hour_slots (trigger_id, event_key, taken_at) VALUES (?, ?, ?)"
        ).bind(trigger.id, `earlier-${index}`, now)
      )
    );
    const full = await send(token, secret, invoice, { id: "msg_busy" });
    const holds = await env.DB.prepare(
      "SELECT COUNT(*) AS kept FROM connector_trigger_holds WHERE trigger_id = ?"
    )
      .bind(trigger.id)
      .first<{ kept: number }>();
    const whileFull = await runInputsOf(trigger.id);
    // An hour on: the room is free again.
    await env.DB.prepare("DELETE FROM trigger_hour_slots WHERE trigger_id = ?")
      .bind(trigger.id)
      .run();
    const retried = await send(token, secret, invoice, {
      id: "msg_busy",
      skew: 30,
    });
    const again = await send(token, secret, invoice, {
      id: "msg_busy",
      skew: 60,
    });

    expect({
      full: full.status,
      retryAfter: full.headers.get("retry-after"),
      holds: holds?.kept,
      whileFull,
      retried: [retried.status, again.status],
      inputs: await runInputsOf(trigger.id),
    }).toStrictEqual({
      full: 503,
      retryAfter: "60",
      holds: 0,
      whileFull: [],
      retried: [202, 202],
      inputs: [{ invoice: "INV-1", amount: 120 }],
    });
  });

  it("starts nothing until an admin grants it its start", async () => {
    const { trigger } = await webhookTrigger({ grant: false });
    const delivered = await send(
      trigger.webhook?.token ?? "",
      trigger.secret ?? "",
      invoice
    );

    expect({
      status: delivered.status,
      inputs: await runInputsOf(trigger.id),
    }).toStrictEqual({ status: 422, inputs: [] });
  });

  it("takes only its newest secret once rotated, and none once revoked, until rotated again", async () => {
    const { builder, trigger } = await webhookTrigger();
    const token = trigger.webhook?.token ?? "";
    const first = trigger.secret ?? "";
    const { triggers } = builder.api.workflowResources;
    const { secret: second } = await triggers.rotateWebhookSecret(trigger.id);
    const withFirst = await send(token, first, invoice);
    const withSecond = await send(
      token,
      second,
      JSON.stringify({ invoice: "INV-4", amount: 4 })
    );
    const revoked = await triggers.revokeWebhookSecret(trigger.id);
    const whileRevoked = await send(
      token,
      second,
      JSON.stringify({ invoice: "INV-5", amount: 5 })
    );
    const { secret: third } = await triggers.rotateWebhookSecret(trigger.id);
    const withThird = await send(
      token,
      third,
      JSON.stringify({ invoice: "INV-6", amount: 6 })
    );
    const someoneElse = await signedInApi(idp, "admin");
    const notTheirs = await outcome(
      someoneElse.api.workflowResources.triggers.rotateWebhookSecret(trigger.id)
    );

    expect({
      distinct: new Set([first, second, third]).size,
      statuses: [
        withFirst.status,
        withSecond.status,
        whileRevoked.status,
        withThird.status,
      ],
      revoked: revoked.webhook?.secret,
      notTheirs,
      inputs: await runInputsOf(trigger.id),
    }).toStrictEqual({
      distinct: 3,
      statuses: [401, 202, 401, 202],
      revoked: "revoked",
      notTheirs: "workflow.trigger_unavailable",
      inputs: [
        { invoice: "INV-4", amount: 4 },
        { invoice: "INV-6", amount: 6 },
      ],
    });
  });

  it("starts nothing for a delivery whose secret is rotated as it is admitted, and takes it again signed with the new one", async () => {
    const { builder, trigger } = await webhookTrigger();
    const token = trigger.webhook?.token ?? "";
    let rotated = "";
    // The secret rotated after the delivery was checked, before its start
    // is admitted: the statement that admits it reads the trigger live.
    const rotating = racedAt(/trigger_resources AS live/u, async () => {
      ({ secret: rotated } =
        await builder.api.workflowResources.triggers.rotateWebhookSecret(
          trigger.id
        ));
    });
    const raced = await send(token, trigger.secret ?? "", invoice, {
      id: "msg_race",
      coreEnv: rotating,
    });
    const before = await runInputsOf(trigger.id);
    // The sender's retry, signed with the new secret: nothing was settled.
    const retried = await send(token, rotated, invoice, { id: "msg_race" });

    expect({
      raced: raced.status,
      before,
      retried: retried.status,
      after: await runInputsOf(trigger.id),
    }).toStrictEqual({
      raced: 401,
      before: [],
      retried: 202,
      after: [{ invoice: "INV-1", amount: 120 }],
    });
  });
});
