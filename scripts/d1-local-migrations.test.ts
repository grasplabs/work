/**
 * The local stack's migration step (d1-local-migrations.ts), on a small
 * database through the repo's own Wrangler, in the environment the e2e
 * stack starts it in (playwright.config.ts): Wrangler's console at
 * warnings only, its log in a folder nothing made yet.
 */
import { execFileSync, spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { cleanUp, tempDir } from "./workerd-test-server.ts";

const script = path.join(import.meta.dirname, "d1-local-migrations.ts");

/** A Worker config binding one database with two migrations. */
const wranglerConfig = (): string => {
  const dir = tempDir();
  const migrations = path.join(dir, "migrations");
  mkdirSync(migrations);
  writeFileSync(
    path.join(migrations, "0000_notes.sql"),
    "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);"
  );
  writeFileSync(
    path.join(migrations, "0001_note_author.sql"),
    "ALTER TABLE notes ADD COLUMN author TEXT;"
  );
  const config = path.join(dir, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "d1-local-migrations-test",
      compatibility_date: "2026-11-01",
      d1_databases: [
        {
          binding: "DB",
          database_name: "test",
          database_id: "00000000-0000-0000-0000-000000000000",
          migrations_dir: "migrations",
        },
      ],
    })
  );
  return config;
};

const binaries = path.join(import.meta.dirname, "../node_modules/.bin");

/** The environment the e2e stack starts the step in, Wrangler's on the path. */
const stackEnv = (logDir: string): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: `${binaries}${path.delimiter}${process.env.PATH ?? ""}`,
  WRANGLER_LOG: "warn",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_LOG_PATH: path.join(logDir, "missing", "wrangler.log"),
});

const migrate = (
  config: string,
  persistTo: string,
  logDir: string
): SpawnSyncReturns<string> =>
  spawnSync("node", [script, "--persist-to", persistTo, "-c", config], {
    encoding: "utf-8",
    env: stackEnv(logDir),
  });

describe("d1-local-migrations", () => {
  afterEach(cleanUp);

  it("applies a database's pending migrations once, under a quiet Wrangler log", () => {
    const config = wranglerConfig();
    const persistTo = path.join(tempDir(), "state");
    const logDir = tempDir();

    expect(migrate(config, persistTo, logDir)).toMatchObject({
      status: 0,
      stdout: `${config} DB: 2 migrations applied, 0 already were\n`,
    });
    expect(migrate(config, persistTo, logDir)).toMatchObject({
      status: 0,
      stdout: `${config} DB: 0 migrations applied, 2 already were\n`,
    });
  }, 60_000);

  it("fails with the database, its config and Wrangler's reason when reading what is applied fails", () => {
    const config = wranglerConfig();
    const persistTo = path.join(tempDir(), "state");
    const logDir = tempDir();
    // A table of applied migrations that isn't Wrangler's: no `name`.
    execFileSync(
      path.join(binaries, "wrangler"),
      [
        "d1",
        "execute",
        "DB",
        "--local",
        "-c",
        config,
        "--persist-to",
        persistTo,
        "--command",
        'CREATE TABLE "d1_migrations" (id INTEGER);',
      ],
      { env: stackEnv(logDir), stdio: "ignore" }
    );

    const { status, stderr } = migrate(config, persistTo, logDir);

    expect(status).not.toBe(0);
    expect(stderr).toContain(`wrangler d1 execute failed for DB (${config})`);
    expect(stderr).toContain("no such column: name");
  }, 60_000);
});
