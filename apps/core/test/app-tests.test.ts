import { manifestText } from "@grasp-os/sdk/host";
import { isExpectedError } from "@grasp-os/shared/errors";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { activateVersion } from "../src/app-activation.ts";
import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease, sealRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { sweepTestFixtures } from "../src/app-tests.ts";
import {
  commitFiles,
  createApp,
  findApp,
  setCurrentVersion,
} from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import {
  createStore,
  discardFixtureStore,
  openFixtureStore,
  openStore,
} from "../src/data-stores.ts";
import { person } from "./sealed-apps.ts";

// An App's tests (`appTest`, spec 28.2), as core runs them whenever a
// version is made current: each suite in its own isolate, every call
// through the real operation host on a fixture store of the test's own.
// What the tests here check is what that host did: the App's access
// rules held between principals and roles, a store per test, refusals a
// screen's call would get, failures named as people read them, the
// limits on a run, and nothing left in the App's own store or behind in
// fixture stores.

const appFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(200) }),
  mottos: defineTable({ text: v.string().min(1).max(200) }),
});
`,
  "operations/notes.ts": `import { AppError, resource, v } from "@grasp-os/sdk";
import { action, internalQuery, mutation, query } from "#grasp/server";

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

export const help = resource.knowledge("help", {
  operations: ["search"],
  collections: ["handbook"],
});

export const searchHelp = action({
  args: { text: v.string().min(1) },
  returns: v.array(v.object({ title: v.string(), excerpt: v.string() })).max(20),
  uses: [help],
  handler: async (ctx, args) => await ctx.resources.help.search({ text: args.text, limit: 5 }),
});

export const count = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).length,
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { count, create, find, help, searchHelp, setMotto, titles } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: {
    tables: {
      notes: { read: "owner", write: "owner" },
      mottos: { read: "appMembers", write: "appBuilders" },
    },
  },
  operations: { notes: { create, titles, find, setMotto, searchHelp } },
  internalOperations: { notes: { count } },
  screens: [],
  uses: [help],
});
`,
  "tests/fixtures/notes.json": JSON.stringify({
    principals: {
      "note-owner": { role: "user" },
      "other-owner": { role: "user" },
      "note-builder": { role: "builder" },
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
    "a builder sets the motto, a user may not": async (t) => {
      const builder = await t.as("note-builder");
      const user = await t.as("note-owner");
      await builder.mutation(api.notes.setMotto, { text: "Write it down" });
      await t.rejectsCode(user.mutation(api.notes.setMotto, { text: "Mine" }), "data.write_denied");
    },
    "no outside system is reached": async (t) => {
      const owner = await t.as("note-owner");
      await t.rejectsCode(owner.action(api.notes.searchHelp, { text: "leave" }), "resource.unavailable");
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
    "a call it doesn't wait for ends with it": async (t) => {
      const owner = await t.as("note-owner");
      void owner.mutation(api.notes.create, { title: "Late" }).catch(() => null);
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

/** A suite of one test, which runs `body` with an owner at hand. */
const suiteOf = (
  body: string,
  before = ""
): string => `import { appTest } from "@grasp-os/sdk/testing";
import { api } from "#grasp";
${before}
export default appTest({
  fixtures: "notes",
  tests: {
    "runs": async (t) => {
      const owner = await t.as("note-owner");
      ${body}
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
    await activateVersion(on, owner, app, 1);
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

  it("fail closed on a report that leaves a test out", async () => {
    // The suite's own code rewrites what the isolate reports: one failing
    // test reported as none.
    // Rewrites the runner's report on its way out: past the types on
    // purpose, as a forger's code would.
    const forging = `const stringify = JSON.stringify as (value: unknown, ...rest: unknown[]) => string;
(JSON as { stringify: unknown }).stringify = (value: Record<string, unknown> | null, ...rest: unknown[]) =>
  value !== null && typeof value === "object" && "results" in value
    ? stringify({ fixtures: value.fixtures, results: [] })
    : stringify(value, ...rest);`;
    const built = await appWith({
      ...appFiles,
      "tests/forged.test.ts": suiteOf("t.equal(1, 2);", forging),
    });
    const { code, failures } = await refusal(built);
    expect(code).toBe("version.tests_failed");
    expect(failures).toStrictEqual([
      "tests/forged.test.ts: its report doesn't hold one result for each of the 1 tests it ran",
    ]);
  });

  it("fail a test that never finishes, and a suite that runs past its deadline", async () => {
    const waiting = `const owner = await t.as("note-owner");
      await owner.mutation(api.notes.create, { title: "Held" });
      await new Promise((resolve) => { setTimeout(resolve, 2500); });`;
    const built = await appWith({
      ...appFiles,
      "tests/hanging-test.test.ts": suiteOf(
        `await owner.mutation(api.notes.create, { title: "Held" });
      await new Promise(() => {});`
      ),
      // Each test within its 3 s, both together past the suite's 4 s.
      "tests/hanging-suite.test.ts": `import { appTest } from "@grasp-os/sdk/testing";
import { api } from "#grasp";
export default appTest({
  fixtures: "notes",
  tests: {
    "first": async (t) => { ${waiting} },
    "second": async (t) => { ${waiting} },
  },
});
`,
    });
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
    const built = await appWith({
      ...appFiles,
      "tests/notes.test.ts": suiteOf(
        'await owner.mutation(api.notes.create, { title: "Kept" });'
      ),
    });
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
    await activateVersion(
      envWith({ DATA_STORES: stalling, APP_TEST_LIMITS_MS: "///1000" }),
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
    const built = await appWith({
      ...appFiles,
      "tests/a.test.ts": suiteOf(
        "await new Promise((resolve) => { setTimeout(resolve, 2000); });"
      ),
      "tests/b.test.ts": suiteOf("t.equal(1, 1);"),
    });
    // The suites may take 500 ms in all: the first starts with that much
    // left and runs out of it, the second can't start.
    const { code, failures } = await refusal(
      built,
      envWith({ APP_TEST_LIMITS_MS: "//500" })
    );
    expect(code).toBe("version.tests_failed");
    expect(failures).toStrictEqual([
      "tests/a.test.ts: it stopped: didn't finish within 0.5 seconds",
      "tests/b.test.ts: didn't run: the version's tests ran past their 0.5 seconds",
    ]);
  });

  it("run a suite in any folder an App's paths allow, dots included", async () => {
    const built = await appWith({
      ...appFiles,
      "tests/access.rules/notes.test.ts": suiteOf("t.equal(1, 2);"),
    });
    const { code, failures } = await refusal(built);
    expect(code).toBe("version.tests_failed");
    expect(failures).toStrictEqual([
      'tests/access.rules/notes.test.ts, "runs": expected 2, got 1',
    ]);
  });

  it("refuse a file under tests/ that is no suite, helper or fixture", async () => {
    const built = await appWith({
      ...appFiles,
      "tests/notes.test.ts": passingSuite,
      "tests/notes.spec.js": "export default {};\n",
    });
    const { code, failures } = await refusal(built);
    expect(code).toBe("version.tests_failed");
    expect(failures).toStrictEqual([
      "tests/notes.spec.js: tests/notes.spec.js is in tests/, which holds only test suites (*.test.ts), their helpers (*.ts) and fixtures (tests/fixtures/<name>.json).",
    ]);
  });

  it("refuse more suites than an App may have", async () => {
    const suites = Object.fromEntries(
      Array.from({ length: 21 }, (_unused, index) => [
        `tests/suite-${index}.test.ts`,
        suiteOf("t.equal(1, 1);"),
      ])
    );
    const built = await appWith({ ...appFiles, ...suites });
    const { code, failures } = await refusal(built);
    expect(code).toBe("version.tests_failed");
    expect(failures).toStrictEqual([
      "tests: An App has at most 20 test suites (tests/**.test.ts); this one has 21. Put more tests in each suite.",
    ]);
  });

  it("say so where nothing could bound them", async () => {
    const built = await appWith({
      ...appFiles,
      "tests/notes.test.ts": passingSuite,
    });
    // Sealed where App code may run; made current where it may not.
    const store = await createStore(env, built.owner);
    await sealRelease(env, {
      app: built.app,
      version: 1,
      store,
      by: built.owner,
    });
    await expect(
      setCurrentVersion(unbounded, built.owner, built.app, 1)
    ).rejects.toMatchObject({ code: "version.tests_unavailable" });
  });

  it("need no runtime for fixtures and helpers alone, yet refuse a stray file anywhere", async () => {
    /** Version 1 of an App with `files`, sealed where App code may run. */
    const sealedWith = async (files: Record<string, string>) => {
      const built = await appWith(files);
      const store = await createStore(env, built.owner);
      await sealRelease(env, {
        app: built.app,
        version: 1,
        store,
        by: built.owner,
      });
      return built;
    };
    // `appFiles` holds tests/fixtures/notes.json; a helper, but no suite.
    const helpers = await sealedWith({
      ...appFiles,
      "tests/lib/owner.ts": "export const ownerName = 'note-owner';\n",
    });
    await expect(
      setCurrentVersion(unbounded, helpers.owner, helpers.app, 1)
    ).resolves.toMatchObject({ currentVersion: 1 });

    const stray = await sealedWith({
      ...appFiles,
      "tests/notes.spec.js": "export default {};\n",
    });
    await expect(
      setCurrentVersion(unbounded, stray.owner, stray.app, 1)
    ).rejects.toMatchObject({
      code: "version.tests_failed",
      details: {
        failures: [
          "tests/notes.spec.js: tests/notes.spec.js is in tests/, which holds only test suites (*.test.ts), their helpers (*.ts) and fixtures (tests/fixtures/<name>.json).",
        ],
      },
    });
  });

  it("don't run again when the current version is made current again", async () => {
    const built = await appWith({
      ...appFiles,
      "tests/notes.test.ts": passingSuite,
    });
    await activateVersion(env, built.owner, built.app, 1);
    // Where the tests can't run at all, the current version is still
    // made current again: nothing ran them.
    await expect(
      setCurrentVersion(unbounded, built.owner, built.app, 1)
    ).resolves.toMatchObject({ currentVersion: 1 });
  });
});

/** A sealed App's release, for fixture stores with its schema. */
const sealed = async (): Promise<{ built: Built; release: Release }> => {
  const built = await appWith(appFiles);
  await activateVersion(env, built.owner, built.app, 1);
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
  await openFixtureStore(env, id).defineTables(
    manifestText(release.app.schema),
    { resourceId: built.app, resourceVersion: 1 }
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
      store.defineTables(manifestText(app.release.app.schema), {
        resourceId: app.built.app,
        resourceVersion: 1,
      })
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
    const store = await createStore(env, app.built.owner);
    const opened = await openStore(env, store);
    await opened.defineTables(manifestText(app.release.app.schema), {
      resourceId: app.built.app,
      resourceVersion: 1,
    });
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
    await object.watch(
      id,
      "fixture-note-owner",
      { notes: notes ?? 0 },
      watcher
    );
    expect(released).toBe(0);

    await discardFixtureStore(env, id);

    await vi.waitFor(() => {
      expect(released).toBe(1);
    });
  });

  it("never discard a store core didn't record as a fixture", async () => {
    const id = storeIdSchema.parse(crypto.randomUUID());
    await expect(discardFixtureStore(env, id)).rejects.toThrow(
      "Only a fixture store core recorded is discarded."
    );
  });
});
