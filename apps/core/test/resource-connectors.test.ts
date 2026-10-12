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
  contract = "microsoft-365.mail@1"
): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ notes: defineTable({ title: v.string() }) });
`,
  "operations/mail.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const mail = resource.connector("mail", {
  contract: "${contract}",
  actions: ["send", "list"],
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
import { careless, inbox, mail, send } from "./operations/mail.ts";
import schema from "./schema.ts";

export default app({
  name: "Mailer",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { mail: { send, inbox, careless } },
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
  key?: string
): Promise<OperationResult> => {
  const operation = release.app.operations[path];
  const answered = await callAppFunction(
    env,
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

  it("stop a binding whose contract drifted since it was approved", async () => {
    const mailer = await mailerApp();
    // As if the connector's release changed the actions' shape: what
    // connect serves now no longer has the fingerprint approved.
    await drizzle(env.DB)
      .update(appResourceBindings)
      .set({ fingerprint: "0".repeat(64) })
      .where(eq(appResourceBindings.id, mailer.binding?.id ?? ""));
    expect(outcomeOf(await call(mailer, "mail.inbox", {}))).toStrictEqual({
      failed: "resource.unavailable",
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
