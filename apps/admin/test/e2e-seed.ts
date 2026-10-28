import type { ReleaseManifest } from "@grasp-os/shared/release";
/**
 * What the browser journeys' admin starts from (e2e/admin-rollout.e2e.ts),
 * made as the admin's tests make it: its database migrated, its Secrets
 * Store filled as deploy-ops fills it, and a client in ring 0, on its own
 * account in the fake Cloudflare API, running a release a deploy made live,
 * with a newer release imported to roll out.
 */
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { act, adminDatabase } from "../src/db/act.ts";
import { clients, releases } from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { saveDestination } from "../src/hosting/inventory.ts";
import { importReleases } from "../src/releases/import.ts";
import type { fakeCloudflareApi } from "./cloudflare-api.ts";
import { evidence, verified } from "./hosting.ts";
import { buildRelease, publishRelease, putBlobs } from "./releases.ts";
import { adminOf, adminSecrets } from "./secrets-store-admin.ts";

/** What a seed made, for the journeys to find on the admin's pages. */
export interface Seeded {
  clientId: string;
  /** The newest release, which it doesn't run yet. */
  releaseId: string;
}

/** The admin's migrations, as drizzle-kit writes them (src/db/migrations). */
const migrations = import.meta.glob<string>("../src/db/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * Applies the admin's migrations not applied yet, each recorded in
 * `d1_migrations` as `wrangler d1 migrations apply` records it.
 */
const migrate = async (database: D1Database): Promise<void> => {
  await database.exec(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  );
  const { results } = await database
    .prepare("SELECT name FROM d1_migrations")
    .all<{ name: string }>();
  const applied = new Set(results.map(({ name }) => name));
  const files = Object.entries(migrations)
    .map(([path, sql]) => ({
      name: path.slice(path.lastIndexOf("/") + 1),
      sql,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  for (const { name, sql } of files.filter((file) => !applied.has(file.name))) {
    const statements = sql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement !== "");
    // oxlint-disable-next-line no-await-in-loop -- in order, each in one batch
    await database.batch([
      ...statements.map((statement) => database.prepare(statement)),
      database
        .prepare("INSERT INTO d1_migrations (name) VALUES (?)")
        .bind(name),
    ]);
  }
};

/** Puts every secret the admin reads in its store, unless it's there. */
const fillStore = async (tokens: {
  deployer: string;
  tenant: string;
}): Promise<void> => {
  for (const [binding, value] of adminSecrets(tokens)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      await binding.get();
    } catch {
      // Not in the store yet: a store's secret reads only once it's there.
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      const admin = await adminOf(binding);
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      await admin.create(value);
    }
  }
};

const staff = { email: "staff@grasp.test", sub: "" };

/**
 * Seeds the admin: a new client in ring 0 on the fake's new account,
 * running a release a deploy made live, and a newer release. Every client
 * an earlier seed made is offboarded, so a journey tried again reaches
 * only its own.
 */
export const seed = async (
  cloudflare: ReturnType<typeof fakeCloudflareApi>,
  tokens: { deployer: string; tenant: string }
): Promise<Seeded> => {
  await migrate(env.DB);
  await fillStore(tokens);
  const db = adminDatabase(env.DB);
  await db
    .update(clients)
    .set({ status: "offboarded" })
    .where(eq(clients.status, "active"));
  const previous = await publishRelease({ notes: "feat(core): what runs" });
  await importReleases(env.RELEASES, db);
  const account = cloudflare.addAccount();
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name: clientId,
        accountId: account.id,
        ring: 0,
        status: "active",
        signIn: JSON.stringify({
          domains: ["acme.test"],
          admins: ["ada@acme.test"],
          googleHostedDomain: "acme.test",
        }),
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  await runDeploy(
    await deployContext(env),
    await startDeploy(db, staff, clientId, previous.id)
  );
  const next = await publishRelease({
    notes: "feat(core): roll out",
    core: "export default { core: 2 };",
    connect: "export default { connect: 2 };",
  });
  await importReleases(env.RELEASES, db);
  return { clientId, releaseId: next.id };
};

/** What a placed seed made, for the placed-client journey to choose on the admin's pages. */
export interface SeededPlaced {
  /** A dedicated destination on a new account in the fake, every requirement verified. */
  destinationId: string;
  /** Two releases a placed client runs, oldest first. */
  releaseIds: [string, string];
}

/**
 * A release a placed client runs, imported as the admin imports one:
 * core's own Durable Object classes, and none of the Workflows binding a
 * placed client has no resource for (as test/client-provision-operation
 * imports one), built `builtAt`.
 */
const placedRelease = async (
  notes: string,
  core: string,
  builtAt: Date
): Promise<string> => {
  const built = await buildRelease({
    notes,
    core,
    connect: core.replace("core", "connect"),
  });
  const { core: worker } = built.manifest.workers;
  if (worker === undefined) {
    throw new Error("The seed's release has no core");
  }
  const manifest: ReleaseManifest = {
    ...built.manifest,
    workers: {
      ...built.manifest.workers,
      core: {
        ...worker,
        durableObjectMigrations: [
          { tag: "v1", new_sqlite_classes: ["Workspace", "AuditLog"] },
        ],
        bindings: worker.bindings.filter(({ type }) => type !== "workflow"),
      },
    },
  };
  await putBlobs(built);
  await adminDatabase(env.DB)
    .insert(releases)
    .values({
      id: manifest.releaseId,
      commitSha: manifest.commit,
      manifest: JSON.stringify(manifest),
      manifestSha256: "0".repeat(64),
      builtAt,
      importedAt: builtAt,
    });
  return manifest.releaseId;
};

/**
 * Seeds the admin for the placed-client journey: a dedicated destination
 * on the fake's new account, and two releases a placed client runs. The
 * journey adds the client itself, as staff do.
 */
export const seedPlaced = async (
  cloudflare: ReturnType<typeof fakeCloudflareApi>,
  tokens: { deployer: string; tenant: string }
): Promise<SeededPlaced> => {
  await migrate(env.DB);
  await fillStore(tokens);
  const account = cloudflare.addAccount();
  const destinationId = `dedicated-${crypto.randomUUID().slice(0, 8)}`;
  await saveDestination(adminDatabase(env.DB), staff, {
    id: destinationId,
    kind: "dedicated",
    accountId: account.id,
    namespace: null,
    policies: ["eu-storage"],
    capabilities: verified({}, evidence),
  });
  const now = Date.now();
  const first = await placedRelease(
    "feat(core): what it starts on",
    "export default { core: 1 };",
    new Date(now - 60_000)
  );
  const second = await placedRelease(
    "feat(core): what it's released to",
    "export default { core: 2 };",
    new Date(now)
  );
  return { destinationId, releaseIds: [first, second] };
};
