/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import {
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { InputMapping } from "@grasp-os/shared/workflow-triggers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { z } from "zod";

import worker from "../src/index.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { unique } from "./sign-in.ts";
import type { signedInApi } from "./sign-in.ts";

// Email triggers: Email Routing hands core's email handler each message
// for the deployment's domain, which starts the run of the independent
// workflow whose email trigger receives mail at its address, with the
// message mapped into its input. Tests deliver messages to the handler as
// Email Routing does. What the tests of email triggers share; each test
// file signs people in with an IdP of its own (`mockIdp()` registers
// hooks, so it can't be called here).

/** A signed-in person's API. */
export type Person = Awaited<ReturnType<typeof signedInApi>>;

/**
 * A message from Ben, with an attachment, as it goes over the wire: with a
 * Message-ID and a Received header when given, and `to`, the subject, the
 * attachment's name and the text as given.
 */
export const invoiceMail = ({
  subject = "Invoice INV-7",
  messageId,
  receivedBy,
  to = "invoices@grasp.test",
  filename = "inv-7.pdf",
  text = "Please pay by Friday.",
  from = "Ben <ben@acme.test>",
  headers = [],
}: {
  subject?: string;
  messageId?: string;
  receivedBy?: string;
  to?: string;
  filename?: string;
  text?: string;
  from?: string;
  headers?: string[];
} = {}): string =>
  [
    ...(receivedBy === undefined
      ? []
      : [`Received: from ${receivedBy}; Mon, 28 Sep 2026 08:00:01 +0000`]),
    ...(messageId === undefined ? [] : [`Message-ID: <${messageId}>`]),
    ...headers,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "Date: Mon, 28 Sep 2026 08:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    "--b",
    `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0=",
    "--b--",
    "",
  ].join("\r\n");

/** What became of a delivery: the reason it was rejected with, if it was. */
export interface Delivery {
  rejected: string | undefined;
}

/**
 * Delivers `raw` to `to`, as Email Routing does, on an env with `changes`;
 * `rawSize` is the size the message says it is.
 */
export const deliver = async (
  to: string,
  raw: string,
  {
    changes = {},
    rawSize,
    envelopeFrom = "bounces@acme.test",
  }: { changes?: Partial<Env>; rawSize?: number; envelopeFrom?: string } = {}
): Promise<Delivery> => {
  const bytes = new TextEncoder().encode(raw);
  const delivery: Delivery = { rejected: undefined };
  const message: ForwardableEmailMessage = {
    from: envelopeFrom,
    to,
    raw: new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    headers: new Headers(),
    rawSize: rawSize ?? bytes.byteLength,
    setReject: (reason) => {
      delivery.rejected = reason;
    },
    forward: async () =>
      await Promise.reject(new Error("Core never forwards mail")),
    reply: async () =>
      await Promise.reject(new Error("Core never replies to mail")),
  };
  const ctx = createExecutionContext();
  await worker.email(message, { ...env, ...changes }, ctx);
  await waitOnExecutionContext(ctx);
  return delivery;
};

/**
 * Every kept message in R2 (workflows/kept-email.ts), as its key and when
 * it was stored. Kept mail only, not the whole bucket: other parts of core
 * write there too, on their own schedule. The mail a test delivers arms
 * the clock (index.ts), which after each file's reset starts empty and
 * runs every task as soon as it is armed. Its sweeps then write their
 * cursors (`builds-sweep.json`, `screen-frames-sweep.json`) while the
 * test is still going.
 */
export const storedObjects = async (): Promise<string[]> => {
  const listed = await env.FILES.list({
    prefix: "inbound-email/",
    limit: 1000,
  });
  return listed.objects.map(
    ({ key, uploaded }) => `${key}@${uploaded.toISOString()}`
  );
};

/** The keys of the objects in R2 that `before` didn't list. */
export const addedSince = async (
  before: readonly string[]
): Promise<string[]> => {
  const now = await storedObjects();
  return now
    .filter((object) => !before.includes(object))
    .map((object) => object.split("@")[0] ?? object);
};

/** A kept message's name: its day, and the SHA-256 of its bytes. */
export const storedName = /^(?<day>\d{4}-\d{2}-\d{2})\/[0-9a-f]{64}$/u;

/** The deployment's mail domain: its hostname, as the router sorts by. */
export const own = new URL(clientOrigin).hostname;

/** An admin, straight in the database, to grant triggers their starts. */
export const admin = async (): Promise<Identity> => {
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

export const stringOrNull = { anyOf: [{ type: "string" }, { type: "null" }] };

/**
 * An attachment, as a message's input lists it: as a file of the run too,
 * when a run file may be it.
 */
export const attachment = {
  type: "object",
  properties: {
    filename: stringOrNull,
    mimeType: { type: "string" },
    size: { type: "integer" },
    file: { type: "object", "x-grasp-value": { kind: "file" } },
  },
  required: ["filename", "mimeType", "size"],
  additionalProperties: false,
};

/** A workflow taking a message's `subject`, and what else its trigger maps. */
export const definitionOf = (name: string, version = "1.0.0"): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version,
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

export const mapping = {
  fields: {
    subject: "/subject",
    from: "/from/address",
    stored: "/stored",
    attachments: "/attachments",
  },
  defaults: {},
};

/** `request`, asked for and granted by `by`. */
export const granted = async (
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

/** What a test's email trigger is on, when not the plain `definitionOf`. */
export interface Starting {
  /** The workflow's definition, by its name. */
  definition?: (name: string) => string;
  /** Its own modules, by path. */
  modules?: Record<string, string>;
  /** Its files binding, approved by the admin, for a catalog key of its own. */
  files?: true;
  input?: InputMapping;
  /** The name its address takes, when not a random one of its own. */
  address?: string;
}

/**
 * `builder`'s workflow with an email trigger of theirs on it, made over
 * `/rpc`, granted `start` by an admin: the trigger as its owner sees it,
 * and the address it receives at.
 */
export const emailTriggerFor = async (
  builder: Person,
  {
    definition = definitionOf,
    modules,
    files,
    input = mapping,
    address,
  }: Starting = {}
) => {
  const by = await admin();
  const { id, name } = await builder.api.workflowResources.create(
    `intake-${unique()}`
  );
  await builder.api.workflowResources.publish(id, {
    definition: definition(name),
    basedOn: null,
    ...(modules === undefined ? {} : { modules }),
  });
  if (files === true) {
    await approveWorkflowBinding(env, by, id, {
      alias: "files",
      target: { kind: "files" },
      reviewed: { version: 1 },
    });
  }
  const trigger = await builder.api.workflowResources.triggers.create({
    kind: "email",
    workflowId: id,
    version: 1,
    config: { input, ...(address === undefined ? {} : { address }) },
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
    name,
    trigger,
    start,
    address: `${trigger.address ?? ""}@${own}`,
  };
};

/** The runs trigger `trigger` started, oldest first. */
export const runsOf = async (trigger: string) => {
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

/** A run's input, as its receipt keeps it. */
export const inputOf = (input: string | null): unknown =>
  JSON.parse(input ?? "null");

/** What a message trigger's run takes of the message (`messageTriggerFor`). */
const messageFields = {
  id: { type: "string" },
  stored: stringOrNull,
  from: { type: "string" },
  to: {
    type: "array",
    items: {
      type: "object",
      properties: { name: { type: "string" }, address: { type: "string" } },
      required: ["name", "address"],
      additionalProperties: false,
    },
  },
  subject: { type: "string" },
  text: { type: "string" },
  truncated: { type: "boolean" },
  attachments: { type: "array", items: attachment },
};

/** A workflow taking what `messageFields` says of a message. */
const messageDefinitionOf = (name: string): string =>
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
          properties: messageFields,
          required: Object.keys(messageFields),
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

/**
 * `builder`'s email trigger at a name of its own made of `prefix`, whose
 * runs take the message as `messageFields` says: its name, and its ID.
 */
export const messageTriggerFor = async (builder: Person, prefix: string) => {
  const name = `${prefix}-${unique()}`;
  const { trigger } = await emailTriggerFor(builder, {
    definition: messageDefinitionOf,
    input: {
      fields: Object.fromEntries(
        Object.keys(messageFields).map((field) => [
          field,
          field === "from" ? "/from/address" : `/${field}`,
        ])
      ),
      defaults: {},
    },
    address: name,
  });
  return { name, id: trigger.id };
};

/**
 * The last character of `text`, whole: a character UTF-16 splits in two
 * (an emoji) is both its halves.
 */
const lastCharacter = (text: string): string => {
  const last = text.codePointAt(text.length - 1) ?? 0;
  const split = last >= 0xdc_00 && last <= 0xdf_ff && text.length > 1;
  return text.slice(text.length - (split ? 2 : 1));
};

const messageSchema = z.object({
  id: z.string(),
  stored: z.string().nullable(),
  from: z.string(),
  to: z.array(z.unknown()),
  subject: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  attachments: z.array(
    z.object({ filename: z.string().nullable(), size: z.number() })
  ),
});

/**
 * What each run trigger `id` started took of its message, oldest first:
 * as `messageFields` says, with its last character, its attachments as
 * `name:size`, and how large it is as JSON.
 */
export const messagesOf = async (id: string) => {
  const runs = await runsOf(id);
  return runs.map(({ input }) => {
    const message = messageSchema.parse(inputOf(input));
    return {
      ...message,
      to: message.to.length,
      last: lastCharacter(message.text),
      attachments: message.attachments.map(
        ({ filename, size }) => `${filename ?? ""}:${String(size)}`
      ),
      size: JSON.stringify(message).length,
    };
  });
};
