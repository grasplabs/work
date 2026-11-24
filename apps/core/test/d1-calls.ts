/**
 * Every D1 statement run in this isolate counts as unanswered until it
 * settles (open-sockets.ts), so a test that timed out names a statement
 * it was still waiting on.
 *
 * The prototypes of workerd's D1 classes are wrapped, as reset-storage.ts
 * wraps the namespaces', once per runtime: each file's setup imports this
 * again from the module cache.
 */
import { env } from "cloudflare:workers";

import { untilAnswered } from "./open-sockets.ts";

/** Marks a method as wrapped, so it is wrapped once. */
const traced = Symbol.for("grasp.d1-calls");

/** A statement's text, up to this long, which tells statements apart. */
const shownChars = 100;

const textOf = (statement: unknown): string => {
  const text: unknown =
    typeof statement === "object" && statement !== null
      ? Reflect.get(statement, "statement")
      : undefined;
  return typeof text === "string"
    ? text.replaceAll(/\s+/gu, " ").trim().slice(0, shownChars)
    : "a statement";
};

/** Has `name` on `prototype` count as unanswered, named by `what`, until it settles. */
const trace = (
  prototype: object,
  name: string,
  what: (self: unknown, args: unknown[]) => string
): void => {
  const original: unknown = Reflect.get(prototype, name);
  if (
    typeof original !== "function" ||
    Reflect.get(original, traced) === true
  ) {
    return;
  }
  const wrapped = async function wrapped(
    this: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    const answer: unknown = await untilAnswered(
      what(this, args),
      Promise.resolve(Reflect.apply(original, this, args))
    );
    return answer;
  };
  Reflect.set(wrapped, traced, true);
  Reflect.set(prototype, name, wrapped);
};

/** Counts every D1 statement and batch as unanswered until it settles. */
export const traceD1Calls = (): void => {
  const database = Reflect.getPrototypeOf(env.DB);
  const statement = Reflect.getPrototypeOf(env.DB.prepare("SELECT 1"));
  if (database === null || statement === null) {
    throw new Error("Expected D1's classes in the env");
  }
  for (const name of ["all", "first", "raw", "run"]) {
    trace(statement, name, (self) => `D1 ${name}: ${textOf(self)}`);
  }
  trace(database, "batch", (_self, [statements]) =>
    Array.isArray(statements)
      ? `D1 batch of ${statements.length}: ${textOf(statements[0])}`
      : "D1 batch"
  );
  trace(
    database,
    "exec",
    (_self, [query]) => `D1 exec: ${textOf({ statement: query })}`
  );
};
