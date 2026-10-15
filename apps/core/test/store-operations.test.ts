/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { AuditEvent } from "@grasp-os/shared/audit";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type {
  Authority,
  PermissionRequest,
} from "@grasp-os/shared/permissions";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { callAppFunction, callRunFunction } from "../src/app-functions.ts";
import { addMember } from "../src/app-members.ts";
import type { Release } from "../src/app-releases.ts";
import { appFor, commitFiles, setCurrentVersion } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { permissionsOpenTo } from "../src/permissions-open.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import {
  approveResourceBinding,
  reviewResourceBindings,
  revokeResourceBinding,
} from "../src/resource-bindings.ts";
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
import { allEvents } from "./audit-events.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { outcome, unique } from "./sign-in.ts";

// A business store's public operations, shared with other Apps and with
// independent workflows (store-operations.ts), from its threat model:
// calling an operation that isn't public, calling without an approved
// binding, a revoked grant still working, the store owner's privilege
// carried to the caller, and one consumer's data or keys reaching
// another. Each consumer goes in through what it really uses: an App's
// action through its declared store resource, called as a screen calls
// it; a workflow's approval through the admin's RPC function, and its
// call through the function its runs call.

/** The App that owns the store: contacts, people's own notes, builders' secrets. */
const crmFiles = (
  listReturns = "v.array(v.string())",
  revision = 1
): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  contacts: defineTable({ name: v.string() }),
  notes: defineTable({ text: v.string() }),
  secrets: defineTable({ text: v.string() }),
});
`,
  "operations/crm.ts": `// Revision ${revision}.
import { v } from "@grasp-os/sdk";
import { action, internalQuery, mutation, query } from "#grasp/server";

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

export const note = mutation({
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

export const keep = mutation({
  args: { text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("secrets", { text: args.text });
    return null;
  },
});

export const secrets = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("secrets").take(100)).map(({ text }) => text),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { add, count, keep, list, mine, note, ping, secrets } from "./operations/crm.ts";
import schema from "./schema.ts";

export default app({
  name: "CRM",
  schema,
  access: {
    tables: {
      contacts: { read: "appMembers", write: "appMembers" },
      notes: { read: "owner", write: "owner" },
      secrets: { read: "appBuilders", write: "appBuilders" },
    },
  },
  operations: {
    contacts: { list, add, ping },
    notes: { add: note, mine },
    secrets: { keep, list: secrets },
  },
  internalOperations: { contacts: { count } },
  screens: [],
  uses: [],
});
`,
});

/** An App calling the CRM's store through its declared store resources. */
const deskFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  marks: defineTable({ label: v.string() }),
});
`,
  "operations/desk.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const crm = resource.store("crm", {
  operations: {
    "contacts.list": { kind: "query", args: {}, returns: v.array(v.string()) },
    "contacts.add": { kind: "mutation", args: { name: v.string() }, returns: v.null() },
    "notes.add": { kind: "mutation", args: { text: v.string() }, returns: v.null() },
    "notes.mine": { kind: "query", args: {}, returns: v.array(v.string()) },
    "secrets.list": { kind: "query", args: {}, returns: v.array(v.string()) },
  },
});

export const hidden = resource.store("hidden", {
  operations: {
    "contacts.count": { kind: "query", args: {}, returns: v.number() },
  },
});

/** What a call answered, as JSON, or why it failed: its code and the store's. */
const attempt = async (work) => {
  try {
    return JSON.stringify(await work());
  } catch (error) {
    const details = Object(Reflect.get(Object(error), "details"));
    return ["error", Reflect.get(Object(error), "code"), Reflect.get(details, "code")]
      .filter((part) => part !== undefined)
      .map(String)
      .join(":");
  }
};

export const list = action({
  args: {},
  returns: v.string(),
  uses: [crm],
  handler: async (ctx) => await attempt(() => ctx.resources.crm.call("contacts.list", {})),
});

export const add = action({
  args: { name: v.string() },
  returns: v.string(),
  uses: [crm],
  handler: async (ctx, args) =>
    await attempt(() => ctx.resources.crm.call("contacts.add", { name: args.name })),
});

export const note = action({
  args: { text: v.string() },
  returns: v.string(),
  uses: [crm],
  handler: async (ctx, args) =>
    await attempt(() => ctx.resources.crm.call("notes.add", { text: args.text })),
});

export const mine = action({
  args: {},
  returns: v.string(),
  uses: [crm],
  handler: async (ctx) => await attempt(() => ctx.resources.crm.call("notes.mine", {})),
});

export const secrets = action({
  args: {},
  returns: v.string(),
  uses: [crm],
  handler: async (ctx) => await attempt(() => ctx.resources.crm.call("secrets.list", {})),
});

export const count = action({
  args: {},
  returns: v.string(),
  uses: [hidden],
  handler: async (ctx) => await attempt(() => ctx.resources.hidden.call("contacts.count", {})),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { add, count, crm, hidden, list, mine, note, secrets } from "./operations/desk.ts";
import schema from "./schema.ts";

export default app({
  name: "Desk",
  schema,
  access: { tables: { marks: { read: "owner", write: "owner" } } },
  operations: { desk: { add, count, list, mine, note, secrets } },
  internalOperations: {},
  screens: [],
  uses: [crm, hidden],
});
`,
};

/** What the audit log recorded of the changes consumers made to `store`. */
const writtenTo = (events: readonly AuditEvent[], store: string) =>
  events
    .filter(
      ({ action, target }) =>
        action === "store.operation.called" && target?.id === store
    )
    .map(({ detail }) => detail);

/** What the audit log recorded of `consumer`'s refused calls: path and why. */
const refusedOf = (events: readonly AuditEvent[], consumer: string) =>
  events
    .filter(
      ({ action, detail }) =>
        action === "store.operation.refused" && detail.consumer === consumer
    )
    .map(({ detail }) => [detail.operation, detail.reason]);

/** Desk's files as its version `version` commits them: the same code. */
const deskVersion = (version: number): Record<string, string> => ({
  ...deskFiles,
  "operations/desk.ts": `// Version ${version}.\n${deskFiles["operations/desk.ts"] ?? ""}`,
});

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

/** What `by` gets calling `path` of `sealed`'s current release, as a screen calls it. */
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
      reference: {
        resourceId: release.manifest.resourceId,
        resourceVersion: release.manifest.resourceVersion,
        contractId: path,
        fingerprint: release.fingerprints[path] ?? "",
        kind: operation?.kind ?? "query",
      },
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

/** The admin's binding of Desk's `alias` to `permissionId`. */
const bind = async (
  admin: Person,
  desk: Sealed,
  permissionId: string,
  alias = "crm"
) =>
  await approveResourceBinding(env, admin, {
    app: desk.app,
    alias,
    target: { kind: "store", permissionId },
    reviewed: { version: desk.release.manifest.resourceVersion },
  });

const crmActions = [
  "contacts.list",
  "contacts.add",
  "notes.add",
  "notes.mine",
  "secrets.list",
];

describe("an App calling another App's store", () => {
  it("reaches it only once an admin granted its own permission and bound the declaration to it", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    await call(crm.owner, crm, "contacts.add", { name: "Ada" });
    const before = await call(desk.owner, desk, "desk.list");
    const permission = await deskGrant(admin, desk, crm, crmActions);
    const grantedOnly = await call(desk.owner, desk, "desk.list");
    await bind(admin, desk, permission);
    const bound = await call(desk.owner, desk, "desk.list");
    // Desk's owner has no role in the CRM: what they add through Desk
    // lands in the CRM's store, as its own screens see it.
    const added = await call(desk.owner, desk, "desk.add", { name: "Grace" });
    expect({
      before,
      grantedOnly,
      bound,
      added,
      crmSees: await call(crm.owner, crm, "contacts.list"),
      deskOwnerInCrm: await outcome(appFor(env, desk.owner, crm.app, "user")),
      // The change names the App that made it, never its arguments.
      written: writtenTo(await allEvents(), crm.store),
    }).toStrictEqual({
      before: "error:resource.unavailable",
      grantedOnly: "error:resource.unavailable",
      bound: ["Ada"],
      added: null,
      crmSees: ["Ada", "Grace"],
      deskOwnerInCrm: "app.not_found",
      written: [
        {
          consumerType: "app",
          consumer: desk.app,
          consumerVersion: 1,
          permissionId: permission,
          operation: "contacts.add",
        },
      ],
    });
  });

  it("is never served an internal function or an operation the permission doesn't list", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    // The permission lists the internal function: still never served.
    const internal = await deskGrant(admin, desk, crm, ["contacts.count"]);
    const short = await deskGrant(admin, desk, crm, ["contacts.list"]);
    expect({
      internal: await outcome(bind(admin, desk, internal, "hidden")),
      // `crm` declares more than this permission lists.
      short: await outcome(bind(admin, desk, short)),
      called: await call(desk.owner, desk, "desk.count"),
    }).toStrictEqual({
      internal: "resource.target_invalid",
      short: "resource.target_invalid",
      called: "error:resource.unavailable",
    });
  });

  it("stops at the next call once its binding or its permission is revoked", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    const permission = await deskGrant(admin, desk, crm, crmActions);
    const binding = await bind(admin, desk, permission);
    const served = await call(desk.owner, desk, "desk.list");
    await revokeResourceBinding(env, admin, binding.id);
    const bindingRevoked = await call(desk.owner, desk, "desk.list");
    await bind(admin, desk, permission);
    const boundAgain = await call(desk.owner, desk, "desk.list");
    await revokePermission(env, admin, permission);
    expect({
      served,
      bindingRevoked,
      boundAgain,
      permissionRevoked: await call(desk.owner, desk, "desk.list"),
      addAfter: await call(desk.owner, desk, "desk.add", { name: "Eve" }),
      crmSees: await call(crm.owner, crm, "contacts.list"),
    }).toStrictEqual({
      served: [],
      bindingRevoked: "error:resource.unavailable",
      boundAgain: [],
      permissionRevoked: "error:resource.unavailable",
      addAfter: "error:resource.unavailable",
      crmSees: [],
    });
  });

  it("stops once the store's App changes an operation's contract, and goes on while it keeps it", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    const permission = await deskGrant(admin, desk, crm, crmActions);
    await bind(admin, desk, permission);
    await call(crm.owner, crm, "contacts.add", { name: "Ada" });
    // Same contract, new code: still served.
    const kept = await nextVersion(crm, crmFiles(undefined, 2), 2);
    const whileKept = await call(desk.owner, desk, "desk.list");
    // Another return: the binding no longer serves it.
    await nextVersion(kept, crmFiles("v.array(v.string()).max(10)"), 3);
    expect({
      whileKept,
      changed: await call(desk.owner, desk, "desk.list"),
      // Operations it kept as they were still serve nothing: the binding
      // covers the whole declaration.
      addChanged: await call(desk.owner, desk, "desk.add", { name: "Bo" }),
      // Nor can it be bound again while the store serves another shape.
      again: await outcome(bind(admin, desk, permission)),
      // Each request it refused is recorded, with Desk and its binding.
      refused: refusedOf(await allEvents(), desk.app),
    }).toStrictEqual({
      whileKept: ["Ada"],
      changed: "error:resource.unavailable",
      addChanged: "error:resource.unavailable",
      again: "resource.target_invalid",
      // A store that serves an operation other than declared serves the
      // binding nothing, as one no longer granted.
      refused: [
        ["binding:crm", "grant_lost"],
        ["binding:crm", "grant_lost"],
      ],
    });
  });

  it("acts as the person calling, a member and never a builder of the store's App", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    await bind(admin, desk, await deskGrant(admin, desk, crm, crmActions));
    await call(crm.owner, crm, "secrets.keep", { text: "launch codes" });
    // Desk's owner keeps a note through Desk: theirs, not the CRM owner's.
    const kept = await call(desk.owner, desk, "desk.note", { text: "mine" });
    expect({
      kept,
      deskOwnerReads: await call(desk.owner, desk, "desk.mine"),
      // Another person using Desk reads only their own.
      adminReads: await call(admin, desk, "desk.mine"),
      crmOwnerReads: await call(crm.owner, crm, "notes.mine"),
      // The admin builds every App, the CRM included, and reads its
      // builders' table there; through Desk, never.
      adminInCrm: await call(admin, crm, "secrets.list"),
      adminThroughDesk: await call(admin, desk, "desk.secrets"),
    }).toStrictEqual({
      kept: null,
      deskOwnerReads: ["mine"],
      adminReads: [],
      crmOwnerReads: [],
      adminInCrm: ["launch codes"],
      adminThroughDesk: "error:resource.unavailable",
    });
  });

  it("carries restricted mode both ways, before the data moves", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    const other = await sealedApp(deskFiles, "Other desk");
    await bind(admin, desk, await deskGrant(admin, desk, crm, crmActions));
    const restricted = async (sealed: Sealed) =>
      await isRestricted(env, authorityOf(sealed), contextOf(sealed));
    // The CRM read restricted data: Desk reading from it is restricted too.
    await restrict(env, authorityOf(crm), contextOf(crm), ["test"]);
    const deskBefore = await restricted(desk);
    const read = await call(desk.owner, desk, "desk.list");
    const deskAfter = await restricted(desk);
    // A restricted caller restricts the store's App it writes to.
    const crm2 = await sealedApp(crmFiles(), "Second CRM");
    await bind(admin, other, await deskGrant(admin, other, crm2, crmActions));
    await restrict(env, authorityOf(other), contextOf(other), ["test"]);
    const crm2Before = await restricted(crm2);
    const wrote = await call(other.owner, other, "desk.add", { name: "Ada" });
    expect({
      deskBefore,
      read,
      deskAfter,
      crm2Before,
      wrote,
      crm2After: await restricted(crm2),
    }).toStrictEqual({
      deskBefore: false,
      read: [],
      deskAfter: true,
      crm2Before: false,
      wrote: null,
      crm2After: true,
    });
  });

  it("offers an admin only the store permissions that serve a declaration as declared", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    const every = await deskGrant(admin, desk, crm, crmActions);
    await deskGrant(admin, desk, crm, ["contacts.list"]);
    const review = await reviewResourceBindings(env, admin, desk.app);
    const offered = Object.fromEntries(
      review.resources.map(({ alias, choices, operations }) => [
        alias,
        {
          operations,
          permissions:
            choices?.kind === "store"
              ? choices.permissions.map(({ permissionId }) => permissionId)
              : null,
        },
      ])
    );
    expect(offered).toStrictEqual({
      crm: { operations: [...crmActions].toSorted(), permissions: [every] },
      // The internal function is never served, whatever is granted.
      hidden: { operations: ["contacts.count"], permissions: [] },
    });
  });

  it("gives each consumer its own grant, which serves no other App", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    const other = await sealedApp(deskFiles, "Other desk");
    const deskPermission = await deskGrant(admin, desk, crm, crmActions);
    const otherPermission = await deskGrant(admin, other, crm, crmActions);
    // Another App's permission binds nothing here.
    const borrowed = await outcome(bind(admin, other, deskPermission));
    await bind(admin, desk, deskPermission);
    await bind(admin, other, otherPermission);
    await revokePermission(env, admin, otherPermission);
    expect({
      borrowed,
      desk: await call(desk.owner, desk, "desk.list"),
      other: await call(other.owner, other, "desk.list"),
    }).toStrictEqual({
      borrowed: "resource.target_invalid",
      desk: [],
      other: "error:resource.unavailable",
    });
  });

  it("can't be asked for by someone with no role in the store's App, nor for that App itself", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    const ask = async (by: Person, appId: string) =>
      await outcome(
        requestPermission(
          env,
          by,
          {
            subject: { type: "app", appId },
            object: { type: "store", storeId: crm.store },
            actions: ["contacts.list"],
            binding: bindingName(),
          },
          rolesOf(by)
        )
      );
    expect({
      // Desk's builder can't see the CRM: told there's no such store.
      noRole: await ask(desk.owner, desk.app),
      ownStore: await ask(admin, crm.app),
      asAdmin: await ask(admin, desk.app),
    }).toStrictEqual({
      noRole: "permission.invalid",
      ownStore: "permission.invalid",
      asAdmin: "ok",
    });
  });

  it("lists a store permission only to those who may open the store's App", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    const permission = await deskGrant(admin, desk, crm, ["contacts.list"]);
    const listedTo = async (by: Person) => {
      const listed = await permissionsOpenTo(env, by, {
        type: "app",
        appId: desk.app,
      });
      return listed.some(({ id }) => id === permission);
    };
    // Desk's builder can't open the CRM: the store and its operations are
    // the CRM's to show.
    const hidden = await listedTo(desk.owner);
    await addMember(env, crm.owner, crm.app, {
      type: "person",
      id: desk.owner.userId,
      role: "user",
    });
    expect({
      hidden,
      shared: await listedTo(desk.owner),
      admin: await listedTo(admin),
    }).toStrictEqual({ hidden: false, shared: true, admin: true });
  });

  it("asks an admin again for a store permission once a builder makes another version current", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    // An operation named as reading may still write: every store action
    // counts as changing things.
    const permission = await deskGrant(admin, desk, crm, ["read"]);
    await bind(admin, desk, await deskGrant(admin, desk, crm, crmActions));
    const before = await call(desk.owner, desk, "desk.add", { name: "Ada" });
    const second = await nextVersion(desk, deskVersion(2), 2);
    const row = await env.DB.prepare(
      "SELECT status FROM permissions WHERE id = ?"
    )
      .bind(permission)
      .first<{ status: string }>();
    expect({
      before,
      status: row?.status,
      after: await call(desk.owner, second, "desk.add", { name: "Mallory" }),
      crmSees: await call(crm.owner, crm, "contacts.list"),
    }).toStrictEqual({
      before: null,
      status: "requested",
      after: "error:resource.unavailable",
      crmSees: ["Ada"],
    });
  });

  it("refuses a run pinned to a version no admin approved, though the grant was given again for a later one", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    const permission = await deskGrant(admin, desk, crm, crmActions);
    await bind(admin, desk, permission);
    // A builder makes version 2 current, unapproved, and a run starts on
    // it; then version 3, which an admin approves by granting again.
    const second = await nextVersion(desk, deskVersion(2), 2);
    const third = await nextVersion(second, deskVersion(3), 3);
    await grantPermission(env, admin, permission, { version: 3 });
    const runId = runIdSchema.parse(crypto.randomUUID());
    await env.DB.prepare(
      "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at) VALUES (?, ?, 'sync', 2, ?, 'running', ?)"
    )
      .bind(runId, desk.app, desk.owner.userId, Date.now())
      .run();
    const pinned = await callRunFunction(
      env,
      {
        run: {
          app: appIdSchema.parse(desk.app),
          workflow: workflowIdSchema.parse("sync"),
          runId,
          version: 2,
          authority: {
            subject: { type: "app", appId: appIdSchema.parse(desk.app) },
            onBehalfOf: desk.owner.userId,
            mode: "workflow",
            appVersion: 2,
          },
          shareSubject: desk.owner.userId,
        },
        requestId: crypto.randomUUID(),
        deadline: Date.now() + 30_000,
        stillCurrent: async () => {
          await Promise.resolve();
        },
        requireHolds: () => {
          // The attempt holds its lease throughout.
        },
        held: () => {
          throw new Error("Nothing is held here");
        },
      },
      { contractId: "desk.add", kind: "action" },
      { name: "Mallory" },
      `step:${crypto.randomUUID()}`
    );
    const logged = await allEvents();
    const refusals = logged.filter(
      ({ action, detail }) =>
        action === "store.operation.refused" &&
        detail.consumer === desk.app &&
        detail.consumerVersion === 2
    );
    expect({
      pinned: pinned.ok ? pinned.value : pinned.error.code,
      approved: await call(desk.owner, third, "desk.add", { name: "Grace" }),
      crmSees: await call(crm.owner, crm, "contacts.list"),
      refused: refusals.map(({ target, detail }) => ({
        target: target?.id,
        operation: detail.operation,
        reason: detail.reason,
      })),
    }).toStrictEqual({
      pinned: "error:resource.unavailable",
      approved: null,
      crmSees: ["Grace"],
      refused: [
        {
          target: crm.store,
          operation: "contacts.add",
          reason: "permission.denied",
        },
      ],
    });
  });

  it("commits nothing under a store release that is no longer current", async () => {
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
    // The CRM moves on between the call's resolution and its run.
    const moved = await nextVersion(crm, crmFiles(undefined, 2), 2);
    expect({
      stale: await outcome(
        callStoreOperation(
          env,
          consumer,
          served,
          { name: "Mallory" },
          {
            actor: { type: "person", userId: desk.owner.userId },
            principal: desk.owner.userId,
            requestId: crypto.randomUUID(),
            deadline: Date.now() + 30_000,
            idempotencyKey: `key-${unique()}`,
            runId: null,
          }
        )
      ),
      crmSees: await call(crm.owner, moved, "contacts.list"),
    }).toStrictEqual({ stale: "resource.unavailable", crmSees: [] });
  });

  it("commits nothing once the calling App's own authority is withdrawn after its request was admitted", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    await bind(admin, desk, await deskGrant(admin, desk, crm, crmActions));
    const { release } = desk;
    const request = JSON.stringify({
      reference: {
        resourceId: release.manifest.resourceId,
        resourceVersion: release.manifest.resourceVersion,
        contractId: "desk.add",
        fingerprint: release.fingerprints["desk.add"] ?? "",
        kind: "action",
      },
      input: { name: "Mallory" },
    });
    // What admitted Desk's call (an agent's permission, say) holds as the
    // call starts and as its request to the CRM is admitted, then is
    // withdrawn: the CRM's mutation runs no further.
    let checks = 0;
    const answer = await callAppFunction(
      env,
      desk.owner,
      desk.app,
      request,
      Date.now() + 30_000,
      async () => {
        checks += 1;
        if (checks > 2) {
          throw new Error("Withdrawn");
        }
        await Promise.resolve();
      }
    );
    expect({
      answered: answer.result.ok
        ? answer.result.value
        : answer.result.error.code,
      crmSees: await call(crm.owner, crm, "contacts.list"),
    }).toStrictEqual({
      answered: "error:internal.unexpected",
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
    // The same key from the CRM's own screen is the CRM's own receipt.
    await expect(call(crm.owner, crm, "contacts.list")).resolves.toStrictEqual([
      "Ada",
      "Ada",
    ]);
  });
});

/** A workflow's arguments for an operation that takes a name. */
const byName = { name: "${ $workflow.input.who }" };

/**
 * A workflow with one operation binding, `lookup`, of catalog contract
 * `key`, which it calls with `args`.
 */
const workflowOf = async (
  owner: Person,
  key: string,
  args: Record<string, string>
) => {
  const workflow = await createWorkflowResource(env, owner, `crm-${unique()}`);
  await publishWorkflowVersion(env, owner, workflow.id, {
    definition: JSON.stringify({
      document: {
        dsl: "1.0.3",
        namespace: workflowNamespace,
        name: workflow.name,
        version: "1.0.0",
        title: workflow.name,
        metadata: {
          grasp: {
            profile: "grasp-open-workflow/1",
            params: {},
            bindings: { lookup: { kind: "operation", contract: key } },
          },
        },
      },
      input: {
        schema: {
          format: "json",
          document: {
            type: "object",
            properties: { who: { type: "string" } },
            required: ["who"],
            additionalProperties: false,
          },
        },
      },
      output: {
        schema: {
          format: "json",
          document: {
            type: "object",
            properties: { status: { type: "string" } },
            required: ["status"],
            additionalProperties: false,
          },
        },
      },
      do: [
        {
          add: {
            call: "grasp.operation",
            with: {
              binding: "lookup",
              arguments: args,
            },
          },
        },
        { finish: { set: { status: "done" } } },
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

  it("runs as the person its run acts for, and stops once its permission is revoked", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const crm = await sealedApp(crmFiles(), "CRM");
    const key = await contractOf(admin, crm.release, "notes.add");
    const workflow = await workflowOf(ada, key, {
      text: "${ $workflow.input.who }",
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
          { id: workflow.id, version: 1, approval: frozen },
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
      text: "${ $workflow.input.who }",
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
          { id: workflow.id, version: 1, approval },
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
    const crmSource = crmFiles()["operations/crm.ts"] ?? "";
    const withNote = (from: string, to: string): Record<string, string> => ({
      ...crmFiles(),
      "operations/crm.ts": crmSource.replace(from, to),
    });
    const noteMutation = "export const note = mutation({";
    const noteArgs = `${noteMutation}\n  args: { text: v.string() },`;
    // The same shapes, now a query.
    const asQuery = await nextVersion(
      crm,
      withNote(noteMutation, "export const note = query({"),
      2
    );
    const otherKind = await run();
    // A mutation again, taking other arguments.
    const latest = await nextVersion(
      asQuery,
      withNote(
        noteArgs,
        `${noteMutation}\n  args: { text: v.string().max(10) },`
      ),
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
});
