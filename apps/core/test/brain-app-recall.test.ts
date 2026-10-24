import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import type { FunctionAnswer } from "../src/app-functions.ts";
import type { Release } from "../src/app-releases.ts";
import { appFor, setCurrentVersion } from "../src/apps.ts";
import { createCollection } from "../src/knowledge/collections.ts";
import { saveDocument } from "../src/knowledge/documents.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { approveResourceBinding } from "../src/resource-bindings.ts";
import { isRestricted } from "../src/restricted.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";

// An App's recall of the Brain (GRA-296): a `recall` operation of a
// knowledge resource, served by the one recall service every caller
// reaches (knowledge/recall.ts), through core's operation host. How it
// can fail, and what each test holds it to:
// 1. Apps start with no Brain: collection grants and an approved binding
//    alone recall nothing.
// 2. A recall reaches past its binding: into a collection the App was
//    granted for something else, or one the declaration never names.
// 3. A recall reaches past its person: a bound collection they can't
//    read is left out, as a search leaves it, and says nothing of it.
// 4. A name the declaration doesn't have widens or probes the binding.
// 5. Sensitive evidence leaves without its classification, or without
//    restricting the App.
// 6. A retained binding keeps recalling after the Brain's grant is gone.

/** An App whose action recalls from two declared Knowledge collections. */
const brainFiles = (): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string() }),
});
`,
  "operations/brain.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const help = resource.knowledge("help", {
  operations: ["recall"],
  collections: ["handbook", "salaries"],
});

/** The titles of what a recall cited, and how far it got. */
export const ask = action({
  args: { query: v.string().min(1), collections: v.array(v.string()).optional() },
  returns: v.object({ cited: v.array(v.string()), coverage: v.string() }),
  uses: [help],
  handler: async (ctx, args) => {
    const pack = await ctx.resources.help.recall({
      query: args.query,
      ...(args.collections === undefined ? {} : { collections: args.collections }),
    });
    return {
      cited: pack.items.map((item) => item.citationLocator[0] ?? ""),
      coverage: pack.coverage.state,
    };
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { ask, help } from "./operations/brain.ts";
import schema from "./schema.ts";

export default app({
  name: "Ask",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { brain: { ask } },
  internalOperations: {},
  screens: [],
  uses: [help],
});
`,
});

type Sealed = Fixture & { release: Release };

type Admin = Awaited<ReturnType<typeof person>>;

/** A permission of the App, asked for by its owner and granted. */
const granted = async (
  sealed: Sealed,
  admin: Admin,
  object: { type: "collection"; collectionId: string } | { type: "platform" },
  binding: string
): Promise<string> => {
  const requested = await requestPermission(
    env,
    sealed.owner,
    {
      subject: { type: "app", appId: sealed.app },
      object,
      actions: [object.type === "platform" ? "brain" : "read"],
      binding,
    },
    {
      app: async (app, role) => await appFor(env, sealed.owner, app, role),
      resource: async () =>
        await Promise.reject(
          new Error("No independent resource is named here")
        ),
    }
  );
  await grantPermission(env, admin, requested.id, {
    version: sealed.release.manifest.resourceVersion,
  });
  return requested.id;
};

/**
 * The Ask App, sealed, current and bound: a handbook everyone reads, a
 * sensitive salaries collection of a team its owner is in, and a third
 * collection the App may read too, under a grant of its own that this
 * binding doesn't name. Each holds a document about leave.
 */
const brainApp = async () => {
  const fixture = await appWith(brainFiles(), "Ask");
  const release = await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  const sealed: Sealed = { ...fixture, release };
  const admin = await person("admin");
  const team = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Payroll', 'organization', ?)"
    ).bind(team, Date.now()),
    ...[sealed.owner, admin].map((member) =>
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), team, member.userId, Date.now())
    ),
  ]);
  const teamAdmin = { ...admin, teams: [{ id: team, name: "Payroll" }] };
  const handbook = await createCollection(env, admin, {
    name: "Handbook",
    access: "everyone",
  });
  const salaries = await createCollection(env, teamAdmin, {
    name: "Salaries",
    access: "teams",
    teams: [team],
    sensitive: true,
  });
  const elsewhere = await createCollection(env, admin, {
    name: "Elsewhere",
    access: "everyone",
  });
  for (const [collectionId, path, text] of [
    [handbook.id, "leave.md", "# Leave\nAsk your lead before you take leave."],
    [salaries.id, "pay.md", "# Pay\nLeave is paid at the usual rate."],
    [elsewhere.id, "travel.md", "# Travel\nLeave your car at home."],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- one document at a time
    await saveDocument(env, teamAdmin, {
      collectionId,
      path,
      text,
      ifVersion: 0,
    });
  }
  const collections = {
    handbook: await granted(
      sealed,
      admin,
      { type: "collection", collectionId: handbook.id },
      "HANDBOOK"
    ),
    salaries: await granted(
      sealed,
      admin,
      { type: "collection", collectionId: salaries.id },
      "SALARIES"
    ),
  };
  await granted(
    sealed,
    admin,
    { type: "collection", collectionId: elsewhere.id },
    "ELSEWHERE"
  );
  await approveResourceBinding(env, admin, {
    app: sealed.app,
    alias: "help",
    target: { kind: "knowledge", collections },
    reviewed: { version: 1 },
  });
  return {
    sealed,
    admin,
    team,
    grantBrain: async () =>
      await granted(sealed, admin, { type: "platform" }, "BRAIN"),
    ids: { handbook: handbook.id, salaries: salaries.id },
  };
};

/** Calls `brain.ask` of the App as its owner: the whole answer. */
const ask = async (
  { app, owner, release }: Sealed,
  input: { query: string; collections?: string[] }
): Promise<FunctionAnswer> => {
  const operation = release.app.operations["brain.ask"];
  if (operation === undefined) {
    throw new Error("No brain.ask");
  }
  return await callAppFunction(
    env,
    owner,
    app,
    JSON.stringify({
      reference: {
        resourceId: release.manifest.resourceId,
        resourceVersion: release.manifest.resourceVersion,
        contractId: "brain.ask",
        fingerprint: release.fingerprints["brain.ask"] ?? "",
        kind: operation.kind,
      },
      input,
    })
  );
};

const askedSchema = z.strictObject({
  cited: z.array(z.string()),
  coverage: z.string(),
});

/** What a call answered: the titles it cited, or its error's code. */
const outcomeOf = (result: OperationResult): Json =>
  result.ok
    ? askedSchema.parse(result.value).cited.toSorted()
    : { failed: result.error.code };

/** Signing people in, sealing and granting can be slow on CI. */
const setUpTime = { timeout: 60_000 };

describe("an App's recall of the Brain", setUpTime, () => {
  it("recalls nothing without the Brain's permission, and only its bound collections with it", async () => {
    const { sealed, grantBrain, ids } = await brainApp();
    const without = await ask(sealed, { query: "leave" });
    await grantBrain();
    const withBrain = await ask(sealed, { query: "leave" });
    expect({
      without: outcomeOf(without.result),
      // Never Travel: the App may read its collection, but not through
      // this binding.
      withBrain: outcomeOf(withBrain.result),
      provenance: withBrain.provenance,
    }).toStrictEqual({
      without: { failed: "resource.unavailable" },
      withBrain: ["Leave", "Pay"],
      provenance: {
        collectionIds: [ids.handbook, ids.salaries].toSorted(),
        sensitive: true,
        restricted: true,
        connections: [],
        truncated: false,
      },
    });
  });

  it("narrows to the collections named, and refuses a name the declaration lacks", async () => {
    const { sealed, grantBrain, ids } = await brainApp();
    await grantBrain();
    const handbookOnly = await ask(sealed, {
      query: "leave",
      collections: ["handbook"],
    });
    const undeclared = await ask(sealed, {
      query: "leave",
      collections: ["handbook", "elsewhere"],
    });
    expect({
      handbookOnly: outcomeOf(handbookOnly.result),
      provenance: handbookOnly.provenance,
      undeclared: outcomeOf(undeclared.result),
    }).toStrictEqual({
      handbookOnly: ["Leave"],
      // Nothing sensitive was read, so nothing restricts the call.
      provenance: {
        collectionIds: [ids.handbook],
        sensitive: false,
        restricted: false,
        connections: [],
        truncated: false,
      },
      undeclared: { failed: "contract.invalid_args" },
    });
  });

  it("leaves out a bound collection its person can't read, as if it held nothing", async () => {
    const { sealed, grantBrain, team, ids } = await brainApp();
    await grantBrain();
    // The owner leaves the payroll team: salaries is still bound, but no
    // longer theirs to read.
    await env.DB.prepare(
      "DELETE FROM team_members WHERE team_id = ? AND user_id = ?"
    )
      .bind(team, sealed.owner.userId)
      .run();
    const all = await ask(sealed, { query: "leave" });
    const salariesOnly = await ask(sealed, {
      query: "leave",
      collections: ["salaries"],
    });
    expect({
      all: outcomeOf(all.result),
      allProvenance: all.provenance?.collectionIds,
      salariesOnly: outcomeOf(salariesOnly.result),
      salariesProvenance: salariesOnly.provenance,
    }).toStrictEqual({
      all: ["Leave"],
      allProvenance: [ids.handbook],
      // Not refused: the same answer as a collection that holds nothing.
      salariesOnly: [],
      salariesProvenance: {
        collectionIds: [],
        sensitive: false,
        restricted: false,
        connections: [],
        truncated: false,
      },
    });
  });

  it("restricts the App once a recall hands it sensitive evidence", async () => {
    const { sealed, grantBrain } = await brainApp();
    await grantBrain();
    const authority = {
      subject: { type: "app" as const, appId: sealed.app },
      onBehalfOf: sealed.owner.userId,
      mode: "interactive" as const,
      appVersion: 1,
    };
    const context = { type: "app" as const, appId: sealed.app };
    const before = await isRestricted(env, authority, context);
    const plain = await ask(sealed, {
      query: "leave",
      collections: ["handbook"],
    });
    const afterPlain = await isRestricted(env, authority, context);
    await ask(sealed, { query: "paid", collections: ["salaries"] });
    expect({
      before,
      plain: outcomeOf(plain.result),
      afterPlain,
      afterSensitive: await isRestricted(env, authority, context),
    }).toStrictEqual({
      before: false,
      plain: ["Leave"],
      afterPlain: false,
      afterSensitive: true,
    });
  });

  it("stops recalling once the Brain's permission is revoked, through the same binding", async () => {
    const { sealed, admin, grantBrain } = await brainApp();
    const brain = await grantBrain();
    const before = await ask(sealed, {
      query: "leave",
      collections: ["handbook"],
    });
    await revokePermission(env, admin, brain);
    const after = await ask(sealed, {
      query: "leave",
      collections: ["handbook"],
    });
    expect({
      before: outcomeOf(before.result),
      after: outcomeOf(after.result),
    }).toStrictEqual({
      before: ["Leave"],
      after: { failed: "resource.unavailable" },
    });
  });
});
