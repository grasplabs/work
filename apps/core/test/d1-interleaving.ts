import { env } from "cloudflare:workers";

/**
 * Core's env with a database that runs `during` once, just before the
 * first statement or batch whose SQL matches `pattern`: another run's
 * work landing between what this run read and what it writes, in the
 * order a test chooses. `after`, if given, runs once that statement or
 * batch has run, whether it wrote or failed. `during` uses the plain
 * `env`, so it is not caught again.
 */
export const interleaving = (
  pattern: RegExp,
  during: () => Promise<void>,
  after?: () => void
): Env => {
  const queries = new WeakMap<object, string>();
  let ran = false;
  /** Runs `write` with `during` before it and `after` after it, the first time `query` matches. */
  const caught = async <T>(
    query: string,
    write: () => Promise<T>
  ): Promise<T> => {
    if (ran || !pattern.test(query)) {
      return await write();
    }
    ran = true;
    await during();
    try {
      return await write();
    } finally {
      after?.();
    }
  };
  const db = new Proxy(env.DB, {
    get: (target, name): unknown => {
      if (name === "prepare") {
        return (query: string) =>
          new Proxy(target.prepare(query), {
            get: (inner, key): unknown => {
              const value: unknown = Reflect.get(inner, key);
              if (key === "bind" && typeof value === "function") {
                return (...values: unknown[]) => {
                  // The bound statement itself, so a batch takes it as
                  // D1 made it; its own reads and writes caught on it.
                  const bound = inner.bind(...values);
                  queries.set(bound, query);
                  for (const method of ["run", "all", "raw", "first"]) {
                    const own: unknown = Reflect.get(bound, method);
                    if (typeof own === "function") {
                      Reflect.set(
                        bound,
                        method,
                        async (...args: unknown[]): Promise<unknown> =>
                          await caught(
                            query,
                            async (): Promise<unknown> =>
                              await Reflect.apply(own, bound, args)
                          )
                      );
                    }
                  }
                  return bound;
                };
              }
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
      }
      if (name === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const query = statements
            .map((statement) => queries.get(statement) ?? "")
            .find((text) => pattern.test(text));
          return await caught(
            query ?? "",
            async () => await target.batch(statements)
          );
        };
      }
      const member: unknown = Reflect.get(target, name);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { ...env, DB: db };
};
