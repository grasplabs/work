import { actorOf } from "@grasp-os/shared/audit";
import type { Role } from "@grasp-os/shared/roles";
import { dataErrors } from "@grasp-os/shared/stores";
import type { Commit, Committed, Held } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { deleteStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { storeClosingMs } from "../src/store-deletion.ts";
import { StoreHost } from "../src/store-host.ts";
import { storeOfNewApp } from "./app-stores.ts";
import { allEvents } from "./audit-events.ts";
import { seedResourceRun } from "./runs.ts";
import {
  applied,
  manifestHash,
  memberRoles,
  newRecordId,
  tablesManifest,
} from "./store-schemas.ts";

// An App's store's lifecycle (data-stores.ts, store-host.ts), from the
// threat model in data-stores.ts: who may delete a store, that a store
// something still relies on can't be deleted, and that a deleted store
// stays deleted. Each test makes its own people, Apps and stores.

const dayMs = 24 * 60 * 60 * 1000;
const schemaHash = await manifestHash(tablesManifest("notes"));

/** A member of the organization in `role`, as their session has them. */
const person = async (role: Role): Promise<Acting> => {
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
    teams: [],
    staff: false,
  };
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
      functionKind: "mutation",
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
    actor: { type: "person", userId: by.userId },
    roles: memberRoles,
    stagedAt: Date.now(),
    schemaHash,
    receipt: { receiptId, fence },
    writes: [
      {
        op: "insert",
        id: newRecordId(),
        table: "notes",
        fields: { title: "Note" },
      },
    ],
  };
  return await store.commit(commit);
};

/** The store of a new App `by` builds, with a `notes` table. */
const storeOf = async (by: Acting): Promise<OpenStore> => {
  const store = await openStore(env, await storeOfNewApp(env, by));
  await store.applySchema(applied(tablesManifest("notes")));
  return store;
};

/** Expires every receipt of store `id`, as the sweep does past retention. */
const expireReceipts = async (id: string): Promise<void> => {
  await inHost(id, async (host) => {
    await host.sweepReceipts(new Date(Date.now() + 31 * dayMs));
  });
};

/** How `by`'s deletion of store `id` ends: "ok", or its error's code. */
const deletionOutcome = async (by: Acting, id: string): Promise<string> => {
  try {
    await deleteStore(env, by, id);
    return "ok";
  } catch (error) {
    return dataErrors.codeOf(error) ?? "unexpected";
  }
};

/** The deletion holding store `id`'s closing mark, if one does. */
const closingOwner = async (id: string): Promise<string | null> => {
  const row = await env.DB.prepare(
    "SELECT closing_owner AS owner FROM business_stores WHERE id = ?"
  )
    .bind(id)
    .first<{ owner: string | null }>();
  return row?.owner ?? null;
};

/** All a caller can see of what it was refused with. */
const seen = (error: unknown) =>
  error instanceof Error
    ? {
        ...Object.fromEntries(Object.entries(error)),
        errorName: error.name,
        errorMessage: error.message,
      }
    : error;

/** How many records store `id`'s object still holds. */
const recordsLeft = async (id: string): Promise<number> =>
  await runInDurableObject(objectOf(id), (_instance, state) =>
    Number(
      state.storage.sql.exec("SELECT count(*) AS n FROM sdk_records").one().n
    )
  );

/** Who the `store.deleted` events of store `id` name, in log order. */
const deletionsOf = async (id: string): Promise<unknown[]> => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action === "store.deleted" &&
        target?.type === "store" &&
        target.id === id
    )
    .map(({ actor }) => actor);
};

/** The events about store `id`, by action. */
const eventsOf = async (id: string): Promise<string[]> => {
  const events = await allEvents();
  return events
    .filter(({ target }) => target?.type === "store" && target.id === id)
    .map(({ action }) => action);
};

describe("deleting stores", () => {
  it("is for whoever builds the store's App, and nobody else learns it exists", async () => {
    const owner = await person("builder");
    const admin = await person("admin");
    const stranger = await person("builder");
    const staff: Acting = { ...(await person("admin")), staff: true };
    const [mine, viaAdmin, viaStaff] = await Promise.all(
      [owner, owner, owner].map(async (by) => await storeOfNewApp(env, by))
    );
    if (
      mine === undefined ||
      viaAdmin === undefined ||
      viaStaff === undefined
    ) {
      throw new Error("Stores missing");
    }

    // Neither a builder of another App, nor its owner once their role in
    // the organization no longer builds, learns of it.
    await expect(deleteStore(env, stranger, mine)).rejects.toMatchObject({
      code: "data.store_unavailable",
    });
    await expect(
      deleteStore(env, { ...owner, role: "user" }, mine)
    ).rejects.toMatchObject({ code: "data.store_unavailable" });

    await deleteStore(env, owner, mine);
    await deleteStore(env, admin, viaAdmin);
    // Whether a client's data is destroyed is the client's decision.
    await expect(deleteStore(env, staff, viaStaff)).rejects.toMatchObject({
      code: "role.forbidden",
    });
    await Promise.all(
      [mine, viaAdmin].map(async (id) => {
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

  it("answers a store that doesn't exist and one not theirs alike", async () => {
    const owner = await person("builder");
    const stranger = await person("builder");
    const id = await storeOfNewApp(env, owner);
    const missing = await deleteStore(env, stranger, crypto.randomUUID()).catch(
      (error: unknown) => error
    );
    const unmanaged = await deleteStore(env, stranger, id).catch(
      (error: unknown) => error
    );
    expect(seen(missing)).toMatchObject({ code: "data.store_unavailable" });
    expect(seen(missing)).toStrictEqual(seen(unmanaged));
  });

  it("is refused while a receipt refers to the store, and allowed once they expired", async () => {
    const owner = await person("builder");
    const store = await storeOf(owner);
    await commitNote(store, owner);

    await expect(deleteStore(env, owner, store.id)).rejects.toMatchObject({
      code: "data.store_in_use",
    });
    await expect(eventsOf(store.id)).resolves.toStrictEqual([
      "store.created",
      "store.delete_refused",
    ]);
    // Still there, and still serving.
    await expect(commitNote(store, owner)).resolves.toHaveProperty("inserted");

    await expireReceipts(store.id);
    await deleteStore(env, owner, store.id);
    await expect(openStore(env, store.id)).rejects.toMatchObject({
      code: "data.store_unavailable",
    });
  });

  it("closes a store only for the deletion holding its mark, whose refusal clears its own mark alone", async () => {
    const owner = await person("builder");
    const store = await storeOf(owner);
    // A receipt: the first deletion's close is refused.
    await commitNote(store, owner);
    // A second deletion starts while the first holds the mark, just as
    // the first is about to close the store.
    const getByName = env.DATA_STORES.getByName.bind(env.DATA_STORES);
    let closes = 0;
    let second: string | undefined;
    const overlapping = (name: string) => {
      const stub = getByName(name);
      return new Proxy(stub, {
        get: (target, property): unknown =>
          property === "close"
            ? async (...args: Parameters<typeof stub.close>) => {
                closes += 1;
                second ??= await deletionOutcome(owner, store.id);
                return await target.close(...args);
              }
            : Reflect.get(target, property),
      });
    };
    Reflect.set(env.DATA_STORES, "getByName", overlapping);
    let first: string;
    try {
      first = await deletionOutcome(owner, store.id);
    } finally {
      Reflect.set(env.DATA_STORES, "getByName", getByName);
    }
    expect([first, second, closes, await closingOwner(store.id)]).toStrictEqual(
      ["data.store_in_use", "data.store_closing", 1, null]
    );
    // Not deleted: it still serves.
    await expect(commitNote(store, owner)).resolves.toHaveProperty("inserted");
  });

  it("never clears a mark another deletion took over after its own lapsed", async () => {
    const owner = await person("builder");
    const store = await storeOf(owner);
    await commitNote(store, owner);
    // The first deletion stalls past its mark's lapse; a second takes the
    // mark over and is held just before its own close.
    const getByName = env.DATA_STORES.getByName.bind(env.DATA_STORES);
    const secondAtClose = Promise.withResolvers<null>();
    const letSecondClose = Promise.withResolvers<null>();
    let secondOutcome: Promise<string> | undefined;
    let closes = 0;
    const stalling = (name: string) => {
      const stub = getByName(name);
      return new Proxy(stub, {
        get: (target, property): unknown =>
          property === "close"
            ? async (...args: Parameters<typeof stub.close>) => {
                closes += 1;
                if (closes === 1) {
                  await env.DB.prepare(
                    "UPDATE business_stores SET closing_at = ? WHERE id = ?"
                  )
                    .bind(Date.now() - 2 * storeClosingMs, store.id)
                    .run();
                  secondOutcome = deletionOutcome(owner, store.id);
                  await secondAtClose.promise;
                } else {
                  secondAtClose.resolve(null);
                  await letSecondClose.promise;
                }
                return await target.close(...args);
              }
            : Reflect.get(target, property),
      });
    };
    Reflect.set(env.DATA_STORES, "getByName", stalling);
    let first: string;
    let duringSecond: string | null;
    try {
      first = await deletionOutcome(owner, store.id);
      // The first was refused and cleared nothing of the second's.
      duringSecond = await closingOwner(store.id);
      letSecondClose.resolve(null);
    } finally {
      Reflect.set(env.DATA_STORES, "getByName", getByName);
    }
    expect([
      first,
      duringSecond === null,
      await secondOutcome,
      closes,
      await closingOwner(store.id),
    ]).toStrictEqual([
      "data.store_in_use",
      false,
      "data.store_in_use",
      2,
      null,
    ]);
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
        functionKind: "mutation",
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
    const workflow = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO workflow_resources (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(workflow, `Runner ${workflow}`, owner.userId, Date.now())
      .run();
    const runId = await seedResourceRun({
      workflow,
      principal: owner.userId,
      status: "running",
      createdAt: Date.now(),
    });
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

  it("finishes a deletion that stopped half-way, auditing it once, as by whoever marked it", async () => {
    const owner = await person("builder");
    const admin = await person("admin");
    const store = await storeOf(owner);
    // The owner's deletion marked the object; its inventory batch never
    // ran, and the object's alarm hasn't either.
    await inHost(store.id, async (host) => {
      await host.close(store.id, actorOf(owner));
      await host.ctx.storage.deleteAlarm();
    });

    // An admin deletes it again, and core's batch lands first.
    await deleteStore(env, admin, store.id);
    await expect(openStore(env, store.id)).rejects.toMatchObject({
      code: "data.store_unavailable",
    });
    await expect(deletionsOf(store.id)).resolves.toStrictEqual([
      { type: "person", userId: owner.userId },
    ]);
  });

  it("purges the records on the alarm, keeping only the deletion mark", async () => {
    const owner = await person("builder");
    const store = await storeOf(owner);
    await commitNote(store, owner);
    await commitNote(store, owner);
    // What a record referring to another leaves in the reference index:
    // the purge drains it with the records.
    await runInDurableObject(objectOf(store.id), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO sdk_record_refs (table_id, record_id, to_table_id, to_record_id) VALUES ('t', 'a', 't', 'b')"
      );
    });
    await expireReceipts(store.id);
    await deleteStore(env, owner, store.id);

    // Its alarm, run here rather than waited for (its own may have run).
    await inHost(store.id, async (host) => {
      await host.runAlarm({});
    });
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
        references: state.storage.sql
          .exec("SELECT count(*) AS n FROM sdk_record_refs")
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
      references: 0,
      deleted: 1,
    });
  });

  it("records a deletion core never recorded before purging anything, auditing it once", async () => {
    const owner = await person("builder");
    const store = await storeOf(owner);
    await commitNote(store, owner);
    await expireReceipts(store.id);
    // The object is marked; core's call stops there, and nobody retries.
    await inHost(store.id, async (host) => {
      await host.close(store.id, actorOf(owner));
      await host.ctx.storage.deleteAlarm();
    });
    // Its alarm: run here, in the test's own request, rather than on its
    // own schedule, which the test can't wait for.
    await inHost(store.id, async (host) => {
      await host.runAlarm({});
    });

    const row = await env.DB.prepare(
      "SELECT deleted_at FROM business_stores WHERE id = ?"
    )
      .bind(store.id)
      .first<{ deleted_at: number | null }>();
    expect(row?.deleted_at).not.toBeNull();
    const logged = await allEvents();
    const events = logged.filter(({ target }) => target?.id === store.id);
    expect(
      events.map(({ action, actor }) => ({ action, actor }))
    ).toStrictEqual([
      {
        action: "store.created",
        actor: { type: "person", userId: owner.userId },
      },
      {
        action: "store.deleted",
        actor: { type: "person", userId: owner.userId },
      },
    ]);
    await expect(recordsLeft(store.id)).resolves.toBe(0);
    // Core's own recording, coming late, adds nothing.
    await deleteStore(env, owner, store.id).catch(() => {});
    await expect(eventsOf(store.id)).resolves.toStrictEqual([
      "store.created",
      "store.deleted",
    ]);
  });

  it("audits concurrent deletions once", async () => {
    const owner = await person("builder");
    const admin = await person("admin");
    const store = await storeOf(owner);
    await Promise.allSettled([
      deleteStore(env, owner, store.id),
      deleteStore(env, admin, store.id),
    ]);
    // One event, naming whichever of them marked the store.
    const marked = await runInDurableObject(
      objectOf(store.id),
      (_i, state) =>
        state.storage.sql
          .exec<{ deleted_by: string }>("SELECT deleted_by FROM sdk_store")
          .one().deleted_by
    );
    await expect(deletionsOf(store.id)).resolves.toStrictEqual([
      JSON.parse(marked),
    ]);
  });

  it("purges a page at a time, resuming on the next alarm", async () => {
    const owner = await person("builder");
    const store = await storeOf(owner);
    await Promise.all([
      commitNote(store, owner),
      commitNote(store, owner),
      commitNote(store, owner),
    ]);
    await expireReceipts(store.id);
    // Marked, with its own alarm held off, so the test runs each one.
    await inHost(store.id, async (host) => {
      await host.close(store.id, actorOf(owner));
      await host.ctx.storage.deleteAlarm();
    });

    const left: number[] = [];
    for (let alarm = 0; alarm < 4; alarm += 1) {
      // One alarm after the other, each with no time for a second page.
      // oxlint-disable-next-line no-await-in-loop -- see above
      await inHost(store.id, async (host) => {
        await host.runAlarm({}, {}, { page: 1, budgetMs: 0 });
      });
      // oxlint-disable-next-line no-await-in-loop -- see above
      left.push(await recordsLeft(store.id));
    }
    expect(left).toStrictEqual([2, 1, 0, 0]);
    // Its alarm stays set while anything is left to purge.
    const alarm = await runInDurableObject(
      objectOf(store.id),
      async (_instance, state) => await state.storage.getAlarm()
    );
    expect(alarm).not.toBeNull();
  });

  it("schedules its own alarm, which records the deletion and purges", async () => {
    const owner = await person("builder");
    const store = await storeOf(owner);
    await commitNote(store, owner);
    await expireReceipts(store.id);
    // Marked inside the object; core's batch never runs. Only the alarm
    // the deletion set for itself can finish it.
    await inHost(store.id, async (host) => {
      await host.close(store.id, actorOf(owner));
    });

    await vi.waitFor(
      async () => {
        const row = await env.DB.prepare(
          "SELECT deleted_at FROM business_stores WHERE id = ?"
        )
          .bind(store.id)
          .first<{ deleted_at: number | null }>();
        expect(row?.deleted_at).not.toBeNull();
        await expect(deletionsOf(store.id)).resolves.toHaveLength(1);
        await expect(recordsLeft(store.id)).resolves.toBe(0);
      },
      { timeout: 10_000, interval: 100 }
    );
  });
});
