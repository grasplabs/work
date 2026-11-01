import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { signInApps } from "../src/deploy/context.ts";
import { derivedCoreConfig } from "../src/deploy/core-config.ts";
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

  it("drop every client's saved settings with their table, so a client that had them still deploys with only what the admin derives", async () => {
    const db = migrationDb();
    const { before, it: dropSettings } = upTo("0044_drop_client_settings.sql");
    await applyD1Migrations(db, before);
    const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
    const signIn = JSON.stringify({
      domains: ["acme.test"],
      admins: ["ada@acme.test"],
      googleHostedDomain: "acme.test",
    });
    const now = Date.now();
    // A row for each var no deploy sets any more, and one that would have
    // replaced the derived sign-in.
    const saved = {
      QUOTA_LIMITS: { generation: 1, limits: { workflowSteps: 10 } },
      MODEL_GATEWAY: { eu: { models: ["openai/gpt-5"], deployment: true } },
      MEMORY_LIMITS: { "USER.md": 10 },
      AUDIT_RETENTION_DAYS: 90,
      AUDIT_ARCHIVE_RETENTION_DAYS: 400,
      RUN_RETENTION_DAYS: 7,
      INBOUND_MAIL_DOMAIN: "mail.acme.test",
      SIGN_IN: { domains: ["elsewhere.test"] },
    };
    await db.batch([
      db
        .prepare(
          "INSERT INTO clients (id, name, ring, sign_in, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)"
        )
        .bind(clientId, clientId, signIn, now, now),
      ...Object.entries(saved).map(([key, value]) =>
        db
          .prepare(
            "INSERT INTO settings (client_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, 'staff@grasp.test', ?)"
          )
          .bind(clientId, key, JSON.stringify(value), now)
      ),
    ]);

    await applyD1Migrations(db, [dropSettings]);
    const domain = "grasp.test";
    const derived = derivedCoreConfig({
      clientId,
      signIn,
      domain,
      apps: signInApps(env),
    });
    const change = {
      by: "staff@grasp.test",
      what: "release",
      release: "26.01.100000001",
      at: new Date(now).toISOString(),
    } as const;
    const vars = configuredCoreVars(clientId, derived, change);
    const tables = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'"
      )
      .all();

    expect({
      names: Object.keys(vars).toSorted(),
      signIn: vars.SIGN_IN,
      table: tables.results,
    }).toStrictEqual({
      names: [
        "CLIENT_ID",
        "MAIL_FROM",
        "PLATFORM_CHANGE",
        "RUNTIME_PROFILE",
        "SIGN_IN",
      ],
      signIn: derived.SIGN_IN,
      table: [],
    });
  });
});
