import { env } from "cloudflare:workers";

/**
 * Core's env with a database that runs `during` once, just before the
 * first batch holding a statement whose SQL matches `pattern`: another
 * run's work landing between what this run read and what it writes, in
 * the order a test chooses. `during` uses the plain `env`, so it is not
 * caught again.
 */
export const interleaving = (
  pattern: RegExp,
  during: () => Promise<void>
): Env => {
  const queries = new WeakMap<object, string>();
  let ran = false;
  const db = new Proxy(env.DB, {
    get: (target, name): unknown => {
      if (name === "prepare") {
        return (query: string) =>
          new Proxy(target.prepare(query), {
            get: (inner, key): unknown => {
              const value: unknown = Reflect.get(inner, key);
              if (key === "bind" && typeof value === "function") {
                return (...values: unknown[]) => {
                  const bound = inner.bind(...values);
                  queries.set(bound, query);
                  return bound;
                };
              }
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
      }
      if (name === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (
            !ran &&
            statements.some((statement) =>
              pattern.test(queries.get(statement) ?? "")
            )
          ) {
            ran = true;
            await during();
          }
          return await target.batch(statements);
        };
      }
      const member: unknown = Reflect.get(target, name);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { ...env, DB: db };
};
