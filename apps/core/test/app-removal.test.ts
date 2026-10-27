import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { addIntegration } from "../src/app-integrations.ts";
import { removeApp } from "../src/app-removal.ts";
import { updateApp } from "../src/app-settings.ts";
import { appFor } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { deleteStore } from "../src/data-stores.ts";
import { authorize } from "../src/knowledge/app-entries.ts";
import { indexApps } from "../src/knowledge/apps-collection.ts";
import { requestPermission } from "../src/permissions.ts";
import { published, release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Removing an App (app-removal.ts), from its threat model: someone without
// the right removes it; its work outlives it; it is reached afterwards;
// its grants outlive it; it takes with it what it doesn't own (a store,
// its records, its owner claim); a race with a restore; and its removal
// goes unrecorded.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const slow = { timeout: 60_000 };

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/**
 * A new App of `owner`'s, published, shared with `members`, then
 * archived.
 */
const archivedApp = async (
  owner: Person,
  members: { person: Person; role: "user" | "builder" }[] = []
): Promise<string> => {
  const { id } = await owner.api.apps.create({ name: `Desk ${unique()}` });
  await published(id);
  for (const { person, role } of members) {
    // oxlint-disable-next-line no-await-in-loop -- one share at a time
    await owner.api.apps.members.add(id, {
      type: "person",
      id: person.userId,
      role,
    });
  }
  await owner.api.apps.archive(id);
  return id;
};

/** `person` as core's functions take a caller. */
const acting = (
  person: Person,
  role: Role,
  staff = false
): Acting & { email: string; name: string; expiresAt: string } => ({
  userId: person.userId,
  email: `${person.userId}@acme.test`,
  name: "Person",
  role,
  teams: [],
  staff,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

/** A store the App owns, its default store, with its inventory row. */
const ownedStore = async (app: string): Promise<string> => {
  const store = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO business_stores (id, owner_id, physical_namespace_role, created_at) VALUES (?, 'someone', 'data_store', ?)"
    ).bind(store, Date.now()),
    env.DB.prepare(
      "INSERT INTO sdk_store_owners (store_id, app_id, claimed_at) VALUES (?, ?, ?)"
    ).bind(store, app, Date.now()),
    env.DB.prepare(
      "INSERT INTO app_default_stores (app_id, store_id, created_at) VALUES (?, ?, ?)"
    ).bind(app, store, Date.now()),
  ]);
  return store;
};

const rowCount = async (sql: string, ...values: unknown[]) => {
  const row = await env.DB.prepare(sql)
    .bind(...values)
    .first<{ n: number }>();
  return row?.n ?? -1;
};

/** `target`'s `key`, a method bound to it. */
const passOn = (target: object, key: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, key);
  if (typeof value !== "function") {
    return value;
  }
  return (...args: unknown[]): unknown => {
    const answer: unknown = Reflect.apply(value, target, args);
    return answer;
  };
};

/**
 * `db`, but with `meanwhile` run once, right after the first statement
 * whose SQL `at` matches has run: another request's writes landing
 * between two of the removal's own reads and its write.
 */
const interleaved = (
  db: D1Database,
  at: (query: string) => boolean,
  meanwhile: () => Promise<void>
): D1Database => {
  let ran = false;
  const real = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const after = async <T>(query: string, answer: Promise<T>): Promise<T> => {
    const value = await answer;
    if (!ran && at(query)) {
      ran = true;
      await meanwhile();
    }
    return value;
  };
  const wrap = (
    statement: D1PreparedStatement,
    query: string
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get: (target, key) => {
        switch (key) {
          case "bind": {
            return (...values: unknown[]) =>
              wrap(target.bind(...values), query);
          }
          case "first": {
            return async (column?: string) =>
              await after(
                query,
                column === undefined ? target.first() : target.first(column)
              );
          }
          case "all": {
            return async () => await after(query, target.all());
          }
          case "run": {
            return async () => await after(query, target.run());
          }
          case "raw": {
            return async (options?: { columnNames?: boolean }) =>
              await after(
                query,
                options?.columnNames === true
                  ? target.raw({ columnNames: true })
                  : target.raw()
              );
          }
          default: {
            return passOn(target, key);
          }
        }
      },
    });
    real.set(wrapped, statement);
    return wrapped;
  };
  return new Proxy(db, {
    get: (target, key) => {
      if (key === "prepare") {
        return (query: string) => wrap(target.prepare(query), query);
      }
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) =>
          await target.batch(
            statements.map((statement) => real.get(statement) ?? statement)
          );
      }
      return passOn(target, key);
    },
  });
};

/**
 * A stop claimed for an independent run App `app` started, that hasn't
 * ended it yet: what an archive's `stopRunsStartedBy` leaves settling.
 */
const settlingStop = (app: string): D1PreparedStatement[] => {
  const workflow = crypto.randomUUID();
  const run = crypto.randomUUID();
  const now = Date.now();
  return [
    env.DB.prepare(
      "INSERT INTO workflow_resources (id, name, owner_id, created_at) VALUES (?, ?, 'someone', ?)"
    ).bind(workflow, `w-${workflow}`, now),
    env.DB.prepare(
      "INSERT INTO workflow_start_receipts (id, invoker_type, invoker_id, idempotency_key, workflow_resource_id, workflow_resource_version, manifest_hash, principal_id, authority_generation, input_hash, created_at) VALUES (?, 'app', ?, ?, ?, 1, 'm', 'someone', 1, 'i', ?)"
    ).bind(run, app, run, workflow, now),
    env.DB.prepare(
      "INSERT INTO workflow_resource_runs (id, workflow_resource_id, version, manifest_hash, build_hash, principal_id, status, created_at, stop_requested_at) VALUES (?, ?, 1, 'm', 'b', 'someone', 'running', ?, ?)"
    ).bind(run, workflow, now, now),
  ];
};

describe("removing an App", slow, () => {
  it("is for its owner or an admin, never staff, a builder who isn't its owner, or anyone while it isn't archived", async () => {
    const [owner, builder, admin] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("admin"),
    ]);
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();
    const { id: live } = await owner.api.apps.create({
      name: `Live ${unique()}`,
    });
    const archived = await archivedApp(owner, [
      { person: builder, role: "builder" },
    ]);

    expect({
      notArchived: await outcome(owner.api.apps.remove(live)),
      byBuilder: await outcome(builder.api.apps.remove(archived)),
      byStaff: await outcome(staff.apps.remove(archived)),
      byAdmin: await outcome(admin.api.apps.remove(archived)),
    }).toStrictEqual({
      notArchived: "app.remove_unarchived",
      byBuilder: "app.remove_forbidden",
      byStaff: "role.forbidden",
      byAdmin: "ok",
    });
  });

  it("leaves nothing of it to reach, ends its grants and members, keeps its store and the store's owner, and is recorded once", async () => {
    const [owner, user] = await Promise.all([
      personApi("builder"),
      personApi("user"),
    ]);
    const app = await archivedApp(owner, [{ person: user, role: "user" }]);
    const store = await ownedStore(app);
    await env.DB.prepare(
      "INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id, actions, binding, status, requested_by, requested_at, personal) VALUES (?, 'app', ?, 'connection', 'connection-outlook', '[\"mail.list\"]', 'OUTLOOK', 'active', ?, ?, 0)"
    )
      .bind(crypto.randomUUID(), app, owner.userId, Date.now())
      .run();
    const events = await auditedDuring(async () => {
      await owner.api.apps.remove(app);
    });
    const listed = await owner.api.apps.list();

    expect({
      removed: events
        .filter(({ action }) => action === "app.removed")
        .map(({ target }) => target?.id),
      get: await outcome(owner.api.apps.get(app)),
      listed: listed.some(({ id }) => id === app),
      restore: await outcome(owner.api.apps.restore(app)),
      again: await outcome(owner.api.apps.remove(app)),
      members: await rowCount(
        "SELECT count(*) AS n FROM app_members WHERE app_id = ?",
        app
      ),
      activeGrants: await rowCount(
        "SELECT count(*) AS n FROM permissions WHERE subject_type = 'app' AND subject_id = ? AND status <> 'revoked'",
        app
      ),
      store: await rowCount(
        "SELECT count(*) AS n FROM business_stores WHERE id = ? AND deleted_at IS NULL",
        store
      ),
      claim: await rowCount(
        "SELECT count(*) AS n FROM sdk_store_owners WHERE store_id = ? AND app_id = ?",
        store,
        app
      ),
    }).toStrictEqual({
      removed: [app],
      get: "app.not_found",
      listed: false,
      restore: "app.not_found",
      again: "app.not_found",
      members: 0,
      activeGrants: 0,
      store: 1,
      claim: 1,
    });
  });

  it("leaves its default store to the organization's admins, never staff or its owner, so its records are never stuck", async () => {
    const [owner, admin] = await Promise.all([
      personApi("builder"),
      personApi("admin"),
    ]);
    const app = await archivedApp(owner);
    const store = await ownedStore(app);
    await owner.api.apps.remove(app);

    expect({
      byOwner: await outcome(deleteStore(env, acting(owner, "builder"), store)),
      byStaff: await outcome(
        deleteStore(env, acting(admin, "admin", true), store)
      ),
      byAdmin: await outcome(deleteStore(env, acting(admin, "admin"), store)),
    }).toStrictEqual({
      byOwner: "data.store_unavailable",
      byStaff: "role.forbidden",
      byAdmin: "ok",
    });
  });

  it("forgets its entry in the Apps collection: nobody, an admin included, finds its name or AGENTS.md", async () => {
    const [owner, admin] = await Promise.all([
      personApi("builder"),
      personApi("admin"),
    ]);
    const word = `v${crypto.randomUUID().replaceAll("-", "")}`;
    const { id: app } = await owner.api.apps.create({
      name: `Leave ${word}`,
    });
    await release(owner, app, {
      "AGENTS.md": `# How we approve leave\n\nEvery ${word} request goes to the team lead.\n`,
    });
    await indexApps(env);
    const found = async () => {
      const { hits } = await admin.api.knowledge.search(word);
      return hits.filter(({ collectionId }) => collectionId === "apps").length;
    };
    const before = await found();
    await owner.api.apps.archive(app);
    await owner.api.apps.remove(app);
    // The cron's indexing never writes it back.
    await indexApps(env);
    const entry = await env.KNOWLEDGE.prepare(
      "SELECT count(*) AS n FROM documents WHERE collection_id = 'apps' AND path = ?"
    )
      .bind(`${app}/AGENTS.md`)
      .first<{ n: number }>();
    const readable = await authorize(env, {
      type: "person",
      person: acting(admin, "admin"),
    });

    expect({
      before,
      after: await found(),
      kept: entry?.n,
      listedToAdmin: readable.only?.apps?.includes(`${app}/AGENTS.md`) ?? true,
    }).toStrictEqual({
      before: 1,
      after: 0,
      // A tombstone stays, read by nobody.
      kept: 1,
      listedToAdmin: false,
    });
  });

  it("has its entry forgotten by the cron's indexing when forgetting it failed at removal", async () => {
    const owner = await personApi("builder");
    const word = `v${crypto.randomUUID().replaceAll("-", "")}`;
    const { id: app } = await owner.api.apps.create({
      name: `Leave ${word}`,
    });
    await release(owner, app, { "AGENTS.md": `# Leave\n\n${word}\n` });
    await indexApps(env);
    // Removed, as if its entry's forgetting had failed: its note is left.
    await env.DB.prepare(
      "UPDATE apps SET status = 'archived', removed_at = ?, removed_by = ?, current_version = NULL WHERE id = ?"
    )
      .bind(Date.now(), owner.userId, app)
      .run();
    await indexApps(env);
    const note = await rowCount(
      "SELECT count(*) AS n FROM app_entries WHERE app_id = ?",
      app
    );
    const text = await env.KNOWLEDGE.prepare(
      "SELECT count(*) AS n FROM documents WHERE collection_id = 'apps' AND path = ? AND current_version > 1"
    )
      .bind(`${app}/AGENTS.md`)
      .first<{ n: number }>();

    // Its note gone only once its entry is the tombstone, a version later.
    expect({ note, tombstoned: text?.n }).toStrictEqual({
      note: 0,
      tombstoned: 1,
    });
  });

  it("has its entry forgotten by the cron's indexing when neither its note nor its forgetting was written", async () => {
    const owner = await personApi("builder");
    const word = `v${crypto.randomUUID().replaceAll("-", "")}`;
    const { id: app } = await owner.api.apps.create({
      name: `Leave ${word}`,
    });
    await release(owner, app, { "AGENTS.md": `# Leave\n\n${word}\n` });
    await indexApps(env);
    const versionOf = async () => {
      const row = await env.KNOWLEDGE.prepare(
        "SELECT current_version AS v FROM documents WHERE collection_id = 'apps' AND path = ?"
      )
        .bind(`${app}/AGENTS.md`)
        .first<{ v: number }>();
      return row?.v ?? 0;
    };
    const indexed = await versionOf();
    // Its entry saved but never noted, then removed with its forgetting
    // failed: nothing in core names the entry.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM app_entries WHERE app_id = ?").bind(app),
      env.DB.prepare(
        "UPDATE apps SET status = 'archived', removed_at = ?, removed_by = ?, current_version = NULL WHERE id = ?"
      ).bind(Date.now(), owner.userId, app),
    ]);
    await indexApps(env);
    const tombstoned = await versionOf();
    // Forgotten once: later runs write no further version of it.
    await indexApps(env);

    expect({
      indexed,
      tombstoned: tombstoned - indexed,
      again: (await versionOf()) - indexed,
    }).toStrictEqual({ indexed: 1, tombstoned: 1, again: 1 });
  });

  it("is never undone by a restore racing it: one of the two wins, and a removed App stays removed", async () => {
    const owner = await personApi("builder");
    const apps = await Promise.all(
      [1, 2, 3].map(async () => await archivedApp(owner))
    );
    const outcomes: { app: string; restored: unknown; removed: unknown }[] = [];
    const events = await auditedDuring(async () => {
      await Promise.all(
        apps.map(async (app) => {
          // Both read it archived; whichever writes second is refused.
          const [restored, removed] = await Promise.all([
            outcome(owner.api.apps.restore(app)),
            outcome(owner.api.apps.remove(app)),
          ]);
          outcomes.push({ app, restored, removed });
        })
      );
    });
    const raced = await Promise.all(
      outcomes.map(async ({ app, restored, removed }) => {
        const row = await env.DB.prepare(
          "SELECT status, removed_at IS NOT NULL AS removed FROM apps WHERE id = ?"
        )
          .bind(app)
          .first<{ status: string; removed: number }>();
        const recorded = events
          .filter(({ target }) => target?.id === app)
          .map(({ action }) => action)
          .filter(
            (action) => action === "app.restored" || action === "app.removed"
          );
        return {
          oneWon: (restored === "ok") !== (removed === "ok"),
          stored:
            removed === "ok"
              ? row?.status === "archived" && row.removed === 1
              : row?.status === "draft" && row.removed === 0,
          recorded:
            recorded.length === 1 &&
            recorded[0] === (removed === "ok" ? "app.removed" : "app.restored"),
        };
      })
    );

    expect(raced).toStrictEqual(
      Array.from({ length: 3 }, () => ({
        oneWon: true,
        stored: true,
        recorded: true,
      }))
    );
  });

  it("waits for the stops of the archive it writes over, however the App changed between its checks", async () => {
    const owner = await personApi("builder");
    const [sameArchive, newerArchive] = await Promise.all([
      archivedApp(owner),
      archivedApp(owner),
    ]);
    // Right after the removal found no stop settling: a stop claimed for
    // the same archive; or a restore, new work, and another archive,
    // whose stop is settling.
    const removedWith = async (app: string, meanwhile: D1PreparedStatement[]) =>
      await outcome(
        removeApp(
          {
            ...env,
            DB: interleaved(
              env.DB,
              (query) => query.includes("stop_requested_at"),
              async () => {
                await env.DB.batch(meanwhile);
              }
            ),
          },
          acting(owner, "builder"),
          app
        )
      );
    const events = await auditedDuring(async () => {
      await removedWith(sameArchive, settlingStop(sameArchive));
      await removedWith(newerArchive, [
        env.DB.prepare(
          "UPDATE apps SET status_changed_at = status_changed_at + 60000 WHERE id = ?"
        ).bind(newerArchive),
        ...settlingStop(newerArchive),
      ]);
    });
    const removed = await rowCount(
      "SELECT count(*) AS n FROM apps WHERE id IN (?, ?) AND removed_at IS NOT NULL",
      sameArchive,
      newerArchive
    );

    expect({
      removed,
      recorded: events.filter(({ action }) => action === "app.removed").length,
      // Asked again, it is refused up front, its stop still settling.
      again: await outcome(owner.api.apps.remove(sameArchive)),
    }).toStrictEqual({ removed: 0, recorded: 0, again: "app.stops_pending" });
  });

  it("takes no change that read the App before it was removed: no new name, no integration", async () => {
    const owner = await personApi("builder");
    const [renamed, integrated] = await Promise.all([
      archivedApp(owner),
      archivedApp(owner),
    ]);
    // Removed right after the change first read the App.
    const removedMeanwhile = (app: string): Env => ({
      ...env,
      DB: interleaved(
        env.DB,
        (query) => query.includes('"apps"'),
        async () => {
          await env.DB.prepare(
            "UPDATE apps SET removed_at = ?, removed_by = ?, current_version = NULL WHERE id = ?"
          )
            .bind(Date.now(), owner.userId, app)
            .run();
        }
      ),
    });
    const events = await auditedDuring(async () => {
      await outcome(
        updateApp(
          removedMeanwhile(renamed),
          acting(owner, "builder"),
          renamed,
          {
            name: "Renamed after removal",
          }
        )
      );
      await outcome(
        addIntegration(
          removedMeanwhile(integrated),
          acting(owner, "builder"),
          integrated,
          { source: "native", id: "slack" }
        )
      );
    });

    expect({
      name: await rowCount(
        "SELECT count(*) AS n FROM apps WHERE id = ? AND name = 'Renamed after removal'",
        renamed
      ),
      integrations: await rowCount(
        "SELECT count(*) AS n FROM app_integrations WHERE app_id = ?",
        integrated
      ),
      recorded: events.map(({ action }) => action),
    }).toStrictEqual({ name: 0, integrations: 0, recorded: [] });
  });

  it("takes no permission request that read the App before it was removed, and the database refuses any other write that would, but to what it is", async () => {
    const owner = await personApi("builder");
    const [app, other] = await Promise.all([
      archivedApp(owner),
      owner.api.apps.create({ name: `Other ${unique()}` }),
    ]);
    const by = acting(owner, "builder");
    // Removed right after the request first read the App.
    const racing = {
      ...env,
      DB: interleaved(
        env.DB,
        (query) => query.includes('"apps"'),
        async () => {
          await env.DB.prepare(
            "UPDATE apps SET removed_at = ?, removed_by = ?, current_version = NULL WHERE id = ?"
          )
            .bind(Date.now(), owner.userId, app)
            .run();
        }
      ),
    };
    const requested = await outcome(
      requestPermission(
        racing,
        by,
        {
          subject: { type: "app", appId: app },
          object: { type: "app", appId: other.id },
          actions: ["read"],
          binding: "OTHER",
        },
        {
          app: async (id, role) => await appFor(env, by, id, role),
          resource: () => {
            throw new Error("Only Apps are named here");
          },
        }
      )
    );
    // Whatever writes next, the database itself refuses it.
    const direct = await outcome(
      env.DB.prepare(
        "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
      )
        .bind(app, owner.userId, owner.userId, Date.now())
        .run()
    );
    const restored = await outcome(
      env.DB.prepare("UPDATE apps SET status = 'draft' WHERE id = ?")
        .bind(app)
        .run()
    );

    // What it is stays open, for erasure, retention and migrations.
    const renamed = await outcome(
      env.DB.prepare("UPDATE apps SET name = 'Erased' WHERE id = ?")
        .bind(app)
        .run()
    );

    expect({
      renamed,
      requested,
      requests: await rowCount(
        "SELECT count(*) AS n FROM permissions WHERE subject_type = 'app' AND subject_id = ?",
        app
      ),
      direct: direct === "ok",
      restored: restored === "ok",
      status: await env.DB.prepare("SELECT status FROM apps WHERE id = ?")
        .bind(app)
        .first("status"),
    }).toStrictEqual({
      renamed: "ok",
      requested: "app.not_found",
      requests: 0,
      direct: false,
      restored: false,
      status: "archived",
    });
  });

  it("changes nothing when a restore lands first", async () => {
    const owner = await personApi("builder");
    const app = await archivedApp(owner);
    // The restore wins; the App is a draft again, and stays.
    await owner.api.apps.restore(app);
    const events = await auditedDuring(async () => {
      await outcome(owner.api.apps.remove(app));
    });

    const kept = await owner.api.apps.get(app);

    expect({
      refused: await outcome(owner.api.apps.remove(app)),
      recorded: events.filter(({ action }) => action === "app.removed").length,
      status: kept.status,
    }).toStrictEqual({
      refused: "app.remove_unarchived",
      recorded: 0,
      status: "draft",
    });
  });
});
