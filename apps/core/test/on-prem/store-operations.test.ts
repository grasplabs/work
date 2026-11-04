import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { callAppFunction } from "../../src/app-functions.ts";
import type { Release } from "../../src/app-releases.ts";
import { setCurrentVersion } from "../../src/apps.ts";
import { approveResourceBinding } from "../../src/resource-bindings.ts";
import { deepFiles, fieldDepth } from "../deep-records.ts";
import { appWith, person, seal } from "../sealed-apps.ts";
import type { Fixture } from "../sealed-apps.ts";

// Another App's functions on-prem (resource-apps.ts): the calling App's
// action runs in a sandbox session, and the function of the App it calls
// in a child of that session, through the real supervisor this
// project starts. The supervisor has two processes: two consumers' actions
// waiting on their calls hold both, and each call still runs.

const crmFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  contacts: defineTable({ name: v.string() }),
});
`,
  "server/contacts.ts": `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";

export const list = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("contacts").take(100)).map(({ name }) => name),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import schema from "./schema.ts";

export default app({
  name: "CRM",
  schema,
  access: { tables: { contacts: { read: "appMembers", write: "appMembers" } } },
  screens: [],
});
`,
};

const deskFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  marks: defineTable({ label: v.string() }),
});
`,
  "server/desk.ts": `import { permission, v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

export const crm = permission.app("crm", {
  functions: {
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
    return await ctx.apps.crm.call("contacts.list", {});
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { crm } from "./server/desk.ts";
import schema from "./schema.ts";

export default app({
  name: "Desk",
  schema,
  access: { tables: { marks: { read: "owner", write: "owner" } } },
  screens: [],
  permissions: { apps: [crm] },
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

/**
 * `desk`'s `crm` bound by `admin` to the CRM, whose user `desk`'s owner
 * is: a call through another App runs under that App's own roles.
 */
const bound = async (admin: Person, desk: Sealed, crm: Sealed) => {
  await env.DB.prepare(
    "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
  )
    .bind(crm.app, desk.owner.userId, admin.userId, Date.now())
    .run();
  await approveResourceBinding(env, admin, {
    app: desk.app,
    alias: "crm",
    target: { kind: "app", appId: crm.app },
    reviewed: { version: 1 },
  });
};

/** What `sealed`'s owner gets calling `desk.list`. */
const list = async (sealed: Sealed): Promise<unknown> => {
  const answer = await callAppFunction(
    env,
    sealed.owner,
    sealed.app,
    JSON.stringify({
      reference: { name: "desk.list", kind: "action" },
      input: {},
    })
  );
  return answer.result.ok ? answer.result.value : answer.result.error.code;
};

describe("another App's function on-prem", () => {
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
