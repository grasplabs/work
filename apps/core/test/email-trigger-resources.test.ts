/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { sha256HexOfBytes } from "@grasp-os/shared/encoding";
import {
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import {
  mailFromHeader,
  mailIngressPath,
  mailSentAtHeader,
  mailSha256Header,
  mailSignatureHeader,
  mailSizeHeader,
  mailToHeader,
  signMail,
} from "@grasp-os/shared/mail-ingress";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import { routerSecretHeader } from "@grasp-os/shared/router";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { inboundEmailMaxBytes } from "@grasp-os/shared/workflows";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import worker from "../src/index.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { stampedMail } from "../src/workflows/mail-stamps.ts";
import { triggeredRunsPerHour } from "../src/workflows/runs.ts";
import { allEvents } from "./audit-events.ts";
import { deliver, invoiceMail, storedObjects } from "./email-triggers.ts";
import { mockIdp } from "./idp.ts";
import { configuredLimits } from "./quota-limits.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { signedInApi, unique } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// Independent workflows' email triggers (workflows/inbound-email.ts), from
// their threat model: mail reaches a trigger only through the signed
// ingress (or Email Routing), at its own address; a forged delivery, mail
// that may loop (sent automatically, from the deployment's own domain, or
// a run's own mail past its lineage's limits, or an App run's), an
// oversized message or one whose attachments would be kept, a sender
// writing someone else's address, a trigger whose creator lost access and
// the same message delivered twice each start nothing more than they
// should, and every refusal is audited.

const idp = mockIdp();

/** The deployment's mail domain: its hostname, as the router sorts by. */
const own = new URL(clientOrigin).hostname;

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

const stringOrNull = { anyOf: [{ type: "string" }, { type: "null" }] };

/** An attachment, as a message's input lists it. */
const attachment = {
  type: "object",
  properties: {
    filename: stringOrNull,
    mimeType: { type: "string" },
    size: { type: "integer" },
  },
  required: ["filename", "mimeType", "size"],
  additionalProperties: false,
};

/** A workflow taking a message's `subject`, and what else its trigger maps. */
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
            subject: { type: "string" },
            from: { type: "string" },
            stored: stringOrNull,
            attachments: { type: "array", items: attachment },
          },
          required: ["subject", "from", "stored", "attachments"],
          additionalProperties: false,
        },
      },
    },
    output: {
      schema: {
        format: "json",
        document: {
          type: "object",
          properties: { subject: { type: "string" } },
          required: ["subject"],
          additionalProperties: false,
        },
      },
    },
    do: [{ finish: { set: { subject: "${ $workflow.input.subject }" } } }],
  });

const mapping = {
  fields: {
    subject: "/subject",
    from: "/from/address",
    stored: "/stored",
    attachments: "/attachments",
  },
  defaults: {},
};

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
 * A builder's workflow with an email trigger of theirs on it, made over
 * `/rpc`, granted `start` by an admin: the trigger as its owner sees it,
 * and the address it receives at.
 */
const emailTrigger = async () => {
  const builder = await signedInApi(idp, "builder");
  const by = await admin();
  const { id, name } = await builder.api.workflowResources.create(
    `intake-${unique()}`
  );
  await builder.api.workflowResources.publish(id, {
    definition: definitionOf(name),
    basedOn: null,
  });
  const trigger = await builder.api.workflowResources.triggers.create({
    kind: "email",
    workflowId: id,
    version: 1,
    config: { input: mapping },
  });
  const start = await granted(by, {
    subject: { type: "trigger", triggerId: triggerIdSchema.parse(trigger.id) },
    object: {
      type: "workflow",
      workflowId: workflowResourceIdSchema.parse(id),
    },
    actions: ["start"],
  });
  return {
    builder,
    admin: by,
    workflow: id,
    trigger,
    start,
    address: `${trigger.address ?? ""}@${own}`,
  };
};

/** How a test posts to the raw-mail ingress, when not as the router does. */
interface Posting {
  secret?: string;
  unsigned?: boolean;
  envelopeFrom?: string;
}

/**
 * Posts `raw` for `to` to core's raw-mail ingress, as the router's mail
 * sorter does: signed for its recipient, sender, hash, size and time.
 */
const post = async (
  to: string,
  raw: string,
  posting: Posting = {}
): Promise<Response> => {
  const bytes = new TextEncoder().encode(raw);
  const mail = {
    to,
    from: posting.envelopeFrom ?? "bounces@acme.test",
    sha256: await sha256HexOfBytes(bytes),
    size: bytes.byteLength,
    sentAt: new Date().toISOString(),
  };
  const signature = await signMail(posting.secret ?? env.ROUTER_SECRET, mail);
  return await worker.fetch(
    new Request(`https://core${mailIngressPath}`, {
      method: "POST",
      headers: {
        [routerSecretHeader]: env.ROUTER_SECRET,
        [mailToHeader]: mail.to,
        [mailFromHeader]: mail.from,
        [mailSha256Header]: mail.sha256,
        [mailSizeHeader]: String(mail.size),
        [mailSentAtHeader]: mail.sentAt,
        ...(posting.unsigned === true
          ? {}
          : { [mailSignatureHeader]: signature }),
      },
      body: raw,
    }),
    env,
    createExecutionContext()
  );
};

/** The runs trigger `trigger` started, oldest first. */
const runsOf = async (trigger: string) => {
  const rows = await env.DB.prepare(
    "SELECT run.id, run.depth, run.root_run_id AS root, receipt.idempotency_key AS key, receipt.principal_id AS principal, receipt.input FROM workflow_resource_runs AS run JOIN workflow_start_receipts AS receipt ON receipt.id = run.id WHERE receipt.invoker_type = 'trigger' AND receipt.invoker_id = ? ORDER BY receipt.created_at, run.depth"
  )
    .bind(trigger)
    .all<{
      id: string;
      depth: number;
      root: string | null;
      key: string;
      principal: string;
      input: string | null;
    }>();
  return rows.results;
};

/** How many runs trigger `id` started. */
const runCount = async (id: string): Promise<number> => {
  const runs = await runsOf(id);
  return runs.length;
};

/** A run's input, as its receipt keeps it. */
const inputOf = (input: string | null): unknown => JSON.parse(input ?? "null");

/** Why each of trigger `id`'s messages was refused, as audited. */
const refusalsOf = async (id: string) => {
  const logged = await allEvents();
  return logged
    .filter(
      ({ action, target }) =>
        action === "workflow.email.refused" && target?.id === id
    )
    .map(({ detail }) => detail.reason);
};

/** A native mail connection in connect's registry, of `account`. */
const connection = async (account: string): Promise<string> => {
  const id = `connection-${unique()}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, tools, account_name, account_email, created_at, updated_at) VALUES (?, 'microsoft', 'shared', NULL, 'active', 'native', 'microsoft-365', '[]', ?, ?, ?, ?)"
    )
    .bind(id, account, account, now, now)
    .run();
  return id;
};

/**
 * The stamp run `run` (an independent workflow's, or an App's) puts on its
 * mail from `mailbox`, through `connectionId`, to `to`, as its step's call
 * records it (mail-stamps.ts).
 */
const stampOf = async (
  run: string,
  kind: "app" | "resource",
  connectionId: string,
  mailbox: string,
  to: string
): Promise<string> => {
  const { stamp } = await stampedMail(
    env,
    { run, stepKey: `step-${unique()}`, kind },
    {
      connectionId,
      action: "mail.send",
      input: { mailbox, to: [to], subject: "Again", body: "Again." },
    }
  );
  if (stamp === undefined) {
    throw new Error("Expected the mail stamped");
  }
  return stamp;
};

describe("independent workflows' email triggers", { timeout: 120_000 }, () => {
  it("start one run per message, mapped into its input and acting for the trigger's creator, however often it is delivered, at an address shown with the trigger", async () => {
    const { builder, workflow, trigger, address } = await emailTrigger();
    const message = invoiceMail({
      to: address,
      messageId: `m-${unique()}@acme.test`,
    });

    const first = await post(address, message);
    // Delivered again, with a hop's header added: the same message.
    const again = await post(
      address,
      `Received: from mx2.acme.test; Mon, 28 Sep 2026 08:00:02 +0000\r\n${message}`
    );
    // And once more through Email Routing.
    const routed = await deliver(address, message);
    const listed = await builder.api.workflowResources.triggers.list(workflow);
    const runs = await runsOf(trigger.id);

    expect({
      statuses: [first.status, again.status],
      routed: routed.rejected,
      shown: listed.map(({ id, kind, address: at, config }) => ({
        id,
        kind,
        address: at,
        config,
      })),
      runs: runs.map(({ key, principal, input }) => ({
        key: /^grasp:email:[\w-]+:[0-9a-f]{64}$/u.test(key),
        principal,
        input: inputOf(input),
      })),
    }).toStrictEqual({
      statuses: [202, 202],
      routed: undefined,
      shown: [
        {
          id: trigger.id,
          kind: "email",
          address: `trigger-${trigger.id}`,
          config: { input: mapping },
        },
      ],
      runs: [
        {
          key: true,
          principal: builder.userId,
          // Listed, never kept: an independent run reads no attachment.
          input: {
            subject: "Invoice INV-7",
            from: "ben@acme.test",
            stored: null,
            attachments: [
              { filename: "inv-7.pdf", mimeType: "application/pdf", size: 5 },
            ],
          },
        },
      ],
    });
  });

  it("start nothing for a delivery that isn't signed by the router", async () => {
    const { trigger, address } = await emailTrigger();

    const forged = await post(address, invoiceMail({ to: address }), {
      secret: "not-the-router-secret",
    });
    const unsigned = await post(address, invoiceMail({ to: address }), {
      unsigned: true,
    });
    const runs = await runsOf(trigger.id);

    expect({
      statuses: [forged.status, unsigned.status],
      runs: runs.length,
    }).toStrictEqual({ statuses: [403, 403], runs: 0 });
  });

  it("bounce mail to a trigger that is turned off, deleted or doesn't exist, and to a look-alike of its address", async () => {
    const { builder, trigger, address } = await emailTrigger();
    const deleted = await emailTrigger();
    await builder.api.workflowResources.triggers.setEnabled(trigger.id, false);
    await deleted.builder.api.workflowResources.triggers.delete(
      deleted.trigger.id
    );
    const nobody = `trigger-${crypto.randomUUID()}@${own}`;
    const lookAlike = `trigger-${trigger.id}x@${own}`;

    const responses = await Promise.all(
      [address, deleted.address, nobody, lookAlike].map(
        async (to) => await post(to, invoiceMail({ to }))
      )
    );
    const bodies = await Promise.all(
      responses.map(async (response) => await response.json())
    );

    expect({
      statuses: responses.map(({ status }) => status),
      bodies,
      runs: await runCount(trigger.id),
    }).toStrictEqual({
      statuses: [422, 422, 422, 422],
      bodies: Array.from({ length: 4 }, () => ({
        reason: "No such address.",
      })),
      runs: 0,
    });
  });

  it("drop mail sent automatically or from the deployment's own domain, audited, never bounced, and take a forged From for untrusted data only", async () => {
    const { trigger, address } = await emailTrigger();

    const automatic = await post(
      address,
      invoiceMail({ to: address, headers: ["Auto-Submitted: auto-replied"] })
    );
    const ownFrom = await post(
      address,
      invoiceMail({ to: address, from: `Grasp <runs@${own}>` })
    );
    const ownEnvelope = await post(address, invoiceMail({ to: address }), {
      envelopeFrom: `bounces@${own}`,
    });
    // The client's CEO, written in by anyone: a root, the address only
    // what the run reads.
    const spoofed = await post(
      address,
      invoiceMail({ to: address, from: "CEO <ceo@acme.test>" })
    );
    const runs = await runsOf(trigger.id);

    expect({
      statuses: [automatic, ownFrom, ownEnvelope, spoofed].map(
        ({ status }) => status
      ),
      refused: await refusalsOf(trigger.id),
      runs: runs.map(({ depth, input }) => ({
        depth,
        input: inputOf(input),
      })),
    }).toStrictEqual({
      statuses: [202, 202, 202, 202],
      refused: ["auto_submitted", "own_domain", "own_domain"],
      runs: [
        {
          depth: 0,
          input: {
            subject: "Invoice INV-7",
            from: "ceo@acme.test",
            stored: null,
            attachments: [
              { filename: "inv-7.pdf", mimeType: "application/pdf", size: 5 },
            ],
          },
        },
      ],
    });
  });

  it("bounce a message over the size limit, and keep no message's attachments", async () => {
    const { trigger, address } = await emailTrigger();
    const before = await storedObjects();

    const oversized = await deliver(
      address,
      invoiceMail({ to: address, text: "x".repeat(inboundEmailMaxBytes) })
    );
    const withAttachment = await deliver(address, invoiceMail({ to: address }));
    const after = await storedObjects();

    expect({
      oversized: oversized.rejected,
      withAttachment: withAttachment.rejected,
      runs: await runCount(trigger.id),
      kept: after.filter((object) => !before.includes(object)),
    }).toStrictEqual({
      oversized: "The message is too large.",
      withAttachment: undefined,
      runs: 1,
      kept: [],
    });
  });

  it("start nothing once the trigger's creator lost access or its grant is revoked, audited", async () => {
    const left = await emailTrigger();
    const revoked = await emailTrigger();
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(left.builder.userId)
      .run();
    await revokePermission(env, revoked.admin, revoked.start);

    const statuses = await Promise.all(
      [left, revoked].map(async ({ address }) => {
        const response = await post(address, invoiceMail({ to: address }));
        return response.status;
      })
    );

    expect({
      statuses,
      runs: [
        await runCount(left.trigger.id),
        await runCount(revoked.trigger.id),
      ],
      refused: [
        await refusalsOf(left.trigger.id),
        await refusalsOf(revoked.trigger.id),
      ],
    }).toStrictEqual({
      statuses: [202, 202],
      runs: [0, 0],
      refused: [["workflow.start_denied"], ["workflow.start_denied"]],
    });
  });

  it("join the lineage of the independent run whose mail it is, until the lineage's limit refuses it, audited", async () => {
    const { trigger, address } = await emailTrigger();
    const mailbox = `ops-${unique()}@acme.test`;
    const shared = await connection(mailbox);
    env.TEST_QUOTA_LIMITS = { workflowNestingLevels: 3 };
    try {
      // Mail from outside: a root.
      await post(address, invoiceMail({ to: address }));
      // Each new run mails the trigger's address; its message carries the
      // run's stamp, from the run's mailbox.
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
        const stamp = await stampOf(
          last.id,
          "resource",
          shared,
          mailbox,
          address
        );
        // oxlint-disable-next-line no-await-in-loop -- one hop after another
        await post(
          address,
          invoiceMail({
            to: address,
            from: mailbox,
            messageId: `hop-${unique()}@acme.test`,
            headers: [`X-Grasp-Stamp: ${stamp}`],
          }),
          { envelopeFrom: mailbox }
        );
      }
    } finally {
      env.TEST_QUOTA_LIMITS = configuredLimits;
    }
    const runs = await runsOf(trigger.id);
    const [root] = runs;

    expect({
      depths: runs.map(({ depth }) => depth),
      oneLineage: runs.slice(2).every(({ root: of }) => of === runs[1]?.root),
      rootFirst: root?.depth,
      refused: await refusalsOf(trigger.id),
    }).toStrictEqual({
      // The root, then two levels under it: the third is past the limit.
      depths: [0, 1, 2],
      oneLineage: true,
      rootFirst: 0,
      refused: ["workflow.lineage_limit"],
    });
  });

  it("take a run's stamp only from that run's own sender, to the address it mailed", async () => {
    const { trigger, address } = await emailTrigger();
    const other = await emailTrigger();
    const mailbox = `ops-${unique()}@acme.test`;
    const shared = await connection(mailbox);
    await post(address, invoiceMail({ to: address }));
    const [first] = await runsOf(trigger.id);
    const stamp = await stampOf(
      first?.id ?? "",
      "resource",
      shared,
      mailbox,
      address
    );
    const stamped = (to: string) =>
      invoiceMail({
        to,
        from: mailbox,
        messageId: `copy-${unique()}@acme.test`,
        headers: [`X-Grasp-Stamp: ${stamp}`],
      });

    // Its From written as the run's mailbox, sent from elsewhere.
    await post(address, stamped(address), { envelopeFrom: "eve@evil.test" });
    // The run's own mail, carried on to another trigger's address.
    await post(other.address, stamped(other.address), {
      envelopeFrom: mailbox,
    });
    const runs = await runsOf(trigger.id);
    const others = await runsOf(other.trigger.id);

    expect({
      depths: runs.map(({ depth }) => depth),
      others: others.map(({ depth }) => depth),
    }).toStrictEqual({ depths: [0, 0], others: [0] });
  });

  it("refuse an App run's own mail, audited, rather than start it as a new root", async () => {
    const { builder, trigger, address } = await emailTrigger();
    const mailbox = `ops-${unique()}@acme.test`;
    const shared = await connection(mailbox);
    const app = `app-${unique()}`;
    const appRun = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Echo', '', ?, ?)"
      ).bind(app, builder.userId, Date.now()),
      env.DB.prepare(
        "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) VALUES (?, ?, 'echo', 1, NULL, 'running', ?, NULL)"
      ).bind(appRun, app, Date.now()),
    ]);
    const stamp = await stampOf(appRun, "app", shared, mailbox, address);

    const response = await post(
      address,
      invoiceMail({
        to: address,
        from: mailbox,
        headers: [`X-Grasp-Stamp: ${stamp}`],
      }),
      { envelopeFrom: mailbox }
    );

    expect({
      status: response.status,
      runs: await runCount(trigger.id),
      refused: await refusalsOf(trigger.id),
    }).toStrictEqual({
      status: 202,
      runs: 0,
      refused: ["lineage.unjoinable"],
    });
  });

  it("fail a delivery for now past the trigger's hourly limit, starting nothing", async () => {
    const { trigger, address } = await emailTrigger();
    await post(address, invoiceMail({ to: address }));
    const [started] = await runsOf(trigger.id);
    // Fills the hour with copies of its receipt, each under a key of its own.
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
        ).bind(crypto.randomUUID(), `filler-${unique()}`, started?.id ?? "")
      )
    );
    const warned = vi.spyOn(console, "warn").mockReturnValue();
    const failed = vi.spyOn(console, "error").mockReturnValue();

    const over = await post(
      address,
      invoiceMail({ to: address, messageId: `late-${unique()}@acme.test` })
    );
    warned.mockRestore();
    failed.mockRestore();

    expect({
      over: over.status === 202 || over.status === 422,
      runs: await runCount(trigger.id),
    }).toStrictEqual({ over: false, runs: 1 });
  });
});
