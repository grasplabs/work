import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { personOf } from "../src/connections.ts";
import { testApp } from "./app-definitions.ts";
import { commitApp } from "./apps.ts";
import { mockIdpWith } from "./idp.ts";
import {
  call,
  idp,
  isFetcher,
  outcomeOf,
} from "./resource-connectors-harness.ts";
import { sampleKeyControlUrl } from "./sample-key-fake.ts";
import { signedInApi } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// An App calls a connector written on `@grasp-os/sdk/connector` the way
// it calls any connector: through connect, under a binding an admin
// approved and the App's own grant on the connection, checked against the
// contract connect generates from the connector's tools. This runs the
// real connect with connect's sample API-key app bundled
// (apps/connect/test/fixtures/sample-key-connector.ts); only the app's
// API is faked (test/sample-key-fake.ts).

mockIdpWith(idp);

const providers = testBinding("CONNECT_PROVIDERS");

const control = async (init?: RequestInit): Promise<Response> => {
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return await providers.fetch(sampleKeyControlUrl, init);
};

/** Has the app list `answer` for `board`. */
const answerFor = async (board: string, answer: unknown): Promise<void> => {
  await control({ method: "POST", body: JSON.stringify({ board, answer }) });
};

/** The headers of every request the app got to list `board`. */
const listingsOf = async (board: string) => {
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  const response = await providers.fetch(
    `${sampleKeyControlUrl}?${new URLSearchParams({ board }).toString()}`
  );
  return z.array(z.record(z.string(), z.string())).parse(await response.json());
};

/** The credentials each listing of `board` carried, by header. */
const credentialsOf = async (board: string) => {
  const listings = await listingsOf(board);
  return listings.map((headers) =>
    Object.fromEntries(
      Object.entries(headers).filter(([name]) =>
        /auth|key|token|cookie/u.test(name)
      )
    )
  );
};

const someBoard = () => `board-${crypto.randomUUID()}`;

const boardsFiles = () =>
  testApp(
    {
      name: "Boards",
      permissions: [
        'permission.connection("boards", {\n  contract: "sample-key.items@1",\n  actions: ["list"],\n})',
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
  await control({
    method: "POST",
    body: JSON.stringify({
      key,
      account: { id: `team-${key}`, name: "Team", email: "team@acme.test" },
    }),
  });
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
    actions: ["items.list"],
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
      const board = someBoard();
      const items = [
        { id: "item-1", title: "First" },
        { id: "item-2", title: "Second" },
      ];
      await answerFor(board, { items });
      const result = await call(boards, "boards.items", { board });
      const answered: unknown =
        result.ok && typeof result.value === "string"
          ? JSON.parse(result.value)
          : outcomeOf(result);
      expect({
        answered,
        credentials: await credentialsOf(board),
      }).toStrictEqual({
        answered: { items },
        credentials: [{ "x-api-key": boards.key }],
      });
    });

    it("refuse an argument the contract doesn't allow before connect", async () => {
      const boards = await boardsApp();
      const board = someBoard();
      const result = await call(boards, "boards.archived", { board });
      expect({
        outcome: outcomeOf(result),
        listings: await listingsOf(board),
      }).toStrictEqual({
        outcome: { failed: "permission.invalid_args" },
        listings: [],
      });
    });

    it("fail closed on an answer outside the tool's returns", async () => {
      const boards = await boardsApp();
      const board = someBoard();
      await answerFor(board, { items: [{ id: 1, title: null }] });
      // The app was asked, and its answer refused in the connector: the
      // App gets a failure in its place, and none of the answer.
      const result = await call(boards, "boards.items", { board });
      const listings = await listingsOf(board);
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
        listings: await listingsOf(board),
      }).toStrictEqual({
        outcome: { failed: "permission.unavailable" },
        listings: [],
      });
    });
  }
);
