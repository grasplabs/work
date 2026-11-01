import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { clients, settings } from "../src/db/schema.ts";
import { signInApps } from "../src/deploy/context.ts";
import {
  derivedCoreConfig,
  onboardingSender,
} from "../src/deploy/core-config.ts";
import { configuredCoreVars } from "../src/deploy/core-vars.ts";

// The admin's migrations on a database with rows in it, as staging's and
// production's have, rather than the empty one every other test starts
// from: each brought up to the migration before, seeded, then migrated.

const isMigrationList = (value: unknown): value is D1Migration[] =>
  Array.isArray(value) &&
  value.every(
    (migration: unknown) =>
      typeof migration === "object" &&
      migration !== null &&
      "name" in migration &&
      typeof migration.name === "string"
  );

const migrations: unknown = Reflect.get(env, "ADMIN_MIGRATIONS");
const database: unknown = Reflect.get(env, "MIGRATION_D1");

const isDatabase = (value: unknown): value is D1Database =>
  typeof value === "object" &&
  value !== null &&
  "prepare" in value &&
  "batch" in value;

/** The empty database the test pool binds for this file alone. */
const migrationDb = (): D1Database => {
  if (!isDatabase(database)) {
    throw new TypeError("Expected MIGRATION_D1, a D1 database");
  }
  return database;
};

/** The migrations before `name`, and `name` itself. */
const upTo = (name: string): { before: D1Migration[]; it: D1Migration } => {
  if (!isMigrationList(migrations)) {
    throw new TypeError("Expected the admin's migrations as ADMIN_MIGRATIONS");
  }
  const at = migrations.findIndex((migration) => migration.name === name);
  const found = migrations[at];
  if (found === undefined) {
    throw new Error(`No migration ${name}`);
  }
  return { before: migrations.slice(0, at), it: found };
};

describe("the admin's migrations, on rows", () => {
  it("make clients' accounts optional and drop the removed Workflow's claims, keeping every client and what refers to it", async () => {
    const db = migrationDb();
    const { before, it: clientsAsPlacements } = upTo(
      "0028_clients_as_placements.sql"
    );
    await applyD1Migrations(db, before);
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          "INSERT INTO clients (id, name, account_id, created_at, updated_at) VALUES ('acme', 'Acme', 'acct-acme', ?1, ?1), ('beta', 'Beta', 'acct-beta', ?1, ?1)"
        )
        .bind(now),
      db
        .prepare(
          "INSERT INTO client_workers (client_id, worker, script_name, deployed_at) VALUES ('acme', 'core', 'grasp-os-core', ?1)"
        )
        .bind(now),
      db
        .prepare(
          "INSERT INTO client_runs (client_id, run_id, kind, claimed_at) VALUES ('acme', 'acme-run', 'provision', ?1), ('beta', 'rollout-1', 'rollout', ?1)"
        )
        .bind(now),
    ]);

    await applyD1Migrations(db, [clientsAsPlacements]);
    // Added since: no account of its own.
    await db
      .prepare(
        "INSERT INTO clients (id, name, created_at, updated_at) VALUES ('gamma', 'Gamma', ?1, ?1)"
      )
      .bind(now)
      .run();

    const read = async (query: string) => {
      const { results } = await db.prepare(query).all();
      return results;
    };
    expect({
      clients: await read("SELECT id, account_id FROM clients ORDER BY id"),
      workers: await read("SELECT client_id, script_name FROM client_workers"),
      runs: await read(
        "SELECT client_id, kind FROM client_runs ORDER BY client_id"
      ),
      dangling: await read("PRAGMA foreign_key_check"),
    }).toStrictEqual({
      clients: [
        { id: "acme", account_id: "acct-acme" },
        { id: "beta", account_id: "acct-beta" },
        { id: "gamma", account_id: null },
      ],
      workers: [{ client_id: "acme", script_name: "grasp-os-core" }],
      runs: [{ client_id: "beta", kind: "rollout" }],
      dangling: [],
    });
  });

  it("drop a client's saved PLATFORM_AI setting with the setting itself, so its next deploy takes the rest", async () => {
    const db = migrationDb();
    const { before, it: dropPlatformAi } = upTo("0043_drop_platform_ai.sql");
    await applyD1Migrations(db, before);
    const orm = drizzle(db);
    const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
    const signIn = JSON.stringify({
      domains: ["acme.test"],
      admins: ["ada@acme.test"],
      googleHostedDomain: "acme.test",
    });
    const now = new Date();
    await orm.insert(clients).values({
      id: clientId,
      name: clientId,
      ring: 0,
      signIn,
      createdAt: now,
      updatedAt: now,
    });
    await orm.insert(settings).values(
      [
        ["PLATFORM_AI", JSON.stringify({ conversion: { provider: "local" } })],
        ["AUDIT_RETENTION_DAYS", JSON.stringify(90)],
      ].map(([key, value]) => ({
        clientId,
        key: key ?? "",
        value: value ?? "",
        updatedBy: "staff@grasp.test",
        updatedAt: now,
      }))
    );

    await applyD1Migrations(db, [dropPlatformAi]);
    const domain = "grasp.test";
    const vars = await configuredCoreVars(
      orm,
      clientId,
      derivedCoreConfig({
        clientId,
        signIn,
        domain,
        apps: signInApps(env),
      }),
      {
        by: "staff@grasp.test",
        what: "release",
        release: "26.01.100000001",
        at: now.toISOString(),
      },
      onboardingSender(clientId, domain).address
    );

    expect({
      platformAi: "PLATFORM_AI" in vars,
      kept: vars.AUDIT_RETENTION_DAYS,
    }).toStrictEqual({ platformAi: false, kept: 90 });
  });
});
