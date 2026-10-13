import type {
  ConnectorContract,
  ConnectorContractRequest,
} from "@grasp-os/shared/connect";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import {
  appResourceBindings,
  permissions as permissionRows,
} from "../src/db/core/schema.ts";
import { confirmPendingAction } from "../src/pending-actions.ts";
import {
  approveResourceBinding,
  reviewResourceBindings,
} from "../src/resource-bindings.ts";
import { consentCode, graphSentUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { mailControlUrl, mailServerUrl } from "./mail-server.ts";
import type { ToolkitServer } from "./mail-server.ts";
import { planOf, recordedQueries } from "./query-plans.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";

// An App's connector resources reach an outside system only through
// connect, under a binding an admin approved and the App's own connection
// permission, checked against the generated connector contract both ways
// (spec 12). This runs the real connect and its native Microsoft 365
// connector, with only Microsoft's sign-in and Graph faked.

const idp = mockIdp();

/** An App whose actions send and list mail through Microsoft 365. */
const mailFiles = (
  contract = "microsoft-365.mail@1",
  actions = `["send", "list"]`
): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ notes: defineTable({ title: v.string() }) });
`,
  "operations/mail.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const mail = resource.connector("mail", {
  contract: "${contract}",
  actions: ${actions},
});

export const send = action({
  args: { to: v.string().email(), subject: v.string().min(1) },
  returns: v.object({ mailbox: v.string(), sent: v.boolean() }),
  uses: [mail],
  handler: async (ctx, args) => {
    const sent = await ctx.resources.mail.call("send", {
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
  uses: [mail],
  handler: async (ctx) => {
    const listed = await ctx.resources.mail.call("list", { mailbox: "team@acme.test" });
    return typeof listed === "object" && listed !== null && !Array.isArray(listed) && Array.isArray(listed.messages)
      ? listed.messages.length
      : -1;
  },
});

/** Sends a subject of its own each time: one call key, another payload. */
export const sendFresh = action({
  args: {},
  returns: v.boolean(),
  uses: [mail],
  handler: async (ctx) => {
    await ctx.resources.mail.call("send", {
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
  uses: [mail],
  handler: async (ctx) => {
    const client = ctx.resources.mail;
    const listed = await client.call("list", { mailbox: "team@acme.test" });
    const prototype = Object.getPrototypeOf(client) ?? {};
    return [
      ...Object.getOwnPropertyNames(globalThis),
      ...Object.getOwnPropertyNames(client),
      ...Object.getOwnPropertyNames(prototype),
      JSON.stringify(listed),
      JSON.stringify(client),
      String(client.call),
    ].join(",");
  },
});

/** Sends without what the contract requires. */
export const careless = action({
  args: {},
  returns: v.string(),
  uses: [mail],
  handler: async (ctx) => {
    await ctx.resources.mail.call("send", { mailbox: "team@acme.test" });
    return "sent";
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { careless, inbox, mail, probe, send, sendFresh } from "./operations/mail.ts";
import schema from "./schema.ts";

export default app({
  name: "Mailer",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { mail: { send, inbox, careless, sendFresh, probe } },
  internalOperations: {},
  screens: [],
  uses: [mail],
});
`,
});

/** The Mailer, with a second alias of the same contract: its archive. */
const archiveFiles = (): Record<string, string> => ({
  ...mailFiles(),
  "operations/archive.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const archive = resource.connector("archive", {
  contract: "microsoft-365.mail@1",
  actions: ["send", "list"],
});

export const archived = action({
  args: {},
  returns: v.boolean(),
  uses: [archive],
  handler: async (ctx) => {
    await ctx.resources.archive.call("list", { mailbox: "team@acme.test" });
    return true;
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { archive, archived } from "./operations/archive.ts";
import { careless, inbox, mail, probe, send, sendFresh } from "./operations/mail.ts";
import schema from "./schema.ts";

export default app({
  name: "Mailer",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { mail: { send, inbox, careless, sendFresh, probe }, archive: { archived } },
  internalOperations: {},
  screens: [],
  uses: [mail, archive],
});
`,
});

/** The Mailer, declaring its mail resource still, with no action that uses it. */
const unusedMailFiles = (): Record<string, string> => ({
  "operations/mail.ts": `import { resource, v } from "@grasp-os/sdk";
import { query } from "#grasp/server";

export const mail = resource.connector("mail", {
  contract: "microsoft-365.mail@1",
  actions: ["send", "list"],
});

export const ping = query({ args: {}, returns: v.string(), handler: () => "pong" });
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { mail, ping } from "./operations/mail.ts";
import schema from "./schema.ts";

export default app({
  name: "Mailer",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { mail: { ping } },
  internalOperations: {},
  screens: [],
  uses: [mail],
});
`,
});

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** A shared Microsoft 365 account, connected by `admin`: its ID. */
const connectShared = async (admin: Person): Promise<string> => {
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

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** What Graph sent, in order. */
const graphSent = async (): Promise<unknown[]> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  const response = await providers.fetch(graphSentUrl);
  return z.array(z.unknown()).parse(await response.json());
};

/** How many messages Graph sent with `subject` (each test's own). */
const sentCount = async (subject: string): Promise<number> => {
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
const mailerApp = async (
  options: {
    tools?: string[];
    contract?: string;
    bind?: boolean;
    files?: Record<string, string>;
  } = {}
) => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const created = await builder.api.apps.create({ name: "Mailer" });
  await builder.api.apps.files.commit(
    created.id,
    options.files ?? mailFiles(options.contract),
    "First"
  );
  await builder.api.apps.versions.setCurrent(created.id, 1);
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

type Mailer = Awaited<ReturnType<typeof mailerApp>>;

/** Calls `path` of the Mailer as its builder, under the call key `key`. */
const call = async (
  { by, release }: Pick<Mailer, "by" | "release">,
  path: string,
  input: unknown,
  key?: string,
  callEnv: Env = env
): Promise<OperationResult> => {
  const operation = release.app.operations[path];
  const answered = await callAppFunction(
    callEnv,
    by,
    release.manifest.resourceId,
    JSON.stringify({
      reference: {
        resourceId: release.manifest.resourceId,
        resourceVersion: release.manifest.resourceVersion,
        contractId: path,
        fingerprint: release.fingerprints[path] ?? "",
        kind: operation?.kind ?? "action",
      },
      input,
      ...(key === undefined ? {} : { idempotencyKey: key }),
    })
  );
  return answered.result;
};

const outcomeOf = (result: OperationResult): Json =>
  result.ok ? result.value : { failed: result.error.code };

/** The Mailer's declared resources and what its admin may bind each to. */
const choicesOf = async ({ admin, release }: Mailer) => {
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
const failure = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? String(Reflect.get(error, "code")) : "?";
  }
  return "ok";
};

/** Confirms every held action waiting for the Mailer's builder. */
const confirmAll = async ({
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
const servingEnv = (
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
const askCountingEnv = () => {
  let asks = 0;
  const counting = servingEnv((contract) => {
    asks += 1;
    return contract;
  });
  return { env: counting, asks: () => asks };
};

/** `contract` with `action`'s output schema replaced by `output`. */
const withOutput =
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
const someMessages = {
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
const heldSend = async ({ builder }: Mailer) => {
  const [held] = await builder.api.pendingActions.list();
  if (held === undefined) {
    throw new Error("Expected a held action");
  }
  return held;
};

describe("connector resource bindings", { timeout: 120_000 }, () => {
  it("read through connect under the App's connection grant", async () => {
    const mailer = await mailerApp();
    expect(outcomeOf(await call(mailer, "mail.inbox", {}))).toBe(0);
  });

  it("find a call's binding by the index of active bindings, reading no bindings whole", async () => {
    const mailer = await mailerApp();
    const queries = await recordedQueries(async () => {
      await call(mailer, "mail.inbox", {});
    });
    const plans = await Promise.all(
      queries
        .filter(({ query }) => /from "app_resource_bindings"/u.test(query))
        .map(async (recorded) => await planOf(recorded))
    );

    expect({
      looked: plans.length > 0,
      plans: new Set(plans.flat()),
    }).toStrictEqual({
      looked: true,
      plans: new Set([
        "SEARCH app_resource_bindings USING INDEX app_resource_bindings_active_idx (app_id=? AND alias=?)",
      ]),
    });
  });

  it("hold a side effect for the person, then answer it once, under the call's key", async () => {
    const mailer = await mailerApp();
    const input = { to: "ada@acme.test", subject: "Launch" };
    const held = await call(mailer, "mail.send", input, "launch-1");
    const whileHeld = await graphSent();
    await confirmAll(mailer);
    const answered = await call(mailer, "mail.send", input, "launch-1");
    const again = await call(mailer, "mail.send", input, "launch-1");
    expect({
      held: outcomeOf(held),
      sentWhileHeld: whileHeld.length,
      answered: outcomeOf(answered),
      again: outcomeOf(again),
    }).toStrictEqual({
      held: { failed: "resource.awaiting_confirmation" },
      sentWhileHeld: 0,
      answered: { mailbox: "team@acme.test", sent: true },
      again: { mailbox: "team@acme.test", sent: true },
    });
    // Sent once, as the person confirmed it: the repeats replayed it.
    await expect(graphSent()).resolves.toStrictEqual([
      { mailbox: "team@acme.test", subject: "Launch", to: ["ada@acme.test"] },
    ]);
  });

  it("refuse arguments the contract doesn't allow before connect sees them", async () => {
    const mailer = await mailerApp();
    const result = await call(mailer, "mail.careless", {});
    const pending = await mailer.builder.api.pendingActions.list();
    expect({ outcome: outcomeOf(result), held: pending.length }).toStrictEqual({
      outcome: { failed: "resource.invalid_args" },
      held: 0,
    });
  });

  it("stop a binding once connect serves another contract than was approved", async () => {
    const mailer = await mailerApp();
    const changed = servingEnv(withOutput("list", someMessages));
    const reshaped = await call(mailer, "mail.inbox", {}, undefined, changed);
    // A connection that is gone serves no contract at all.
    const listed = await mailer.admin.api.connections.list();
    const shared = listed.find((connection) => connection.scope === "shared");
    await mailer.admin.api.connections.disconnect(shared?.id ?? "");
    const disconnected = await call(mailer, "mail.inbox", {});
    expect({
      reshaped: outcomeOf(reshaped),
      disconnected: outcomeOf(disconnected),
    }).toStrictEqual({
      reshaped: { failed: "resource.unavailable" },
      disconnected: { failed: "resource.unavailable" },
    });
  });

  it("refuse an answer outside the contract connect serves", async () => {
    const mailer = await mailerApp({ bind: false });
    const changed = servingEnv(withOutput("list", someMessages));
    // Approved against the stricter contract, which the real answer (no
    // messages) breaks.
    const admin = await mailer.admin.api.whoami();
    await approveResourceBinding(changed, admin, mailer.approval);
    const result = await call(mailer, "mail.inbox", {}, undefined, changed);
    expect(outcomeOf(result)).toStrictEqual({
      failed: "contract.invalid_resource_result",
    });
  });

  it("carry the connections a call read into its provenance", async () => {
    const mailer = await mailerApp();
    const answered = await callAppFunction(
      env,
      mailer.by,
      mailer.release.manifest.resourceId,
      JSON.stringify({
        reference: {
          resourceId: mailer.release.manifest.resourceId,
          resourceVersion: 1,
          contractId: "mail.inbox",
          fingerprint: mailer.release.fingerprints["mail.inbox"] ?? "",
          kind: "action",
        },
        input: {},
      })
    );
    const permissions = await mailer.admin.api.permissions.list();
    const connection = permissions.find(({ id }) => id === mailer.permission);
    expect(answered.provenance?.truncated).toBeFalsy();
    expect(answered.provenance?.connections).toStrictEqual([
      {
        connectionId:
          connection?.object.type === "connection"
            ? connection.object.connectionId
            : "",
        resources: [],
      },
    ]);
  });

  it("refuse side effects of a version made current without an admin, until one grants it again", async () => {
    const mailer = await mailerApp();
    // The builder's next version changes nothing the binding approved,
    // but makes the connection permission asked for again.
    await mailer.builder.api.apps.files.commit(
      mailer.release.manifest.resourceId,
      { "README.md": "Mailer." },
      "Docs"
    );
    await mailer.builder.api.apps.versions.setCurrent(
      mailer.release.manifest.resourceId,
      2
    );
    const next = {
      ...mailer,
      release: await loadRelease(
        env,
        appIdSchema.parse(mailer.release.manifest.resourceId),
        2
      ),
    };
    const input = { to: "ada@acme.test", subject: "Unapproved" };
    const unapproved = await call(next, "mail.send", input, "next-1");
    await mailer.admin.api.permissions.grant(mailer.permission, {
      version: 2,
    });
    // The binding carries over to the identical declaration.
    const granted = await call(next, "mail.send", input, "next-2");
    expect({
      unapproved: outcomeOf(unapproved),
      granted: outcomeOf(granted),
      sent: await sentCount("Unapproved"),
    }).toStrictEqual({
      unapproved: { failed: "resource.unavailable" },
      granted: { failed: "resource.awaiting_confirmation" },
      sent: 0,
    });
  });

  it("refuse a call key replayed with another payload", async () => {
    const mailer = await mailerApp();
    await call(mailer, "mail.sendFresh", {}, "fresh-1");
    const replayed = await call(mailer, "mail.sendFresh", {}, "fresh-1");
    expect(outcomeOf(replayed)).toStrictEqual({
      failed: "resource.idempotency_conflict",
    });
  });

  it("answer a declined side effect as declined, under its call's key, never sent", async () => {
    const mailer = await mailerApp();
    const input = { to: "ada@acme.test", subject: "Declined" };
    await call(mailer, "mail.send", input, "declined-1");
    const waiting = await heldSend(mailer);
    await mailer.builder.api.pendingActions.decline(waiting.id);
    const again = await call(mailer, "mail.send", input, "declined-1");
    expect({
      again: outcomeOf(again),
      sent: await sentCount("Declined"),
    }).toStrictEqual({
      again: { failed: "resource.declined" },
      sent: 0,
    });
  });

  it("drop a held side effect when its binding is revoked", async () => {
    const mailer = await mailerApp();
    await call(
      mailer,
      "mail.send",
      { to: "ada@acme.test", subject: "Late" },
      "late-1"
    );
    await mailer.admin.api.resourceBindings.revoke(mailer.binding?.id ?? "");
    const waiting = await mailer.builder.api.pendingActions.list();
    expect({
      waiting: waiting.length,
      sent: await sentCount("Late"),
    }).toStrictEqual({
      waiting: 0,
      sent: 0,
    });
  });

  it("refuse to confirm a held side effect its binding no longer serves, and drop it", async () => {
    const mailer = await mailerApp();
    await call(
      mailer,
      "mail.send",
      { to: "ada@acme.test", subject: "Stale" },
      "stale-1"
    );
    const held = await heldSend(mailer);
    // Revoked behind the API's back, so nothing dropped the held action:
    // only the check on confirming stands between it and Graph.
    await drizzle(env.DB)
      .update(appResourceBindings)
      .set({ status: "revoked", revokedAt: new Date(), revokedBy: "test" })
      .where(eq(appResourceBindings.id, mailer.binding?.id ?? ""));
    // Through the session, as the person's client confirms: the refusal
    // reaches it with its code, not redacted.
    const refused = await failure(
      async () =>
        await mailer.builder.api.pendingActions.confirm(held.id, held.inputHash)
    );
    const waiting = await mailer.builder.api.pendingActions.list();
    expect({
      refused,
      sent: await sentCount("Stale"),
      waiting: waiting.length,
    }).toStrictEqual({ refused: "resource.unavailable", sent: 0, waiting: 0 });
  });

  it("refuse to confirm a held side effect whose binding's budget was damaged since", async () => {
    const mailer = await mailerApp();
    await call(
      mailer,
      "mail.send",
      { to: "ada@acme.test", subject: "Damaged" },
      "damaged-1"
    );
    const held = await heldSend(mailer);
    // Its caps no longer read, as a live request would find them: it
    // would run uncapped, so it runs nothing.
    await drizzle(env.DB)
      .update(appResourceBindings)
      .set({ budget: "not a budget" })
      .where(eq(appResourceBindings.id, mailer.binding?.id ?? ""));
    const refused = await failure(
      async () =>
        await mailer.builder.api.pendingActions.confirm(held.id, held.inputHash)
    );
    const waiting = await mailer.builder.api.pendingActions.list();
    expect({
      refused,
      sent: await sentCount("Damaged"),
      waiting: waiting.length,
    }).toStrictEqual({ refused: "resource.unavailable", sent: 0, waiting: 0 });
  });

  it("refuse to confirm a held side effect whose contract drifted since", async () => {
    const mailer = await mailerApp();
    await call(
      mailer,
      "mail.send",
      { to: "ada@acme.test", subject: "Drift" },
      "drift-1"
    );
    const held = await heldSend(mailer);
    const changed = servingEnv(
      withOutput("send", {
        type: "object",
        properties: { mailbox: { type: "string" } },
        required: ["mailbox"],
        additionalProperties: false,
      })
    );
    const refused = await failure(
      async () =>
        await confirmPendingAction(changed, mailer.by, held.id, held.inputHash)
    );
    const waiting = await mailer.builder.api.pendingActions.list();
    expect({
      refused,
      sent: await sentCount("Drift"),
      waiting: waiting.length,
    }).toStrictEqual({ refused: "resource.unavailable", sent: 0, waiting: 0 });
  });

  it("refuse to confirm a held side effect once a version widened its declaration", async () => {
    const mailer = await mailerApp();
    await call(
      mailer,
      "mail.send",
      { to: "ada@acme.test", subject: "Wider" },
      "wider-1"
    );
    const held = await heldSend(mailer);
    const app = mailer.release.manifest.resourceId;
    await mailer.builder.api.apps.files.commit(
      app,
      mailFiles("microsoft-365.mail@1", `["send", "list", "createDraft"]`),
      "More"
    );
    await mailer.builder.api.apps.versions.setCurrent(app, 2);
    // An admin grants the connection again, approving the version: only
    // the binding, approved for the narrower declaration, is stale.
    await mailer.admin.api.permissions.grant(mailer.permission, { version: 2 });
    const refused = await failure(
      async () =>
        await confirmPendingAction(env, mailer.by, held.id, held.inputHash)
    );
    const waiting = await mailer.builder.api.pendingActions.list();
    expect({
      refused,
      sent: await sentCount("Wider"),
      waiting: waiting.length,
    }).toStrictEqual({ refused: "resource.unavailable", sent: 0, waiting: 0 });
  });

  it("leave a dropped held call's key free: the same call is asked again, never answered as declined", async () => {
    const mailer = await mailerApp();
    const input = { to: "ada@acme.test", subject: "Again" };
    await call(mailer, "mail.send", input, "again-1");
    // Approved again: the binding is replaced, its held call dropped.
    await mailer.admin.api.resourceBindings.approve(mailer.approval);
    const afterReplace = await call(mailer, "mail.send", input, "again-1");
    // Revoked, then approved anew: dropped again.
    const [current] = await mailer.admin.api.resourceBindings.list(
      mailer.release.manifest.resourceId
    );
    await mailer.admin.api.resourceBindings.revoke(current?.id ?? "");
    await mailer.admin.api.resourceBindings.approve(mailer.approval);
    const afterRevoke = await call(mailer, "mail.send", input, "again-1");
    expect({
      afterReplace: outcomeOf(afterReplace),
      afterRevoke: outcomeOf(afterRevoke),
      sent: await sentCount("Again"),
    }).toStrictEqual({
      afterReplace: { failed: "resource.awaiting_confirmation" },
      afterRevoke: { failed: "resource.awaiting_confirmation" },
      sent: 0,
    });
  });

  it("refuse to confirm a held call whose stored binding no longer reads", async () => {
    const mailer = await mailerApp();
    await call(
      mailer,
      "mail.send",
      { to: "ada@acme.test", subject: "Garbled" },
      "garbled-1"
    );
    const held = await heldSend(mailer);
    await connectDb()
      .prepare("UPDATE pending_actions SET binding = ? WHERE id = ?")
      .bind("not a binding", held.id)
      .run();
    const refused = await failure(
      async () =>
        await mailer.builder.api.pendingActions.confirm(held.id, held.inputHash)
    );
    expect({ refused, sent: await sentCount("Garbled") }).toStrictEqual({
      refused: "resource.unavailable",
      sent: 0,
    });
  });

  it("refuse to confirm a held call once no action of the current version uses its alias", async () => {
    const mailer = await mailerApp();
    await call(
      mailer,
      "mail.send",
      { to: "ada@acme.test", subject: "Unused" },
      "unused-1"
    );
    const held = await heldSend(mailer);
    const app = mailer.release.manifest.resourceId;
    await mailer.builder.api.apps.files.commit(app, unusedMailFiles(), "Quiet");
    await mailer.builder.api.apps.versions.setCurrent(app, 2);
    await mailer.admin.api.permissions.grant(mailer.permission, { version: 2 });
    const refused = await failure(
      async () =>
        await mailer.builder.api.pendingActions.confirm(held.id, held.inputHash)
    );
    expect({ refused, sent: await sentCount("Unused") }).toStrictEqual({
      refused: "resource.unavailable",
      sent: 0,
    });
  });

  it("expose no binding, key or token to App code", async () => {
    const mailer = await mailerApp();
    const result = await call(mailer, "mail.probe", {});
    const seen =
      result.ok && typeof result.value === "string" ? result.value : "";
    const names = new Set(seen.split(","));
    // Core's and connect's bindings and secrets, by name and by value.
    const bindings = [
      "CONNECT",
      "DB",
      "AI",
      "KNOWLEDGE",
      "LOADER",
      "APPS",
      "DATA_STORES",
      "FILES",
      "WORKSPACES",
      "MODEL_GATEWAY",
      "CAPABILITY_SIGNING_KEY",
      "TOKEN_ENCRYPTION_KEY",
      "env",
    ];
    const secrets = [
      env.CAPABILITY_SIGNING_KEY,
      env.BETTER_AUTH_SECRET,
      "access.",
      "refresh.",
      "Bearer",
    ];
    expect({
      probed: seen.length > 0,
      bindings: bindings.filter((name) => names.has(name)),
      secrets: secrets.filter((secret) => seen.includes(secret)),
    }).toStrictEqual({ probed: true, bindings: [], secrets: [] });
  });

  it("stop when the connection permission is revoked", async () => {
    const mailer = await mailerApp();
    await mailer.admin.api.permissions.revoke(mailer.permission);
    expect(outcomeOf(await call(mailer, "mail.inbox", {}))).toStrictEqual({
      failed: "resource.unavailable",
    });
  });

  it("bind only a contract the connection serves, for tools it allows", async () => {
    const narrow = await mailerApp({ tools: ["mail.list"], bind: false });
    const google = await mailerApp({
      contract: "google-workspace.mail@1",
      bind: false,
    });
    const unknown = await mailerApp({ contract: "grasp.mail@1", bind: false });
    const refusal = async ({ admin, approval }: Mailer) =>
      await failure(
        async () => await admin.api.resourceBindings.approve(approval)
      );
    expect({
      // The permission doesn't allow `mail.send`.
      narrow: await refusal(narrow),
      // A Microsoft connection serves no Google contract.
      google: await refusal(google),
      // No connector generates it.
      unknown: await refusal(unknown),
    }).toStrictEqual({
      narrow: "resource.target_invalid",
      google: "resource.target_invalid",
      unknown: "resource.target_invalid",
    });
  });

  it("offer an admin only the connection permissions that serve the declared actions", async () => {
    const narrow = await mailerApp({ tools: ["mail.list"], bind: false });
    const full = await mailerApp({ bind: false });
    const db = drizzle(env.DB);
    const granted = await db
      .select()
      .from(permissionRows)
      .where(eq(permissionRows.id, full.permission))
      .get();
    const connectionId = granted?.objectId ?? "";
    // On the same connection, the Mailer also holds a permission that
    // doesn't allow `mail.send`, and a copy of its full one that holds in
    // one chat only: neither is offered, nor is the other App's.
    const listOnly = await full.builder.api.permissions.request({
      subject: { type: "app", appId: full.release.manifest.resourceId },
      object: { type: "connection", connectionId },
      actions: ["mail.list"],
      binding: "MAIL_LIST",
    });
    await full.admin.api.permissions.grant(listOnly.id, { version: 1 });
    if (granted !== undefined) {
      await db.insert(permissionRows).values({
        ...granted,
        id: crypto.randomUUID(),
        chatId: crypto.randomUUID(),
      });
    }
    expect({
      narrow: await choicesOf(narrow),
      full: await choicesOf(full),
    }).toStrictEqual({
      // The permission doesn't allow `mail.send`, which the App declares.
      narrow: [
        {
          alias: "mail",
          state: "unbound",
          actions: ["send", "list"],
          choices: { kind: "connector", permissions: [], truncated: false },
        },
      ],
      full: [
        {
          alias: "mail",
          state: "unbound",
          actions: ["send", "list"],
          choices: {
            kind: "connector",
            permissions: [
              {
                permissionId: full.permission,
                connectionId,
                resource: null,
              },
            ],
            truncated: false,
          },
        },
      ],
    });
  });

  it("ask connect once per connection and contract in a review, however many bindings and choices name it", async () => {
    // A second alias of the same contract, bound to the same permission.
    const mailer = await mailerApp({ files: archiveFiles() });
    const app = mailer.release.manifest.resourceId;
    await mailer.admin.api.resourceBindings.approve({
      ...mailer.approval,
      alias: "archive",
    });
    const counted = askCountingEnv();
    const review = await reviewResourceBindings(
      counted.env,
      await mailer.admin.api.whoami(),
      app
    );
    expect({
      states: review.resources.map(({ alias, state }) => [alias, state]),
      offered: review.resources.map(
        ({ choices }) =>
          choices?.kind === "connector" && choices.permissions.length
      ),
      truncated: review.truncated,
      asks: counted.asks(),
    }).toStrictEqual({
      states: [
        ["archive", "served"],
        ["mail", "served"],
      ],
      offered: [1, 1],
      truncated: false,
      asks: 1,
    });
  });

  it("never report a connector binding served when the review's asks run out", async () => {
    const mailer = await mailerApp();
    const counted = askCountingEnv();
    const review = await reviewResourceBindings(
      counted.env,
      await mailer.admin.api.whoami(),
      mailer.release.manifest.resourceId,
      0
    );
    expect({
      states: review.resources.map(({ state }) => state),
      choices: review.resources.map(({ choices }) => choices),
      truncated: review.truncated,
      asks: counted.asks(),
    }).toStrictEqual({
      states: ["unchecked"],
      choices: [{ kind: "connector", permissions: [], truncated: true }],
      truncated: true,
      asks: 0,
    });
  });

  it("name a connector binding's own connection for the App's builder, with no choices", async () => {
    const mailer = await mailerApp();
    const review = await mailer.builder.api.resourceBindings.review(
      mailer.release.manifest.resourceId
    );
    const listed = await mailer.builder.api.connections.list();
    const granted = await drizzle(env.DB)
      .select({ objectId: permissionRows.objectId })
      .from(permissionRows)
      .where(eq(permissionRows.id, mailer.permission))
      .get();
    const connection = listed.find(({ id }) => id === granted?.objectId);
    expect(
      review.resources.map(({ binding, choices }) => ({
        label: binding?.label,
        choices,
      }))
    ).toStrictEqual([
      {
        label: {
          connection: {
            account: connection?.accountName ?? null,
            provider: "microsoft",
          },
          collections: {},
        },
        choices: null,
      },
    ]);
  });

  it("say a connector binding no longer serves once its contract changed or its connection is gone", async () => {
    const mailer = await mailerApp();
    const admin = await mailer.admin.api.whoami();
    const app = mailer.release.manifest.resourceId;
    const stateIn = async (reviewEnv: Env) => {
      const review = await reviewResourceBindings(reviewEnv, admin, app);
      return review.resources.map(({ state }) => state);
    };
    const served = await stateIn(env);
    const reshaped = await stateIn(
      servingEnv(withOutput("list", someMessages))
    );
    const listed = await mailer.admin.api.connections.list();
    const shared = listed.find((connection) => connection.scope === "shared");
    await mailer.admin.api.connections.disconnect(shared?.id ?? "");
    expect({
      served,
      reshaped,
      disconnected: await stateIn(env),
    }).toStrictEqual({
      served: ["served"],
      reshaped: ["contract_changed"],
      disconnected: ["grant_lost"],
    });
  });
});

// A Composio toolkit's contract, `composio.<toolkit>@1` (threat model on
// GRA-504): generated from what the connection's own server lists now, so
// Composio changing a tool after an admin approved the binding stops it
// until an admin approves again. The real connect runs behind core; only
// Composio's server is faked (test/mail-server.ts), with tools of a CRM
// toolkit.

/** What listing contacts takes, as the CRM's server first lists it. */
const listArguments = { limit: { type: "integer", minimum: 1 } };

const noContacts = { contacts: [] };

/** What listing contacts answers, as the CRM's server first lists it. */
const listAnswer = {
  type: "object",
  properties: { contacts: { type: "array", items: { type: "string" } } },
  required: ["contacts"],
};

/**
 * A CRM toolkit's tools, as its Composio server lists them: listing takes
 * `listProperties` and answers `listOutput`.
 */
const crmTools = ({
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
const crmAnswers = (contacts: object = noContacts) => ({
  CRM_LIST_CONTACTS: {
    content: [{ type: "text", text: JSON.stringify(contacts) }],
    structuredContent: contacts,
  },
  CRM_CREATE_CONTACT: {
    content: [{ type: "text", text: "Created contact-1" }],
  },
});

/** The admin's allowlist: listing is a read, creating isn't. */
const crmRules = (listIsRead = true) => [
  { name: "CRM_LIST_CONTACTS", read: listIsRead },
  "CRM_CREATE_CONTACT",
];

/** An App whose actions list and create contacts in the CRM. */
const crmFiles = (): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ notes: defineTable({ title: v.string() }) });
`,
  "operations/crm.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const crm = resource.connector("crm", {
  contract: "composio.crm@1",
  actions: ["CRM_LIST_CONTACTS", "CRM_CREATE_CONTACT"],
});

export const contacts = action({
  args: {},
  returns: v.number(),
  uses: [crm],
  handler: async (ctx) => {
    const listed = await ctx.resources.crm.call("CRM_LIST_CONTACTS", { limit: 5 });
    return typeof listed === "object" && listed !== null && !Array.isArray(listed) && Array.isArray(listed.contacts)
      ? listed.contacts.length
      : -1;
  },
});

/** Lists with an argument the tool doesn't name. */
export const sloppy = action({
  args: {},
  returns: v.number(),
  uses: [crm],
  handler: async (ctx) => {
    await ctx.resources.crm.call("CRM_LIST_CONTACTS", { limit: 5, archived: true });
    return 0;
  },
});

export const create = action({
  args: { email: v.string() },
  returns: v.string(),
  uses: [crm],
  handler: async (ctx, args) => {
    const created = await ctx.resources.crm.call("CRM_CREATE_CONTACT", { email: args.email });
    return typeof created === "string" ? created : "";
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { contacts, create, crm, sloppy } from "./operations/crm.ts";
import schema from "./schema.ts";

export default app({
  name: "Contacts",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { crm: { contacts, create, sloppy } },
  internalOperations: {},
  screens: [],
  uses: [crm],
});
`,
});

/** An App reading contacts from two CRMs, each its own resource. */
const twoCrmFiles = (): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ notes: defineTable({ title: v.string() }) });
`,
  "operations/crm.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const crm = resource.connector("crm", {
  contract: "composio.crm@1",
  actions: ["CRM_LIST_CONTACTS"],
});

export const backup = resource.connector("backup", {
  contract: "composio.crm@1",
  actions: ["CRM_LIST_CONTACTS"],
});

export const contacts = action({
  args: {},
  returns: v.number(),
  uses: [crm, backup],
  handler: async (ctx) => {
    await ctx.resources.crm.call("CRM_LIST_CONTACTS", { limit: 5 });
    await ctx.resources.backup.call("CRM_LIST_CONTACTS", { limit: 5 });
    return 0;
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { backup, contacts, crm } from "./operations/crm.ts";
import schema from "./schema.ts";

export default app({
  name: "Two CRMs",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { crm: { contacts } },
  internalOperations: {},
  screens: [],
  uses: [crm, backup],
});
`,
});

const crmServerStateSchema = z.object({
  ran: z.array(z.object({ tool: z.string(), arguments: z.unknown() })),
});

/**
 * A shared CRM connection in connect's registry, as the Composio flow
 * leaves it, to a server of its own listing `crmTools()`.
 */
const crmConnection = async () => {
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
const contactsApp = async (
  options: {
    bind?: boolean;
    before?: (crm: CrmConnection) => Promise<void>;
  } = {}
) => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const created = await builder.api.apps.create({ name: "Contacts" });
  await builder.api.apps.files.commit(created.id, crmFiles(), "First");
  await builder.api.apps.versions.setCurrent(created.id, 1);
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

type CrmConnection = Awaited<ReturnType<typeof crmConnection>>;

describe("Composio connector resource bindings", { timeout: 120_000 }, () => {
  it("read through connect, under a contract generated from the connection's own server", async () => {
    const app = await contactsApp();
    const listed = await call(app, "crm.contacts", {});
    expect({
      listed: outcomeOf(listed),
      ran: await app.crm.ran(),
    }).toStrictEqual({
      listed: 0,
      ran: [{ tool: "CRM_LIST_CONTACTS", arguments: { limit: 5 } }],
    });
  });

  it("refuse an argument the tool doesn't name before Composio sees it", async () => {
    const app = await contactsApp();
    const result = await call(app, "crm.sloppy", {});
    expect({
      outcome: outcomeOf(result),
      ran: await app.crm.ran(),
    }).toStrictEqual({ outcome: { failed: "resource.invalid_args" }, ran: [] });
  });

  it("stop once Composio changes a tool, until an admin approves the binding again", async () => {
    const app = await contactsApp();
    await app.crm.serve({
      list: crmTools({
        listProperties: { ...listArguments, archived: { type: "boolean" } },
      }),
    });
    const drifted = await call(app, "crm.contacts", {});
    const ranWhileDrifted = await app.crm.ran();
    await app.approve();
    const approvedAgain = await call(app, "crm.contacts", {});
    expect({
      drifted: outcomeOf(drifted),
      ranWhileDrifted,
      approvedAgain: outcomeOf(approvedAgain),
    }).toStrictEqual({
      drifted: { failed: "resource.unavailable" },
      ranWhileDrifted: [],
      approvedAgain: 0,
    });
  });

  it("stop once the admin's rules for a tool change, or the tool leaves the allowlist", async () => {
    const app = await contactsApp();
    await app.crm.allow(crmRules(false));
    const notARead = await call(app, "crm.contacts", {});
    await app.crm.allow(["CRM_CREATE_CONTACT"]);
    const notAllowed = await call(app, "crm.contacts", {});
    expect({
      notARead: outcomeOf(notARead),
      notAllowed: outcomeOf(notAllowed),
      ran: await app.crm.ran(),
    }).toStrictEqual({
      notARead: { failed: "resource.unavailable" },
      notAllowed: { failed: "resource.unavailable" },
      ran: [],
    });
  });

  it("refuse an answer with more than the tool promises", async () => {
    const app = await contactsApp();
    await app.crm.serve({ answers: crmAnswers({ contacts: [], total: 0 }) });
    expect(outcomeOf(await call(app, "crm.contacts", {}))).toStrictEqual({
      failed: "contract.invalid_resource_result",
    });
  });

  it("hold a tool the admin didn't mark as a read, whatever Composio says of it, and answer its text", async () => {
    const app = await contactsApp();
    const input = { email: "ada@acme.test" };
    const held = await call(app, "crm.create", input, "create-1");
    const ranWhileHeld = await app.crm.ran();
    await confirmAll(app);
    const answered = await call(app, "crm.create", input, "create-1");
    expect({
      held: outcomeOf(held),
      ranWhileHeld,
      answered: outcomeOf(answered),
    }).toStrictEqual({
      held: { failed: "resource.awaiting_confirmation" },
      ranWhileHeld: [],
      answered: "Created contact-1",
    });
  });

  it("keep a held write waiting while Composio can't be reached to confirm it, and run it once it can", async () => {
    const app = await contactsApp();
    const input = { email: "grace@acme.test" };
    await call(app, "crm.create", input, "create-2");
    const [held] = await app.builder.api.pendingActions.list();
    if (held === undefined) {
      throw new Error("Expected a held action");
    }
    await app.crm.unavailable();
    const whileDown = await failure(
      async () =>
        await app.builder.api.pendingActions.confirm(held.id, held.inputHash)
    );
    const stillWaiting = await app.builder.api.pendingActions.list();
    await app.builder.api.pendingActions.confirm(held.id, held.inputHash);
    const answered = await call(app, "crm.create", input, "create-2");
    expect({
      whileDown,
      stillWaiting: stillWaiting.map(({ id }) => id),
      answered: outcomeOf(answered),
      ran: await app.crm.ran(),
    }).toStrictEqual({
      whileDown: "resource.unavailable",
      stillWaiting: [held.id],
      answered: "Created contact-1",
      ran: [{ tool: "CRM_CREATE_CONTACT", arguments: input }],
    });
  });

  it("bind no tool whose answer is open, and no contract while Composio can't be reached", async () => {
    const open = await contactsApp({
      bind: false,
      before: async (crm) => {
        await crm.serve({ list: crmTools({ listOutput: { type: "object" } }) });
      },
    });
    const app = await contactsApp();
    await app.crm.unavailable();
    const unreachable = await call(app, "crm.contacts", {});
    expect({
      open: await failure(open.approve),
      unreachable: outcomeOf(unreachable),
      ran: await app.crm.ran(),
    }).toStrictEqual({
      open: "resource.target_invalid",
      unreachable: { failed: "resource.unavailable" },
      ran: [],
    });
  });

  it("review the rest of an App's resources while one CRM's Composio server can't be reached, marking only that CRM unchecked", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const created = await builder.api.apps.create({ name: "Two CRMs" });
    await builder.api.apps.files.commit(created.id, twoCrmFiles(), "First");
    await builder.api.apps.versions.setCurrent(created.id, 1);
    const down = await crmConnection();
    const up = await crmConnection();
    const granted = async (crm: CrmConnection, binding: string) => {
      const requested = await builder.api.permissions.request({
        subject: { type: "app", appId: created.id },
        object: { type: "connection", connectionId: crm.id },
        actions: ["CRM_LIST_CONTACTS"],
        binding,
      });
      await admin.api.permissions.grant(requested.id, { version: 1 });
      return requested.id;
    };
    const downPermission = await granted(down, "CRM");
    const upPermission = await granted(up, "BACKUP");
    const approve = async (alias: string, permissionId: string) =>
      await admin.api.resourceBindings.approve({
        app: created.id,
        alias,
        target: { kind: "connector", permissionId },
        reviewed: { version: 1 },
      });
    await approve("crm", downPermission);
    await approve("backup", upPermission);
    await down.unavailable();
    const review = await admin.api.resourceBindings.review(created.id);
    // Each CRM is offered the reachable permission; the unreachable one is
    // neither offered nor ruled out, so the choices say they are partial.
    const offered = {
      kind: "connector",
      permissions: [
        { permissionId: upPermission, connectionId: up.id, resource: null },
      ],
      truncated: true,
    };
    expect({
      resources: review.resources.map(({ alias, state, choices }) => ({
        alias,
        state,
        choices,
      })),
      truncated: review.truncated,
    }).toStrictEqual({
      resources: [
        { alias: "backup", state: "served", choices: offered },
        { alias: "crm", state: "unchecked", choices: offered },
      ],
      truncated: false,
    });
  });
});
