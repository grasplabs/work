import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { loadRelease } from "../src/app-releases.ts";
import { personOf } from "../src/connections.ts";
import { testApp } from "./app-definitions.ts";
import { commitApp } from "./apps.ts";
import { mockIdpWith } from "./idp.ts";
import {
  call,
  idp,
  outcomeOf,
  recordedRequests,
} from "./resource-connectors-harness.ts";
import { signedInApi } from "./sign-in.ts";

// An App calls a connector written on `@grasp-os/sdk/connector` the way
// it calls any connector: through connect, under a binding an admin
// approved and the App's own grant on the connection, checked against the
// contract connect generates from the connector's tools. This runs the
// real connect with connect's sample API-key app bundled
// (apps/connect/test/fixtures/sample-key/connector.ts); only the app's
// API is faked, by its recorded answers (the fixture's fixtures.json,
// which connect's build replays too).

mockIdpWith(idp);

/** The credentials of each request that listed `board` with `key`. */
const listingsOf = async (board: string, key: string) =>
  await recordedRequests(`/v1/boards/${board}/items`, "x-api-key", key);

const someBoard = () => `board-${crypto.randomUUID()}`;

const boardsFiles = () =>
  testApp(
    {
      name: "Boards",
      permissions: [
        'permission.connection("boards", {\n  contract: "sample-key.boards.items@1",\n  actions: ["list"],\n})',
      ],
    },
    {
      "server/boards.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const boards = permissions.boards;

/** The board's items, as the app answered them. */
export const items = action({
  args: { board: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const listed = await ctx.connections.boards.list({ board: args.board });
    return JSON.stringify(listed);
  },
});

/** Lists with an argument the contract doesn't name. */
export const archived = action({
  args: { board: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    // An argument the contract doesn't name, past the types on purpose.
    await ctx.connections.boards.list({ board: args.board, archived: true } as never);
    return "listed";
  },
});
`,
    }
  );

/**
 * The Boards App, made by a builder, current, with a grant an admin gave
 * it to list items through a shared connection to the sample app, and its
 * `boards` resource bound to it.
 */
const boardsApp = async () => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const created = await builder.api.apps.create({ name: "Boards" });
  await commitApp(builder.api, created.id, boardsFiles());
  await builder.api.versions.rollback({ kind: "app", id: created.id }, 1);
  const key = `key-${crypto.randomUUID()}`;
  // Core has no route yet that connects an app signing in with an API
  // key: the admin's connection is made at connect, as core would ask it.
  const { connectionId } = await env.CONNECT.connectWithKey({
    person: await personOf(env, await admin.api.whoami()),
    provider: "sample-key",
    scope: "shared",
    key,
  });
  const requested = await builder.api.permissions.request({
    subject: { type: "app", appId: created.id },
    object: { type: "connection", connectionId },
    actions: ["boards.items.list"],
    binding: "BOARDS",
  });
  await admin.api.permissions.grant(requested.id, { version: 1 });
  await admin.api.resourceBindings.approve({
    app: created.id,
    alias: "boards",
    target: { kind: "connector", permissionId: requested.id },
    reviewed: { version: 1 },
  });
  return {
    admin,
    key,
    permission: requested.id,
    by: await builder.api.whoami(),
    release: await loadRelease(env, created.id, 1),
  };
};

describe(
  "a connector written on the SDK, called by an App",
  { timeout: 120_000 },
  () => {
    it("answer the App the app's items, listed with the connection's key alone", async () => {
      const boards = await boardsApp();
      // The board the app's recorded answers list two pages of.
      const result = await call(boards, "boards.items", { board: "board-1" });
      const answered: unknown =
        result.ok && typeof result.value === "string"
          ? JSON.parse(result.value)
          : outcomeOf(result);
      const listings = await listingsOf("board-1", boards.key);
      expect({
        answered,
        credentials: listings.map(({ credentials }) => credentials),
      }).toStrictEqual({
        answered: {
          items: [
            { id: "item-1", title: "First" },
            { id: "item-2", title: "Second" },
          ],
          next: "page-2",
        },
        credentials: [{ "x-api-key": boards.key }],
      });
    });

    it("refuse an argument the contract doesn't allow before connect", async () => {
      const boards = await boardsApp();
      const board = someBoard();
      const result = await call(boards, "boards.archived", { board });
      expect({
        outcome: outcomeOf(result),
        listings: await listingsOf(board, boards.key),
      }).toStrictEqual({
        outcome: { failed: "permission.invalid_args" },
        listings: [],
      });
    });

    it("fail closed on an answer outside the tool's returns", async () => {
      const boards = await boardsApp();
      // The board the app's recorded answer lists items of the wrong
      // shape: the app was asked, and its answer refused in the
      // connector. The App gets a failure in its place, and none of it.
      const board = "malformed";
      const result = await call(boards, "boards.items", { board });
      const listings = await listingsOf(board, boards.key);
      expect({
        outcome: outcomeOf(result),
        listings: listings.length,
      }).toStrictEqual({
        outcome: { failed: "internal.unexpected" },
        listings: 1,
      });
    });

    it("refuse the App once the admin revokes its grant", async () => {
      const boards = await boardsApp();
      const board = someBoard();
      await boards.admin.api.permissions.revoke(boards.permission);
      const result = await call(boards, "boards.items", { board });
      expect({
        outcome: outcomeOf(result),
        listings: await listingsOf(board, boards.key),
      }).toStrictEqual({
        outcome: { failed: "permission.unavailable" },
        listings: [],
      });
    });
  }
);
