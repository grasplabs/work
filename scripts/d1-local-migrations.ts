/**
 * Applies the local D1 migrations of Wrangler configs to a persisted dev
 * state, as `wrangler d1 migrations apply --local` would, in one batch per
 * database:
 *
 *   node ../../scripts/d1-local-migrations.ts --persist-to <dir> -c wrangler.jsonc -c ../connect/wrangler.jsonc
 *
 * Wrangler starts its local runtime once for every migration file it
 * applies. With core at 136 files that took a minute of the local stack's
 * start (`vp run dev`, and the e2e stack, whose start Playwright gives two
 * minutes). Here each database costs two Wrangler runs, whatever its
 * number of migrations: one reads what is applied, one applies the rest.
 *
 * Each pending migration goes in as Wrangler's own query for it, its file
 * then its row in `d1_migrations`, in Wrangler's order, so Wrangler reads
 * the result as its own and `wrangler d1 migrations apply` still works on
 * the same state.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { d1DatabasesOf, d1MigrationFiles } from "./workerd-d1.ts";

/** Wrangler's table of applied migrations, as Wrangler creates it. */
const createMigrationsTable = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

/** What `wrangler d1 execute --json` answers: each statement's rows. */
const executeAnswerSchema = z.array(
  z.object({ results: z.array(z.record(z.string(), z.unknown())) })
);

/** One migration as Wrangler applies it: its file, then its row. */
export const migrationQuery = (name: string, sql: string): string =>
  `${sql}\nINSERT INTO "d1_migrations" (name)\nvalues ('${name.replaceAll("'", "''")}');`;

/** The `--config` and `--persist-to` arguments, as given. */
const argumentsOf = (
  args: readonly string[]
): { configs: string[]; persistTo: string } => {
  const configs: string[] = [];
  let persistTo: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const [name, value] = [args[index], args[index + 1]];
    if ((name === "-c" || name === "--config") && value !== undefined) {
      configs.push(value);
      index += 1;
    } else if (name === "--persist-to" && value !== undefined) {
      persistTo = value;
      index += 1;
    } else {
      throw new Error(`Unexpected argument: ${name}`);
    }
  }
  if (configs.length === 0 || persistTo === undefined) {
    throw new Error(
      "Usage: node scripts/d1-local-migrations.ts --persist-to <dir> -c <wrangler.jsonc> [-c …]"
    );
  }
  return { configs, persistTo };
};

/** Runs `wrangler d1 execute` on the local state, and returns its output. */
const execute = (
  config: string,
  persistTo: string,
  binding: string,
  args: readonly string[]
): string =>
  execFileSync(
    "wrangler",
    [
      "d1",
      "execute",
      binding,
      "--local",
      "-c",
      config,
      "--persist-to",
      persistTo,
      ...args,
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] }
  );

const main = (): void => {
  const { configs, persistTo } = argumentsOf(process.argv.slice(2));
  const scratch = mkdtempSync(path.join(tmpdir(), "d1-migrations-"));
  try {
    for (const config of configs) {
      for (const { binding, migrationsDir } of d1DatabasesOf(config)) {
        const answer = executeAnswerSchema.parse(
          JSON.parse(
            execute(config, persistTo, binding, [
              "--json",
              "--command",
              `${createMigrationsTable} SELECT name FROM "d1_migrations";`,
            ])
          )
        );
        const applied = new Set(
          answer.flatMap(({ results }) =>
            results.flatMap(({ name }) =>
              typeof name === "string" ? [name] : []
            )
          )
        );
        const pending = d1MigrationFiles(migrationsDir).filter(
          (name) => !applied.has(name)
        );
        if (pending.length > 0) {
          const file = path.join(scratch, `${binding}.sql`);
          writeFileSync(
            file,
            pending
              .map((name) =>
                migrationQuery(
                  name,
                  readFileSync(path.join(migrationsDir, name), "utf-8")
                )
              )
              .join("\n")
          );
          execute(config, persistTo, binding, ["--file", file, "--yes"]);
        }
        process.stdout.write(
          `${config} ${binding}: ${pending.length} migrations applied, ${applied.size} already were\n`
        );
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  main();
}
