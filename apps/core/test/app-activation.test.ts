import { storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { activateVersion } from "../src/app-activation.ts";
import { callAppFunction } from "../src/app-functions.ts";
import { addMember, removeMember } from "../src/app-members.ts";
import { loadRelease, sealRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import {
  commitFiles,
  createApp,
  findApp,
  setCurrentVersion,
} from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import {
  createStore,
  deleteStore,
  shareStore,
  storeManagers,
  unshareStore,
} from "../src/data-stores.ts";
import { appDefaultStores, sdkStoreOwners } from "../src/db/core/schema.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { racingDb } from "./apps.ts";
import { failure, person, sweptAway } from "./sealed-apps.ts";

// Making a version of spec 8's layout current seals it on the App's one
// default store, which the host creates the first time a version needs
// one and binds to every later version, so the App's data outlives its
// versions; nothing makes such a version current unsealed.

const notesFiles = (title = "Notes"): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(200) }),
});
`,
  "operations/notes.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "#grasp/server";

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
  "app.ts": `import { app } from "@grasp-os/sdk";
import { create, titles } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: ${JSON.stringify(title)},
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  operations: { notes: { create, titles } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
});

const emptyFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema } from "@grasp-os/sdk";

export default defineSchema({});
`,
  "operations/hello.ts": `import { v } from "@grasp-os/sdk";
import { query } from "#grasp/server";

export const hello = query({
  args: {},
  returns: v.string(),
  handler: () => "hello",
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { hello } from "./operations/hello.ts";
import schema from "./schema.ts";

export default app({
  name: "Hello",
  schema,
  access: { tables: {} },
  operations: { hello: { hello } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
};

type Caller = Awaited<ReturnType<typeof person>>;

/** A builder's App with `files` as its first version. */
const appWith = async (files: Record<string, string>) => {
  const owner = await person("builder");
  const { id } = await createApp(env, owner, { name: "Notes" });
  await commitFiles(env, owner, id, files, "First version");
  return { owner, app: id };
};

/** Calls `path` of `release` for `by`, as a screen sends it. */
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
      reference: {
        resourceId: release.manifest.resourceId,
        resourceVersion: release.manifest.resourceVersion,
        contractId: path,
        fingerprint: release.fingerprints[path],
        kind: operation?.kind,
      },
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

describe(
  "activating a version of spec 8's layout",
  { timeout: 120_000 },
  () => {
    it("seals it on a default store the host creates, and its functions run", async () => {
      const { owner, app } = await appWith(notesFiles());
      const activated = await activateVersion(env, owner, app, 1);
      expect(activated.currentVersion).toBe(1);

      const release = await loadRelease(env, app, 1);
      const [store] = await defaultStores(app);
      expect(release.store?.storeId).toBe(store?.storeId);
      const [owned] = await drizzle(env.DB)
        .select()
        .from(sdkStoreOwners)
        .where(eq(sdkStoreOwners.appId, app))
        .all();
      expect(owned?.storeId).toBe(store?.storeId);

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
      await activateVersion(env, owner, app, 1);
      const first = await loadRelease(env, app, 1);
      await call(owner, first, "notes.create", { title: "Kept" });

      await commitFiles(env, owner, app, notesFiles("Notes 2"), "Second");
      await activateVersion(env, owner, app, 2);
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

    it("lets another builder of the App activate on the default store the first one created", async () => {
      const { owner, app } = await appWith(notesFiles());
      await activateVersion(env, owner, app, 1);
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
      const activated = await activateVersion(env, other, app, 2);
      const second = await loadRelease(env, app, 2);
      expect([
        activated.currentVersion,
        second.store?.storeId === first.store?.storeId,
        await call(other, second, "notes.titles", {}),
      ]).toStrictEqual([2, true, { ok: true, value: ["Shared"] }]);
    });

    it("is refused to someone who builds no App, sealing directly onto its store", async () => {
      const { owner, app } = await appWith(notesFiles());
      await activateVersion(env, owner, app, 1);
      const [recorded] = await defaultStores(app);
      const stranger = await person("builder");
      await expect(
        failure(
          async () =>
            await sealRelease(env, {
              app,
              version: 1,
              store: storeIdSchema.parse(recorded?.storeId),
              by: stranger,
            })
        )
      ).resolves.toBe("app.not_found");
    });

    it("creates no store for an App without tables", async () => {
      const { owner, app } = await appWith(emptyFiles);
      await activateVersion(env, owner, app, 1);
      await expect(storeOf(app, 1)).resolves.toBeNull();
      await expect(defaultStores(app)).resolves.toHaveLength(0);
    });

    it("gives two Apps two stores, never one between them", async () => {
      const first = await appWith(notesFiles());
      const second = await appWith(notesFiles());
      await activateVersion(env, first.owner, first.app, 1);
      await activateVersion(env, second.owner, second.app, 1);
      const [a] = await defaultStores(first.app);
      const [b] = await defaultStores(second.app);
      expect(a?.storeId).toBeDefined();
      expect(a?.storeId).not.toBe(b?.storeId);
    });

    it("is refused to someone who doesn't build the App, who creates nothing", async () => {
      const { app } = await appWith(notesFiles());
      const stranger = await person("builder");
      await expect(
        failure(async () => await activateVersion(env, stranger, app, 1))
      ).resolves.toBe("app.not_found");
      await expect(defaultStores(app)).resolves.toHaveLength(0);
      await expect(currentOf(app)).resolves.toBeNull();
    });

    it("gives two first activations at once one store, claimed once", async () => {
      const { owner, app } = await appWith(notesFiles());
      const outcomes = await Promise.all([
        failure(async () => await activateVersion(env, owner, app, 1)),
        failure(async () => await activateVersion(env, owner, app, 1)),
      ]);
      expect(outcomes).toContain("ok");
      const stores = await defaultStores(app);
      expect(stores).toHaveLength(1);
      const claims = await drizzle(env.DB)
        .select()
        .from(sdkStoreOwners)
        .where(eq(sdkStoreOwners.appId, app))
        .all();
      expect(claims.map(({ storeId }) => storeId)).toStrictEqual([
        stores[0]?.storeId,
      ]);
      await expect(storeOf(app, 1)).resolves.toMatchObject({
        storeId: stores[0]?.storeId,
      });
    });

    it("refuses a revoked version, even one revoked as it is made current", async () => {
      const { owner, app } = await appWith(notesFiles());
      await activateVersion(env, owner, app, 1);
      await commitFiles(env, owner, app, notesFiles("Notes 2"), "Second");
      await activateVersion(env, owner, app, 2);
      await commitFiles(env, owner, app, notesFiles("Notes 3"), "Third");
      await activateVersion(env, owner, app, 3);
      const admin = await person("admin");

      // Revoked before: refused at the check.
      await revokeRelease(env, admin, { app, version: 1 }, "Leaks data");
      await expect(
        failure(async () => await setCurrentVersion(env, owner, app, 1))
      ).resolves.toBe("version.revoked");

      // Revoked between the check and the change: refused by the change.
      const racing = racingDb(async () => {
        await revokeRelease(env, admin, { app, version: 2 }, "Leaks data");
      }, /update "apps"/iu);
      await expect(
        failure(
          async () =>
            await setCurrentVersion({ ...env, DB: racing }, owner, app, 2)
        )
      ).resolves.toBe("version.revoked");
      await expect(currentOf(app)).resolves.toBe(3);
    });

    it("refuses a rollback onto a store retention let go, and gives later versions a fresh one", async () => {
      const { owner, app } = await appWith(notesFiles());
      await activateVersion(env, owner, app, 1);
      const [deleted] = await defaultStores(app);
      await commitFiles(env, owner, app, emptyFiles, "No tables");
      await activateVersion(env, owner, app, 2);
      // Version 1 kept binds its store; once retention lets it go, the
      // store can be deleted.
      await sweptAway(app, 1);
      await deleteStore(env, owner, deleted?.storeId ?? "");

      // Sealed again, version 1 would bind a fresh store: another release
      // than the one deleted, which its number never comes to name.
      await expect(
        failure(async () => await activateVersion(env, owner, app, 1))
      ).resolves.toBe("version.seal_conflict");
      await expect(currentOf(app)).resolves.toBe(2);

      await commitFiles(env, owner, app, notesFiles("Notes 3"), "Tables again");
      await activateVersion(env, owner, app, 3);
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
      await activateVersion(env, owner, app, 1);
      const [store] = await defaultStores(app);
      await commitFiles(env, owner, app, emptyFiles, "No tables");
      await activateVersion(env, owner, app, 2);
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
            await setCurrentVersion({ ...env, DB: racing }, owner, app, 1)
        )
      ).resolves.toBe("data.store_unavailable");
      await expect(currentOf(app)).resolves.toBe(2);
    });

    it("never makes such a version current unsealed", async () => {
      const { owner, app } = await appWith(notesFiles());
      await expect(
        failure(async () => await setCurrentVersion(env, owner, app, 1))
      ).resolves.toBe("version.not_sealed");
      await expect(currentOf(app)).resolves.toBeNull();
    });

    it("refuses a version that can't be sealed, and leaves the current one", async () => {
      const { owner, app } = await appWith(notesFiles());
      await activateVersion(env, owner, app, 1);
      await commitFiles(
        env,
        owner,
        app,
        { ...notesFiles(), "app.ts": "export default 42;\n" },
        "Broken"
      );
      await expect(
        failure(async () => await activateVersion(env, owner, app, 2))
      ).resolves.not.toBe("ok");
      await expect(currentOf(app)).resolves.toBe(1);
    });
  }
);

/** Whom `by` sees listed as managing store `store`, by ID. */
const managerIds = async (by: Acting, store: string): Promise<string[]> => {
  const managers = await storeManagers(env, by, store);
  return managers.map(({ id }) => id);
};

/** Makes `userId` a user of the organization, a role that doesn't build. */
const demote = async (userId: string): Promise<void> => {
  await env.DB.prepare("UPDATE members SET role = 'user' WHERE user_id = ?")
    .bind(userId)
    .run();
};

describe("an App's default store", { timeout: 120_000 }, () => {
  it("is managed by whoever builds the App, not by the builder who first activated once they leave", async () => {
    const { owner, app } = await appWith(notesFiles());
    // A builder the App is shared with activates first, so the store is
    // theirs as `createStore` records it.
    const first = await person("builder");
    await addMember(env, owner, app, {
      type: "person",
      id: first.userId,
      role: "builder",
    });
    await activateVersion(env, first, app, 1);
    const [recorded] = await defaultStores(app);
    const store = recorded?.storeId ?? "";
    const whileBuilding = await storeManagers(env, first, store);
    await removeMember(env, owner, app, { type: "person", id: first.userId });
    const admin = await person("admin");
    expect([
      whileBuilding.map(({ id }) => id),
      await failure(async () => await storeManagers(env, first, store)),
      await failure(async () => {
        await deleteStore(env, first, store);
      }),
      await managerIds(owner, store),
      await managerIds(admin, store),
    ]).toStrictEqual([
      [owner.userId, first.userId],
      "data.store_unavailable",
      "data.store_unavailable",
      // The owner is left, as an admin sees it too.
      [owner.userId],
      [owner.userId],
    ]);
  });

  it("lists as managers only who builds the App now, its owner included", async () => {
    const { owner, app } = await appWith(notesFiles());
    await activateVersion(env, owner, app, 1);
    const [recorded] = await defaultStores(app);
    const store = recorded?.storeId ?? "";
    const capped = await person("builder");
    const builds = await person("builder");
    for (const member of [capped, builds]) {
      // oxlint-disable-next-line no-await-in-loop -- shared in turn, so the order they are listed in is theirs
      await addMember(env, owner, app, {
        type: "person",
        id: member.userId,
        role: "builder",
      });
    }
    const admin = await person("admin");
    const before = await managerIds(admin, store);
    // Their role in the organization caps their role in the App.
    await demote(capped.userId);
    const memberCapped = await managerIds(admin, store);
    await demote(owner.userId);
    expect([
      before,
      memberCapped,
      await managerIds(admin, store),
    ]).toStrictEqual([
      [owner.userId, capped.userId, builds.userId],
      [owner.userId, builds.userId],
      [builds.userId],
    ]);
  });

  it("is refused to everyone, never managed as a plain store, once its App row is gone", async () => {
    const creator = await person("builder");
    const store = await createStore(env, creator);
    await drizzle(env.DB).insert(appDefaultStores).values({
      appId: "app_00000000000000000000missing",
      storeId: store,
      createdAt: new Date(),
    });
    const admin = await person("admin");
    expect([
      await failure(async () => await storeManagers(env, creator, store)),
      await failure(async () => await storeManagers(env, admin, store)),
      await failure(async () => {
        await deleteStore(env, creator, store);
      }),
    ]).toStrictEqual([
      "data.store_unavailable",
      "data.store_unavailable",
      "data.store_unavailable",
    ]);
  });

  it("is managed by none of the App's users, and shared or unshared only with the App", async () => {
    const { owner, app } = await appWith(notesFiles());
    await activateVersion(env, owner, app, 1);
    const [recorded] = await defaultStores(app);
    const store = recorded?.storeId ?? "";
    const reader = await person("builder");
    await addMember(env, owner, app, {
      type: "person",
      id: reader.userId,
      role: "user",
    });
    const outsider = await person("builder");
    expect([
      await failure(async () => await storeManagers(env, reader, store)),
      await failure(async () => {
        await shareStore(env, owner, store, {
          type: "person",
          id: outsider.userId,
        });
      }),
      await failure(async () => {
        await unshareStore(env, owner, store, {
          type: "person",
          id: outsider.userId,
        });
      }),
      await failure(async () => await storeManagers(env, outsider, store)),
    ]).toStrictEqual([
      "data.store_unavailable",
      "data.store_managed_by_app",
      "data.store_managed_by_app",
      "data.store_unavailable",
    ]);
  });
});
