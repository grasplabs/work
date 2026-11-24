import { env } from "cloudflare:workers";

/**
 * Core's env with a database that runs `during` once, just before the
 * first statement or batch whose SQL matches `pattern` and that binds
 * `bound` (a test's own connection, so other tests' work in the same run
 * never sets it off): another run's work landing between what this run
 * read and what it writes, in the order a test chooses. `after`, if
 * given, runs once that statement or batch has run, whether it wrote or
 * failed, before the writer goes on: another run's work landing between
 * this write and the next. Both use the plain `env`, so neither is
 * caught again.
 */
export const interleaving = (
  { pattern, bound }: { pattern: RegExp; bound: string },
  during: () => Promise<void>,
  after?: () => Promise<void> | void
): Env => {
  const queries = new WeakMap<object, { query: string; values: unknown[] }>();
  let ran = false;
  const matches = (statement?: { query: string; values: unknown[] }) =>
    statement !== undefined &&
    pattern.test(statement.query) &&
    statement.values.includes(bound);
  /** Runs `write` with `during` before it and `after` after it, the first time `statement` matches. */
  const caught = async <T>(
    statement: { query: string; values: unknown[] } | undefined,
    write: () => Promise<T>
  ): Promise<T> => {
    if (ran || !matches(statement)) {
      return await write();
    }
    ran = true;
    await during();
    try {
      return await write();
    } finally {
      await after?.();
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
                  const made = inner.bind(...values);
                  const statement = { query, values };
                  queries.set(made, statement);
                  for (const method of ["run", "all", "raw", "first"]) {
                    const own: unknown = Reflect.get(made, method);
                    if (typeof own === "function") {
                      Reflect.set(
                        made,
                        method,
                        async (...args: unknown[]): Promise<unknown> =>
                          await caught(
                            statement,
                            async (): Promise<unknown> =>
                              await Reflect.apply(own, made, args)
                          )
                      );
                    }
                  }
                  return made;
                };
              }
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
      }
      if (name === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const statement = statements
            .map((each) => queries.get(each))
            .find(matches);
          return await caught(
            statement,
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
