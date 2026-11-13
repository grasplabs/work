import { manifestText, schemaHash } from "@grasp-os/runtime/host";
import { isExpectedError } from "@grasp-os/shared/errors";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease, sealRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { sweepTestFixtures } from "../src/app-tests.ts";
import { appKind, createApp, findApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import {
  discardFixtureStore,
  openFixtureStore,
  openStore,
} from "../src/data-stores.ts";
import { rollback } from "../src/publish.ts";
import { testApp, withFiles } from "./app-definitions.ts";
import type { TestApp, TestSource } from "./app-definitions.ts";
import { storeOfNewApp } from "./app-stores.ts";
import { commitDefined } from "./apps.ts";
import { person } from "./sealed-apps.ts";
import { applied } from "./store-schemas.ts";

// An App's tests (`appTest`, spec 28.2), as core runs them whenever a
// version is made current: each suite in its own isolate, every call
// through the real function host on a fixture store of the test's own.
// What the tests here check is what that host did: the App's access
// rules held between identities and roles, a store per test, what a
// test seeds and inspects directly (`t.run`) and where that may happen,
// refusals a page's call would get, failures named as people read them,
// the limits on a run, and nothing left in the App's own store or behind
// in fixture stores.

const appFiles: TestApp = testApp(
  {
    name: "Notes",
    tables: {
      notes: {
        fields: { title: "v.string().min(1).max(200)" },
        access: { read: "owner", write: "owner" },
      },
      mottos: {
        fields: { text: "v.string().min(1).max(200)" },
        access: { read: "appMembers", write: "appBuilders" },
      },
    },
    permissions: ['permission.brain({ operations: ["recall"] })'],
  },
  {
    "server/notes.ts": `import { AppError, v } from "@grasp-os/sdk";
import { action, internalQuery, mutation, query } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

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

/** Only the App's builders may set its motto. */
export const setMotto = mutation({
  args: { text: v.string().min(1).max(200) },
  returns: v.id("mottos"),
  handler: async (ctx, args) => await ctx.db.insert("mottos", args),
});

export const help = permissions.brain;

export const searchHelp = action({
  args: { text: v.string().min(1) },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const pack = await ctx.brain.recall({ question: args.text, budget: { tokens: 500 } });
    return pack.items.map((item) => item.text);
  },
});

export const count = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).length,
});
`,
  }
);

/** The imports every suite here starts with. */
const suiteImports = `import { appTest } from "@grasp-os/sdk/testing";
import { api } from "@server/_generated/api";
import { expect } from "vitest";
import schema from "../server/schema.ts";
`;

const passingSuite = `${suiteImports}
export default appTest(schema, {
  "an owner reads back the note they create": async (t) => {
    const owner = t.withIdentity({ name: "Ada" });
    const id = await owner.mutation(api.notes.create, { title: "First note" });
    expect(await owner.query(api.notes.find, { id })).toBe("First note");
    expect(await owner.query(api.notes.titles, {})).toEqual(["First note"]);
  },
  "each test starts on an empty store": async (t) => {
    const owner = t.withIdentity({ name: "Ada" });
    expect(await owner.query(api.notes.titles, {})).toEqual([]);
  },
  "another owner sees none of it": async (t) => {
    const owner = t.withIdentity({ name: "Ada" });
    const other = t.withIdentity({ name: "Bo" });
    const id = await owner.mutation(api.notes.create, { title: "Mine" });
    expect(await other.query(api.notes.titles, {})).toEqual([]);
    await expect(other.query(api.notes.find, { id })).rejects.toMatchObject({
      code: "note.not_found",
    });
  },
  "a builder sets the motto, a user may not": async (t) => {
    const builder = t.withIdentity({ name: "Cy", role: "builder" });
    const user = t.withIdentity({ name: "Ada" });
    await builder.mutation(api.notes.setMotto, { text: "Write it down" });
    await expect(
      user.mutation(api.notes.setMotto, { text: "Mine" })
    ).rejects.toMatchObject({ code: "data.write_denied" });
  },
  "no outside system is reached": async (t) => {
    const owner = t.withIdentity({ name: "Ada" });
    await expect(
      owner.action(api.notes.searchHelp, { text: "leave" })
    ).rejects.toMatchObject({ code: "permission.unavailable" });
  },
  "the host refuses what a page's call is refused": async (t) => {
    const owner = t.withIdentity({ name: "Ada" });
    const internal = { ...api.notes.titles, name: "notes.count" };
    await expect(owner.query(internal, {})).rejects.toMatchObject({
      code: "function.not_found",
    });
    await expect(
      owner.mutation(api.notes.create, { title: "" })
    ).rejects.toMatchObject({ code: "contract.invalid_args" });
  },
  "a call it doesn't wait for ends with it": async (t) => {
    const owner = t.withIdentity({ name: "Ada" });
    void owner.mutation(api.notes.create, { title: "Late" }).catch(() => null);
  },
});
`;

const failingSuite = `${suiteImports}
export default appTest(schema, {
  "compares what the App answers": async (t) => {
    const owner = t.withIdentity({ name: "Ada" });
    expect(await owner.query(api.notes.titles, {})).toEqual(["Something"]);
  },
  "fails on an error nobody expected": async (t) => {
    const owner = t.withIdentity({ name: "Ada" });
    const other = t.withIdentity({ name: "Bo" });
    const id = await owner.mutation(api.notes.create, { title: "Mine" });
    await other.query(api.notes.find, { id });
  },
  "fails when an expected refusal never comes": async (t) => {
    const owner = t.withIdentity({ name: "Ada" });
    await expect(owner.query(api.notes.titles, {})).rejects.toMatchObject({
      code: "note.not_found",
    });
  },
  "fails for one name given two roles": async (t) => {
    t.withIdentity({ name: "Ada" });
    t.withIdentity({ name: "Ada", role: "builder" });
  },
  "fails for a name no decision could ask": async (t) => {
    t.withIdentity({ name: "Ada Lovelace" });
  },
  "passes": async () => {
    expect(1).toBe(1);
  },
});
`;

/** A suite of one test, which runs `body` with an owner at hand. */
const suiteOf = (body: string, before = ""): string => `${suiteImports}
${before}
export default appTest(schema, {
  "runs": async (t) => {
    const owner = t.withIdentity({ name: "Ada" });
    ${body}
  },
});
`;

interface Built {
  owner: Acting & Identity;
  app: AppId;
}

/** A builder's App with `files` as its first version. */
const appWith = async (files: TestSource): Promise<Built> => {
  const owner = await person("builder");
  const { id } = await createApp(env, owner, { name: "Notes" });
  await commitDefined(env, owner, id, files, "First version");
  return { owner, app: id };
};

/** Core's env as code reads it, with `changes` over it; env itself unchanged. */
const envWith = (changes: Partial<Env>): Env =>
  new Proxy(env, {
    get: (target, key, receiver): unknown =>
      Object.hasOwn(changes, key)
        ? Reflect.get(changes, key)
        : Reflect.get(target, key, receiver),
  });

/** A deployment where nothing bounds App code: on-prem, without the sandbox host. */
const unbounded = envWith({ SANDBOX_IN_PROCESS: undefined });

/** What activating version 1 failed with: its code and failures. */
const refusal = async (
  { owner, app }: Built,
  on: Env = env
): Promise<{ code: unknown; failures: unknown }> => {
  try {
    await rollback(on, appKind, owner, app, 1);
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

/** The alarm store `id`'s object has armed, if any. */
const alarmOf = async (id: string): Promise<number | null> =>
  await runInDurableObject(
    env.DATA_STORES.getByName(id),
    async (_instance, state) => await state.storage.getAlarm()
  );

describe("an App's tests", { timeout: 180_000 }, () => {
  it("make the version current when they pass, and leave the App's data alone", async () => {
    const built = await appWith(
      withFiles(appFiles, {
        "tests/notes.test.ts": passingSuite,
      })
    );
    await rollback(env, appKind, built.owner, built.app, 1);
    await expect(findApp(env, built.app)).resolves.toMatchObject({
      currentVersion: 1,
    });

    // The App's own store holds nothing the tests wrote.
    const answer = await callAppFunction(
      env,
      built.owner,
      built.app,
      JSON.stringify({
        reference: { name: "notes.titles", kind: "query" },
        args: {},
      })
    );
    expect(answer.result).toStrictEqual({ ok: true, value: [] });
    // And no fixture store is left.
    await expect(fixturesLeft()).resolves.toBe(0);
  });

  it("give each identity the teams it names, as a table's team rules read them, which t.run reads past", async () => {
    const built = await appWith(
      testApp(
        {
          name: "Deals",
          tables: {
            deals: {
              fields: { title: "v.string()", team: "v.string()" },
              access: {
                read: "appMembers",
                write: "appMembers",
                rows: { read: [{ kind: "team", field: "team" }] },
              },
            },
          },
        },
        {
          "server/deals.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";

export const add = mutation({
  args: { title: v.string(), team: v.string() },
  returns: v.id("deals"),
  handler: async (ctx, args) => await ctx.db.insert("deals", args),
});

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) =>
    (await ctx.db.query("deals").take(100)).map((deal) => deal.title),
});
`,

          "tests/deals.test.ts": `${suiteImports}
export default appTest(schema, {
  "each team reads its own deals, and adds none for another": async (t) => {
    const seller = t.withIdentity({ name: "Sam", teams: ["sales"] });
    const helper = t.withIdentity({ name: "Hal", teams: ["support"] });
    await seller.mutation(api.deals.add, { title: "Acme", team: "sales" });
    expect(await seller.query(api.deals.titles, {})).toEqual(["Acme"]);
    expect(await helper.query(api.deals.titles, {})).toEqual([]);
    await expect(
      seller.mutation(api.deals.add, { title: "Globex", team: "support" })
    ).rejects.toMatchObject({ code: "data.write_denied" });
  },
  "t.run sees every team's deals": async (t) => {
    const seller = t.withIdentity({ name: "Sam", teams: ["sales"] });
    await seller.mutation(api.deals.add, { title: "Acme", team: "sales" });
    await t.run(async (ctx) => {
      await ctx.db.insert("deals", { title: "Initech", team: "support" });
    });
    const titles = await t.run(async (ctx) => {
      const deals = await ctx.db.query("deals").take(10);
      return deals.map((deal) => deal.title).toSorted();
    });
    expect(titles).toEqual(["Acme", "Initech"]);
    expect(await seller.query(api.deals.titles, {})).toEqual(["Acme"]);
  },
});
`,
        }
      )
    );
    await rollback(env, appKind, built.owner, built.app, 1);
    await expect(findApp(env, built.app)).resolves.toMatchObject({
      currentVersion: 1,
    });
  });

  it("refuse the version while one fails, naming each failing test and why", async () => {
    const built = await appWith(
      withFiles(appFiles, {
        "tests/failing.test.ts": failingSuite,
      })
    );
    const { code, failures } = await refusal(built);
    expect(code).toBe("version.tests_failed");
    expect(failures).toStrictEqual([
      expect.stringMatching(
        /^tests\/failing\.test\.ts, "compares what the App answers": expected \[\] to deeply equal \[ 'Something' \]/u
      ),
      'tests/failing.test.ts, "fails on an error nobody expected": unexpected error note.not_found: No such note.',
      expect.stringMatching(
        /^tests\/failing\.test\.ts, "fails when an expected refusal never comes": promise resolved .* instead of rejecting/u
      ),
      'tests/failing.test.ts, "fails for one name given two roles": "Ada" is already someone with role user in no team: the same name is the same person.',
      'tests/failing.test.ts, "fails for a name no decision could ask": t.withIdentity takes { name, role?: "user" | "builder", teams?: ["<team ID>"] }: A name is letters, digits, _ and -, at most 64: as a decision\'s recipients name someone.',
    ]);
    await expect(findApp(env, built.app)).resolves.toMatchObject({
      currentVersion: null,
    });
    await expect(fixturesLeft()).resolves.toBe(0);
  });

  it("can't reach the App's server code, only its references", async () => {
    const built = await appWith(
      withFiles(appFiles, {
        "tests/sneaky.test.ts": `import { appTest } from "@grasp-os/sdk/testing";
import { titles } from "../server/notes.ts";
import schema from "../server/schema.ts";

export default appTest(schema, { "runs a handler": async () => { await titles.handler(); } });
`,
      })
    );
    const { code, failures } = await refusal(built);
    expect(code).toBe("version.tests_failed");
    expect(failures).toStrictEqual([
      expect.stringMatching(
        /^tests\/sneaky\.test\.ts:2: "\.\.\/server\/notes\.ts" can't be imported here\./u
      ),
    ]);
  });

  it("seed and inspect every record with t.run, past the App's access rules, on the test's own store alone", async () => {
    const built = await appWith(
      withFiles(appFiles, {
        "tests/seeded.test.ts": `${suiteImports}
export default appTest(schema, {
  "seeds what nobody may read, and inspects all of it": async (t) => {
    const ada = t.withIdentity({ name: "Ada" });
    const seeded = await t.run(
      async (ctx) => await ctx.db.insert("notes", { title: "Seeded" })
    );
    // Owned by the test itself: no identity reads it through the App.
    expect(await ada.query(api.notes.titles, {})).toEqual([]);
    await ada.mutation(api.notes.create, { title: "Ada's" });
    // Seeded as Ada, it is hers.
    await ada.run(async (ctx) => {
      await ctx.db.insert("notes", { title: "Ada's seed" });
    });
    expect((await ada.query(api.notes.titles, {})).toSorted()).toEqual([
      "Ada's",
      "Ada's seed",
    ]);
    const all = await t.run(async (ctx) => {
      const notes = await ctx.db.query("notes").take(10);
      return notes.map((note) => note.title).toSorted();
    });
    expect(all).toEqual(["Ada's", "Ada's seed", "Seeded"]);
    expect(await t.run(async (ctx) => await ctx.db.get("notes", seeded))).toMatchObject({
      title: "Seeded",
    });
  },
  "commits nothing of a run that throws, and reads its own writes": async (t) => {
    await expect(
      t.run(async (ctx) => {
        await ctx.db.insert("notes", { title: "Dropped" });
        expect(await ctx.db.query("notes").take(10)).toHaveLength(1);
        throw new Error("changed my mind");
      })
    ).rejects.toThrow("changed my mind");
    expect(await t.run(async (ctx) => await ctx.db.query("notes").take(10))).toEqual([]);
  },
  "holds what it writes to the schema": async (t) => {
    await expect(
      t.run(async (ctx) => {
        await ctx.db.insert("notes", { title: "" });
      })
    ).rejects.toMatchObject({ code: expect.stringMatching(/invalid/u) });
  },
  "refuses a run whose reads a write changed before it committed, never dropping its own writes": async (t) => {
    const ada = t.withIdentity({ name: "Ada" });
    await expect(
      t.run(async (ctx) => {
        await ctx.db.query("notes").take(10);
        // Committed while the run is open, to what it read.
        await ada.mutation(api.notes.create, { title: "Meanwhile" });
        await ctx.db.insert("notes", { title: "Seeded" });
      })
    ).rejects.toMatchObject({ code: "mutation.concurrent_change" });
    const titles = await t.run(async (ctx) => {
      const notes = await ctx.db.query("notes").take(10);
      return notes.map((note) => note.title);
    });
    expect(titles).toEqual(["Meanwhile"]);
  },
});
`,
      })
    );
    await rollback(env, appKind, built.owner, built.app, 1);
    await expect(findApp(env, built.app)).resolves.toMatchObject({
      currentVersion: 1,
    });
    // The App's own store holds nothing the tests seeded.
    const answer = await callAppFunction(
      env,
      built.owner,
      built.app,
      JSON.stringify({
        reference: { name: "notes.titles", kind: "query" },
        args: {},
      })
    );
    expect(answer.result).toStrictEqual({ ok: true, value: [] });
    await expect(fixturesLeft()).resolves.toBe(0);
  });

  it("fail closed on a report that leaves a test out", async () => {
    // The suite's own code rewrites what the isolate reports: one failing
    // test reported as none.
    // Rewrites the runner's report on its way out: past the types on
    // purpose, as a forger's code would.
    const forging = `const stringify = JSON.stringify as (value: unknown, ...rest: unknown[]) => string;
(JSON as { stringify: unknown }).stringify = (value: Record<string, unknown> | null, ...rest: unknown[]) =>
  value !== null && typeof value === "object" && "results" in value
    ? stringify({ results: [] })
    : stringify(value, ...rest);`;
    const built = await appWith(
      withFiles(appFiles, {
        "tests/forged.test.ts": suiteOf("expect(1).toBe(2);", forging),
      })
    );
    const { code, failures } = await refusal(built);
    expect(code).toBe("version.tests_failed");
    expect(failures).toStrictEqual([
      "tests/forged.test.ts: its report doesn't hold one result for each of the 1 tests it ran",
    ]);
  });

  it("fail a test that never finishes, and a suite that runs past its deadline", async () => {
    const waiting = `const owner = t.withIdentity({ name: "Ada" });
      await owner.mutation(api.notes.create, { title: "Held" });
      await new Promise((resolve) => { setTimeout(resolve, 2500); });`;
    const built = await appWith(
      withFiles(appFiles, {
        "tests/hanging-test.test.ts": suiteOf(
          `await owner.mutation(api.notes.create, { title: "Held" });
      await new Promise(() => {});`
        ),
        // Each test within its 3 s, both together past the suite's 4 s.
        "tests/hanging-suite.test.ts": `${suiteImports}
export default appTest(schema, {
  "first": async (t) => { ${waiting} },
  "second": async (t) => { ${waiting} },
});
`,
      })
    );
    const { code, failures } = await refusal(
      built,
      envWith({ APP_TEST_LIMITS_MS: "3000/4000" })
    );
    expect(code).toBe("version.tests_failed");
    expect(failures).toStrictEqual([
      "tests/hanging-suite.test.ts: it stopped: didn't finish within 4 seconds",
      'tests/hanging-test.test.ts, "runs": didn\'t finish within 3 seconds',
    ]);
    // Both sessions were closed, and their stores discarded.
    await expect(fixturesLeft()).resolves.toBe(0);
  });

  it("give up on a cleanup that stalls, leaving its stores to the sweep", async () => {
    const built = await appWith(
      withFiles(appFiles, {
        "tests/notes.test.ts": suiteOf(
          'await owner.mutation(api.notes.create, { title: "Kept" });'
        ),
      })
    );
    // Every store object answers as it does, but a discard never ends.
    const stalling = new Proxy(env.DATA_STORES, {
      get: (namespace, key): unknown => {
        const value: unknown = Reflect.get(namespace, key);
        if (key !== "getByName" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(namespace) : value;
        }
        return (name: string) =>
          new Proxy(namespace.getByName(name), {
            get: (stub, method): unknown => {
              if (method === "discardFixture") {
                return async () => await Promise.withResolvers<never>().promise;
              }
              // An RPC stub's methods call through it whatever `this` is.
              return Reflect.get(stub, method);
            },
          });
      },
    });
    const started = Date.now();
    await rollback(
      envWith({ DATA_STORES: stalling, APP_TEST_LIMITS_MS: "///1000" }),
      appKind,
      built.owner,
      built.app,
      1
    );
    expect(Date.now() - started).toBeLessThan(20_000);
    await expect(findApp(env, built.app)).resolves.toMatchObject({
      currentVersion: 1,
    });
    // The store it couldn't discard stays recorded, for the sweep, which
    // discards it (here, at once).
    await expect(fixturesLeft()).resolves.toBe(1);
    await sweepTestFixtures(env, new Date(Date.now() + 2 * 60 * 60_000));
    await expect(fixturesLeft()).resolves.toBe(0);
  });

  it("run no suite past the run's deadline", async () => {
    const built = await appWith(
      withFiles(appFiles, {
        "tests/a.test.ts": suiteOf(
          "await new Promise((resolve) => { setTimeout(resolve, 2000); });"
        ),
        "tests/b.test.ts": suiteOf("expect(1).toBe(1);"),
      })
    );
    // The suites may take 500 ms in all: the first runs out of it, and is
    // told the run's limit (not the time it happened to have left), the
    // second can't start.
    const { code, failures } = await refusal(
      built,
      envWith({ APP_TEST_LIMITS_MS: "//500" })
    );
    expect(code).toBe("version.tests_failed");
    expect(failures).toStrictEqual([
      "tests/a.test.ts: it stopped: the version's tests ran past their 0.5 seconds",
      "tests/b.test.ts: didn't run: the version's tests ran past their 0.5 seconds",
    ]);
  });

  it("run a suite in any folder an App's paths allow, dots included", async () => {
    const built = await appWith(
      withFiles(appFiles, {
        "tests/access.rules/notes.test.ts": suiteOf(
          "expect(1).toBe(2);"
        ).replace("../server/schema.ts", "../../server/schema.ts"),
      })
    );
    const { code, failures } = await refusal(built);
    expect(code).toBe("version.tests_failed");
    expect(failures).toStrictEqual([
      'tests/access.rules/notes.test.ts, "runs": expected 1 to be 2 // Object.is equality',
    ]);
  });

  it("refuse a file under tests/ that is no suite or helper, a fixture file included", async () => {
    const built = await appWith(
      withFiles(appFiles, {
        "tests/notes.test.ts": passingSuite,
        "tests/notes.spec.js": "export default {};\n",
        "tests/fixtures/notes.json": "{}\n",
      })
    );
    const { code, failures } = await refusal(built);
    expect(code).toBe("version.tests_failed");
    expect(failures).toStrictEqual(
      ["tests/fixtures/notes.json", "tests/notes.spec.js"].map(
        (file) =>
          `${file}: ${file} is in tests/, which holds only test suites (*.test.ts) and their helpers (*.ts): a test gives who it acts as (t.withIdentity) and what a run starts with (its start's options) itself.`
      )
    );
  });

  it("refuse more suites than an App may have", async () => {
    const suites = Object.fromEntries(
      Array.from({ length: 21 }, (_unused, index) => [
        `tests/suite-${index}.test.ts`,
        suiteOf("expect(1).toBe(1);"),
      ])
    );
    const built = await appWith(
      withFiles(appFiles, {
        ...suites,
      })
    );
    const { code, failures } = await refusal(built);
    expect(code).toBe("version.tests_failed");
    expect(failures).toStrictEqual([
      "tests: An App has at most 20 test suites (tests/**.test.ts); this one has 21. Put more tests in each suite.",
    ]);
  });

  it("say so where nothing could bound them", async () => {
    const built = await appWith(
      withFiles(appFiles, {
        "tests/notes.test.ts": passingSuite,
      })
    );
    // Sealed where App code may run; made current where it may not.
    await sealRelease(env, { app: built.app, version: 1, by: built.owner });
    await expect(
      rollback(unbounded, appKind, built.owner, built.app, 1)
    ).rejects.toMatchObject({ code: "version.tests_unavailable" });
  });

  it("need no runtime for helpers alone, yet refuse a stray file anywhere", async () => {
    /** Version 1 of an App with `files`, sealed where App code may run. */
    const sealedWith = async (files: TestSource) => {
      const built = await appWith(files);
      await sealRelease(env, { app: built.app, version: 1, by: built.owner });
      return built;
    };
    // A helper, but no suite.
    const helpers = await sealedWith(
      withFiles(appFiles, {
        "tests/lib/owner.ts": "export const ownerName = 'Ada';\n",
      })
    );
    await expect(
      rollback(unbounded, appKind, helpers.owner, helpers.app, 1)
    ).resolves.toMatchObject({ version: 1 });

    const stray = await sealedWith(
      withFiles(appFiles, {
        "tests/notes.spec.js": "export default {};\n",
      })
    );
    await expect(
      rollback(unbounded, appKind, stray.owner, stray.app, 1)
    ).rejects.toMatchObject({
      code: "version.tests_failed",
      details: {
        failures: [
          "tests/notes.spec.js: tests/notes.spec.js is in tests/, which holds only test suites (*.test.ts) and their helpers (*.ts): a test gives who it acts as (t.withIdentity) and what a run starts with (its start's options) itself.",
        ],
      },
    });
  });

  it("don't run again when the current version is made current again", async () => {
    const built = await appWith(
      withFiles(appFiles, {
        "tests/notes.test.ts": passingSuite,
      })
    );
    await rollback(env, appKind, built.owner, built.app, 1);
    // Where the tests can't run at all, the current version is still
    // made current again: nothing ran them.
    await expect(
      rollback(unbounded, appKind, built.owner, built.app, 1)
    ).resolves.toMatchObject({ version: 1 });
  });
});

/** A sealed App's release, for fixture stores with its schema. */
const sealed = async (): Promise<{ built: Built; release: Release }> => {
  const built = await appWith(appFiles);
  await rollback(env, appKind, built.owner, built.app, 1);
  return { built, release: await loadRelease(env, built.app, 1) };
};

/** A fixture store with `release`'s tables, recorded `ago` ms back. */
const fixtureStore = async (
  { built, release }: { built: Built; release: Release },
  ago = 0
): Promise<StoreId> => {
  const id = storeIdSchema.parse(crypto.randomUUID());
  await env.DB.prepare(
    "INSERT INTO app_test_fixtures (store_id, app_id, version, created_at) VALUES (?, ?, 1, ?)"
  )
    .bind(id, built.app, Date.now() - ago)
    .run();
  await openFixtureStore(env, id).applySchema(
    applied(manifestText(release.app.schema))
  );
  return id;
};

describe("fixture stores", () => {
  it("are discarded by the sweep once a run that left them is long over", async () => {
    const app = await sealed();
    const old = await fixtureStore(app, 2 * 60 * 60_000);
    const fresh = await fixtureStore(app, 60_000);
    await expect(tablesIn(old)).resolves.toBeGreaterThan(0);

    await sweepTestFixtures(env, new Date());

    await expect(tablesIn(old)).resolves.toBe(0);
    await expect(tablesIn(fresh)).resolves.toBeGreaterThan(0);
    await expect(fixturesLeft()).resolves.toBe(1);
  });

  it("refuse every call once discarded, one already made included, and arm no alarm", async () => {
    const app = await sealed();
    const id = await fixtureStore(app);
    const store = openFixtureStore(env, id);
    // A read under way as the store is discarded, never awaited before.
    const late = store.generations(["notes"]);
    await discardFixtureStore(env, id);
    await late.catch(() => null);

    await expect(store.generations(["notes"])).rejects.toThrow(
      "This fixture store was discarded."
    );
    await expect(
      store.applySchema(applied(manifestText(app.release.app.schema)))
    ).rejects.toThrow("This fixture store was discarded.");
    await expect(tablesIn(id)).resolves.toBe(0);
    await expect(alarmOf(id)).resolves.toBeNull();
  });

  it("are never opened as business stores", async () => {
    const id = await fixtureStore(await sealed());
    await expect(openStore(env, id)).rejects.toMatchObject({
      code: "data.store_unavailable",
    });
  });

  it("never discard a store the inventory lists, whose data stays", async () => {
    const app = await sealed();
    const store = await storeOfNewApp(env, app.built.owner);
    const opened = await openStore(env, store);
    await opened.applySchema(applied(manifestText(app.release.app.schema)));
    await runInDurableObject(env.DATA_STORES.getByName(store), (_i, state) => {
      state.storage.kv.put("probe", "kept");
    });

    await expect(discardFixtureStore(env, store)).rejects.toThrow(
      "A listed store is deleted, never discarded."
    );
    await expect(
      runInDurableObject(env.DATA_STORES.getByName(store), (_i, state) =>
        state.storage.kv.get("probe")
      )
    ).resolves.toBe("kept");
    await expect(tablesIn(store)).resolves.toBeGreaterThan(0);
    await expect(opened.generations(["notes"])).resolves.toBeDefined();
  });

  it("let go of their live queries' watchers once discarded", async () => {
    const app = await sealed();
    const id = await fixtureStore(app);
    const object = env.DATA_STORES.getByName(id);
    const { notes } = await object.generations(id, ["notes"]);
    let released = 0;
    // A watcher as core passes one: released once the store lets go of it.
    const watcher = Object.assign(
      (_tables: string[]): void => {
        // Told of no write: nothing writes to the store here.
      },
      {
        [Symbol.dispose]: (): void => {
          released += 1;
        },
      }
    );
    await object.watch(id, "fixture-Ada", { notes: notes ?? 0 }, watcher);
    expect(released).toBe(0);

    await discardFixtureStore(env, id);

    await vi.waitFor(() => {
      expect(released).toBe(1);
    });
  });

  it("take an unrestricted read or commit only on a fixture store core recorded, never a listed or unrecorded one", async () => {
    const app = await sealed();
    const fixture = await fixtureStore(app);
    const listed = await storeOfNewApp(env, app.built.owner);
    const business = await openStore(env, listed);
    await business.applySchema(applied(manifestText(app.release.app.schema)));
    const unrecorded = storeIdSchema.parse(crypto.randomUUID());
    await openFixtureStore(env, unrecorded).applySchema(
      applied(manifestText(app.release.app.schema))
    );
    const { notes = 0 } = await env.DATA_STORES.getByName(fixture).generations(
      fixture,
      ["notes"]
    );
    const hash = await schemaHash(app.release.app.schema);
    const scopeOf = (_id: StoreId) => ({
      schemaHash: hash,
      principal: "test-run",
      appMember: true,
      appBuilder: true,
      unrestricted: true as const,
      consumer: { resourceId: app.built.app, resourceVersion: 1 },
    });
    const read = { kind: "get" as const, table: "notes", id: "none" };
    const outcome = async (id: StoreId): Promise<string> => {
      try {
        await env.DATA_STORES.getByName(id).read(id, scopeOf(id), read);
        return "read";
      } catch (error) {
        return isExpectedError(error) ? error.code : "threw";
      }
    };
    expect({
      fixture: await outcome(fixture),
      listed: await outcome(listed),
      unrecorded: await outcome(unrecorded),
    }).toStrictEqual({
      fixture: "read",
      listed: "data.access_denied",
      unrecorded: "data.access_denied",
    });
    // A commit as much as a read: an unrestricted write to a listed
    // store is refused before anything is written.
    const commitTo = async (id: StoreId): Promise<string> => {
      try {
        await env.DATA_STORES.getByName(id).commit({
          storeId: id,
          principal: { userId: "test-run" },
          actor: { type: "person", userId: "test-run" },
          roles: {
            appMember: true,
            appBuilder: true,
            unrestricted: true,
          },
          schemaHash: hash,
          receipt: { receiptId: "0".repeat(64), fence: 1 },
          stagedAt: Date.now(),
          readSet: { notes },
          writes: [],
        });
        return "committed";
      } catch (error) {
        return isExpectedError(error) ? error.code : "threw";
      }
    };
    await expect(commitTo(listed)).resolves.toBe("data.access_denied");
  });

  it("never discard a store core didn't record as a fixture", async () => {
    const id = storeIdSchema.parse(crypto.randomUUID());
    await expect(discardFixtureStore(env, id)).rejects.toThrow(
      "Only a fixture store core recorded is discarded."
    );
  });
});
