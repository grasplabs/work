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
import { appResourceBindings } from "../src/db/core/schema.ts";
import { confirmPendingAction } from "../src/pending-actions.ts";
import { approveResourceBinding } from "../src/resource-bindings.ts";
import { consentCode, graphSentUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

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
import { careless, inbox, mail, send, sendFresh } from "./operations/mail.ts";
import schema from "./schema.ts";

export default app({
  name: "Mailer",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { mail: { send, inbox, careless, sendFresh } },
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
  options: { tools?: string[]; contract?: string; bind?: boolean } = {}
) => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const created = await builder.api.apps.create({ name: "Mailer" });
  await builder.api.apps.files.commit(
    created.id,
    mailFiles(options.contract),
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
  { by, release }: Mailer,
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
const confirmAll = async ({ builder }: Mailer): Promise<void> => {
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

  it("refuse to confirm a held side effect its binding no longer serves", async () => {
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
    const refused = await failure(
      async () =>
        await confirmPendingAction(env, mailer.by, held.id, held.inputHash)
    );
    expect({ refused, sent: await sentCount("Stale") }).toStrictEqual({
      refused: "resource.unavailable",
      sent: 0,
    });
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
    expect({ refused, sent: await sentCount("Drift") }).toStrictEqual({
      refused: "resource.unavailable",
      sent: 0,
    });
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
    expect({ refused, sent: await sentCount("Wider") }).toStrictEqual({
      refused: "resource.unavailable",
      sent: 0,
    });
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
});
