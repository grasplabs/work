import { env } from "cloudflare:workers";

/**
 * Connect's database, with `first` run just before each batch lands: a
 * change made by someone else between a check and the write it allowed.
 */
export const racingDb = (first: (db: D1Database) => unknown): D1Database =>
  new Proxy(env.DB, {
    get: (target, property) => {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await Promise.resolve(first(target));
          return await target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });

/** `statement`, and what binding it makes, read only after `race`. */
const racingStatement = (
  statement: D1PreparedStatement,
  race: () => Promise<void>
): D1PreparedStatement =>
  new Proxy(statement, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      if (property === "bind") {
        return (...values: unknown[]) =>
          racingStatement(target.bind(...values), race);
      }
      return async (...args: unknown[]): Promise<unknown> => {
        await race();
        const answer: unknown = await Reflect.apply(value, target, args);
        return answer;
      };
    },
  });

/**
 * Connect's database, with `first` run once just before the first query
 * matching `query` is read, or the one after `skip` such reads: a change
 * made by someone else between two steps of one request.
 */
export const racingRead = (
  query: RegExp,
  first: () => Promise<unknown>,
  { skip = 0 }: { skip?: number } = {}
): D1Database => {
  let reads = 0;
  const race = async (): Promise<void> => {
    reads += 1;
    if (reads === skip + 1) {
      await first();
    }
  };
  return new Proxy(env.DB, {
    get: (target, property) => {
      if (property === "prepare") {
        return (sql: string) =>
          query.test(sql)
            ? racingStatement(target.prepare(sql), race)
            : target.prepare(sql);
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
};
