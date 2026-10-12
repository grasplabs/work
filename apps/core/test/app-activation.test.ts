import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { activateVersion } from "../src/app-activation.ts";
import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import {
  commitFiles,
  createApp,
  findApp,
  setCurrentVersion,
} from "../src/apps.ts";
import { deleteStore } from "../src/data-stores.ts";
import { appDefaultStores, sdkStoreOwners } from "../src/db/core/schema.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { racingDb } from "./apps.ts";
import { failure, person } from "./sealed-apps.ts";

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

    it("refuses a rollback onto a deleted store, and gives later versions a fresh one", async () => {
      const { owner, app } = await appWith(notesFiles());
      await activateVersion(env, owner, app, 1);
      const [deleted] = await defaultStores(app);
      await commitFiles(env, owner, app, emptyFiles, "No tables");
      await activateVersion(env, owner, app, 2);
      await deleteStore(env, owner, deleted?.storeId ?? "");

      await expect(
        failure(async () => await activateVersion(env, owner, app, 1))
      ).resolves.toBe("data.store_unavailable");
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
      const racing = racingDb(async () => {
        await deleteStore(env, owner, store?.storeId ?? "");
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
