import { env } from "cloudflare:workers";

/**
 * Core's database, with `first` run just before each batch lands: a
 * change made by someone else between a check and the write it allowed;
 * and `after`, if given, just after it: a change between the write and
 * whatever reads after it.
 */
export const racingDb = (
  first: (db: D1Database) => unknown,
  after?: (db: D1Database) => unknown
): D1Database =>
  new Proxy(env.DB, {
    get: (target, property) => {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await Promise.resolve(first(target));
          const results = await target.batch(statements);
          await Promise.resolve(after?.(target));
          return results;
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
