/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { toHex } from "@grasp-os/shared/encoding";
import {
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import {
  workflowWebhookHeaders,
  workflowWebhookPath,
} from "@grasp-os/shared/workflow-triggers";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { outcome, routed, signedInApi, unique } from "./sign-in.ts";

// Independent workflows' webhook triggers (workflows/webhook-triggers.ts),
// from their threat model: a delivery that isn't signed with the trigger's
// secret, one replayed past its window, one too large, one that isn't
// JSON or isn't an input the workflow takes, one before an admin granted
// the trigger its start, and the same delivery sent twice each start
// nothing more than they should; the secret is shown once, never listed
// or audited, and rotating or revoking it stops the old one.

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

/** `v1=` HMAC-SHA256 of `<timestamp>.<body>` with `secret`, as a sender signs. */
const signatureOf = async (
  secret: string,
  timestamp: string,
  body: string
): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${body}`)
  );
  return `v1=${toHex(new Uint8Array(mac))}`;
};

/** How a test sends a delivery, when not as a sender holding the secret does. */
interface Sending {
  secret?: string;
  /** Seconds from now its timestamp says. */
  skew?: number;
  signature?: string;
  method?: string;
}

/** Sends `body` to the webhook trigger's URL at `token`, signed with `secret`. */
const send = async (
  token: string,
  secret: string,
  body: string,
  sending: Sending = {}
): Promise<Response> => {
  const timestamp = String(Math.floor(Date.now() / 1000) + (sending.skew ?? 0));
  const signature =
    sending.signature ??
    (await signatureOf(sending.secret ?? secret, timestamp, body));
  return await routed(`${workflowWebhookPath}/${token}`, {
    method: sending.method ?? "POST",
    headers: {
      "content-type": "application/json",
      [workflowWebhookHeaders.timestamp]: timestamp,
      [workflowWebhookHeaders.signature]: signature,
    },
    ...(sending.method === "GET" ? {} : { body }),
  });
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

/** A delivery's body: one invoice. */
const invoice = JSON.stringify({ invoice: "INV-1", amount: 120 });

describe("a workflow's webhook trigger", () => {
  it("shows its secret once, as it is created, never in its listing or the audit log", async () => {
    const { builder, workflow, trigger } = await webhookTrigger();
    const listed = await builder.api.workflowResources.triggers.list(workflow);
    const events = await allEvents();

    expect({
      secret: trigger.secret?.startsWith("gwtsec_"),
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

  it("starts a run with a signed delivery's body as its input, once for the same delivery", async () => {
    const { trigger } = await webhookTrigger();
    const token = trigger.webhook?.token ?? "";
    const secret = trigger.secret ?? "";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signatureOf(secret, timestamp, invoice);
    const delivered = await send(token, secret, invoice, { signature });
    // The same delivery again, as a sender retrying: the same start.
    const again = await send(token, secret, invoice, { signature });

    expect({
      statuses: [delivered.status, again.status],
      inputs: await runInputsOf(trigger.id),
    }).toStrictEqual({
      statuses: [202, 202],
      inputs: [{ invoice: "INV-1", amount: 120 }],
    });
  });

  it("refuses an unsigned, stale, oversized or malformed delivery, and one its workflow doesn't take, starting nothing", async () => {
    const { trigger } = await webhookTrigger();
    const token = trigger.webhook?.token ?? "";
    const secret = trigger.secret ?? "";
    const refused = {
      wrongSecret: await send(token, secret, invoice, {
        secret: "gwtsec_not-the-trigger-secret",
      }),
      tampered: await send(token, secret, invoice, {
        signature: await signatureOf(
          secret,
          String(Math.floor(Date.now() / 1000)),
          JSON.stringify({ invoice: "INV-2", amount: 1 })
        ),
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
});
