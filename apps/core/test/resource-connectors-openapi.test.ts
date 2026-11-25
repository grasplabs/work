import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { personOf } from "../src/connections.ts";
import { testApp } from "./app-definitions.ts";
import { commitApp, publishDefined } from "./apps.ts";
import { mockIdpWith } from "./idp.ts";
import { pipedriveControlUrl } from "./pipedrive-fake.ts";
import {
  call,
  idp,
  isFetcher,
  outcomeOf,
} from "./resource-connectors-harness.ts";
import { signedInApi } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// An App calls a connector generated from its vendor's OpenAPI spec as it
// calls any connector, typed by the tools the spec made. This runs the
// real connect with connect's Pipedrive fixture bundled
// (apps/connect/test/fixtures/pipedrive), whose tools the compiler
// generated from Pipedrive's spec; only Pipedrive is faked
// (test/pipedrive-fake.ts).

mockIdpWith(idp);

const providers = testBinding("CONNECT_PROVIDERS");

const control = async (path: string, init?: RequestInit): Promise<Response> => {
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return await providers.fetch(`${pipedriveControlUrl}${path}`, init);
};

/** The query and the credentials of every request that listed deals with `token`. */
const listingsOf = async (token: string) => {
  const response = await control(
    `?${new URLSearchParams({ token }).toString()}`
  );
  const listings = z
    .array(
      z.object({
        query: z.string(),
        headers: z.record(z.string(), z.string()),
      })
    )
    .parse(await response.json());
  return listings.map(({ query, headers }) => ({
    query: Object.fromEntries(new URLSearchParams(query)),
    credentials: Object.fromEntries(
      Object.entries(headers).filter(([name]) =>
        /auth|key|token|cookie/u.test(name)
      )
    ),
  }));
};

const dealsFiles = (status: string) =>
  testApp(
    {
      name: "Deals",
      permissions: [
        'permission.connection("crm", {\n  contract: "pipedrive.deals@1",\n  actions: ["list"],\n})',
      ],
    },
    {
      "server/deals.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const crm = permissions.crm;

/** A pipeline's deals with a status, as Pipedrive listed them. */
export const titles = action({
  args: { pipeline: v.number() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const listed = await ctx.connections.crm.list({
      pipeline_id: args.pipeline,
      status: [${JSON.stringify(status)}],
      limit: 2,
    });
    return JSON.stringify({
      titles: listed.items.map((deal) => deal.title ?? ""),
      next: listed.next,
    });
  },
});
`,
    }
  );

/**
 * The Deals App, current, with a grant an admin gave it to list deals
 * through a shared connection to Pipedrive, its `crm` resource bound to it.
 */
const dealsApp = async (deals: unknown[]) => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const created = await builder.api.apps.create({ name: "Deals" });
  await commitApp(builder.api, created.id, dealsFiles("open"));
  await builder.api.versions.rollback({ kind: "app", id: created.id }, 1);
  const token = `token-${crypto.randomUUID()}`;
  await control("", {
    method: "POST",
    body: JSON.stringify({
      token,
      account: { id: 7, name: "Sales", email: "sales@acme.test" },
      deals,
    }),
  });
  const { connectionId } = await env.CONNECT.connectWithKey({
    person: await personOf(env, await admin.api.whoami()),
    provider: "pipedrive",
    scope: "shared",
    key: token,
  });
  const requested = await builder.api.permissions.request({
    subject: { type: "app", appId: created.id },
    object: { type: "connection", connectionId },
    actions: ["deals.list"],
    binding: "CRM",
  });
  await admin.api.permissions.grant(requested.id, { version: 1 });
  await admin.api.resourceBindings.approve({
    app: created.id,
    alias: "crm",
    target: { kind: "connector", permissionId: requested.id },
    reviewed: { version: 1 },
  });
  return {
    builder,
    app: created.id,
    token,
    by: await builder.api.whoami(),
    release: await loadRelease(env, created.id, 1),
  };
};

describe(
  "a connector generated from an OpenAPI spec, called by an App",
  { timeout: 120_000 },
  () => {
    it("answer the App a page of deals, asked for with the vendor's arguments and the connection's token alone", async () => {
      const crm = await dealsApp([
        { id: 1, title: "Acme renewal", status: "open", pipeline_id: 3 },
        { id: 2, title: "Globex pilot", status: "open", pipeline_id: 3 },
      ]);
      const result = await call(crm, "deals.titles", { pipeline: 3 });
      const answered: unknown =
        result.ok && typeof result.value === "string"
          ? JSON.parse(result.value)
          : outcomeOf(result);
      expect({
        answered,
        listings: await listingsOf(crm.token),
      }).toStrictEqual({
        answered: { titles: ["Acme renewal", "Globex pilot"], next: null },
        listings: [
          {
            query: { pipeline_id: "3", status: "open", limit: "2" },
            credentials: { "x-api-token": crm.token },
          },
        ],
      });
    });

    it("refuse to publish an App that asks with a value the vendor's spec doesn't allow", async () => {
      const crm = await dealsApp([]);
      await expect(
        publishDefined(env, crm.by, crm.app, dealsFiles("closed"))
      ).rejects.toMatchObject({ code: "app.draft_failed" });
      await expect(
        publishDefined(env, crm.by, crm.app, dealsFiles("won"))
      ).resolves.toMatchObject({ version: 2 });
    });
  }
);
