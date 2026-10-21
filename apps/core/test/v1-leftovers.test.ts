import {
  appIdSchema,
  chatIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { App } from "../src/app.ts";
import { appHost, workspace } from "../src/durable-objects.ts";
import { Workspace } from "../src/workspace.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// What the v1 App server left in storage, gone once (GRA-789): the
// database of each App object's `server` facet, and of each chat's
// preview facet in its Workspace object. Each object deletes them on its
// first start, notes that it did, and deletes nothing on a start after.

/**
 * What a v1 facet stood for here: a class keeping one mark in its
 * storage, loaded in the context of the object that runs it.
 */
const keeper = (): DurableObjectClass =>
  env.LOADER.get("v1-facet-keeper", () => ({
    compatibilityDate: "2026-01-01",
    mainModule: "keeper.js",
    modules: {
      "keeper.js": `import { DurableObject } from "cloudflare:workers";
export class Keeper extends DurableObject {
  keep() { this.ctx.storage.kv.put("kept", true); }
  kept() { return this.ctx.storage.kv.get("kept") === true; }
}`,
    },
  })).getDurableObjectClass("Keeper");

interface Keeping {
  keep: () => Promise<void>;
  kept: () => Promise<boolean>;
}

/** A facet of `state` named `name`, as the v1 server's ran. */
const facetOf = (state: DurableObjectState, name: string): Keeping => {
  const facet: unknown = state.facets.get(name, () => ({
    class: keeper(),
    id: name,
  }));
  // SAFETY: the facet runs `Keeper`, whose two methods these are.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return facet as Keeping;
};

/** Whether `name`'s facet in `state` holds its mark. */
const holdsData = async (
  state: DurableObjectState,
  name: string
): Promise<boolean> => await facetOf(state, name).kept();

/** Starts `Object` on `state` again, as the runtime does after a restart. */
const startAgain = (
  Started: new (state: DurableObjectState, env: Env) => unknown,
  state: DurableObjectState
): unknown => new Started(state, env);

describe("the v1 App server's leftover storage", () => {
  it("is deleted from an App's object once, its server facet's database with it", async () => {
    const host = appHost(env, appIdSchema.parse(crypto.randomUUID()));
    const result = await runInDurableObject(host, async (_instance, state) => {
      // As a v1 App left it: data in its server facet, and no note.
      await facetOf(state, "server").keep();
      state.storage.kv.delete("v1-server-dropped");
      const before = await holdsData(state, "server");
      startAgain(App, state);
      const after = await holdsData(state, "server");
      // Data written since: a later start leaves it.
      await facetOf(state, "server").keep();
      startAgain(App, state);
      return { before, after, later: await holdsData(state, "server") };
    });
    expect(result).toStrictEqual({ before: true, after: false, later: true });
  });

  it("is deleted from a Workspace's object once, each held draft's preview facet's database with it", async () => {
    const chats = workspace(env, workspaceIdSchema.parse(crypto.randomUUID()));
    const chatId = chatIdSchema.parse(crypto.randomUUID());
    const app = crypto.randomUUID();
    const facet = `preview:${chatId}:${app}`;
    const result = await runInDurableObject(chats, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO chats (id, title, created_at, person_id, agent_id) VALUES (?, 'Build', 0, 'p', 'agent')",
        chatId
      );
      state.storage.sql.exec(
        "INSERT INTO chat_drafts (chat_id, app_id, base, revision, updated_at) VALUES (?, ?, 1, 1, 0)",
        chatId,
        app
      );
      await facetOf(state, facet).keep();
      state.storage.kv.delete("v1-previews-dropped");
      const before = await holdsData(state, facet);
      startAgain(Workspace, state);
      return { before, after: await holdsData(state, facet) };
    });
    expect(result).toStrictEqual({ before: true, after: false });
  });
});

describe("an App's host object", () => {
  it("runs no App code, and serves none of the v1 server's calls or caller tokens", () => {
    const removed = [
      "call",
      "admit",
      "claimHostCall",
      "claimStatistic",
      "limitedReadAudit",
      "restart",
      "revokeRunCalls",
      "revokeAttemptCalls",
      "waitingHolds",
    ];
    expect(
      removed.filter((name) => Reflect.has(App.prototype, name))
    ).toStrictEqual([]);
  });
});

const idp = mockIdp();

/** A request for `subject` to reach App `app`'s code with `actions`. */
const onApp = (
  subject: PermissionRequest["subject"],
  app: string,
  actions: string[]
): PermissionRequest => ({
  subject,
  object: { type: "app", appId: app },
  actions,
  binding: "OTHER",
});

describe("the v1 App server's exports", () => {
  it("are never asked for: an App reaches another's functions through an app resource, an agent with read or write", async () => {
    const admin = await signedInApi(idp, "admin");
    const [{ id: app }, { id: other }] = await Promise.all([
      admin.api.apps.create({ name: `App ${unique()}` }),
      admin.api.apps.create({ name: `Other ${unique()}` }),
    ]);
    const agent = { type: "agent" as const, agentId: `agent-${unique()}` };
    const refused = await Promise.all(
      [
        onApp({ type: "app", appId: app }, other, ["read"]),
        onApp({ type: "app", appId: app }, other, ["findCustomers"]),
        onApp(agent, other, ["findCustomers"]),
        onApp(agent, other, ["toString"]),
      ].map(
        async (request) => await outcome(admin.api.permissions.request(request))
      )
    );

    expect(refused).toStrictEqual([
      "permission.invalid",
      "permission.invalid",
      "permission.invalid",
      "permission.invalid",
    ]);
    await expect(
      admin.api.permissions.request(onApp(agent, other, ["read", "write"]))
    ).resolves.toMatchObject({
      subject: agent,
      object: { type: "app", appId: other },
      actions: ["read", "write"],
      status: "requested",
    });
  });

  it("leave no grant behind: the migration takes out every one an agent's read or write isn't", async () => {
    const app = crypto.randomUUID();
    const other = crypto.randomUUID();
    const agent = `agent-${unique()}`;
    const rows = [
      ["app", app, "app", other, ["read"]],
      ["workflow", `wf-${unique()}`, "app", other, ["write"]],
      ["agent", agent, "app", other, ["findCustomers", "read"]],
      ["agent", agent, "app", app, ["read", "write"]],
      ["app", app, "collection", other, ["read"]],
    ] as const;
    const ids = await Promise.all(
      rows.map(
        async ([subjectType, subjectId, objectType, objectId, actions]) => {
          const id = crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id,
            actions, binding, status, requested_by, requested_at, granted_by, granted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'test', 0, 'test', 0)`
          )
            .bind(
              id,
              subjectType,
              subjectId,
              objectType,
              objectId,
              JSON.stringify(actions),
              `B${unique().toUpperCase().replaceAll("-", "")}`
            )
            .run();
          return id;
        }
      )
    );
    // The migration's own deletes, as it ran them on what was there.
    const migration = z
      .array(z.object({ name: z.string(), queries: z.array(z.string()) }))
      .parse(testBinding("CORE_MIGRATIONS"))
      .find(({ name }) => name.includes("drop_v1_exports"));
    const deletes = (migration?.queries ?? []).filter((query) =>
      query.trimStart().startsWith("DELETE")
    );
    await env.DB.batch(deletes.map((query) => env.DB.prepare(query)));

    const left = await env.DB.prepare(
      `SELECT id FROM permissions WHERE id IN (${ids.map(() => "?").join(", ")})`
    )
      .bind(...ids)
      .all<{ id: string }>();
    expect({
      deletes: deletes.length,
      left: left.results
        .map(({ id }) => ids.indexOf(id))
        .toSorted((a, b) => a - b),
    }).toStrictEqual({ deletes: 2, left: [3, 4] });
  });
});
