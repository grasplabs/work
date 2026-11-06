import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import type {
  Authority,
  PermissionRequest,
} from "@grasp-os/shared/permissions";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { callAppFunction } from "../src/app-functions.ts";
import type { Release } from "../src/app-releases.ts";
import { appFor, commitFiles, setCurrentVersion } from "../src/apps.ts";
import { deleteStore } from "../src/data-stores.ts";
import { liveRuns } from "../src/live-runs.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { isRestricted, restrict } from "../src/restricted.ts";
import {
  callStoreOperation,
  storeOperationFor,
} from "../src/store-operations.ts";
import type { StoreConsumer } from "../src/store-operations.ts";
import {
  approveWorkflowBinding,
  callApprovedStoreOperation,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { appDefinition } from "./app-definitions.ts";
import { allEvents } from "./audit-events.ts";
import { appWith, person, seal, sweptAway } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { outcome, unique } from "./sign-in.ts";

// A business store's public operations, shared with other Apps and with
// independent workflows (store-operations.ts), from its threat model:
// calling an operation that isn't public, calling without an approved
// binding, a revoked grant still working, the store owner's privilege
// carried to the caller, and one consumer's data or keys reaching
// another. Each consumer goes in through what it really uses: an App's
// action through its declared store resource, called as a page calls
// it; a workflow's approval through the admin's RPC function, and its
// call through the function its runs call.

/** The App that owns the store: contacts, people's own notes, builders' secrets. */
const crmFiles = (
  listReturns = "v.array(v.string())",
  revision = 1
): Record<string, string> => ({
  ...appDefinition({
    name: "CRM",
    tables: {
      contacts: {
        fields: { name: "v.string()" },
        access: { read: "appMembers", write: "appMembers" },
      },
      notes: {
        fields: { text: "v.string()" },
        access: { read: "owner", write: "owner" },
      },
      secrets: {
        fields: { text: "v.string()" },
        access: { read: "appBuilders", write: "appBuilders" },
      },
    },
  }),
  "server/contacts.ts": `// Revision ${revision}.
import { v } from "@grasp-os/sdk";
import { action, internalQuery, mutation, query } from "@server/_generated/server";

export const list = query({
  args: {},
  returns: ${listReturns},
  handler: async (ctx) => (await ctx.db.query("contacts").take(100)).map(({ name }) => name).toSorted(),
});

export const add = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("contacts", { name: args.name });
    return null;
  },
});

export const count = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await ctx.db.query("contacts").take(100)).length,
});

export const ping = action({
  args: {},
  returns: v.null(),
  handler: async () => null,
});
`,
  "server/notes.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";

export const add = mutation({
  args: { text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("notes", { text: args.text });
    return null;
  },
});

export const mine = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map(({ text }) => text),
});
`,
  "server/secrets.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";

export const keep = mutation({
  args: { text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("secrets", { text: args.text });
    return null;
  },
});

export const list = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("secrets").take(100)).map(({ text }) => text),
});
`,
});

/** The CRM without tables: nothing to store, so no store binding. */
const tablelessFiles: Record<string, string> = {
  ...appDefinition({ name: "CRM", tables: {} }),
  "server/hello.ts": `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";
export const hello = query({ args: {}, returns: v.string(), handler: () => "hello" });
`,
};

/**
 * An App consuming the CRM's store through a store permission granted to
 * it (`storeOperationFor`): nothing of its own reaches it.
 */
const deskFiles: Record<string, string> = {
  ...appDefinition({
    name: "Desk",
    tables: {
      marks: {
        fields: { label: "v.string()" },
        access: { read: "owner", write: "owner" },
      },
    },
  }),
};

/** What the audit log recorded of `consumer`'s refused calls: path and why. */
const refusedOf = (events: readonly AuditEvent[], consumer: string) =>
  events
    .filter(
      ({ action, detail }) =>
        action === "store.operation.refused" && detail.consumer === consumer
    )
    .map(({ detail }) => [detail.operation, detail.reason]);

type Sealed = Fixture & { release: Release };

/** An App with `files`, sealed and current. */
const sealedApp = async (
  files: Record<string, string>,
  name?: string
): Promise<Sealed> => {
  const fixture = await appWith(files, name);
  const release = await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  return { ...fixture, release };
};

/** Commits `files` as the App's version `version`, seals it and makes it current. */
const nextVersion = async (
  sealed: Sealed,
  files: Record<string, string>,
  version: number
): Promise<Sealed> => {
  await commitFiles(env, sealed.owner, sealed.app, files, "Next version");
  const release = await seal(sealed, version);
  await setCurrentVersion(env, sealed.owner, sealed.app, version);
  return { ...sealed, release };
};

type Person = Awaited<ReturnType<typeof person>>;

/** `sealed`'s own authority, at version 1, as its restricted mode reads it. */
const authorityOf = (sealed: Sealed): Authority => ({
  subject: { type: "app", appId: appIdSchema.parse(sealed.app) },
  onBehalfOf: sealed.owner.userId,
  mode: "interactive",
  appVersion: 1,
});

/** `sealed`'s own work context. */
const contextOf = (sealed: Sealed) =>
  ({ type: "app", appId: appIdSchema.parse(sealed.app) }) as const;

/** What `by` gets calling `path` of `sealed`'s current release, as a page calls it. */
const call = async (
  by: Person,
  sealed: Sealed,
  path: string,
  input: unknown = {}
): Promise<unknown> => {
  const { release } = sealed;
  const operation = release.app.operations[path];
  const answer = await callAppFunction(
    env,
    by,
    sealed.app,
    JSON.stringify({
      reference: { name: path, kind: operation?.kind ?? "query" },
      input,
    })
  );
  if (!answer.result.ok) {
    return `refused:${answer.result.error.code}`;
  }
  const { value } = answer.result;
  return typeof value === "string" && !value.startsWith("error:")
    ? JSON.parse(value)
    : value;
};

/** How `by` names Apps and independent resources in a permission. */
const rolesOf = (by: Person) => ({
  app: async (named: string, role: "user" | "builder") =>
    await appFor(env, by, named, role),
  resource: async (
    ref: Parameters<typeof requireResourceRole>[2],
    needed: Parameters<typeof requireResourceRole>[3]
  ) => {
    await requireResourceRole(env, by, ref, needed);
  },
});

/** A binding name of its own, as a permission needs one. */
const bindingName = () =>
  `STORE_${unique().toUpperCase().replaceAll("-", "_")}`;

/**
 * A store permission `admin` asks for and grants: for App `subject` at its
 * current `version`, or for a workflow.
 */
const granted = async (
  admin: Person,
  request: Omit<PermissionRequest, "binding">,
  version: number | null
): Promise<string> => {
  const asked = await requestPermission(
    env,
    admin,
    { ...request, binding: bindingName() },
    rolesOf(admin)
  );
  await grantPermission(env, admin, asked.id, { version });
  return asked.id;
};

/** Desk's grant of `actions` on CRM's store. */
const deskGrant = async (
  admin: Person,
  desk: Sealed,
  crm: Sealed,
  actions: readonly string[]
): Promise<string> =>
  await granted(
    admin,
    {
      subject: { type: "app", appId: desk.app },
      object: { type: "store", storeId: crm.store },
      actions: [...actions],
    },
    desk.release.manifest.resourceVersion
  );

const crmActions = [
  "contacts.list",
  "contacts.add",
  "notes.add",
  "notes.mine",
  "secrets.list",
];

describe("a store operation's caller", () => {
  it("is refused, and recorded, once the person it acts for has left the organization", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    const leaver = await person("user");
    const consumer: StoreConsumer = {
      subject: { type: "app", id: desk.app },
      version: 1,
      permissionId: await deskGrant(admin, desk, crm, crmActions),
    };
    const served = await storeOperationFor(env, consumer, "contacts.add");
    if (served === undefined) {
      throw new Error("Expected the operation to be served");
    }
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(leaver.userId)
      .run();
    const refused = await outcome(
      callStoreOperation(
        env,
        consumer,
        served,
        { name: "Mallory" },
        {
          actor: { type: "person", userId: leaver.userId },
          principal: leaver.userId,
          requestId: crypto.randomUUID(),
          deadline: Date.now() + 30_000,
          idempotencyKey: `key-${unique()}`,
          runId: null,
        }
      )
    );
    expect({
      refused,
      recorded: refusedOf(await allEvents(), desk.app),
      crmSees: await call(crm.owner, crm, "contacts.list"),
    }).toStrictEqual({
      refused: "resource.unavailable",
      recorded: [["contacts.add", "permission.person_inactive"]],
      crmSees: [],
    });
  });
});

describe("a store operation's receipts", () => {
  it("refuse a key used again with other arguments as the consumer's conflict", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    const consumer: StoreConsumer = {
      subject: { type: "app", id: desk.app },
      version: 1,
      permissionId: await deskGrant(admin, desk, crm, crmActions),
    };
    const served = await storeOperationFor(env, consumer, "contacts.add");
    if (served === undefined) {
      throw new Error("Expected the operation to be served");
    }
    const key = `key-${unique()}`;
    const add = async (name: string) =>
      await outcome(
        callStoreOperation(
          env,
          consumer,
          served,
          { name },
          {
            actor: { type: "person", userId: desk.owner.userId },
            principal: desk.owner.userId,
            requestId: crypto.randomUUID(),
            deadline: Date.now() + 30_000,
            idempotencyKey: key,
            runId: null,
          }
        )
      );
    expect({
      first: await add("Ada"),
      other: await add("Mallory"),
      crmSees: await call(crm.owner, crm, "contacts.list"),
    }).toStrictEqual({
      first: "ok",
      other: "resource.idempotency_conflict",
      crmSees: ["Ada"],
    });
  });

  it("answer a key again only to the consumer that used it", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    const other = await sealedApp(deskFiles, "Other desk");
    const consumerOf = async (sealed: Sealed): Promise<StoreConsumer> => ({
      subject: { type: "app", id: sealed.app },
      version: 1,
      permissionId: await deskGrant(admin, sealed, crm, crmActions),
    });
    const consumers = [await consumerOf(desk), await consumerOf(other)];
    const key = `key-${unique()}`;
    for (const consumer of [...consumers, consumers[0]]) {
      if (consumer === undefined) {
        continue;
      }
      // One after the other: the second call of the first consumer finds
      // its own receipt.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const served = await storeOperationFor(env, consumer, "contacts.add");
      if (served === undefined) {
        throw new Error("Expected the operation to be served");
      }
      // oxlint-disable-next-line no-await-in-loop -- see above
      await callStoreOperation(
        env,
        consumer,
        served,
        { name: "Ada" },
        {
          actor: { type: "person", userId: desk.owner.userId },
          principal: desk.owner.userId,
          requestId: crypto.randomUUID(),
          deadline: Date.now() + 30_000,
          idempotencyKey: key,
          runId: null,
        }
      );
    }
    // The same key from the CRM's own page is the CRM's own receipt.
    await expect(call(crm.owner, crm, "contacts.list")).resolves.toStrictEqual([
      "Ada",
      "Ada",
    ]);
  });
});

/** A workflow's arguments for an operation that takes a name. */
const byName = { name: { $expr: "input.who" } };

/** A JSON object schema of `properties`, each required, and nothing else. */
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/**
 * A workflow with one operation binding, `lookup`, of catalog contract
 * `key`, which it calls with `args`.
 */
const workflowOf = async (
  owner: Person,
  key: string,
  args: Record<string, unknown>,
  before: unknown[] = []
) => {
  const workflow = await createWorkflowResource(env, owner, `crm-${unique()}`);
  await publishWorkflowVersion(env, owner, workflow.id, {
    definition: JSON.stringify({
      $schema: workflowSchemaUrl,
      input: object({ who: { type: "string" } }),
      output: {
        schema: object({ status: { type: "string" } }),
        value: { status: "done" },
      },
      bindings: { lookup: { kind: "operation", contract: key } },
      steps: [
        ...before,
        { id: "add", type: "do", binding: "lookup", arguments: args },
      ],
    }),
    basedOn: null,
  });
  return workflow;
};

/** An operation contract `admin` publishes, of `path`'s exact shapes in `release`. */
const contractOf = async (admin: Person, release: Release, path: string) => {
  const operation = release.app.operations[path];
  const key = `crm-${unique()}`;
  await publishCatalogContract(env, admin, {
    key,
    kind: "operation",
    input: JSON.stringify(operation?.args),
    output: JSON.stringify(operation?.returns),
  });
  return key;
};

describe("a workflow calling a store's public operation", () => {
  it("is approved only for a public query or mutation of the contract's exact shape, through its own permission", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const crm = await sealedApp(crmFiles(), "CRM");
    const key = await contractOf(admin, crm.release, "contacts.add");
    const workflow = await workflowOf(ada, key, byName);
    const permissionOf = async (actions: string[], of = workflow.id) =>
      await granted(
        admin,
        {
          subject: { type: "workflow", workflowId: of },
          object: { type: "store", storeId: crm.store },
          actions,
        },
        null
      );
    const approve = async (
      permissionId: string,
      operation: string,
      operationKind: "query" | "mutation" = "mutation"
    ) =>
      await outcome(
        approveWorkflowBinding(env, admin, workflow.id, {
          alias: "lookup",
          target: {
            kind: "storeOperation",
            permissionId,
            operation,
            operationKind,
          },
          reviewed: { version: 1 },
        })
      );
    const every = await permissionOf([
      "contacts.add",
      "contacts.count",
      "contacts.ping",
      "notes.add",
    ]);
    // The internal function and the action with the contract's shapes.
    const countKey = await contractOf(admin, crm.release, "contacts.count");
    const pingKey = await contractOf(admin, crm.release, "contacts.ping");
    const countWorkflow = await workflowOf(ada, countKey, {});
    const pingWorkflow = await workflowOf(ada, pingKey, {});
    const borrower = await workflowOf(ada, key, byName);
    // Each with a permission of its own listing it: still never served.
    const approveOther = async (id: string, operation: string) =>
      await outcome(
        approveWorkflowBinding(env, admin, id, {
          alias: "lookup",
          target: {
            kind: "storeOperation",
            permissionId: await permissionOf([operation], id),
            operation,
            operationKind: "query",
          },
          reviewed: { version: 1 },
        })
      );
    expect({
      unlisted: await approve(
        await permissionOf(["notes.add"]),
        "contacts.add"
      ),
      // `notes.add` takes `text`, not the contract's `name`.
      otherShape: await approve(every, "notes.add"),
      // A mutation approved as a query: never what the admin approved.
      otherKind: await approve(every, "contacts.add", "query"),
      internal: await approveOther(countWorkflow.id, "contacts.count"),
      action: await approveOther(pingWorkflow.id, "contacts.ping"),
      // Another workflow's permission serves nothing here.
      borrowed: await outcome(
        approveWorkflowBinding(env, admin, borrower.id, {
          alias: "lookup",
          target: {
            kind: "storeOperation",
            permissionId: every,
            operation: "contacts.add",
            operationKind: "mutation",
          },
          reviewed: { version: 1 },
        })
      ),
      served: await approve(every, "contacts.add"),
    }).toStrictEqual({
      unlisted: "workflow.binding_invalid",
      otherShape: "workflow.binding_invalid",
      otherKind: "workflow.binding_invalid",
      internal: "workflow.binding_invalid",
      action: "workflow.binding_invalid",
      borrowed: "workflow.binding_invalid",
      served: "ok",
    });
  });

  it("is named in the binding inventory, store, definition and path, while an approval serves it, and the contract alone once revoked", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const crm = await sealedApp(crmFiles(), "CRM");
    const key = await contractOf(admin, crm.release, "contacts.add");
    const workflow = await workflowOf(ada, key, byName);
    const permissionId = await granted(
      admin,
      {
        subject: { type: "workflow", workflowId: workflow.id },
        object: { type: "store", storeId: crm.store },
        actions: ["contacts.add"],
      },
      null
    );
    const approve = async () =>
      await approveWorkflowBinding(env, admin, workflow.id, {
        alias: "lookup",
        target: {
          kind: "storeOperation",
          permissionId,
          operation: "contacts.add",
          operationKind: "mutation",
        },
        reviewed: { version: 1 },
      });
    const inventory = async () =>
      await env.DB.prepare(
        `SELECT kind, target_id AS target, target_version AS definition,
          target_path AS path, approval_id AS approval, contract_id AS contract
        FROM sdk_resource_bindings
        WHERE resource_id = ? AND resource_version = 1 AND alias = 'lookup'`
      )
        .bind(workflow.id)
        .first();
    const published = await inventory();
    const first = await approve();
    const approved = await inventory();
    // Approved again: the second approval replaces the first, and revoking
    // the first after that leaves the row the second's.
    const second = await approve();
    await revokeWorkflowBinding(env, admin, workflow.id, first.id);
    const replaced = await inventory();
    await revokeWorkflowBinding(env, admin, workflow.id, second.id);
    const contract = {
      kind: "operation",
      target: key,
      definition: null,
      path: null,
      approval: null,
      contract: key,
    };
    // Each approval and revocation audited, as the approval's batch and
    // the revocation's own change decide, never the inventory's.
    const events = await allEvents();
    const audited = events
      .filter(
        ({ action, target }) =>
          action.startsWith("workflow.binding.") && target?.id === workflow.id
      )
      .map(({ action, detail }) => [action, detail.approval]);
    expect(audited).toStrictEqual([
      ["workflow.binding.approved", first.id],
      ["workflow.binding.approved", second.id],
      // The first, replaced already, changed nothing when revoked.
      ["workflow.binding.revoked", second.id],
    ]);
    expect({
      published,
      approved,
      replaced,
      revoked: await inventory(),
    }).toStrictEqual({
      published: contract,
      approved: {
        kind: "operation",
        target: crm.store,
        definition: 1,
        path: "contacts.add",
        approval: first.id,
        contract: key,
      },
      replaced: {
        kind: "operation",
        target: crm.store,
        definition: 1,
        path: "contacts.add",
        approval: second.id,
        contract: key,
      },
      revoked: contract,
    });
  });

  it("keeps the store from being deleted while an approval resolves to it, saying how many, until it's revoked", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const crm = await sealedApp(crmFiles(), "CRM");
    const key = await contractOf(admin, crm.release, "contacts.add");
    const workflow = await workflowOf(ada, key, byName);
    const permissionId = await granted(
      admin,
      {
        subject: { type: "workflow", workflowId: workflow.id },
        object: { type: "store", storeId: crm.store },
        actions: ["contacts.add"],
      },
      null
    );
    const approval = await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "lookup",
      target: {
        kind: "storeOperation",
        permissionId,
        operation: "contacts.add",
        operationKind: "mutation",
      },
      reviewed: { version: 1 },
    });
    // The CRM goes on without tables, and retention lets the version that
    // bound the store go: no release keeps it now, only the approval.
    await commitFiles(
      env,
      crm.owner,
      crm.app,
      {
        ...tablelessFiles,
        "server/contacts.ts": null,
        "server/notes.ts": null,
        "server/secrets.ts": null,
      },
      "No tables"
    );
    await seal(crm, 2);
    await setCurrentVersion(env, crm.owner, crm.app, 2);
    await sweptAway(crm.app, 1);
    // The store is counted by the approval its row names: no write leaves
    // the row naming the store without it, so none hides the consumer.
    const unnamed = await env.DB.prepare(
      "UPDATE sdk_resource_bindings SET approval_id = NULL WHERE resource_id = ? AND alias = 'lookup'"
    )
      .bind(workflow.id)
      .run()
      .then(
        () => "written",
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("names its store only with its approval")
            ? "refused"
            : error
      );
    const refused = await deleteStore(env, crm.owner, crm.store).then(
      () => null,
      (error: unknown) =>
        error instanceof Error && "code" in error
          ? { code: error.code, message: error.message }
          : error
    );
    await revokeWorkflowBinding(env, admin, workflow.id, approval.id);
    await deleteStore(env, crm.owner, crm.store);
    expect({ unnamed, refused }).toStrictEqual({
      unnamed: "refused",
      refused: {
        code: "data.store_consumed",
        message:
          "One workflow or App calls this store's operations through an approval. Revoke that approval first, then delete the store.",
      },
    });
  });

  it("runs as the person its run acts for, and stops once its permission is revoked", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const crm = await sealedApp(crmFiles(), "CRM");
    const key = await contractOf(admin, crm.release, "notes.add");
    const workflow = await workflowOf(ada, key, {
      text: { $expr: "input.who" },
    });
    const permissionId = await granted(
      admin,
      {
        subject: { type: "workflow", workflowId: workflow.id },
        object: { type: "store", storeId: crm.store },
        actions: ["notes.add"],
      },
      null
    );
    const approve = async () =>
      await approveWorkflowBinding(env, admin, workflow.id, {
        alias: "lookup",
        target: {
          kind: "storeOperation",
          permissionId,
          operation: "notes.add",
          operationKind: "mutation",
        },
        reviewed: { version: 1 },
      });
    const approval = await approve();
    const run = async (text: string, frozen = approval) =>
      await outcome(
        callApprovedStoreOperation(
          env,
          {
            id: workflow.id,
            version: 1,
            approval: frozen,
            restrictedRun: null,
          },
          { text },
          {
            actor: { type: "person", userId: ada.userId },
            principal: ada.userId,
            requestId: crypto.randomUUID(),
            deadline: Date.now() + 30_000,
            idempotencyKey: `step-${unique()}`,
            runId: null,
          }
        )
      );
    const first = await run("from the run");
    // The run froze the approval as it started; revoking it still stops
    // the next call.
    await revokeWorkflowBinding(env, admin, workflow.id, approval.id);
    const approvalRevoked = await run("after the approval");
    const again = await approve();
    await revokePermission(env, admin, permissionId);
    const afterRevoke = await run("after revoke", again);
    // Ada has no role in the CRM; the note is hers, and only hers.
    expect({
      first,
      approvalRevoked,
      afterRevoke,
      crmOwnerReads: await call(crm.owner, crm, "notes.mine"),
    }).toStrictEqual({
      first: "ok",
      approvalRevoked: "resource.unavailable",
      afterRevoke: "resource.unavailable",
      crmOwnerReads: [],
    });
  });

  it("stops serving once the store serves the operation as another kind or shape, and records each refusal", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const crm = await sealedApp(crmFiles(), "CRM");
    const key = await contractOf(admin, crm.release, "notes.add");
    const workflow = await workflowOf(ada, key, {
      text: { $expr: "input.who" },
    });
    const permissionId = await granted(
      admin,
      {
        subject: { type: "workflow", workflowId: workflow.id },
        object: { type: "store", storeId: crm.store },
        actions: ["notes.add"],
      },
      null
    );
    const approval = await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "lookup",
      target: {
        kind: "storeOperation",
        permissionId,
        operation: "notes.add",
        operationKind: "mutation",
      },
      reviewed: { version: 1 },
    });
    const run = async () =>
      await outcome(
        callApprovedStoreOperation(
          env,
          { id: workflow.id, version: 1, approval, restrictedRun: null },
          { text: "from the run" },
          {
            actor: { type: "person", userId: ada.userId },
            principal: ada.userId,
            requestId: crypto.randomUUID(),
            deadline: Date.now() + 30_000,
            idempotencyKey: `step-${unique()}`,
            runId: null,
          }
        )
      );
    const notesSource = crmFiles()["server/notes.ts"] ?? "";
    const withNote = (
      ...swaps: [from: string, to: string][]
    ): Record<string, string> => {
      let source = notesSource;
      for (const [from, to] of swaps) {
        source = source.replace(from, to);
      }
      return { ...crmFiles(), "server/notes.ts": source };
    };
    const noteMutation = "export const add = mutation({";
    const noteArgs = `${noteMutation}\n  args: { text: v.string() },`;
    // The same shapes, now a query: one that reads, as a query may.
    const noteBlock = `${noteArgs}
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("notes", { text: args.text });
    return null;
  },
});`;
    const asQuery = await nextVersion(
      crm,
      withNote(
        [
          noteBlock,
          `export const add = query({
  args: { text: v.string() },
  returns: v.null(),
  handler: async () => null,
});`,
        ],
        // No mutation is left to import: App code is type-checked as sealed.
        ["import { mutation, query }", "import { query }"]
      ),
      2
    );
    const otherKind = await run();
    // A mutation again, taking other arguments.
    const latest = await nextVersion(
      asQuery,
      withNote([
        noteArgs,
        `${noteMutation}\n  args: { text: v.string().max(10) },`,
      ]),
      3
    );
    const otherShape = await run();
    const events = await allEvents();
    const approved = events.find(
      ({ action, detail }) =>
        action === "workflow.binding.approved" &&
        detail.approval === approval.id
    );
    expect({
      otherKind,
      otherShape,
      approvedTarget: {
        permissionId: approved?.detail.permissionId,
        operation: approved?.detail.operation,
        operationKind: approved?.detail.operationKind,
      },
      refused: events
        .filter(
          ({ action, detail }) =>
            action === "store.operation.refused" &&
            detail.consumer === workflow.id
        )
        .map(({ detail }) => [detail.operation, detail.reason]),
      crmOwnerReads: await call(crm.owner, latest, "notes.mine"),
    }).toStrictEqual({
      otherKind: "resource.unavailable",
      otherShape: "resource.unavailable",
      approvedTarget: {
        permissionId,
        operation: "notes.add",
        operationKind: "mutation",
      },
      refused: [
        ["notes.add", "workflow.binding_invalid"],
        ["notes.add", "workflow.binding_invalid"],
      ],
      crmOwnerReads: [],
    });
  });

  it("gets nothing from a store whose App is restricted, before or after the call, and records it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const crm = await sealedApp(crmFiles(), "CRM");
    const key = await contractOf(admin, crm.release, "contacts.add");
    const workflow = await workflowOf(ada, key, byName);
    const permissionId = await granted(
      admin,
      {
        subject: { type: "workflow", workflowId: workflow.id },
        object: { type: "store", storeId: crm.store },
        actions: ["contacts.add"],
      },
      null
    );
    const approval = await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "lookup",
      target: {
        kind: "storeOperation",
        permissionId,
        operation: "contacts.add",
        operationKind: "mutation",
      },
      reviewed: { version: 1 },
    });
    const run = async (name: string, meanwhile?: () => Promise<void>) =>
      await outcome(
        callApprovedStoreOperation(
          env,
          { id: workflow.id, version: 1, approval, restrictedRun: null },
          { name },
          {
            actor: { type: "person", userId: ada.userId },
            principal: ada.userId,
            requestId: crypto.randomUUID(),
            deadline: Date.now() + 30_000,
            idempotencyKey: `step-${unique()}`,
            runId: null,
            ...(meanwhile === undefined ? {} : { stillAllowed: meanwhile }),
          }
        )
      );
    // The CRM becomes restricted while the call runs: what it answers
    // never reaches the workflow, though its change stands.
    let restrictedYet = false;
    const during = await run("Ada", async () => {
      if (!restrictedYet) {
        restrictedYet = true;
        await restrict(env, authorityOf(crm), contextOf(crm), ["test"]);
      }
    });
    // Restricted already: nothing runs at all.
    const before = await run("Mallory");
    const refusals = refusedOf(await allEvents(), workflow.id);
    expect({
      during,
      before,
      refusals,
      crmSees: await call(crm.owner, crm, "contacts.list"),
    }).toStrictEqual({
      during: "resource.unavailable",
      before: "resource.unavailable",
      refusals: [
        ["contacts.add", "store.restricted"],
        ["contacts.add", "store.restricted"],
      ],
      crmSees: ["Ada"],
    });
  });

  it("restricts the store's App before a restricted run's input reaches it, and answers that run", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const crm = await sealedApp(crmFiles(), "CRM");
    const key = await contractOf(admin, crm.release, "contacts.add");
    const workflow = await workflowOf(ada, key, byName);
    const permissionId = await granted(
      admin,
      {
        subject: { type: "workflow", workflowId: workflow.id },
        object: { type: "store", storeId: crm.store },
        actions: ["contacts.add"],
      },
      null
    );
    const approval = await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "lookup",
      target: {
        kind: "storeOperation",
        permissionId,
        operation: "contacts.add",
        operationKind: "mutation",
      },
      reviewed: { version: 1 },
    });
    const runId = `run-${unique()}`;
    const answered = await outcome(
      callApprovedStoreOperation(
        env,
        { id: workflow.id, version: 1, approval, restrictedRun: runId },
        { name: "Ada" },
        {
          actor: { type: "person", userId: ada.userId },
          principal: ada.userId,
          requestId: crypto.randomUUID(),
          deadline: Date.now() + 30_000,
          idempotencyKey: `step-${unique()}`,
          runId: null,
        }
      )
    );
    const events = await allEvents();
    expect({
      answered: answered !== "resource.unavailable",
      crmRestricted: await isRestricted(env, authorityOf(crm), contextOf(crm)),
      entered: events
        .filter(
          ({ action, target }) =>
            action === "context.restricted" && target?.id === crm.app
        )
        .map(({ provenance }) => provenance),
      crmSees: await call(crm.owner, crm, "contacts.list"),
    }).toStrictEqual({
      answered: true,
      crmRestricted: true,
      entered: [[`workflow_run:${runId}`]],
      crmSees: ["Ada"],
    });
  });
});

/** Starts version 1 of workflow `id` for `by`, its input `who`: its run's ID. */
const startedFor = async (by: Person, id: string, who: string) => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    {
      version: 1,
      input: { who },
      key: unique(),
    }
  );
  return runId ?? "";
};

/** Run `runId` of workflow `id` once it has ended, as `by` reads it. */
const endedRun = async (by: Person, id: string, runId: string) =>
  await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      expect(run.endedAt).not.toBeNull();
      return run;
    },
    { timeout: 30_000, interval: 100 }
  );

describe("a JSON workflow's run calling a store's public operation", () => {
  it("calls it through the approval its start froze, as its person, its receipt kept while the run lives", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const crm = await sealedApp(crmFiles(), "CRM");
    const key = await contractOf(admin, crm.release, "contacts.add");
    // Waits before its call, so its receipt's run is seen live first.
    const workflow = await workflowOf(ada, key, byName, [
      { id: "hold", type: "wait", for: "1 second" },
    ]);
    const permissionId = await granted(
      admin,
      {
        subject: { type: "workflow", workflowId: workflow.id },
        object: { type: "store", storeId: crm.store },
        actions: ["contacts.add"],
      },
      null
    );
    const approve = async () =>
      await approveWorkflowBinding(env, admin, workflow.id, {
        alias: "lookup",
        target: {
          kind: "storeOperation",
          permissionId,
          operation: "contacts.add",
          operationKind: "mutation",
        },
        reviewed: { version: 1 },
      });
    const approval = await approve();
    const first = await startedFor(ada, workflow.id, "Ada");
    const liveWhileRunning = await liveRuns(env, [first]);
    const firstEnd = await endedRun(ada, workflow.id, first);
    // Its approval revoked and given again while the next waits: a start
    // runs only through the approval it froze.
    const second = await startedFor(ada, workflow.id, "Bob");
    await revokeWorkflowBinding(env, admin, workflow.id, approval.id);
    await approve();
    const secondEnd = await endedRun(ada, workflow.id, second);
    const liveOnceEnded = await liveRuns(env, [first]);
    expect({
      live: liveWhileRunning.has(first),
      liveOnceEnded: liveOnceEnded.has(first),
      first: firstEnd.status,
      second: { status: secondEnd.status, code: secondEnd.error?.code },
      crmSees: await call(crm.owner, crm, "contacts.list"),
    }).toStrictEqual({
      live: true,
      liveOnceEnded: false,
      first: "completed",
      second: { status: "failed", code: "workflow.call_denied" },
      crmSees: ["Ada"],
    });
  });

  it("gets nothing from a store whose App is restricted, and records it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const crm = await sealedApp(crmFiles(), "CRM");
    const key = await contractOf(admin, crm.release, "contacts.add");
    const workflow = await workflowOf(ada, key, byName);
    const permissionId = await granted(
      admin,
      {
        subject: { type: "workflow", workflowId: workflow.id },
        object: { type: "store", storeId: crm.store },
        actions: ["contacts.add"],
      },
      null
    );
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "lookup",
      target: {
        kind: "storeOperation",
        permissionId,
        operation: "contacts.add",
        operationKind: "mutation",
      },
      reviewed: { version: 1 },
    });
    await restrict(env, authorityOf(crm), contextOf(crm), ["test"]);
    const runId = await startedFor(ada, workflow.id, "Mallory");
    const run = await endedRun(ada, workflow.id, runId);
    expect({
      status: run.status,
      code: run.error?.code,
      refusals: refusedOf(await allEvents(), workflow.id),
      crmSees: await call(crm.owner, crm, "contacts.list"),
    }).toStrictEqual({
      status: "failed",
      code: "resource.unavailable",
      refusals: [["contacts.add", "store.restricted"]],
      crmSees: [],
    });
  });
});

/** A CRM whose leads its people read and change by team and by assignee. */
const leadsCrmFiles: Record<string, string> = {
  ...appDefinition({
    name: "Leads",
    tables: {
      leads: {
        fields: {
          name: "v.string()",
          team: "v.string()",
          assignee: "v.person().optional()",
        },
        access: {
          read: "appMembers",
          write: "appMembers",
          rows: {
            read: [
              { kind: "team", field: "team" },
              { kind: "person", field: "assignee" },
            ],
          },
        },
      },
    },
  }),
  "server/leads.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";

export const add = mutation({
  args: { name: v.string(), team: v.string(), assignee: v.string().optional() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("leads", args);
    return null;
  },
});

export const list = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("leads").take(100)).map(({ name }) => name).toSorted(),
});
`,
};

/** Puts `people` in a new team, in core's records; answers its ID. */
const teamOf = async (...people: Person[]): Promise<string> => {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, ?, 'organization', ?)"
  )
    .bind(id, `Team ${id}`, Date.now())
    .run();
  for (const one of people) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of rows
    await env.DB.prepare(
      "INSERT INTO team_members (id, team_id, user_id) VALUES (?, ?, ?)"
    )
      .bind(crypto.randomUUID(), id, one.userId)
      .run();
  }
  return id;
};

describe("a store's public operations and its tables' row rules", () => {
  it("hold a workflow's calls to the rows the person it acts for may reach, by team", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const crm = await sealedApp(leadsCrmFiles, "Leads");
    // Ada, whose workflow calls the CRM, is in Sales with the CRM's owner,
    // who reads what lands; the admin is in Support.
    const sales = await teamOf(ada, crm.owner);
    const support = await teamOf(admin);
    const key = await contractOf(admin, crm.release, "leads.add");
    const workflow = await workflowOf(ada, key, {
      ...byName,
      team: { $expr: "input.who" },
    });
    const permissionId = await granted(
      admin,
      {
        subject: { type: "workflow", workflowId: workflow.id },
        object: { type: "store", storeId: crm.store },
        actions: ["leads.add"],
      },
      null
    );
    const approval = await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "lookup",
      target: {
        kind: "storeOperation",
        permissionId,
        operation: "leads.add",
        operationKind: "mutation",
      },
      reviewed: { version: 1 },
    });
    const run = async (name: string, team: string) =>
      await outcome(
        callApprovedStoreOperation(
          env,
          { id: workflow.id, version: 1, approval, restrictedRun: null },
          { name, team },
          {
            actor: { type: "person", userId: ada.userId },
            principal: ada.userId,
            requestId: crypto.randomUUID(),
            deadline: Date.now() + 30_000,
            idempotencyKey: `step-${unique()}`,
            runId: null,
          }
        )
      );
    const ran = {
      ownTeam: await run("Hooli", sales),
      otherTeam: await run("Wayne", support),
    };
    // Refused: a consumer is told no more than that it isn't served, and
    // nothing of it lands, as the CRM's own read shows.
    expect({
      ran,
      crmSees: await call(crm.owner, crm, "leads.list"),
    }).toStrictEqual({
      ran: { ownTeam: "ok", otherTeam: "resource.unavailable" },
      crmSees: ["Hooli"],
    });
  });
});
