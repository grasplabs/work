import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { callAppFunction } from "../../src/app-functions.ts";
import type { Release } from "../../src/app-releases.ts";
import { appFor, setCurrentVersion } from "../../src/apps.ts";
import { grantPermission, requestPermission } from "../../src/permissions.ts";
import { approveResourceBinding } from "../../src/resource-bindings.ts";
import { deepFiles, fieldDepth } from "../deep-records.ts";
import { appWith, person, seal } from "../sealed-apps.ts";
import type { Fixture } from "../sealed-apps.ts";

// A shared store's operations on-prem (store-operations.ts): the calling
// App's action runs in a sandbox session, and the store App's operation
// it calls in a child of that session, through the real supervisor this
// project starts. The supervisor has two processes: two consumers' actions
// waiting on their store calls hold both, and each call still runs.

const crmFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  contacts: defineTable({ name: v.string() }),
});
`,
  "operations/crm.ts": `import { v } from "@grasp-os/sdk";
import { query } from "#grasp/server";

export const list = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("contacts").take(100)).map(({ name }) => name),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { list } from "./operations/crm.ts";
import schema from "./schema.ts";

export default app({
  name: "CRM",
  schema,
  access: { tables: { contacts: { read: "appMembers", write: "appMembers" } } },
  operations: { contacts: { list } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
};

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
  },
});

/** Holds its process a while, so another consumer's action holds the other, then calls. */
export const list = action({
  args: {},
  returns: v.array(v.string()),
  uses: [crm],
  handler: async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await ctx.resources.crm.call("contacts.list", {});
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { crm, list } from "./operations/desk.ts";
import schema from "./schema.ts";

export default app({
  name: "Desk",
  schema,
  access: { tables: { marks: { read: "owner", write: "owner" } } },
  operations: { desk: { list } },
  internalOperations: {},
  screens: [],
  uses: [crm],
});
`,
};

type Sealed = Fixture & { release: Release };

/** An App with `files`, sealed and current. */
const sealedApp = async (
  files: Record<string, string>,
  name: string
): Promise<Sealed> => {
  const fixture = await appWith(files, name);
  const release = await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  return { ...fixture, release };
};

type Person = Awaited<ReturnType<typeof person>>;

/** `desk`'s store resource, granted CRM's store and bound by `admin`. */
const bound = async (admin: Person, desk: Sealed, crm: Sealed) => {
  const asked = await requestPermission(
    env,
    admin,
    {
      subject: { type: "app", appId: desk.app },
      object: { type: "store", storeId: crm.store },
      actions: ["contacts.list"],
      binding: `STORE_${crypto.randomUUID().slice(0, 8).toUpperCase().replaceAll("-", "_")}`,
    },
    {
      app: async (app, role) => await appFor(env, admin, app, role),
      resource: async () =>
        await Promise.reject(new Error("No independent resource here")),
    }
  );
  await grantPermission(env, admin, asked.id, { version: 1 });
  await approveResourceBinding(env, admin, {
    app: desk.app,
    alias: "crm",
    target: { kind: "store", permissionId: asked.id },
    reviewed: { version: 1 },
  });
};

/** What `sealed`'s owner gets calling `desk.list`. */
const list = async (sealed: Sealed): Promise<unknown> => {
  const { release } = sealed;
  const answer = await callAppFunction(
    env,
    sealed.owner,
    sealed.app,
    JSON.stringify({
      reference: {
        resourceId: release.manifest.resourceId,
        resourceVersion: release.manifest.resourceVersion,
        contractId: "desk.list",
        fingerprint: release.fingerprints["desk.list"] ?? "",
        kind: "action",
      },
      input: {},
    })
  );
  return answer.result.ok ? answer.result.value : answer.result.error.code;
};

describe("a shared store's operation on-prem", () => {
  it("runs in a child of the calling action's session, so consumers waiting on it never starve it", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles, "CRM");
    const desk = await sealedApp(deskFiles, "Desk");
    const other = await sealedApp(deskFiles, "Other desk");
    await bound(admin, desk, crm);
    await bound(admin, other, crm);
    await expect(Promise.all([list(desk), list(other)])).resolves.toStrictEqual(
      [[], []]
    );
  });
});

/** What `sealed`'s owner gets calling `path` of its App with `input`. */
const called = async (
  { owner, app, release }: Sealed,
  path: string,
  kind: "query" | "mutation",
  input: unknown
): Promise<unknown> => {
  const answer = await callAppFunction(
    env,
    owner,
    app,
    JSON.stringify({
      reference: {
        resourceId: release.manifest.resourceId,
        resourceVersion: release.manifest.resourceVersion,
        contractId: path,
        fingerprint: release.fingerprints[path] ?? "",
        kind,
      },
      input,
    })
  );
  return answer.result.ok ? answer.result.value : answer.result.error.code;
};

describe("a record as deep as a store keeps, on-prem", () => {
  it("is written and read back through the sandbox session, every level of it", async () => {
    const deep = await sealedApp(deepFiles, "Deep");
    const id = await called(deep, "deep.put", "mutation", {});
    const levels = await called(deep, "deep.read", "query", { id });
    expect({ written: typeof id, levels }).toStrictEqual({
      written: "string",
      levels: fieldDepth,
    });
  });
});
