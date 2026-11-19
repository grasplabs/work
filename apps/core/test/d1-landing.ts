import { env } from "cloudflare:workers";

// Another request at a chosen point between the code's own statements,
// on the real database: for the races a test can't time.

/**
 * `env` with its D1 binding running `land` once, around the first
 * statement, or batch holding one, whose SQL `matches`: just before it
 * runs, or just after. Every
 * statement still runs on the real database, in the order the code under
 * test sends it; only `land` comes in between, through its own requests.
 * `landed` says whether it came at all.
 */
export const landingAt = (
  matches: RegExp,
  when: "before" | "after",
  land: () => Promise<unknown>
): { coreEnv: Env; landed: () => boolean } => {
  let landed = false;
  const once = async (): Promise<void> => {
    if (!landed) {
      landed = true;
      await land();
    }
  };
  const real = new WeakMap<object, D1PreparedStatement>();
  const queries = new WeakMap<object, string>();
  const runs = new Set<PropertyKey>(["run", "all", "raw", "first"]);
  const watched = (
    statement: D1PreparedStatement,
    query: string
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get: (target, key) => {
        if (key === "bind") {
          return (...values: unknown[]) =>
            watched(target.bind(...values), query);
        }
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") {
          return value;
        }
        if (runs.has(key) && matches.test(query)) {
          return async (...args: unknown[]): Promise<unknown> => {
            if (when === "before") {
              await once();
            }
            const result: unknown = await Reflect.apply(value, target, args);
            if (when === "after") {
              await once();
            }
            return result;
          };
        }
        return (...args: unknown[]): unknown =>
          Reflect.apply(value, target, args);
      },
    });
    real.set(wrapped, statement);
    queries.set(wrapped, query);
    return wrapped;
  };
  const db = new Proxy(env.DB, {
    get: (target, key) => {
      if (key === "prepare") {
        return (query: string) => watched(target.prepare(query), query);
      }
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const named = statements.some((statement) =>
            matches.test(queries.get(statement) ?? "")
          );
          if (named && when === "before") {
            await once();
          }
          const results = await target.batch(
            statements.map((statement) => real.get(statement) ?? statement)
          );
          if (named && when === "after") {
            await once();
          }
          return results;
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  return { coreEnv: { ...env, DB: db }, landed: () => landed };
};

/** The most D1 takes in one value, as its limits page states it. */
const d1ValueBytes = 2_000_000;

/**
 * `env`'s D1 refusing a statement that binds a value over D1's limit of
 * 2 MB, as D1 does in production; the local one takes any size.
 */
export const withD1ValueLimit = (): D1Database =>
  new Proxy(env.DB, {
    get: (target, key) => {
      if (key === "prepare") {
        return (query: string): D1PreparedStatement => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get: (inner, innerKey) => {
              if (innerKey === "bind") {
                return (...values: unknown[]) => {
                  const over = values.some(
                    (value) =>
                      typeof value === "string" &&
                      new TextEncoder().encode(value).length > d1ValueBytes
                  );
                  if (over) {
                    throw new Error("D1_ERROR: string or blob too big");
                  }
                  return inner.bind(...values);
                };
              }
              const value: unknown = Reflect.get(inner, innerKey, inner);
              return typeof value === "function"
                ? (...args: unknown[]): unknown =>
                    Reflect.apply(value, inner, args)
                : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
