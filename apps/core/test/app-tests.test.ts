import { manifestText } from "@grasp-os/sdk/host";
import { isExpectedError } from "@grasp-os/shared/errors";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { activateVersion } from "../src/app-activation.ts";
import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { sweepTestFixtures } from "../src/app-tests.ts";
import { commitFiles, createApp, findApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import {
  createStore,
  discardFixtureStore,
  openFixtureStore,
  openStore,
} from "../src/data-stores.ts";
import { person } from "./sealed-apps.ts";

// An App's tests (`appTest`, spec 28.2), as core runs them when a version
// is made current: each suite in its own isolate, every call through the
// real operation host on a fixture store of the test's own. What the
// tests here check is what that host did: the App's access rules held
// between two principals, a store per test, refusals a screen's call
// would get, failures named as people read them, and nothing left in the
// App's own store or behind in fixture stores.

const appFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(200) }),
});
`,
  "operations/notes.ts": `import { AppError, v } from "@grasp-os/sdk";
import { internalQuery, mutation, query } from "#grasp/server";

export const create = mutation({
  args: { title: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) =>
    (await ctx.db.query("notes").take(100)).map((note) => note.title),
});

export const find = query({
  args: { id: v.id("notes") },
  returns: v.string(),
  handler: async (ctx, args) => {
    const note = await ctx.db.get("notes", args.id);
    if (!note) {
      throw new AppError("note.not_found", "No such note.");
    }
    return note.title;
  },
});

export const count = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).length,
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { count, create, find, titles } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { notes: { create, titles, find } },
  internalOperations: { notes: { count } },
  screens: [],
  uses: [],
});
`,
  "tests/fixtures/notes.json": JSON.stringify({
    principals: {
      "note-owner": { role: "user" },
      "other-owner": { role: "user" },
    },
  }),
};

const passingSuite = `import { appTest } from "@grasp-os/sdk/testing";
import { api } from "#grasp";

export default appTest({
  fixtures: "notes",
  tests: {
    "an owner reads back the note they create": async (t) => {
      const owner = await t.as("note-owner");
      const id = await owner.mutation(api.notes.create, { title: "First note" });
      t.equal(await owner.query(api.notes.find, { id }), "First note");
      t.equal(await owner.query(api.notes.titles, {}), ["First note"]);
    },
    "each test starts on an empty store": async (t) => {
      const owner = await t.as("note-owner");
      t.equal(await owner.query(api.notes.titles, {}), []);
    },
    "another owner sees none of it": async (t) => {
      const owner = await t.as("note-owner");
      const other = await t.as("other-owner");
      const id = await owner.mutation(api.notes.create, { title: "Mine" });
      t.equal(await other.query(api.notes.titles, {}), []);
      await t.rejectsCode(other.query(api.notes.find, { id }), "note.not_found");
    },
    "the host refuses what a screen's call is refused": async (t) => {
      const owner = await t.as("note-owner");
      const internal = { ...api.notes.titles, contractId: "notes.count" };
      await t.rejectsCode(owner.query(internal, {}), "operation.not_found");
      const later = {
        ...api.notes.titles,
        resourceVersion: api.notes.titles.resourceVersion + 1,
      };
      await t.rejectsCode(owner.query(later, {}), "version.mismatch");
      await t.rejectsCode(
        () => owner.mutation(api.notes.create, { title: "" }),
        "contract.invalid_args"
      );
    },
  },
});
`;

const failingSuite = `import { appTest } from "@grasp-os/sdk/testing";
import { api } from "#grasp";

export default appTest({
  fixtures: "notes",
  tests: {
    "compares what the App answers": async (t) => {
      const owner = await t.as("note-owner");
      t.equal(await owner.query(api.notes.titles, {}), ["Something"]);
    },
    "fails on an error nobody expected": async (t) => {
      const owner = await t.as("note-owner");
      const other = await t.as("other-owner");
      const id = await owner.mutation(api.notes.create, { title: "Mine" });
      await other.query(api.notes.find, { id });
    },
    "fails when an expected refusal never comes": async (t) => {
      const owner = await t.as("note-owner");
      await t.rejectsCode(owner.query(api.notes.titles, {}), "note.not_found");
    },
    "fails for a principal the fixture doesn't name": async (t) => {
      await t.as("stranger");
    },
    "passes": async (t) => {
      t.equal(1, 1);
    },
  },
});
`;

interface Built {
  owner: Acting & Identity;
  app: AppId;
}

/** A builder's App with `files` as its first version. */
const appWith = async (files: Record<string, string>): Promise<Built> => {
  const owner = await person("builder");
  const { id } = await createApp(env, owner, { name: "Notes" });
  await commitFiles(env, owner, id, files, "First version");
  return { owner, app: id };
};

/** What activating version 1 failed with: its code and failures. */
const refusal = async ({
  owner,
  app,
}: Built): Promise<{ code: unknown; failures: unknown }> => {
  try {
    await activateVersion(env, owner, app, 1);
  } catch (error) {
    if (!isExpectedError(error)) {
      throw error;
    }
    return { code: error.code, failures: error.details?.failures };
  }
  throw new Error("The version was made current");
};

/** The fixture stores core still records. */
const fixturesLeft = async (): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM app_test_fixtures"
  ).first<{ n: number }>();
  return row?.n ?? -1;
};

/** The tables store `id`'s object still holds. */
const tablesIn = async (id: string): Promise<number> =>
  await runInDurableObject(
    env.DATA_STORES.getByName(id),
    (_instance, state) => {
      const [row] = state.storage.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'"
        )
        .toArray();
      return row?.n ?? -1;
    }
  );

describe("an App's tests", { timeout: 180_000 }, () => {
  it("make the version current when they pass, and leave the App's data alone", async () => {
    const built = await appWith({
      ...appFiles,
      "tests/notes.test.ts": passingSuite,
    });
    await activateVersion(env, built.owner, built.app, 1);
    await expect(findApp(env, built.app)).resolves.toMatchObject({
      currentVersion: 1,
    });

    // The App's own store holds nothing the tests wrote.
    const release = await loadRelease(env, built.app, 1);
    const answer = await callAppFunction(
      env,
      built.owner,
      built.app,
      JSON.stringify({
        reference: {
          resourceId: release.manifest.resourceId,
          resourceVersion: 1,
          contractId: "notes.titles",
          fingerprint: release.fingerprints["notes.titles"],
          kind: "query",
        },
        input: {},
      })
    );
    expect(answer.result).toStrictEqual({ ok: true, value: [] });
    // And no fixture store is left.
    await expect(fixturesLeft()).resolves.toBe(0);
  });

  it("refuse the version while one fails, naming each failing test and why", async () => {
    const built = await appWith({
      ...appFiles,
      "tests/failing.test.ts": failingSuite,
    });
    const { code, failures } = await refusal(built);
    expect(code).toBe("version.tests_failed");
    expect(failures).toStrictEqual([
      'tests/failing.test.ts, "compares what the App answers": expected ["Something"], got []',
      'tests/failing.test.ts, "fails on an error nobody expected": unexpected error note.not_found: No such note.',
      'tests/failing.test.ts, "fails when an expected refusal never comes": expected note.not_found, but the call succeeded',
      'tests/failing.test.ts, "fails for a principal the fixture doesn\'t name": The fixture "notes" has no principal "stranger": name it in tests/fixtures/notes.json.',
    ]);
    await expect(findApp(env, built.app)).resolves.toMatchObject({
      currentVersion: null,
    });
    await expect(fixturesLeft()).resolves.toBe(0);
  });

  it("can't reach the App's server code, only its references", async () => {
    const built = await appWith({
      ...appFiles,
      "tests/sneaky.test.ts": `import { appTest } from "@grasp-os/sdk/testing";
import { titles } from "../operations/notes.ts";

export default appTest({ fixtures: "notes", tests: { "runs a handler": async () => { await titles.handler(); } } });
`,
    });
    const { code, failures } = await refusal(built);
    expect(code).toBe("version.tests_failed");
    expect(failures).toStrictEqual([
      expect.stringMatching(
        /^tests\/sneaky\.test\.ts:2: "\.\.\/operations\/notes\.ts" can't be imported here\./u
      ),
    ]);
  });

  it("fail a suite whose fixture the App doesn't have", async () => {
    const built = await appWith({
      ...appFiles,
      "tests/notes.test.ts": passingSuite.replace(
        'fixtures: "notes"',
        'fixtures: "missing"'
      ),
    });
    const { code, failures } = await refusal(built);
    expect(code).toBe("version.tests_failed");
    expect(failures).toStrictEqual([
      expect.stringMatching(
        /^tests\/notes\.test\.ts: .*its fixture tests\/fixtures\/missing\.json doesn't exist/u
      ),
    ]);
  });
});

describe("fixture stores", () => {
  it("are discarded by the sweep once a run that left them is long over", async () => {
    const built = await appWith(appFiles);
    await activateVersion(env, built.owner, built.app, 1);
    const release = await loadRelease(env, built.app, 1);
    const now = Date.now();
    /** A fixture store a test run left, recorded `ago` milliseconds back. */
    const left = async (ago: number): Promise<string> => {
      const id = storeIdSchema.parse(crypto.randomUUID());
      await env.DB.prepare(
        "INSERT INTO app_test_fixtures (store_id, app_id, version, created_at) VALUES (?, ?, 1, ?)"
      )
        .bind(id, built.app, now - ago)
        .run();
      await openFixtureStore(env, id).defineTables(
        manifestText(release.app.schema),
        { resourceId: built.app, resourceVersion: 1 }
      );
      return id;
    };
    const old = await left(2 * 60 * 60_000);
    const fresh = await left(60_000);
    await expect(tablesIn(old)).resolves.toBeGreaterThan(0);

    await sweepTestFixtures(env, new Date(now));

    await expect(tablesIn(old)).resolves.toBe(0);
    await expect(tablesIn(fresh)).resolves.toBeGreaterThan(0);
    await expect(fixturesLeft()).resolves.toBe(1);
  });

  it("never discard a store the inventory lists", async () => {
    const builder = await person("builder");
    const store = await createStore(env, builder);
    await expect(discardFixtureStore(env, store)).rejects.toThrow(
      "A listed store is deleted, never discarded."
    );
    await expect(openStore(env, store)).resolves.toMatchObject({ id: store });
  });
});
