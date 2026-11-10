import { connectErrors } from "@grasp-os/shared/connect";
import type { OperationResult } from "@grasp-os/shared/operations";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { builtins, fingerprintOf, thisRelease } from "../src/builtins.ts";
import { httpContract, httpReadContract } from "../src/release-contracts.ts";
import { codeResults, codeStep, personalChatsOf, says } from "./agent-chat.ts";
import { commitApp, testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { requestGranted } from "./apps.ts";
import {
  httpApiInsideOrigin,
  httpApiOrigin,
  httpApiReceivedUrl,
} from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import {
  definitionOf,
  endedRun,
  jsonWorkflowAppsOf,
  publishedWorkflow,
  startedBy,
} from "./json-workflow-apps.ts";
import { signedInApi, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// An outside API an admin approved as an HTTP connection (GRA-1478), used
// by an App's action as a connector resource: through core's binding and
// permission checks and the real connect, with only the API and the DNS
// resolver faked (connect-providers.ts).

const idp = mockIdp();

const secret = "the-billing-api-test-credential";

/** An App whose actions read and create invoices at the billing API. */
const billingFiles = (): TestApp =>
  testApp(
    {
      name: "Invoices",
      tables: {
        notes: {
          fields: { title: "v.string()" },
          access: { read: "owner", write: "owner" },
        },
      },
      permissions: [
        'permission.connection("billing", {\n  contract: "http.request@1",\n  actions: ["get", "send"],\n})',
      ],
    },
    {
      "server/billing.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const billing = permissions.billing;

export const open = action({
  args: {},
  returns: v.object({ status: v.number(), count: v.number() }),
  handler: async (ctx) => {
    const response = await ctx.connections.billing.fetch("/v1/invoices?status=open", {
      headers: { accept: "application/json" },
    });
    const listed: { invoices: unknown[] } = await response.json();
    return { status: response.status, count: listed.invoices.length };
  },
});

export const create = action({
  args: { amount: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const response = await ctx.connections.billing.fetch("/v1/invoices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: args.amount }),
    });
    return response.status;
  },
});

/** Asks for what the admin never approved: the answer is its code. */
export const stray = action({
  args: { path: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    try {
      const response = await ctx.connections.billing.fetch(args.path);
      return String(response.status);
    } catch (error) {
      return String(Reflect.get(Object(error), "code"));
    }
  },
});
`,
    }
  );

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** What reached the outside API, in order. */
const received = async () => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  const response = await providers.fetch(httpApiReceivedUrl);
  return z
    .array(
      z.object({
        url: z.string(),
        method: z.string(),
        headers: z.record(z.string(), z.string()),
        body: z.string(),
      })
    )
    .parse(await response.json());
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

/** The Invoices App, current, bound to an HTTP connection an admin approved. */
const invoicesApp = async () => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const { connectionId } = await admin.api.connections.createHttp({
    name: "Billing API",
    origin: httpApiOrigin,
    pathPrefixes: ["/v1"],
    methods: ["GET", "POST"],
    credential: { kind: "bearer", token: secret },
  });
  const created = await builder.api.apps.create({ name: "Invoices" });
  await commitApp(builder.api.apps.files, created.id, billingFiles(), "First");
  await builder.api.apps.versions.setCurrent(created.id, 1);
  const requested = await builder.api.permissions.request({
    subject: { type: "app", appId: created.id },
    object: { type: "connection", connectionId },
    actions: ["get", "send"],
    binding: "BILLING",
  });
  await admin.api.permissions.grant(requested.id, { version: 1 });
  await admin.api.resourceBindings.approve({
    app: created.id,
    alias: "billing",
    target: { kind: "connector", permissionId: requested.id },
    reviewed: { version: 1 },
  });
  const release = await loadRelease(env, created.id, 1);
  const by: Identity = await builder.api.whoami();
  return { admin, builder, by, release, connectionId };
};

type Invoices = Awaited<ReturnType<typeof invoicesApp>>;

/** Calls `path` of the App as its builder, under the call key `key`. */
const call = async (
  { by, release }: Pick<Invoices, "by" | "release">,
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
      reference: { name: path, kind: operation?.kind ?? "action" },
      args: input,
      ...(key === undefined ? {} : { idempotencyKey: key }),
    })
  );
  return answered.result;
};

describe("an App calling an outside API", () => {
  it("is approved only by an admin, on an origin whose name leads to the public internet, never showing its credential", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const connection = {
      name: "Billing API",
      origin: httpApiOrigin,
      methods: ["GET" as const],
      credential: { kind: "bearer" as const, token: secret },
    };
    const refused = [
      await failure(
        async () => await builder.api.connections.createHttp(connection)
      ),
      await failure(
        async () =>
          await admin.api.connections.createHttp({
            ...connection,
            origin: httpApiInsideOrigin,
          })
      ),
      await failure(
        async () =>
          await admin.api.connections.createHttp({
            ...connection,
            origin: "https://169.254.169.254",
          })
      ),
    ];
    const { connectionId } = await admin.api.connections.createHttp(connection);
    const listed = await admin.api.connections.list();

    expect(refused).toStrictEqual([
      "role.forbidden",
      "connection.http_origin_refused",
      "connection.invalid",
    ]);
    expect(listed.find(({ id }) => id === connectionId)).toMatchObject({
      source: "http",
      http: { origin: httpApiOrigin, credentialHeader: "authorization" },
    });
    expect(JSON.stringify(listed)).not.toContain(secret);
  });

  it("reads through its binding with the credential connect adds, sends once its person confirms, and is refused off the approved paths or origin", async () => {
    const invoices = await invoicesApp();
    const before = await received();
    const opened = await call(invoices, "billing.open", {});
    const created = await call(
      invoices,
      "billing.create",
      { amount: 10 },
      "k1"
    );
    for (const held of await invoices.builder.api.pendingActions.list()) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await invoices.builder.api.pendingActions.confirm(
        held.id,
        held.inputHash
      );
    }
    const confirmed = await call(
      invoices,
      "billing.create",
      { amount: 10 },
      "k1"
    );
    const strays = await Promise.all(
      ["/v1/moved", "/admin", "/v1/../admin"].map(
        async (path) => await call(invoices, "billing.stray", { path })
      )
    );
    const all = await received();
    const reached = all.slice(before.length);

    expect(opened).toStrictEqual({
      ok: true,
      value: { status: 200, count: 1 },
    });
    expect(created).toMatchObject({
      ok: false,
      error: { code: "resource.awaiting_confirmation" },
    });
    expect(confirmed).toStrictEqual({ ok: true, value: 201 });
    expect(strays).toStrictEqual(
      ["/v1/moved", "/admin", "/v1/../admin"].map(() => ({
        ok: true,
        value: "resource.not_allowed",
      }))
    );
    // The redirect's request went out; the stray paths' never did. The
    // credential went with each, and came back with none.
    expect({
      reached: reached.map(({ method, url, headers, body }) => ({
        sent: `${method} ${url}`,
        authorization: headers.authorization,
        body,
      })),
      secretShown: JSON.stringify([opened, confirmed, strays]).includes(secret),
    }).toStrictEqual({
      reached: [
        {
          sent: `GET ${httpApiOrigin}/v1/invoices?status=open`,
          authorization: `Bearer ${secret}`,
          body: "",
        },
        {
          sent: `POST ${httpApiOrigin}/v1/invoices`,
          authorization: `Bearer ${secret}`,
          body: '{"amount":10}',
        },
        {
          sent: `GET ${httpApiOrigin}/v1/moved`,
          authorization: `Bearer ${secret}`,
          body: "",
        },
      ],
      secretShown: false,
    });
  });
});

describe("the chat and an outside API", () => {
  it("lists it only as one for Apps, and can neither ask for it nor call it, even granted", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const person = await signedInApi(idp, "user");
    const { connectionId } = await admin.api.connections.createHttp({
      name: "Billing API",
      origin: httpApiOrigin,
      pathPrefixes: ["/v1"],
      methods: ["GET"],
      credential: { kind: "bearer", token: secret },
    });
    const id = JSON.stringify(connectionId);
    const chats = await personalChatsOf(
      person.userId,
      codeStep(
        `export default async (self, env) => {
          const tried = async (work) => { try { return await work(); } catch (error) { return error.message; } };
          const available = await env.connections.available();
          return {
            listed: available.filter(({ connectionId }) => connectionId === ${id}),
            asked: await tried(() => env.connections.request({ connectionId: ${id}, actions: ["get"], binding: "ASKED", reason: "To list invoices." })),
            called: await tried(() => env.connections.call("API", "get", { path: "/v1/invoices" })),
          };
        };`
      ),
      says("Done.")
    );
    // Even an agent an admin granted it to can't call it from the chat.
    await requestGranted(idp, builder, {
      subject: { type: "agent", agentId: chats.agent.agentId },
      object: { type: "connection", connectionId },
      actions: ["get"],
      binding: "API",
    });
    const before = await received();
    const { chat, ask } = await chats.newChat();
    await ask("List the open invoices.");
    const steps = await codeResults(chats.stub, chat.id);
    const after = await received();

    expect(steps.map(({ text }) => text)).toStrictEqual([
      `Returned:\n${JSON.stringify({
        listed: [
          {
            connectionId,
            provider: "http",
            account: `Billing API (${httpApiOrigin})`,
            scope: "shared",
            actions: ["get"],
            decidedBy: "admin",
            forAppsOnly: true,
          },
        ],
        asked: permissionErrors.create("permission.invalid").message,
        called: connectErrors.create("connect.class_unknown").message,
      })}`,
    ]);
    expect(after).toHaveLength(before.length);
  });
});

/** A JSON workflow creating an invoice for `who` through binding `api`. */
const invoicingTasks = [
  {
    id: "create",
    type: "call",
    connection: "api",
    action: "send",
    args: {
      method: "POST",
      path: "/v1/invoices",
      headers: { "content-type": "application/json" },
      body: { $expr: "'{\"who\":\"' + args.who + '\"}'" },
    },
  },
];

/** What the workflow running `invoicingTasks` ends with: the API's answer. */
const invoicedStatus = {
  $expr: 'create.status + " " + create.body',
};

describe("a JSON workflow calling an outside API", () => {
  it("binds the release's HTTP contract to a connection an admin approved, and sends through connect", async () => {
    const { signedIn } = jsonWorkflowAppsOf(idp);
    const admin = await signedIn("admin");
    const builder = await signedIn("builder");
    await builtins(env).ensureInstalled(await fingerprintOf(thisRelease));
    const { connectionId } = await admin.api.connections.createHttp({
      name: "Billing API",
      origin: httpApiOrigin,
      pathPrefixes: ["/v1/invoices"],
      methods: ["GET", "POST"],
      credential: { kind: "header", header: "x-api-key", secret },
    });
    const workflow = await publishedWorkflow(builder, () =>
      definitionOf(invoicingTasks, {
        permissions: { connections: { api: { contract: httpContract } } },
        status: invoicedStatus,
      })
    );
    const requested = await builder.api.permissions.request({
      subject: { type: "workflow", workflowId: workflow.id },
      object: { type: "connection", connectionId },
      actions: ["get", "send"],
      binding: `API_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    await admin.api.permissions.grant(requested.id, { version: null });
    await admin.api.workflowResources.approveBinding(workflow.id, {
      alias: "api",
      target: {
        kind: "connector",
        permissionId: requested.id,
        contract: "http.request@1",
      },
      reviewed: { version: 1 },
    });
    const before = await received();
    const runId = await startedBy(builder, workflow.id, { who: "Ada" });
    const run = await endedRun(builder, workflow.id, runId);
    const all = await received();
    const reached = all.slice(before.length);

    expect({ status: run.status, output: run.result }).toStrictEqual({
      status: "completed",
      output: { status: '201 {"created":{"who":"Ada"}}' },
    });
    expect(
      reached.map(({ method, url, headers, body }) => ({
        method,
        url,
        key: headers["x-api-key"],
        body,
      }))
    ).toStrictEqual([
      {
        method: "POST",
        url: `${httpApiOrigin}/v1/invoices`,
        key: secret,
        body: '{"who":"Ada"}',
      },
    ]);
  });
});

/** A JSON workflow listing invoices through binding `api`. */
const listingTasks = [
  {
    id: "list",
    type: "call",
    connection: "api",
    action: "get",
    args: { path: "/v1/invoices" },
  },
];

describe("a JSON workflow's HTTP contract", () => {
  it("binds a connection allowing no change only as reads, and never asks reads for a change", async () => {
    const { signedIn } = jsonWorkflowAppsOf(idp);
    const admin = await signedIn("admin");
    const builder = await signedIn("builder");
    await builtins(env).ensureInstalled(await fingerprintOf(thisRelease));
    const { connectionId } = await admin.api.connections.createHttp({
      name: "Billing API",
      origin: httpApiOrigin,
      pathPrefixes: ["/v1/invoices"],
      methods: ["GET"],
      credential: { kind: "header", header: "x-api-key", secret },
    });
    /** Workflow `tasks` with `api` bound to `contract`, granted reads. */
    const granted = async (tasks: unknown[], contract: string) => {
      const workflow = await publishedWorkflow(builder, () =>
        definitionOf(tasks, {
          permissions: { connections: { api: { contract } } },
        })
      );
      const requested = await builder.api.permissions.request({
        subject: { type: "workflow", workflowId: workflow.id },
        object: { type: "connection", connectionId },
        actions: ["get"],
        binding: `API_${unique().toUpperCase().replaceAll("-", "_")}`,
      });
      await admin.api.permissions.grant(requested.id, { version: null });
      return { workflow, permissionId: requested.id };
    };
    const bind = async ({
      workflow,
      permissionId,
    }: Awaited<ReturnType<typeof granted>>) =>
      await failure(
        async () =>
          await admin.api.workflowResources.approveBinding(workflow.id, {
            alias: "api",
            target: {
              kind: "connector",
              permissionId,
              contract: "http.request@1",
            },
            reviewed: { version: 1 },
          })
      );

    const full = await bind(await granted(listingTasks, httpContract));
    const reads = await bind(await granted(listingTasks, httpReadContract));
    const sendOnReads = await failure(
      async () => await granted(invoicingTasks, httpReadContract)
    );

    expect({ full, reads, sendOnReads }).toStrictEqual({
      // The full contract's `send` has nothing to serve it.
      full: "workflow.binding_invalid",
      reads: "ok",
      // The reads' contract has no `send` to call.
      sendOnReads: "workflow.definition_invalid",
    });
  });
});
