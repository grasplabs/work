import type { Role } from "@grasp-os/shared/roles";
import type { Commit, Committed, Held } from "@grasp-os/shared/stores";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import {
  createStore,
  deleteStore,
  openStore,
  shareStore,
  unshareStore,
} from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { StoreHost } from "../src/store-host.ts";
import { allEvents } from "./audit-events.ts";

// A business store's lifecycle (data-stores.ts, store-host.ts), from the
// threat model in data-stores.ts: who may create, share and delete a
// store, that a store something still relies on can't be deleted, and
// that a deleted store stays deleted. Each test makes its own people and
// stores.

const dayMs = 24 * 60 * 60 * 1000;
const schemaHash = "a".repeat(64);

/** A member of the organization in `role`, as their session has them. */
const person = async (role: Role, teams: string[] = []): Promise<Acting> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    // The organization, as the first sign-in makes it.
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return {
    userId,
    role,
    teams: teams.map((id) => ({ id, name: "Team" })),
    staff: false,
  };
};

/** A team of the organization. */
const newTeam = async (): Promise<string> => {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Team', 'organization', ?)"
  )
    .bind(id, Date.now())
    .run();
  return id;
};

const objectOf = (id: string) => env.DATA_STORES.getByName(id);

/** Runs `work` on store `id`'s host, inside its object. */
const inHost = async <T>(
  id: string,
  work: (host: StoreHost) => Promise<T>
): Promise<T> =>
  await runInDurableObject(
    objectOf(id),
    async (_instance, state) => await work(new StoreHost(state, env))
  );

/** Commits one note in `store` for `by`, under a receipt of its own. */
const commitNote = async (
  store: OpenStore,
  by: Acting,
  runId: string | null = null
): Promise<Committed> => {
  const claimed = await store.claim({
    scope: {
      principal: by.userId,
      resource: "notes-app",
      binding: null,
      contractId: "notes.create",
      contractVersion: 1,
      operationKind: "mutation",
    },
    key: [crypto.randomUUID()],
    inputHash: "c".repeat(64),
    runId,
    deadline: Date.now() + 60_000,
  });
  if (!("held" in claimed)) {
    throw new Error("A new key found an outcome");
  }
  const { receiptId, fence }: Held = claimed.held;
  const commit: Omit<Commit, "storeId"> = {
    principal: { userId: by.userId },
    schemaHash,
    receipt: { receiptId, fence },
    writes: [{ op: "insert", table: "notes", fields: { title: "Note" } }],
  };
  return await store.commit(commit);
};

/** A store `by` created, with a `notes` table. */
const storeOf = async (by: Acting): Promise<OpenStore> => {
  const store = await openStore(env, await createStore(env, by));
  await store.defineTables(["notes"]);
  return store;
};

/** Expires every receipt of store `id`, as the sweep does past retention. */
const expireReceipts = async (id: string): Promise<void> => {
  await inHost(id, async (host) => {
    await host.sweepReceipts(new Date(Date.now() + 31 * dayMs));
  });
};

/** The events about store `id`, by action. */
const eventsOf = async (id: string): Promise<string[]> => {
  const events = await allEvents();
  return events
    .filter(({ target }) => target?.type === "store" && target.id === id)
    .map(({ action }) => action);
};

describe("creating stores", () => {
  it("is for builders and admins, and audited", async () => {
    const builder = await person("builder");
    const admin = await person("admin");
    const user = await person("user");

    const built = await createStore(env, builder);
    await createStore(env, admin);
    await expect(createStore(env, user)).rejects.toMatchObject({
      code: "role.forbidden",
    });
    await expect(eventsOf(built)).resolves.toStrictEqual(["store.created"]);
  });
});

describe("deleting stores", () => {
  it("is for those who manage the store, and nobody else learns it exists", async () => {
    const owner = await person("builder");
    const team = await newTeam();
    const byPerson = await person("builder");
    const byTeam = await person("builder", [team]);
    const admin = await person("admin");
    const stranger = await person("builder");
    const sharedUser = await person("user");
    const staff: Acting = { ...(await person("admin")), staff: true };

    const stores = await Promise.all(
      [owner, owner, owner, owner, owner].map(
        async (by) => await createStore(env, by)
      )
    );
    const [mine, viaPerson, viaTeam, viaAdmin, viaStaff] = stores;
    if (
      mine === undefined ||
      viaPerson === undefined ||
      viaTeam === undefined ||
      viaAdmin === undefined ||
      viaStaff === undefined
    ) {
      throw new Error("Stores missing");
    }
    await shareStore(env, owner, viaPerson, {
      type: "person",
      id: byPerson.userId,
    });
    await shareStore(env, owner, viaTeam, { type: "team", id: team });

    // Neither a builder it isn't shared with, nor a user, whatever they
    // are shared as, learns of it.
    await expect(deleteStore(env, stranger, mine)).rejects.toMatchObject({
      code: "data.store_unavailable",
    });
    await expect(
      shareStore(env, owner, mine, { type: "person", id: sharedUser.userId })
    ).rejects.toMatchObject({ code: "data.invalid" });
    await expect(
      deleteStore(env, { ...owner, role: "user" }, mine)
    ).rejects.toMatchObject({ code: "data.store_unavailable" });

    await deleteStore(env, owner, mine);
    await deleteStore(env, byPerson, viaPerson);
    await deleteStore(env, byTeam, viaTeam);
    await deleteStore(env, admin, viaAdmin);
    await deleteStore(env, staff, viaStaff);
    await Promise.all(
      stores.map(async (id) => {
        await expect(openStore(env, id)).rejects.toMatchObject({
          code: "data.store_unavailable",
        });
      })
    );
    await expect(eventsOf(mine)).resolves.toStrictEqual([
      "store.created",
      "store.deleted",
    ]);
  });

  it("stops at unsharing: someone unshared no longer manages it", async () => {
    const owner = await person("builder");
    const other = await person("builder");
    const id = await createStore(env, owner);
    await shareStore(env, owner, id, { type: "person", id: other.userId });
    await unshareStore(env, owner, id, { type: "person", id: other.userId });
    await expect(deleteStore(env, other, id)).rejects.toMatchObject({
      code: "data.store_unavailable",
    });
    await expect(eventsOf(id)).resolves.toStrictEqual([
      "store.created",
      "store.member.added",
      "store.member.removed",
    ]);
  });

  it("never lets Grasp staff decide whom a store reaches", async () => {
    const owner = await person("builder");
    const other = await person("builder");
    const staff: Acting = { ...(await person("admin")), staff: true };
    const id = await createStore(env, owner);
    await expect(
      shareStore(env, staff, id, { type: "person", id: other.userId })
    ).rejects.toMatchObject({ code: "role.forbidden" });
  });

  it("is refused while a receipt refers to the store, and allowed once they expired", async () => {
    const owner = await person("builder");
    const store = await storeOf(owner);
    await commitNote(store, owner);

    await expect(deleteStore(env, owner, store.id)).rejects.toMatchObject({
      code: "data.store_in_use",
    });
    // Still there, and still serving.
    await expect(commitNote(store, owner)).resolves.toHaveProperty("inserted");

    await expireReceipts(store.id);
    await deleteStore(env, owner, store.id);
    await expect(openStore(env, store.id)).rejects.toMatchObject({
      code: "data.store_unavailable",
    });
  });

  it("is refused while an attempt holds a claim, and while a live run keeps a receipt", async () => {
    const owner = await person("builder");
    const store = await storeOf(owner);
    await store.claim({
      scope: {
        principal: owner.userId,
        resource: "notes-app",
        binding: null,
        contractId: "notes.create",
        contractVersion: 1,
        operationKind: "mutation",
      },
      key: ["in-flight"],
      inputHash: "c".repeat(64),
      runId: null,
      deadline: Date.now() + 60_000,
    });
    await expect(deleteStore(env, owner, store.id)).rejects.toMatchObject({
      code: "data.store_in_use",
    });

    const running = await storeOf(owner);
    const appId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Runner', '', ?, ?)"
      ).bind(appId, owner.userId, Date.now()),
      env.DB.prepare(
        "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at) VALUES (?, ?, 'w', 1, ?, 'running', ?)"
      ).bind(runId, appId, owner.userId, Date.now()),
    ]);
    await commitNote(running, owner, runId);
    // Past its retention, but its run is live: the sweep keeps it.
    await expireReceipts(running.id);
    await expect(deleteStore(env, owner, running.id)).rejects.toMatchObject({
      code: "data.store_in_use",
    });
  });

  it("refuses every call after it, whatever core's inventory says", async () => {
    const owner = await person("builder");
    const store = await storeOf(owner);
    await deleteStore(env, owner, store.id);

    // A stub held from before, and an inventory row wrongly live again.
    await expect(store.get("notes", "any")).rejects.toMatchObject({
      code: "data.store_unavailable",
    });
    await env.DB.prepare(
      "UPDATE business_stores SET deleted_at = NULL WHERE id = ?"
    )
      .bind(store.id)
      .run();
    const reopened = await openStore(env, store.id);
    await expect(commitNote(reopened, owner)).rejects.toMatchObject({
      code: "data.store_unavailable",
    });
  });

  it("finishes a deletion that stopped half-way, auditing it once", async () => {
    const owner = await person("builder");
    const store = await storeOf(owner);
    // The object was marked; the inventory batch never ran.
    await inHost(store.id, async (host) => {
      await host.close(store.id);
    });

    await deleteStore(env, owner, store.id);
    await expect(openStore(env, store.id)).rejects.toMatchObject({
      code: "data.store_unavailable",
    });
    await expect(eventsOf(store.id)).resolves.toStrictEqual([
      "store.created",
      "store.deleted",
    ]);
  });

  it("purges the records on the alarm, keeping only the deletion mark", async () => {
    const owner = await person("builder");
    const store = await storeOf(owner);
    await commitNote(store, owner);
    await commitNote(store, owner);
    await expireReceipts(store.id);
    await deleteStore(env, owner, store.id);

    await expect(
      runDurableObjectAlarm(objectOf(store.id))
    ).resolves.toBeTruthy();
    const left = await runInDurableObject(
      objectOf(store.id),
      (_instance, state) => ({
        records: state.storage.sql
          .exec("SELECT count(*) AS n FROM sdk_records")
          .one().n,
        tables: state.storage.sql
          .exec("SELECT count(*) AS n FROM sdk_tables")
          .one().n,
        receipts: state.storage.sql
          .exec("SELECT count(*) AS n FROM sdk_mutation_receipts")
          .one().n,
        deleted: state.storage.sql
          .exec("SELECT deleted_at IS NOT NULL AS d FROM sdk_store")
          .one().d,
      })
    );
    expect(left).toStrictEqual({
      records: 0,
      tables: 0,
      receipts: 0,
      deleted: 1,
    });
  });
});
