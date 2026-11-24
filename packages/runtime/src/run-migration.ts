import { inspectApp } from "./app.ts";
import { deterministically } from "./determinism.ts";
import { isThenable } from "./lockdown.ts";
import { migrationHandler, promiseMessage } from "./migration.ts";
import type { MigrationContext } from "./migration.ts";

/** One row a migration transforms: its record's ID and fields. */
export interface MigrationRow {
  readonly id: string;
  readonly fields: unknown;
}

/** What the host asks of a migration: its name and a batch of rows. */
interface MigrationRequest {
  readonly name: string;
  readonly rows: readonly MigrationRow[];
}

/**
 * What a batch answered: each row's output, in order, or the row whose
 * handler threw, and what it said. The host reads all of it as hostile.
 */
type MigrationAnswer =
  | { readonly ok: true; readonly rows: readonly unknown[] }
  | { readonly ok: false; readonly index: number; readonly message: string };

/** The longest message of a handler's failure a batch answers. */
const failureMaxLength = 500;

/** The message of what a handler threw, bounded. */
const messageOf = (error: unknown): string => {
  try {
    const message: unknown = error instanceof Error ? error.message : undefined;
    return typeof message === "string"
      ? message.slice(0, failureMaxLength)
      : "The handler threw";
  } catch {
    return "The handler threw";
  }
};

/**
 * `output` as JSON data, serialized here, inside the deterministic window,
 * so a `toJSON` App code put on it runs without randomness or clocks too.
 * `undefined` (what JSON can't hold) answers null, for the host to refuse.
 */
const asJson = (output: unknown): unknown => {
  const text = JSON.stringify(output);
  if (text === undefined) {
    return null;
  }
  const json: unknown = JSON.parse(text);
  return json;
};

/**
 * Runs migration `request.name` of `registered` (an App `app` made) on
 * `request.rows`, one at a time, in order, deterministically: each row's
 * output, or the first row whose handler threw or answered a promise (the
 * first row when the clock or randomness couldn't be taken away). The
 * host validated each row before and validates each output after, so the
 * runner validates neither.
 */
export const runMigration = (
  registered: unknown,
  request: MigrationRequest
): MigrationAnswer => {
  const declared = inspectApp(registered).migrations.get(request.name);
  if (declared === undefined) {
    throw Object.assign(new Error("There is no such migration."), {
      code: "migration.not_found",
    });
  }
  const handler = migrationHandler(declared);
  const { name, table, fromSchema, toSchema } = declared["~migration"];
  return deterministically(
    (): MigrationAnswer => {
      const rows: unknown[] = [];
      for (const [index, row] of request.rows.entries()) {
        const ctx: MigrationContext = Object.freeze({
          migration: name,
          table,
          fromSchema,
          toSchema,
          id: row.id,
        });
        try {
          const output = handler(ctx, row.fields);
          if (isThenable(output)) {
            throw new Error(promiseMessage);
          }
          rows.push(asJson(output));
        } catch (error) {
          return {
            ok: false,
            index,
            message: messageOf(error),
          };
        }
      }
      return { ok: true, rows };
    },
    (message) => ({ ok: false, index: 0, message })
  );
};
