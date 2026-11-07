import {
  definitionManifest,
  definitionPath,
  readDefinition,
} from "@grasp-os/sdk/definition";
import { schemaHash } from "@grasp-os/sdk/host";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { callAppFunction } from "../src/app-functions.ts";
import { addMember, removeMember } from "../src/app-members.ts";
import { publishVersion } from "../src/app-publish.ts";
import {
  loadRelease,
  readBackRelease,
  sealRelease,
} from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import {
  applyVersionSchema,
  resetAppData,
  resetLegacyAppData,
} from "../src/app-schema.ts";
import { commitFiles, createApp, findApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { deleteStore } from "../src/data-stores.ts";
import { appDefaultStores } from "../src/db/core/schema.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { appDefinition, definedWith, redefined } from "./app-definitions.ts";
import type { AppSpec } from "./app-definitions.ts";
import { storeOfNewApp } from "./app-stores.ts";
import { failingDb, racingDb } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { failure, person, sweptAway } from "./sealed-apps.ts";

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
/**
 * What the audit log holds of version `version` of `app` made current:
 * its `app.version.current` event's detail, and the store's entries of
 * what its schema did to the records (`app.data.*`, the version's).
 */
const schemaAudit = async (app: AppId, version: number) => {
  const events = await allEvents();
  return {
    current: events.find(
      ({ action, target, detail }) =>
        action === "app.version.current" &&
        target?.id === app &&
        detail.version === version
    )?.detail,
    changes: events
      .filter(
        ({ action, target, detail }) =>
          action.startsWith("app.data.") &&
          action !== "app.data.erased" &&
          target?.id === app &&
          detail.version === version
      )
      .map(({ action, detail }) => ({ action, detail })),
  };
};

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

/** The error code of `path` of `app`'s current release for `by`, or "ok". */
const codeOfCall = async (
  by: Caller,
  app: AppId,
  path: string,
  input: Json = {}
): Promise<string> => {
  const current = await currentOf(app);
  const result = await call(
    by,
    await loadRelease(env, app, current ?? 0),
    path,
    input
  );
  return result.ok ? "ok" : result.error.code;
};

/**
 * App `app`'s store as a minute after the schema it holds was applied:
 * a publish that stopped meanwhile has settled (store-host.ts,
 * `publishSettleMs`), and another may go over it.
 */
const settled = async (app: AppId): Promise<void> => {
  const [own] = await defaultStores(app);
  const store = own?.storeId ?? "";
  await runInDurableObject(env.DATA_STORES.getByName(store), (_, state) => {
    state.storage.sql.exec("UPDATE sdk_store SET schema_applied_at = 0");
  });
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

    it("rolls back onto the App's own store, making no second one, sealed again or not", async () => {
      const { owner, app } = await appWith(notesFiles());
      await publishVersion(env, owner, app, 1);
      const [own] = await defaultStores(app);
      await commitFiles(env, owner, app, notesFiles("Notes 2"), "Second");
      await publishVersion(env, owner, app, 2);
      // A rollback to a release still kept seals nothing.
      await publishVersion(env, owner, app, 1);
      await publishVersion(env, owner, app, 2);
      // One whose release retention let go is sealed again, on the same store.
      await sweptAway(app, 1);
      const back = await publishVersion(env, owner, app, 1);
      const bound = await env.DB.prepare(
        "SELECT DISTINCT target_id AS store FROM sdk_resource_bindings WHERE resource_id = ? AND kind = 'store'"
      )
        .bind(app)
        .all<{ store: string }>();
      expect({
        current: back.currentVersion,
        stores: await defaultStores(app),
        bound: bound.results.map(({ store }) => store),
      }).toStrictEqual({
        current: 1,
        stores: [own],
        bound: [own?.storeId],
      });
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
  it("are recorded once each, numbered, and bound by each version", async () => {
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
    const [first, third] = await Promise.all([
      loadRelease(env, app, 1),
      loadRelease(env, app, 3),
    ]);
    expect([definitions.results, bound.results]).toStrictEqual([
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
    ]);
  });
});

/** The hash of the schema the definition `files` hold declares. */
const schemaOf = async (files: Record<string, string>): Promise<string> =>
  await schemaHash(
    definitionManifest(readDefinition(files[definitionPath] ?? "")).schema
  );

/**
 * `evolvingFiles` with an optional `category` that is a number, and a
 * migration from the schema of `from`, where it is text, that answers
 * each record's `category` as `category` (TypeScript over `row`) derives it.
 */
const migratedFiles = async (
  from: Record<string, string>,
  category: string
): Promise<Record<string, string>> => {
  const files = evolvingFiles({ category: "v.number()" });
  return {
    ...files,
    "server/migrations/category.ts": `import { migration, v } from "@grasp-os/sdk";

export default migration({
  name: "category",
  table: "notes",
  fromSchema: ${JSON.stringify(await schemaOf(from))},
  toSchema: ${JSON.stringify(await schemaOf(files))},
  input: v.object({ title: v.string(), category: v.string() }),
  output: v.object({
    title: v.string().min(1).max(200),
    category: v.number().optional(),
  }),
  fixtures: [
    { row: { title: "Fixture", category: "abc" }, expect: { title: "Fixture", category: 3 } },
  ],
  handler: (ctx, row) => ({ title: row.title, category: ${category} }),
});
`,
  };
};

describe(
  "a version's schema applied as it is published",
  { timeout: 180_000 },
  () => {
    it("applies an optional field, and an older version made current again keeps its values", async () => {
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
      // and the store keeps what the second stored.
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

    it("refuses a type change without a migration, losing nothing, and the current version keeps running", async () => {
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

    it("fills in a defaulted field as it publishes, and the records an older version wrote meanwhile", async () => {
      const { owner, app } = await appWith(evolvingFiles());
      await publishVersion(env, owner, app, 1);
      await valueOf(owner, app, "notes.create", { title: "Launch" });
      const defaulted = await nextVersion(
        owner,
        app,
        evolvingFiles({}, { category: 'v.string().default("general")' })
      );

      await publishVersion(env, owner, app, defaulted);
      const filled = await valueOf(owner, app, "notes.rows");
      // The first version, made current again, writes without the field;
      // made current again, the defaulted one fills it in.
      await publishVersion(env, owner, app, 1);
      await valueOf(owner, app, "notes.create", { title: "Hiring" });
      await publishVersion(env, owner, app, defaulted);
      const events = await allEvents();

      // One event per fill, counting its records: none per record.
      expect({
        filled,
        after: await valueOf(owner, app, "notes.rows"),
        audited: events
          .filter(
            ({ action, target }) =>
              action === "app.data.filled" && target?.id === app
          )
          .map(({ actor, detail }) => ({ actor, detail })),
      }).toStrictEqual({
        filled: [{ title: "Launch", category: "general" }],
        after: [
          { title: "Hiring", category: "general" },
          { title: "Launch", category: "general" },
        ],
        audited: [1, 1].map((records) => ({
          actor: { type: "person", userId: owner.userId },
          detail: {
            table: "notes",
            field: "category",
            version: defaulted,
            records,
          },
        })),
      });
    });

    it("asks a value for the records that lack a new required field, and fills in the answer", async () => {
      const { owner, app } = await appWith(evolvingFiles());
      await publishVersion(env, owner, app, 1);
      await valueOf(owner, app, "notes.create", { title: "Launch" });
      const required = evolvingFiles({}, { category: "v.string()" });
      // Its writes keep the field it requires.
      const files = {
        ...required,
        "server/notes.ts": (required["server/notes.ts"] ?? "").replaceAll(
          "{ title }, { expectedRevision",
          "{ title, category: found.category }, { expectedRevision"
        ),
      };
      const unanswered = await nextVersion(owner, app, files);
      const refused = await failure(
        async () => await publishVersion(env, owner, app, unanswered)
      );
      const answered = await nextVersion(
        owner,
        app,
        redefined(files, (definition) => ({
          ...definition,
          answers: [
            {
              table: "table:notes",
              field: "field:notes.category",
              value: "general",
            },
          ],
        }))
      );
      await publishVersion(env, owner, app, answered);

      expect({
        refused,
        rows: await valueOf(owner, app, "notes.rows"),
      }).toStrictEqual({
        refused: "migration.required",
        rows: [{ title: "Launch", category: "general" }],
      });
    });

    it("keeps a renamed field's values by its stable ID, back and forth across a rollback", async () => {
      const first = evolvingFiles({ category: "v.string()" });
      const { owner, app } = await appWith(first);
      await publishVersion(env, owner, app, 1);
      await valueOf(owner, app, "notes.create", {
        title: "Launch",
        category: "news",
      });
      const renamed = definedWith(first, {
        op: "renameField",
        table: "notes",
        field: "category",
        name: "topic",
      });
      const second = await nextVersion(owner, app, {
        ...renamed,
        "server/notes.ts": (renamed["server/notes.ts"] ?? "").replaceAll(
          "category",
          "topic"
        ),
      });

      await publishVersion(env, owner, app, second);
      const moved = await valueOf(owner, app, "notes.rows");
      await valueOf(owner, app, "notes.create", {
        title: "Hiring",
        topic: "jobs",
      });
      await publishVersion(env, owner, app, 1);
      const back = await valueOf(owner, app, "notes.rows");
      await publishVersion(env, owner, app, second);

      expect({
        moved,
        back,
        again: await valueOf(owner, app, "notes.rows"),
      }).toStrictEqual({
        moved: [{ title: "Launch", topic: "news" }],
        back: [
          { title: "Hiring", category: "jobs" },
          { title: "Launch", category: "news" },
        ],
        again: [
          { title: "Hiring", topic: "jobs" },
          { title: "Launch", topic: "news" },
        ],
      });
    });

    it("keeps a renamed table's records by its stable ID", async () => {
      const first = evolvingFiles();
      const { owner, app } = await appWith(first);
      await publishVersion(env, owner, app, 1);
      const id = await valueOf(owner, app, "notes.create", { title: "Launch" });
      const renamed = definedWith(first, {
        op: "renameTable",
        table: "notes",
        name: "memos",
      });
      const second = await nextVersion(owner, app, {
        ...renamed,
        "server/notes.ts": (renamed["server/notes.ts"] ?? "").replaceAll(
          '"notes"',
          '"memos"'
        ),
      });

      await publishVersion(env, owner, app, second);
      await valueOf(owner, app, "notes.rename", { id, title: "Launched" });

      expect({
        rows: await valueOf(owner, app, "notes.rows"),
        audited: await schemaAudit(app, second),
      }).toMatchObject({
        rows: [{ title: "Launched" }],
        audited: {
          current: {
            tablesRenamed: 1,
            fieldsRenamed: 0,
            tablesMigrated: 0,
            recordsRewritten: 0,
          },
          changes: [
            {
              action: "app.data.renamed",
              detail: {
                table: "memos",
                field: null,
                from: "notes",
                to: "memos",
                version: second,
              },
            },
          ],
        },
      });
    });

    it("keeps the store's version moving through a version without tables", async () => {
      const { owner, app } = await appWith(evolvingFiles());
      await publishVersion(env, owner, app, 1);
      await valueOf(owner, app, "notes.create", { title: "Launch" });
      const empty = await nextVersion(owner, app, {
        ...emptyFiles,
        "server/notes.ts": "",
      });
      await publishVersion(env, owner, app, empty);
      const back = await nextVersion(owner, app, evolvingFiles());

      const published = await failure(
        async () => await publishVersion(env, owner, app, back)
      );

      expect({
        published,
        rows: await valueOf(owner, app, "notes.rows"),
      }).toStrictEqual({ published: "ok", rows: [{ title: "Launch" }] });
    });

    it("migrates a table whose row rule's field is renamed in the same version", async () => {
      const access = {
        read: "appMembers",
        write: "appMembers",
        rows: { read: [{ kind: "team", field: "team" }] },
      } as const;
      const first = {
        ...appDefinition({
          name: "Tickets",
          tables: {
            tickets: {
              fields: { title: "v.string()", team: "v.string()" },
              access,
            },
          },
        }),
        "server/hello.ts": emptyFiles["server/hello.ts"] ?? "",
      };
      const { owner, app } = await appWith(first);
      await publishVersion(env, owner, app, 1);
      const [own] = await defaultStores(app);
      const store = own?.storeId ?? "";
      // A ticket of team A, as one of its members wrote it.
      await runInDurableObject(env.DATA_STORES.getByName(store), (_, state) => {
        const [table] = state.storage.sql
          .exec<{ id: string }>("SELECT table_id AS id FROM sdk_tables")
          .toArray();
        const { hash } = state.storage.sql
          .exec<{ hash: string }>("SELECT contract_hash AS hash FROM sdk_store")
          .one();
        state.storage.sql.exec(
          `INSERT INTO sdk_records (table_id, record_id, owner_id, revision, created_at, updated_at, value_json, schema_hash)
            VALUES (?, 'r1', ?, 1, 0, 0, ?, ?)`,
          table?.id ?? "",
          owner.userId,
          JSON.stringify({ team: "t_a", title: "Launch" }),
          hash
        );
      });
      const renamed = definedWith(
        first,
        { op: "renameField", table: "tickets", field: "team", name: "group" },
        {
          op: "changeField",
          table: "tickets",
          field: "title",
          type: "v.number()",
        }
      );
      const second = await nextVersion(owner, app, {
        ...renamed,
        "server/migrations/title.ts": `import { migration, v } from "@grasp-os/sdk";

export default migration({
  name: "title",
  table: "tickets",
  fromSchema: ${JSON.stringify(await schemaOf(first))},
  toSchema: ${JSON.stringify(await schemaOf(renamed))},
  input: v.object({ title: v.string(), team: v.string() }),
  output: v.object({ title: v.number(), group: v.string() }),
  fixtures: [
    { row: { title: "abc", team: "t_a" }, expect: { title: 3, group: "t_a" } },
  ],
  handler: (ctx, row) => ({ title: row.title.length, group: row.team }),
});
`,
      });

      const published = await failure(
        async () => await publishVersion(env, owner, app, second)
      );
      const stored = await runInDurableObject(
        env.DATA_STORES.getByName(store),
        (_, state) =>
          state.storage.sql
            .exec<{ value: string }>(
              "SELECT value_json AS value FROM sdk_records"
            )
            .toArray()
            .map(({ value }): unknown => JSON.parse(value))
      );

      expect({ published, stored }).toStrictEqual({
        published: "ok",
        stored: [{ group: "t_a", title: 6 }],
      });
    });

    it("runs a migration once on every record as it publishes, in one transaction with the schema", async () => {
      const first = evolvingFiles({ category: "v.string()" });
      const { owner, app } = await appWith(first);
      await publishVersion(env, owner, app, 1);
      for (const [title, category] of [
        ["Launch", "news"],
        ["Hiring", "jobs!"],
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one note after the other
        await valueOf(owner, app, "notes.create", { title, category });
      }
      const second = await nextVersion(
        owner,
        app,
        await migratedFiles(first, "row.category.length")
      );

      await publishVersion(env, owner, app, second);

      expect({
        rows: await valueOf(owner, app, "notes.rows"),
        audited: await schemaAudit(app, second),
      }).toMatchObject({
        rows: [
          { title: "Hiring", category: 5 },
          { title: "Launch", category: 4 },
        ],
        audited: {
          current: {
            tablesMigrated: 1,
            recordsRewritten: 2,
          },
          changes: [
            {
              action: "app.data.migrated",
              detail: { table: "notes", records: 2, version: second },
            },
          ],
        },
      });
    });

    it("changes nothing when its migration fails midway, and the current version keeps running", async () => {
      const first = evolvingFiles({ category: "v.string()" });
      const { owner, app } = await appWith(first);
      await publishVersion(env, owner, app, 1);
      for (const title of ["Alpha", "Bad", "Zulu"]) {
        // oxlint-disable-next-line no-await-in-loop -- one note after the other
        await valueOf(owner, app, "notes.create", { title, category: "news" });
      }
      const second = await nextVersion(
        owner,
        app,
        await migratedFiles(
          first,
          '(() => { if (row.title === "Bad") throw new Error("No"); return row.category.length; })()'
        )
      );

      const refused = await failure(
        async () => await publishVersion(env, owner, app, second)
      );

      expect({
        refused,
        current: await currentOf(app),
        rows: await valueOf(owner, app, "notes.rows"),
      }).toStrictEqual({
        refused: "migration.failed",
        current: 1,
        rows: [
          { title: "Alpha", category: "news" },
          { title: "Bad", category: "news" },
          { title: "Zulu", category: "news" },
        ],
      });
    });

    it("makes one of two conflicting versions current when both are published at once", async () => {
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
        // Refused at its store, the other's schema applied or being made
        // current, or by core's compare and set: never both applied.
        refused: [
          "migration.required",
          "migration.busy",
          "app.conflict",
        ].includes(refused ?? ""),
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

    it("finishes a publish whose store took the schema before it stopped", async () => {
      const { owner, app } = await appWith(evolvingFiles());
      await publishVersion(env, owner, app, 1);
      const second = await nextVersion(
        owner,
        app,
        evolvingFiles({ category: "v.string()" })
      );
      await publishVersion(env, owner, app, second);
      // A rollback that stopped after its store took the first version's
      // schema, and before core made it current.
      await applyVersionSchema(
        env,
        owner,
        await readBackRelease(env, app, 1),
        second
      );
      // Published again within the minute, it is refused as busy: the
      // stopped publish may still be going on.
      const busy = await failure(
        async () => await publishVersion(env, owner, app, 1)
      );
      await settled(app);

      await publishVersion(env, owner, app, 1);

      const events = await allEvents();
      const made = events.filter(
        (event) =>
          event.action === "app.version.current" &&
          event.target?.id === app &&
          event.detail.version === 1 &&
          event.detail.previous === second
      );
      expect({
        current: await currentOf(app),
        changed: made.map(({ detail }) => detail.schemaChanged),
        writes: await failure(
          async () =>
            await valueOf(owner, app, "notes.create", { title: "After" })
        ),
      }).toStrictEqual({ current: 1, changed: [false], writes: "ok" });
      expect(busy).toBe("migration.busy");
    });

    it("says a publish is unfinished when its migration can't be taken back, audits it, and finishes it as it is published again", async () => {
      const first = evolvingFiles({ category: "v.string()" });
      const { owner, app } = await appWith(first);
      await publishVersion(env, owner, app, 1);
      await valueOf(owner, app, "notes.create", {
        title: "Launch",
        category: "news",
      });
      const second = await nextVersion(
        owner,
        app,
        await migratedFiles(first, "row.category.length")
      );

      // Its migration applied, then core's batch failing: the first
      // version's schema can't hold the numbers again.
      const refused = await failure(
        async () =>
          await publishVersion(
            { ...env, DB: failingDb(/update "apps"/iu) },
            owner,
            app,
            second
          )
      );
      const stranded = await codeOfCall(owner, app, "notes.rows");
      const events = await allEvents();
      await settled(app);
      await publishVersion(env, owner, app, second);

      expect({
        refused,
        stranded,
        audited: events
          .filter(
            ({ action, target }) =>
              action === "app.version.unfinished" && target?.id === app
          )
          .map(({ detail }) => detail),
        current: await currentOf(app),
        rows: await valueOf(owner, app, "notes.rows"),
      }).toStrictEqual({
        refused: "app.publish_unfinished",
        stranded: "migration.not_current",
        audited: [
          {
            version: second,
            current: 1,
            code: "migration.required",
          },
        ],
        current: second,
        rows: [{ title: "Launch", category: 4 }],
      });
    });

    it("puts the current version's schema back when the batch making another current fails, so it keeps working", async () => {
      const { owner, app } = await appWith(evolvingFiles());
      await publishVersion(env, owner, app, 1);
      await valueOf(owner, app, "notes.create", { title: "Launch" });
      const second = await nextVersion(
        owner,
        app,
        evolvingFiles({ category: "v.string()" })
      );
      await publishVersion(env, owner, app, second);
      const third = await nextVersion(
        owner,
        app,
        evolvingFiles({ category: "v.string()", topic: "v.string()" })
      );

      // The third's schema applied, then core's batch failing.
      const refused = await failure(
        async () =>
          await publishVersion(
            { ...env, DB: failingDb(/update "apps"/iu) },
            owner,
            app,
            third
          )
      );
      const writes = await failure(
        async () =>
          await valueOf(owner, app, "notes.create", {
            title: "Hiring",
            category: "jobs",
          })
      );

      expect({
        refused,
        current: await currentOf(app),
        writes,
        rows: await valueOf(owner, app, "notes.rows"),
      }).toStrictEqual({
        refused: "Error: D1 refused the batch",
        current: second,
        writes: "ok",
        rows: [{ title: "Hiring", category: "jobs" }, { title: "Launch" }],
      });
    });
  }
);

/** Puts `store` in the state of one written before stable IDs: no catalog. */
const asBeforeStableIds = async (store: string): Promise<void> => {
  await runInDurableObject(env.DATA_STORES.getByName(store), (_, state) => {
    state.storage.sql.exec("UPDATE sdk_store SET schema_catalog = NULL");
  });
};

/** How many mutation receipts `store` keeps. */
const receiptsOf = async (store: string): Promise<number> =>
  await runInDurableObject(env.DATA_STORES.getByName(store), (_, state) =>
    Number(
      state.storage.sql
        .exec("SELECT count(*) AS n FROM sdk_mutation_receipts")
        .one().n
    )
  );

/** The store's reset entries in the audit log: its own, then each table's. */
const resetAudit = async (store: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target, detail }) =>
        (action === "store.reset" && target?.id === store) ||
        (action === "app.data.erased" && detail.store === store)
    )
    .map(({ action, actor, detail }) => ({ action, actor, detail }));
};

/** A Notes App with one note, made current, and its store. */
const notedApp = async () => {
  const { owner, app } = await appWith(evolvingFiles());
  await publishVersion(env, owner, app, 1);
  await valueOf(owner, app, "notes.create", { title: "Launch" });
  const bound = await storeOf(app, 1);
  return { owner, app, store: bound?.storeId ?? "" };
};

describe("resetting an App's data", { timeout: 120_000 }, () => {
  it("lets a builder reset data from before stable IDs, which nothing reads, and its current version runs again", async () => {
    const { owner, app, store } = await notedApp();
    await asBeforeStableIds(store);
    const before = await codeOfCall(owner, app, "notes.rows");

    await resetLegacyAppData(env, owner, app);
    const receipts = await receiptsOf(store);
    await valueOf(owner, app, "notes.create", { title: "Hiring" });

    const actor = { type: "person", userId: owner.userId };
    expect({
      before,
      receipts,
      rows: await valueOf(owner, app, "notes.rows"),
      audited: await resetAudit(store),
    }).toStrictEqual({
      before: "migration.metadata_missing",
      receipts: 0,
      rows: [{ title: "Hiring" }],
      audited: [
        {
          action: "store.reset",
          actor,
          detail: {
            app,
            everything: 0,
            tables: 1,
            records: 1,
            files: 0,
            outbox: 0,
            version: 1,
          },
        },
        {
          action: "app.data.erased",
          actor,
          detail: { store, table: "notes", records: 1 },
        },
      ],
    });
  });

  it("refuses a builder's reset of data that can still be read, and Grasp staff's, and a stranger's, changing nothing", async () => {
    const { owner, app } = await notedApp();
    const stranger = await person("builder");

    expect({
      readable: await failure(async () => {
        await resetLegacyAppData(env, owner, app);
      }),
      staff: await failure(async () => {
        await resetLegacyAppData(env, { ...owner, staff: true }, app);
      }),
      stranger: await failure(async () => {
        await resetLegacyAppData(env, stranger, app);
      }),
      rows: await valueOf(owner, app, "notes.rows"),
    }).toStrictEqual({
      readable: "migration.reset_refused",
      staff: "role.forbidden",
      stranger: "app.not_found",
      rows: [{ title: "Launch" }],
    });
  });

  it("lets an admin reset every record, the App's name typed to confirm, and its current version runs again", async () => {
    const { owner, app, store } = await notedApp();
    const admin = await person("admin");

    const mistyped = await failure(async () => {
      await resetAppData(env, admin, app, "notes");
    });
    await resetAppData(env, admin, app, "Notes");
    const audited = await resetAudit(store);

    expect({
      mistyped,
      rows: await valueOf(owner, app, "notes.rows"),
      receipts: await receiptsOf(store),
      audited: audited.map(({ detail }) => detail),
    }).toStrictEqual({
      mistyped: "app.reset_name_mismatch",
      rows: [],
      receipts: 0,
      audited: [
        {
          app,
          everything: 1,
          tables: 1,
          records: 1,
          files: 0,
          outbox: 0,
          version: 1,
        },
        { store, table: "notes", records: 1 },
      ],
    });
  });

  it("resets nothing, refusing nothing, for an App whose current version has no tables", async () => {
    const { owner, app } = await appWith(emptyFiles);
    await publishVersion(env, owner, app, 1);
    const admin = await person("admin");

    await expect(
      failure(async () => {
        await resetAppData(env, admin, app, "Notes");
      })
    ).resolves.toBe("ok");
  });

  it("refuses a full reset to the App's builders and to Grasp staff, changing nothing", async () => {
    const { owner, app } = await notedApp();
    const admin = await person("admin");

    expect({
      builder: await failure(async () => {
        await resetAppData(env, owner, app, "Notes");
      }),
      staff: await failure(async () => {
        await resetAppData(env, { ...admin, staff: true }, app, "Notes");
      }),
      rows: await valueOf(owner, app, "notes.rows"),
    }).toStrictEqual({
      builder: "role.forbidden",
      staff: "role.forbidden",
      rows: [{ title: "Launch" }],
    });
  });
});
