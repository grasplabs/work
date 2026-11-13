import type {
  ConnectorContract,
  ConnectorContractRequest,
} from "@grasp-os/shared/connect";
import type { FunctionResult } from "@grasp-os/shared/functions";
import type { Json } from "@grasp-os/shared/json";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { commitApp, testApp, withFiles } from "./app-definitions.ts";
import type { TestApp, TestSource } from "./app-definitions.ts";
import { consentCode, graphSentUrl } from "./connect-providers.ts";
import { createIdp } from "./fake-idp.ts";
import { mailControlUrl, mailServerUrl } from "./mail-server.ts";
import type { ToolkitServer } from "./mail-server.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";

// What resource-connectors*.test.ts share: the IdP, the Mailer and
// Contacts Apps, and the connections they bind. Each file has the IdP
// answer for its own tests (`mockIdpWith`).

export const idp = createIdp();

/** A permission to call `actions` of `contract` through a connection, as `alias`. */
export const connectionTo = (
  alias: string,
  contract = "microsoft-365.mail@1",
  actions = `["send", "list"]`
): string =>
  `permission.connection("${alias}", { contract: "${contract}", actions: ${actions} })`;

/** The Mailer's definition, holding `permissions`. */
export const mailerDefinition = (permissions: readonly string[]): TestApp =>
  testApp({
    name: "Mailer",
    tables: {
      notes: {
        fields: { title: "v.string()" },
        access: { read: "owner", write: "owner" },
      },
    },
    permissions,
  });

/** An App whose actions send and list mail through Microsoft 365. */
export const mailFiles = (
  contract = "microsoft-365.mail@1",
  actions = `["send", "list"]`
): TestApp =>
  withFiles(mailerDefinition([connectionTo("mail", contract, actions)]), {
    "server/mail.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const mail = permissions.mail;

export const send = action({
  args: { to: v.string().email(), subject: v.string().min(1) },
  returns: v.object({ mailbox: v.string(), sent: v.boolean() }),
  handler: async (ctx, args) => {
    const sent = await ctx.connections.mail.send({
      mailbox: "team@acme.test",
      subject: args.subject,
      body: "Hello.",
      to: [args.to],
    });
    if (typeof sent !== "object" || sent === null || Array.isArray(sent)) {
      return { mailbox: "", sent: false };
    }
    return { mailbox: String(sent.mailbox), sent: sent.sent === true };
  },
});

export const inbox = action({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const listed = await ctx.connections.mail.list({ mailbox: "team@acme.test" });
    return typeof listed === "object" && listed !== null && !Array.isArray(listed) && Array.isArray(listed.messages)
      ? listed.messages.length
      : -1;
  },
});

/** Sends a subject of its own each time: one call key, another payload. */
export const sendFresh = action({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    await ctx.connections.mail.send({
      mailbox: "team@acme.test",
      subject: crypto.randomUUID(),
      body: "Hello.",
      to: ["ada@acme.test"],
    });
    return true;
  },
});

/** Every name App code can reach of its connector client and globals. */
export const probe = action({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const client = ctx.connections.mail;
    const listed = await client.list({ mailbox: "team@acme.test" });
    const prototype = Object.getPrototypeOf(client) ?? {};
    return [
      ...Object.getOwnPropertyNames(globalThis),
      ...Object.getOwnPropertyNames(client),
      ...Object.getOwnPropertyNames(prototype),
      JSON.stringify(listed),
      JSON.stringify(client),
      String(client.list),
    ].join(",");
  },
});

/** Sends without what the contract requires. */
export const careless = action({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    // What its contract requires left out, past the types on purpose.
    await ctx.connections.mail.send({ mailbox: "team@acme.test" } as never);
    return "sent";
  },
});
`,
  });

/**
 * An App declaring a mail connector of a contract no connector generates:
 * the config its definition generates doesn't type-check, as the types
 * know every contract, so no version of it runs to be bound.
 */
export const unknownContractFiles = (): TestApp =>
  mailerDefinition([connectionTo("mail", "grasp.mail@1")]);

/** The Mailer, with a second alias of the same contract: its archive. */
export const archiveFiles = (): TestApp =>
  testApp(
    {
      name: "Mailer",
      tables: {
        notes: {
          fields: { title: "v.string()" },
          access: { read: "owner", write: "owner" },
        },
      },
      permissions: [connectionTo("mail"), connectionTo("archive")],
    },
    {
      ...mailFiles().files,
      "server/archive.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const archive = permissions.archive;

export const archived = action({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    await ctx.connections.archive.list({ mailbox: "team@acme.test" });
    return true;
  },
});
`,
    }
  );

/** The Mailer, declaring its mail resource still, with no action that uses it. */
/** The Mailer's files once it no longer declares its mail connection. */
export const undeclaredMailFiles = (): TestApp =>
  testApp(
    { name: "Mailer" },
    {
      "server/mail.ts": `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";

export const ping = query({ args: {}, returns: v.string(), handler: () => "pong" });
`,
    }
  );

export type Person = Awaited<ReturnType<typeof signedInApi>>;

/** A shared Microsoft 365 account, connected by `admin`: its ID. */
export const connectShared = async (admin: Person): Promise<string> => {
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

export const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** What Graph sent, in order. */
export const graphSent = async (): Promise<unknown[]> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  const response = await providers.fetch(graphSentUrl);
  return z.array(z.unknown()).parse(await response.json());
};

/** How many messages Graph sent with `subject` (each test's own). */
export const sentCount = async (subject: string): Promise<number> => {
  const sent = await graphSent();
  return sent.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      Reflect.get(message, "subject") === subject
  ).length;
};

/**
 * The Mailer App, made by a builder, current, with a permission on a
 * shared Microsoft 365 connection to `tools` an admin granted, and the
 * mail resource bound to it.
 */
export const mailerApp = async (
  options: {
    tools?: string[];
    contract?: string;
    bind?: boolean;
    files?: TestSource;
  } = {}
) => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const created = await builder.api.apps.create({ name: "Mailer" });
  await commitApp(
    builder.api.apps.files,
    created.id,
    options.files ?? mailFiles(options.contract),
    "First"
  );
  await builder.api.versions.rollback({ kind: "app", id: created.id }, 1);
  const connectionId = await connectShared(admin);
  const requested = await builder.api.permissions.request({
    subject: { type: "app", appId: created.id },
    object: { type: "connection", connectionId },
    actions: options.tools ?? ["mail.send", "mail.list"],
    binding: "MAIL",
  });
  // Granting it approves the version the admin reviewed.
  await admin.api.permissions.grant(requested.id, { version: 1 });
  const approval = {
    app: created.id,
    alias: "mail",
    target: { kind: "connector" as const, permissionId: requested.id },
    reviewed: { version: 1 },
  };
  const binding =
    options.bind === false
      ? undefined
      : await admin.api.resourceBindings.approve(approval);
  const release = await loadRelease(env, created.id, 1);
  const by: Identity = await builder.api.whoami();
  return {
    admin,
    builder,
    by,
    release,
    binding,
    approval,
    permission: requested.id,
  };
};

export type Mailer = Awaited<ReturnType<typeof mailerApp>>;

/** Calls `path` of the Mailer as its builder, under the call key `key`. */
export const call = async (
  { by, release }: Pick<Mailer, "by" | "release">,
  path: string,
  input: unknown,
  key?: string,
  callEnv: Env = env
): Promise<FunctionResult> => {
  const fn = release.app.functions[path];
  const answered = await callAppFunction(
    callEnv,
    by,
    release.manifest.resourceId,
    JSON.stringify({
      reference: { name: path, kind: fn?.kind ?? "action" },
      args: input,
      ...(key === undefined ? {} : { idempotencyKey: key }),
    })
  );
  return answered.result;
};

export const outcomeOf = (result: FunctionResult): Json =>
  result.ok ? result.value : { failed: result.error.code };

/** The Mailer's declared resources and what its admin may bind each to. */
export const choicesOf = async ({ admin, release }: Mailer) => {
  const review = await admin.api.resourceBindings.review(
    release.manifest.resourceId
  );
  return review.resources.map(({ alias, state, actions, choices }) => ({
    alias,
    state,
    actions,
    choices,
  }));
};

/** The error code `work` fails with, or "ok". */
export const failure = async (
  work: () => Promise<unknown>
): Promise<string> => {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? String(Reflect.get(error, "code")) : "?";
  }
  return "ok";
};

/** Confirms every held action waiting for the Mailer's builder. */
export const confirmAll = async ({
  builder,
}: Pick<Mailer, "builder">): Promise<void> => {
  const pending = builder.api.pendingActions;
  for (const held of await pending.list()) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time
    await pending.confirm(held.id, held.inputHash);
  }
};

/**
 * Core's env with connect serving its generated contracts changed by
 * `change`, everything else connect does as it is: what a release of a
 * connector that reshaped its actions would serve, which the tests'
 * bundled connectors can't be made to do while they run.
 */
export const servingEnv = (
  change: (contract: ConnectorContract) => ConnectorContract
): Env => {
  const connect = env.CONNECT;
  const reshaped = async (request: ConnectorContractRequest) =>
    change(await connect.connectorContract(request));
  const changed = new Proxy(connect, {
    get: (target, key): unknown => {
      if (key === "connectorContract") {
        return reshaped;
      }
      const value: unknown = Reflect.get(target, key);
      return value;
    },
  });
  return { ...env, CONNECT: changed };
};

/** Core's env as it is, counting how often core asks connect for a contract. */
export const askCountingEnv = () => {
  let asks = 0;
  const counting = servingEnv((contract) => {
    asks += 1;
    return contract;
  });
  return { env: counting, asks: () => asks };
};

/** `contract` with `action`'s output schema replaced by `output`. */
export const withOutput =
  (action: string, output: unknown) =>
  (contract: ConnectorContract): ConnectorContract => {
    const served = contract.actions[action];
    return served === undefined
      ? contract
      : {
          ...contract,
          actions: {
            ...contract.actions,
            [action]: { ...served, output: JSON.stringify(output) },
          },
        };
  };

/** A stricter `list` answer than the connector's: at least one message. */
export const someMessages = {
  type: "object",
  properties: {
    mailbox: { type: "string" },
    messages: {
      type: "array",
      items: { type: "object", properties: {}, additionalProperties: false },
      minItems: 1,
    },
    nextPage: { type: ["string", "null"] },
  },
  required: ["mailbox", "messages", "nextPage"],
  additionalProperties: false,
};

/** The send held for the Mailer's builder, as their list shows it. */
export const heldSend = async ({ builder }: Mailer) => {
  const [held] = await builder.api.pendingActions.list();
  if (held === undefined) {
    throw new Error("Expected a held action");
  }
  return held;
};

// A Composio toolkit's contract, `composio.<toolkit>@1` (threat model on
// GRA-504): generated from what the connection's own server lists now, so
// Composio changing a tool after an admin approved the binding stops it
// until an admin approves again. The real connect runs behind core; only
// Composio's server is faked (test/mail-server.ts), with tools of a CRM
// toolkit.

/** What listing contacts takes, as the CRM's server first lists it. */
export const listArguments = { limit: { type: "integer", minimum: 1 } };

export const noContacts = { contacts: [] };

/** What listing contacts answers, as the CRM's server first lists it. */
export const listAnswer = {
  type: "object",
  properties: { contacts: { type: "array", items: { type: "string" } } },
  required: ["contacts"],
};

/**
 * A CRM toolkit's tools, as its Composio server lists them: listing takes
 * `listProperties` and answers `listOutput`.
 */
export const crmTools = ({
  listProperties = listArguments,
  listOutput = listAnswer,
}: { listProperties?: object; listOutput?: object } = {}) => [
  {
    name: "CRM_LIST_CONTACTS",
    inputSchema: { type: "object", properties: listProperties, required: [] },
    outputSchema: listOutput,
  },
  {
    // Composio says it only reads; the admin didn't.
    name: "CRM_CREATE_CONTACT",
    inputSchema: {
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"],
    },
    annotations: { readOnlyHint: true },
  },
];

/**
 * What the CRM's tools answer: listing answers `contacts` (no contacts by
 * default), creating answers the created one's text.
 */
export const crmAnswers = (contacts: object = noContacts) => ({
  CRM_LIST_CONTACTS: {
    content: [{ type: "text", text: JSON.stringify(contacts) }],
    structuredContent: contacts,
  },
  CRM_CREATE_CONTACT: {
    content: [{ type: "text", text: "Created contact-1" }],
  },
});

/** The admin's allowlist: listing is a read, creating isn't. */
export const crmRules = (listIsRead = true) => [
  { name: "CRM_LIST_CONTACTS", read: listIsRead },
  "CRM_CREATE_CONTACT",
];

/** An App whose actions list and create contacts in the CRM. */
export const crmFiles = (): TestApp =>
  testApp(
    {
      name: "Contacts",
      tables: {
        notes: {
          fields: { title: "v.string()" },
          access: { read: "owner", write: "owner" },
        },
      },
      permissions: [
        'permission.connection("crm", {\n  contract: "composio.crm@1",\n  actions: ["CRM_LIST_CONTACTS", "CRM_CREATE_CONTACT"],\n})',
      ],
    },
    {
      "server/crm.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const crm = permissions.crm;

export const contacts = action({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const listed = await ctx.connections.crm.CRM_LIST_CONTACTS({ limit: 5 });
    return typeof listed === "object" && listed !== null && !Array.isArray(listed) && Array.isArray(listed.contacts)
      ? listed.contacts.length
      : -1;
  },
});

/** Lists with an argument the tool doesn't name. */
export const sloppy = action({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    await ctx.connections.crm.CRM_LIST_CONTACTS({ limit: 5, archived: true });
    return 0;
  },
});

export const create = action({
  args: { email: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const created = await ctx.connections.crm.CRM_CREATE_CONTACT({ email: args.email });
    return typeof created === "string" ? created : "";
  },
});
`,
    }
  );

/** An App reading contacts from two CRMs, each its own resource. */
export const twoCrmFiles = (): TestApp =>
  testApp(
    {
      name: "Two CRMs",
      tables: {
        notes: {
          fields: { title: "v.string()" },
          access: { read: "owner", write: "owner" },
        },
      },
      permissions: [
        'permission.connection("crm", {\n  contract: "composio.crm@1",\n  actions: ["CRM_LIST_CONTACTS"],\n})',
        'permission.connection("backup", {\n  contract: "composio.crm@1",\n  actions: ["CRM_LIST_CONTACTS"],\n})',
      ],
    },
    {
      "server/crm.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const crm = permissions.crm;

export const backup = permissions.backup;

export const contacts = action({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    await ctx.connections.crm.CRM_LIST_CONTACTS({ limit: 5 });
    await ctx.connections.backup.CRM_LIST_CONTACTS({ limit: 5 });
    return 0;
  },
});
`,
    }
  );

export const crmServerStateSchema = z.object({
  ran: z.array(z.object({ tool: z.string(), arguments: z.unknown() })),
});

/**
 * A shared CRM connection in connect's registry, as the Composio flow
 * leaves it, to a server of its own listing `crmTools()`.
 */
export const crmConnection = async () => {
  const name = `crm-${crypto.randomUUID()}`;
  const id = `connection-${name}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, status, server_kind, server, tools, created_at, updated_at) VALUES (?, 'crm', 'shared', 'active', 'composio', ?, ?, ?, ?)"
    )
    .bind(id, mailServerUrl(name), JSON.stringify(crmRules()), now, now)
    .run();
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  /** Changes what the server lists, or answers. */
  const serve = async (server: ToolkitServer): Promise<void> => {
    await providers.fetch(mailControlUrl(name), {
      method: "POST",
      body: JSON.stringify(server),
    });
  };
  await serve({ list: crmTools(), answers: crmAnswers() });
  return {
    id,
    serve,
    /** Makes its server's next look at its tools fail, as a 503. */
    unavailable: async () => {
      await providers.fetch(mailControlUrl(name), {
        method: "POST",
        body: JSON.stringify({ plan: ["unavailable"] }),
      });
    },
    /** Every call that reached one of its tools. */
    ran: async () => {
      const response = await providers.fetch(mailControlUrl(name));
      return crmServerStateSchema.parse(await response.json()).ran;
    },
    /** Sets the admin's allowlist, as editing it in connect would. */
    allow: async (tools: unknown[]): Promise<void> => {
      await connectDb()
        .prepare("UPDATE connections SET tools = ? WHERE id = ?")
        .bind(JSON.stringify(tools), id)
        .run();
    },
  };
};

/**
 * The Contacts App, current, with a permission on a CRM connection to its
 * two tools an admin granted, and its CRM resource bound to it unless
 * `bind` is false.
 */
export const contactsApp = async (
  options: {
    bind?: boolean;
    before?: (crm: CrmConnection) => Promise<void>;
  } = {}
) => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const created = await builder.api.apps.create({ name: "Contacts" });
  await commitApp(builder.api.apps.files, created.id, crmFiles(), "First");
  await builder.api.versions.rollback({ kind: "app", id: created.id }, 1);
  const crm = await crmConnection();
  await options.before?.(crm);
  const requested = await builder.api.permissions.request({
    subject: { type: "app", appId: created.id },
    object: { type: "connection", connectionId: crm.id },
    actions: ["CRM_LIST_CONTACTS", "CRM_CREATE_CONTACT"],
    binding: "CRM",
  });
  await admin.api.permissions.grant(requested.id, { version: 1 });
  const approval = {
    app: created.id,
    alias: "crm",
    target: { kind: "connector" as const, permissionId: requested.id },
    reviewed: { version: 1 },
  };
  const approve = async () =>
    await admin.api.resourceBindings.approve(approval);
  if (options.bind !== false) {
    await approve();
  }
  return {
    admin,
    builder,
    by: await builder.api.whoami(),
    release: await loadRelease(env, created.id, 1),
    crm,
    approve,
  };
};

export type CrmConnection = Awaited<ReturnType<typeof crmConnection>>;
