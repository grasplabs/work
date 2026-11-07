import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { callAppFunction } from "../src/app-functions.ts";
import { addMember, removeMember } from "../src/app-members.ts";
import { publishVersion } from "../src/app-publish.ts";
import { loadRelease, sealRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { commitFiles, createApp, findApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { deleteStore, openStore } from "../src/data-stores.ts";
import { appDefaultStores } from "../src/db/core/schema.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { abandonStoreBackfill, storeBackfill } from "../src/store-abandon.ts";
import { appDefinition } from "./app-definitions.ts";
import type { AppSpec } from "./app-definitions.ts";
import { storeOfNewApp } from "./app-stores.ts";
import { racingDb } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { commit as commitTo } from "./pending-stores.ts";
import { aroundEngine } from "./runs.ts";
import { failure, person, sweptAway } from "./sealed-apps.ts";
import { newRecordId } from "./store-schemas.ts";

// Publishing a version of spec 8's layout seals it on the App's one
// default store, which the host creates the first time a version needs
// one and binds to every later version, so the App's data outlives its
// versions.

/** The Notes App's definition, named `title`, its tables `notes` and `more`. */
const notesSpec = (title: string, more: AppSpec["tables"] = {}): AppSpec => ({
  name: title,
  tables: {
    notes: {
      fields: { title: "v.string().min(1).max(200)" },
      access: { read: "appMembers", write: "appMembers" },
    },
    ...more,
  },
});

const notesFiles = (title = "Notes"): Record<string, string> => ({
  ...appDefinition(notesSpec(title)),
  "server/notes.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";

export const create = mutation({
  args: { title: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map((note) => note.title),
});
`,
});

const emptyFiles: Record<string, string> = {
  ...appDefinition({ name: "Hello", tables: {} }),
  "server/hello.ts": `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";

export const hello = query({
  args: {},
  returns: v.string(),
  handler: () => "hello",
});
`,
};

/**
 * `emptyFiles` over a version of `notesFiles`: its operations replaced,
 * the notes' file gone with the tables it reads.
 */
const withoutNotes: Record<string, string | null> = {
  ...emptyFiles,
  "server/notes.ts": null,
};

type Caller = Awaited<ReturnType<typeof person>>;

/** A builder's App with `files` as its first version. */
const appWith = async (files: Record<string, string>) => {
  const owner = await person("builder");
  const { id } = await createApp(env, owner, { name: "Notes" });
  await commitFiles(env, owner, id, files, "First version");
  return { owner, app: id };
};

/** Calls `path` of `release` for `by`, as a page sends it. */
const call = async (
  by: Caller,
  release: Release,
  path: string,
  input: Json
): Promise<OperationResult> => {
  const operation = release.app.operations[path];
  const { result } = await callAppFunction(
    env,
    by,
    release.manifest.resourceId,
    JSON.stringify({
      reference: { name: path, kind: operation?.kind },
      input,
    })
  );
  return result;
};

const currentOf = async (app: string): Promise<number | null> => {
  const found = await findApp(env, app);
  return found.currentVersion;
};

const storeOf = async (app: AppId, version: number) => {
  const release = await loadRelease(env, app, version);
  return release.store;
};

const defaultStores = async (app: string) =>
  await drizzle(env.DB)
    .select()
    .from(appDefaultStores)
    .where(eq(appDefaultStores.appId, app))
    .all();

/**
 * A Notes App whose `notes` hold a title and the optional fields
 * `optional` (TypeScript source of each field's validator, by name), with
 * `create`, `rename` (a patch), `retitle` (a replacement) and `rows` (each
 * note's fields this version declares) as its functions.
 */
const evolvingFiles = (
  optional: Record<string, string> = {},
  defaulted: Record<string, string> = {},
  { indexed = false } = {}
): Record<string, string> => {
  const extra = [
    ...Object.entries(optional).map(
      ([name, validator]) => `${name}: ${validator}.optional(), `
    ),
    ...Object.entries(defaulted).map(
      ([name, validator]) => `${name}: ${validator}, `
    ),
  ].join("");
  const fields = `title: v.string().min(1).max(200), ${extra}`;
  return {
    ...appDefinition({
      name: "Notes",
      tables: {
        notes: {
          fields: {
            title: "v.string().min(1).max(200)",
            ...Object.fromEntries(
              Object.entries(optional).map(([name, validator]) => [
                name,
                `${validator}.optional()`,
              ])
            ),
            ...defaulted,
          },
          ...(indexed ? { indexes: { by_title: ["title"] } } : {}),
          access: { read: "appMembers", write: "appMembers" },
        },
      },
    }),
    "server/notes.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";

const note = v.object({ ${fields} });

export const create = mutation({
  args: { ${fields} },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const rename = mutation({
  args: { id: v.id("notes"), title: v.string().min(1).max(200) },
  returns: v.null(),
  handler: async (ctx, { id, title }) => {
    const found = await ctx.db.get("notes", id);
    if (found === null) throw new Error("No such note");
    await ctx.db.patch("notes", id, { title }, { expectedRevision: found._rev });
    return null;
  },
});

export const retitle = mutation({
  args: { id: v.id("notes"), title: v.string().min(1).max(200) },
  returns: v.null(),
  handler: async (ctx, { id, title }) => {
    const found = await ctx.db.get("notes", id);
    if (found === null) throw new Error("No such note");
    await ctx.db.replace("notes", id, { title }, { expectedRevision: found._rev });
    return null;
  },
});

export const rows = query({
  args: {},
  returns: v.array(note),
  handler: async (ctx) =>
    (await ctx.db.query("notes").take(100))
      .map(({ _id, _ownerId, _rev, _createdAt, _updatedAt, ...fields }) => fields)
      .toSorted((a, b) => (a.title < b.title ? -1 : 1)),
});
`,
  };
};

/** The value `path` of the current release of `app` answers `by` for `input`. */
const valueOf = async (
  by: Caller,
  app: AppId,
  path: string,
  input: Json = {}
): Promise<Json> => {
  const current = await currentOf(app);
  if (current === null) {
    throw new Error("The App has no current version");
  }
  const result = await call(
    by,
    await loadRelease(env, app, current),
    path,
    input
  );
  if (!result.ok) {
    throw new Error(`${path} failed: ${JSON.stringify(result)}`);
  }
  return result.value;
};

/** Commits `files` as the App's next version, and answers its number. */
const nextVersion = async (
  owner: Caller,
  app: AppId,
  files: Record<string, string>
): Promise<number> => {
  const committed = await commitFiles(env, owner, app, files, "Next version");
  return committed.version;
};

describe(
  "activating a version of spec 8's layout",
  { timeout: 120_000 },
  () => {
    it("seals it on the App's own store, which the host creates, and its functions run", async () => {
      const { owner, app } = await appWith(notesFiles());
      const activated = await publishVersion(env, owner, app, 1);
      expect(activated.currentVersion).toBe(1);

      const release = await loadRelease(env, app, 1);
      const [store] = await defaultStores(app);
      expect(release.store?.storeId).toBe(store?.storeId);

      await expect(
        call(owner, release, "notes.create", { title: "Launch" })
      ).resolves.toMatchObject({ ok: true });
      await expect(
        call(owner, release, "notes.titles", {})
      ).resolves.toStrictEqual({
        ok: true,
        value: ["Launch"],
      });
    });

    it("binds every later version to the same store, so the data stays", async () => {
      const { owner, app } = await appWith(notesFiles());
      await publishVersion(env, owner, app, 1);
      const first = await loadRelease(env, app, 1);
      await call(owner, first, "notes.create", { title: "Kept" });

      await commitFiles(env, owner, app, notesFiles("Notes 2"), "Second");
      await publishVersion(env, owner, app, 2);
      const second = await loadRelease(env, app, 2);
      expect(second.store?.storeId).toBe(first.store?.storeId);
      await expect(defaultStores(app)).resolves.toHaveLength(1);
      await expect(
        call(owner, second, "notes.titles", {})
      ).resolves.toStrictEqual({
        ok: true,
        value: ["Kept"],
      });
    });

    it("lets another builder of the App activate on the store the first one's activation created", async () => {
      const { owner, app } = await appWith(notesFiles());
      await publishVersion(env, owner, app, 1);
      const first = await loadRelease(env, app, 1);
      await call(owner, first, "notes.create", { title: "Shared" });
      // A second builder, who doesn't manage the store the first created.
      const other = await person("builder");
      await addMember(env, owner, app, {
        type: "person",
        id: other.userId,
        role: "builder",
      });
      await commitFiles(env, other, app, notesFiles("Notes 2"), "Second");
      const activated = await publishVersion(env, other, app, 2);
      const second = await loadRelease(env, app, 2);
      expect([
        activated.currentVersion,
        second.store?.storeId === first.store?.storeId,
        await call(other, second, "notes.titles", {}),
      ]).toStrictEqual([2, true, { ok: true, value: ["Shared"] }]);
    });

    it("is refused to someone who doesn't build the App, sealing it directly", async () => {
      const { owner, app } = await appWith(notesFiles());
      await commitFiles(env, owner, app, notesFiles("Notes 2"), "Second");
      const stranger = await person("builder");
      await expect(
        failure(
          async () => await sealRelease(env, { app, version: 2, by: stranger })
        )
      ).resolves.toBe("app.not_found");
      await expect(defaultStores(app)).resolves.toHaveLength(0);
    });

    it("creates no store for an App without tables", async () => {
      const { owner, app } = await appWith(emptyFiles);
      await publishVersion(env, owner, app, 1);
      await expect(storeOf(app, 1)).resolves.toBeNull();
      await expect(defaultStores(app)).resolves.toHaveLength(0);
    });

    it("gives two Apps two stores, never one between them", async () => {
      const first = await appWith(notesFiles());
      const second = await appWith(notesFiles());
      await publishVersion(env, first.owner, first.app, 1);
      await publishVersion(env, second.owner, second.app, 1);
      const [a] = await defaultStores(first.app);
      const [b] = await defaultStores(second.app);
      expect(a?.storeId).toBeDefined();
      expect(a?.storeId).not.toBe(b?.storeId);
    });

    it("is refused to someone who doesn't build the App, who creates nothing", async () => {
      const { app } = await appWith(notesFiles());
      const stranger = await person("builder");
      await expect(
        failure(async () => await publishVersion(env, stranger, app, 1))
      ).resolves.toBe("app.not_found");
      await expect(defaultStores(app)).resolves.toHaveLength(0);
      await expect(currentOf(app)).resolves.toBeNull();
    });

    it("gives two first activations at once one store, listed and audited once", async () => {
      const { owner, app } = await appWith(notesFiles());
      const outcomes = await Promise.all([
        failure(async () => await publishVersion(env, owner, app, 1)),
        failure(async () => await publishVersion(env, owner, app, 1)),
      ]);
      expect(outcomes).toContain("ok");
      const stores = await defaultStores(app);
      expect(stores).toHaveLength(1);
      const events = await allEvents();
      const created = events.filter(
        (event) => event.action === "store.created" && event.detail?.app === app
      );
      expect(created.map((event) => event.target?.id)).toStrictEqual([
        stores[0]?.storeId,
      ]);
      await expect(storeOf(app, 1)).resolves.toMatchObject({
        storeId: stores[0]?.storeId,
      });
    });

    it("refuses a revoked version, even one revoked as it is made current", async () => {
      const { owner, app } = await appWith(notesFiles());
      await publishVersion(env, owner, app, 1);
      await commitFiles(env, owner, app, notesFiles("Notes 2"), "Second");
      await publishVersion(env, owner, app, 2);
      await commitFiles(env, owner, app, notesFiles("Notes 3"), "Third");
      await publishVersion(env, owner, app, 3);
      const admin = await person("admin");

      // Revoked before: refused at the check.
      await revokeRelease(env, admin, { app, version: 1 }, "Leaks data");
      await expect(
        failure(async () => await publishVersion(env, owner, app, 1))
      ).resolves.toBe("version.revoked");

      // Revoked between the check and the change: refused by the change.
      const racing = racingDb(async () => {
        await revokeRelease(env, admin, { app, version: 2 }, "Leaks data");
      }, /update "apps"/iu);
      await expect(
        failure(
          async () =>
            await publishVersion({ ...env, DB: racing }, owner, app, 2)
        )
      ).resolves.toBe("version.revoked");
      await expect(currentOf(app)).resolves.toBe(3);
    });

    it("rolls back onto a fresh store once retention let go of the version and its store, and later versions share it", async () => {
      const { owner, app } = await appWith(notesFiles());
      await publishVersion(env, owner, app, 1);
      const [deleted] = await defaultStores(app);
      await commitFiles(env, owner, app, withoutNotes, "No tables");
      await publishVersion(env, owner, app, 2);
      // Version 1 kept binds its store; once retention lets it go, the
      // store can be deleted.
      await sweptAway(app, 1);
      await deleteStore(env, owner, deleted?.storeId ?? "");

      // Published again, sealed anew on the App's fresh default store: its
      // records went with the store an admin deleted.
      const back = await publishVersion(env, owner, app, 1);
      expect(back.currentVersion).toBe(1);

      await commitFiles(env, owner, app, notesFiles("Notes 3"), "Tables again");
      await publishVersion(env, owner, app, 3);
      const [fresh] = await defaultStores(app);
      expect(fresh?.storeId).not.toBe(deleted?.storeId);
      const release = await loadRelease(env, app, 3);
      expect(release.store?.storeId).toBe(fresh?.storeId);
      await expect(
        call(owner, release, "notes.create", { title: "Fresh" })
      ).resolves.toMatchObject({ ok: true });
    });

    it("refuses a version whose store is deleted as it is made current", async () => {
      const { owner, app } = await appWith(notesFiles());
      await publishVersion(env, owner, app, 1);
      const [store] = await defaultStores(app);
      await commitFiles(env, owner, app, withoutNotes, "No tables");
      await publishVersion(env, owner, app, 2);
      // Its store gone as the statement runs (deletion itself is refused
      // while version 1 is kept: this is the guard behind that).
      const racing = racingDb(async () => {
        await env.DB.prepare(
          "UPDATE business_stores SET deleted_at = ? WHERE id = ?"
        )
          .bind(Date.now(), store?.storeId ?? "")
          .run();
      }, /update "apps"/iu);
      await expect(
        failure(
          async () =>
            await publishVersion({ ...env, DB: racing }, owner, app, 1)
        )
      ).resolves.toBe("data.store_unavailable");
      await expect(currentOf(app)).resolves.toBe(2);
    });

    it("refuses a version that can't be sealed, and leaves the current one", async () => {
      const { owner, app } = await appWith(notesFiles());
      await publishVersion(env, owner, app, 1);
      await commitFiles(
        env,
        owner,
        app,
        { ...notesFiles(), "server/broken.ts": 'throw new Error("Broken");\n' },
        "Broken"
      );
      await expect(
        failure(async () => await publishVersion(env, owner, app, 2))
      ).resolves.not.toBe("ok");
      await expect(currentOf(app)).resolves.toBe(1);
    });
  }
);

/** What deleting store `store` comes to for `by`: who manages it gets past `managedBy`. */
const deleting = async (by: Acting, store: string): Promise<string> =>
  await failure(async () => {
    await deleteStore(env, by, store);
  });

/** Makes `userId` a user of the organization, a role that doesn't build. */
const demote = async (userId: string): Promise<void> => {
  await env.DB.prepare("UPDATE members SET role = 'user' WHERE user_id = ?")
    .bind(userId)
    .run();
};

// Who manages an App's store is who builds the App, decided on each call:
// a store is never shared on its own. Deleting it is how that shows: one
// who manages it is refused only because a kept release binds it
// (`data.store_bound`), anyone else as for a store that doesn't exist.
describe("an App's store", { timeout: 120_000 }, () => {
  it("is managed by whoever builds the App, not by the builder who first activated once they leave", async () => {
    const { owner, app } = await appWith(notesFiles());
    // A builder the App is shared with activates first, so the store's
    // inventory row names them as its creator.
    const first = await person("builder");
    await addMember(env, owner, app, {
      type: "person",
      id: first.userId,
      role: "builder",
    });
    await publishVersion(env, first, app, 1);
    const [recorded] = await defaultStores(app);
    const store = recorded?.storeId ?? "";
    const whileBuilding = await deleting(first, store);
    await removeMember(env, owner, app, { type: "person", id: first.userId });
    const admin = await person("admin");
    expect([
      whileBuilding,
      await deleting(first, store),
      await deleting(owner, store),
      await deleting(admin, store),
    ]).toStrictEqual([
      "data.store_bound",
      "data.store_unavailable",
      "data.store_bound",
      "data.store_bound",
    ]);
  });

  it("is managed by none of the App's users, nor anyone outside it, nor a builder whose organization role no longer builds", async () => {
    const { owner, app } = await appWith(notesFiles());
    await publishVersion(env, owner, app, 1);
    const [recorded] = await defaultStores(app);
    const store = recorded?.storeId ?? "";
    const reader = await person("builder");
    await addMember(env, owner, app, {
      type: "person",
      id: reader.userId,
      role: "user",
    });
    const outsider = await person("builder");
    const capped = await person("builder");
    await addMember(env, owner, app, {
      type: "person",
      id: capped.userId,
      role: "builder",
    });
    await demote(capped.userId);
    expect([
      await deleting(reader, store),
      await deleting(outsider, store),
      await deleting({ ...capped, role: "user" }, store),
    ]).toStrictEqual([
      "data.store_unavailable",
      "data.store_unavailable",
      "data.store_unavailable",
    ]);
  });

  it("is refused to everyone once its App row is gone", async () => {
    const creator = await person("builder");
    const store = await storeOfNewApp(env, creator);
    await drizzle(env.DB)
      .update(appDefaultStores)
      .set({ appId: "app_00000000000000000000missing" })
      .where(eq(appDefaultStores.storeId, store));
    const admin = await person("admin");
    expect([
      await deleting(creator, store),
      await deleting(admin, store),
    ]).toStrictEqual(["data.store_unavailable", "data.store_unavailable"]);
  });
});

describe("a store's definitions", { timeout: 120_000 }, () => {
  it("are recorded once each, numbered, and the store's active one follows the current version", async () => {
    const { owner, app } = await appWith(notesFiles());
    await publishVersion(env, owner, app, 1);
    // The same schema and operations under another name: one definition.
    await commitFiles(env, owner, app, notesFiles("Notes 2"), "Renamed");
    await publishVersion(env, owner, app, 2);
    // Another table: a second definition.
    const widened = {
      ...notesFiles("Notes 3"),
      ...appDefinition(
        notesSpec("Notes 3", { tags: { fields: { name: "v.string()" } } })
      ),
    };
    await commitFiles(env, owner, app, widened, "Tags");
    await publishVersion(env, owner, app, 3);
    const [recorded] = await defaultStores(app);
    const store = recorded?.storeId ?? "";
    const definitions = await env.DB.prepare(
      "SELECT version, schema_hash AS schemaHash, operation_manifest_hash AS operations, source_tree_hash AS tree FROM business_store_versions WHERE store_id = ? ORDER BY version"
    )
      .bind(store)
      .all<{
        version: number;
        schemaHash: string;
        operations: string;
        tree: string;
      }>();
    const bound = await env.DB.prepare(
      "SELECT resource_version AS version, target_version AS definition FROM sdk_resource_bindings WHERE target_id = ? ORDER BY resource_version"
    )
      .bind(store)
      .all<{ version: number; definition: number }>();
    const active = async () =>
      await env.DB.prepare(
        "SELECT active_schema_version AS version, active_schema_hash AS schemaHash, active_operation_manifest_hash AS operations FROM business_stores WHERE id = ?"
      )
        .bind(store)
        .first<{
          version: number | null;
          schemaHash: string | null;
          operations: string | null;
        }>();
    const afterThree = await active();
    // Rolled back: the store's active definition is version 1's again.
    await publishVersion(env, owner, app, 1);
    const afterRollback = await active();
    // A version without a schema binds no store: the store serves no
    // definition while it is current.
    await commitFiles(env, owner, app, withoutNotes, "No tables");
    await publishVersion(env, owner, app, 4);
    const unbound = await active();
    const [first, third] = await Promise.all([
      loadRelease(env, app, 1),
      loadRelease(env, app, 3),
    ]);
    expect([
      definitions.results,
      bound.results,
      afterThree,
      afterRollback,
      unbound,
    ]).toStrictEqual([
      [
        {
          version: 1,
          schemaHash: first.store?.schemaHash,
          operations: first.store?.operationManifestHash,
          tree: first.manifest.sourceTreeHash,
        },
        {
          version: 2,
          schemaHash: third.store?.schemaHash,
          operations: third.store?.operationManifestHash,
          tree: third.manifest.sourceTreeHash,
        },
      ],
      [
        { version: 1, definition: 1 },
        { version: 2, definition: 1 },
        { version: 3, definition: 2 },
      ],
      {
        version: 2,
        schemaHash: third.store?.schemaHash,
        operations: third.store?.operationManifestHash,
      },
      {
        version: 1,
        schemaHash: first.store?.schemaHash,
        operations: first.store?.operationManifestHash,
      },
      { version: null, schemaHash: null, operations: null },
    ]);
  });
});

describe(
  "a version's schema changing on activation",
  { timeout: 180_000 },
  () => {
    it("applies an optional field, and an older version made current again keeps it", async () => {
      const { owner, app } = await appWith(evolvingFiles());
      await publishVersion(env, owner, app, 1);
      await valueOf(owner, app, "notes.create", { title: "Launch" });

      const second = await nextVersion(
        owner,
        app,
        evolvingFiles({ category: "v.string()" })
      );
      await publishVersion(env, owner, app, second);
      const renamed = await valueOf(owner, app, "notes.create", {
        title: "Hiring",
        category: "jobs",
      });
      const replaced = await valueOf(owner, app, "notes.create", {
        title: "News",
        category: "press",
      });

      // Back to the first version: it reads and writes its own fields,
      // and keeps what the second stored.
      await publishVersion(env, owner, app, 1);
      await valueOf(owner, app, "notes.rename", {
        id: renamed,
        title: "Hired",
      });
      await valueOf(owner, app, "notes.retitle", {
        id: replaced,
        title: "Newsroom",
      });
      const firstRows = await valueOf(owner, app, "notes.rows");

      await publishVersion(env, owner, app, second);
      expect({
        first: firstRows,
        second: await valueOf(owner, app, "notes.rows"),
      }).toStrictEqual({
        first: [{ title: "Hired" }, { title: "Launch" }, { title: "Newsroom" }],
        second: [
          { title: "Hired", category: "jobs" },
          { title: "Launch" },
          { title: "Newsroom", category: "press" },
        ],
      });
    });

    it("makes an older version current again after a newer one changed only its indexes", async () => {
      const { owner, app } = await appWith(evolvingFiles());
      await publishVersion(env, owner, app, 1);
      await valueOf(owner, app, "notes.create", { title: "Launch" });
      const indexed = await nextVersion(
        owner,
        app,
        evolvingFiles({}, {}, { indexed: true })
      );
      await publishVersion(env, owner, app, indexed);

      await publishVersion(env, owner, app, 1);

      expect({
        current: await currentOf(app),
        rows: await valueOf(owner, app, "notes.rows"),
      }).toStrictEqual({ current: 1, rows: [{ title: "Launch" }] });
    });

    it("refuses a change that needs a migration, and the current version keeps running", async () => {
      const { owner, app } = await appWith(
        evolvingFiles({ category: "v.string()" })
      );
      await publishVersion(env, owner, app, 1);
      await valueOf(owner, app, "notes.create", {
        title: "Launch",
        category: "news",
      });

      const retyped = await nextVersion(
        owner,
        app,
        evolvingFiles({ category: "v.number()" })
      );
      await expect(
        failure(async () => await publishVersion(env, owner, app, retyped))
      ).resolves.toBe("migration.required");

      expect({
        current: await currentOf(app),
        rows: await valueOf(owner, app, "notes.rows"),
      }).toStrictEqual({
        current: 1,
        rows: [{ title: "Launch", category: "news" }],
      });
    });

    it("fills in a defaulted field in the background, then makes the version current", async () => {
      const { owner, app } = await appWith(evolvingFiles());
      await publishVersion(env, owner, app, 1);
      await valueOf(owner, app, "notes.create", { title: "Launch" });
      const defaulted = await nextVersion(
        owner,
        app,
        evolvingFiles({}, { category: 'v.string().default("general")' })
      );

      // Sealed, and its store's backfill started: current once it ended
      // (`migration.pending` until then, which store-backfill.test.ts
      // holds on to; one note's backfill may be done before the answer).
      await vi.waitFor(
        async () => {
          await publishVersion(env, owner, app, defaulted);
        },
        { timeout: 20_000, interval: 200 }
      );
      const filled = await valueOf(owner, app, "notes.rows");
      // The first version, made current again, writes without the field;
      // the store fills it in.
      await publishVersion(env, owner, app, 1);
      await valueOf(owner, app, "notes.create", { title: "Hiring" });
      await publishVersion(env, owner, app, defaulted);

      expect({
        filled,
        after: await valueOf(owner, app, "notes.rows"),
      }).toStrictEqual({
        filled: [{ title: "Launch", category: "general" }],
        after: [
          { title: "Hiring", category: "general" },
          { title: "Launch", category: "general" },
        ],
      });
    });

    it("answers migration.pending, not an error, while the engine that runs its backfill is unavailable", async () => {
      const { owner, app } = await appWith(evolvingFiles());
      await publishVersion(env, owner, app, 1);
      await valueOf(owner, app, "notes.create", { title: "Launch" });

      // The engine can't be reached, from the seal on: the backfill the
      // seal made pending can't be started, by the seal or the activation.
      const activated = await aroundEngine(
        async () => {
          await Promise.resolve();
          throw new Error("The engine is unavailable");
        },
        async () => {
          const defaulted = await nextVersion(
            owner,
            app,
            evolvingFiles({}, { category: 'v.string().default("general")' })
          );
          return await failure(
            async () => await publishVersion(env, owner, app, defaulted)
          );
        }
      );

      expect({ activated, current: await currentOf(app) }).toStrictEqual({
        activated: "migration.pending",
        current: 1,
      });
    });

    it("keeps a version whose failed backfill an admin abandoned refused, resealed or not", async () => {
      const { owner, app } = await appWith(evolvingFiles());
      await publishVersion(env, owner, app, 1);
      const first = await storeOf(app, 1);
      if (first === null) {
        throw new Error("The first version binds no store");
      }
      const store = await openStore(env, first.storeId);
      // A value under a key no version declares, which no default fills
      // over and no version can change.
      const odd = newRecordId();
      await commitTo(store, first.schemaHash, [
        {
          op: "insert",
          table: "notes",
          id: odd,
          fields: { title: "Odd", category: 42 },
        },
      ]);
      const files = evolvingFiles(
        {},
        { category: 'v.string().default("general")' }
      );
      const defaulted = await nextVersion(owner, app, files);
      await vi.waitFor(
        async () => {
          await expect(
            failure(
              async () => await publishVersion(env, owner, app, defaulted)
            )
          ).resolves.toBe("migration.backfill_failed");
        },
        { timeout: 20_000, interval: 200 }
      );
      const admin = await person("admin");
      const backfill = await storeBackfill(env, admin, store.id);
      if (backfill === null) {
        throw new Error("No backfill is pending");
      }
      await abandonStoreBackfill(env, admin, {
        store: store.id,
        target: backfill.target,
        attempt: backfill.attempt,
      });
      const reseal = async () =>
        await failure(
          async () =>
            await sealRelease(env, { app, version: defaulted, by: owner })
        );
      const resealed = await reseal();
      // The record goes, and a later version brings the same schema back
      // into force.
      await commitTo(store, first.schemaHash, [
        { op: "delete", table: "notes", id: odd, expectedRevision: 1 },
      ]);
      // The same schema, under code changed elsewhere.
      const again = await nextVersion(owner, app, {
        ...files,
        "server/notes.ts": `${files["server/notes.ts"] ?? ""}// Again.\n`,
      });
      await vi.waitFor(
        async () => {
          await publishVersion(env, owner, app, again);
        },
        { timeout: 20_000, interval: 200 }
      );
      const resealedAfter = await reseal();
      const activated = await failure(
        async () => await publishVersion(env, owner, app, defaulted)
      );

      expect({
        resealed,
        resealedAfter,
        activated,
        current: await currentOf(app),
      }).toStrictEqual({
        resealed: "migration.abandoned",
        resealedAfter: "migration.abandoned",
        activated: "migration.abandoned",
        current: again,
      });
    });

    it("makes one of two conflicting versions current when both are activated at once", async () => {
      const { owner, app } = await appWith(evolvingFiles());
      await publishVersion(env, owner, app, 1);
      const asText = await nextVersion(
        owner,
        app,
        evolvingFiles({ colour: "v.string()" })
      );
      const asNumber = await nextVersion(
        owner,
        app,
        evolvingFiles({ colour: "v.number()" })
      );

      const outcomes = await Promise.all([
        failure(async () => await publishVersion(env, owner, app, asText)),
        failure(async () => await publishVersion(env, owner, app, asNumber)),
      ]);

      const winner = outcomes[0] === "ok" ? asText : asNumber;
      const [refused, made] = outcomes.toSorted();
      expect({
        // Refused at its seal, once the other's change was in, or at its
        // store while the other's activation was in flight: either way
        // before its change was applied there.
        refused: ["migration.required", "migration.busy"].includes(
          refused ?? ""
        ),
        made,
        current: await currentOf(app),
        // The version made current still writes to its store.
        writes: await failure(
          async () =>
            await valueOf(owner, app, "notes.create", { title: "After" })
        ),
      }).toStrictEqual({
        refused: true,
        made: "ok",
        current: winner,
        writes: "ok",
      });
    });

    it("finishes an activation whose store applied the schema before it stopped, with the store's evidence", async () => {
      const { owner, app } = await appWith(evolvingFiles());
      await publishVersion(env, owner, app, 1);
      const [recorded] = await defaultStores(app);
      const store = await openStore(
        env,
        storeIdSchema.parse(recorded?.storeId)
      );
      const second = await nextVersion(
        owner,
        app,
        evolvingFiles({ category: "v.string()" })
      );
      // What a seal that stopped after the store applied its schema left:
      // the schema applied for version 2, and nothing in core.
      const applied = await store.defineTables(
        manifestText(
          schemaManifest(
            defineSchema({
              notes: defineTable({
                title: v.string().min(1).max(200),
                category: v.string().optional(),
              }).access({ read: "appMembers", write: "appMembers" }),
            })
          )
        ),
        { resourceId: app, resourceVersion: second }
      );

      await publishVersion(env, owner, app, second);

      const events = await allEvents();
      const sealed = events.filter(
        (event) =>
          event.action === "app.release.sealed" &&
          event.target?.id === app &&
          event.detail.version === second
      );
      expect({
        current: await currentOf(app),
        evidence: sealed.map(({ detail }) => detail),
      }).toStrictEqual({
        current: second,
        evidence: [
          expect.objectContaining({
            store: store.id,
            storeContractHash: applied.contract.hash,
            storePlanHash: applied.contract.planHash,
            storeContractChanged: true,
            storeReceipt: applied.contract.receiptId,
          }),
        ],
      });
    });
  }
);
