/**
 * What the browser journeys' console starts from (e2e/console-rollout.e2e.ts),
 * made as the console's tests make it: its database migrated, its Secrets
 * Store filled as deploy-ops fills it, and a client in ring 0, on its own
 * account in the fake Cloudflare API, running a release a deploy made live,
 * with a newer release imported to roll out.
 */
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { act, consoleDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { importReleases } from "../src/releases/import.ts";
import type { fakeCloudflareApi } from "./cloudflare-api.ts";
import { publishRelease } from "./releases.ts";
import { adminOf, consoleSecrets } from "./secrets-store-admin.ts";

/** What a seed made, for the journeys to find on the console's pages. */
export interface Seeded {
  clientId: string;
  /** The newest release, which it doesn't run yet. */
  releaseId: string;
}

/** The console's migrations, as drizzle-kit writes them (src/db/migrations). */
const migrations = import.meta.glob<string>("../src/db/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * Applies the console's migrations not applied yet, each recorded in
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

/** Puts every secret the console reads in its store, unless it's there. */
const fillStore = async (tokens: {
  deployer: string;
  tenant: string;
}): Promise<void> => {
  for (const [binding, value] of consoleSecrets(tokens)) {
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
 * Seeds the console: a new client in ring 0 on the fake's new account,
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
  const db = consoleDatabase(env.DB);
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
