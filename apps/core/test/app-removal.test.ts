import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { deleteStore } from "../src/data-stores.ts";
import { authorize } from "../src/knowledge/app-entries.ts";
import { indexApps } from "../src/knowledge/apps-collection.ts";
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
