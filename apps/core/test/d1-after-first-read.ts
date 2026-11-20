// Core's database with one change landing at a chosen moment: right after
// the first read that starts with a given text answered, before its
// reader gets the answer, as another person's change landing between one
// change's read and its write. No sleeps: the change runs at that await.

/**
 * `database`, but `between` runs right after the first read whose query
 * starts with `readStart` (as drizzle writes it, in lower case) answered,
 * before its reader gets the answer. Every other statement is the
 * database's own.
 */
export const afterFirstRead = (
  database: D1Database,
  readStart: string,
  between: () => Promise<void>
): D1Database => {
  let ran = false;
  const after = async <T>(read: Promise<T>): Promise<T> => {
    const answered = await read;
    if (!ran) {
      ran = true;
      await between();
    }
    return answered;
  };
  const reading = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, name): unknown => {
        const member: unknown = Reflect.get(target, name);
        if (typeof member !== "function") {
          return member;
        }
        if (name === "bind") {
          return (...values: unknown[]): D1PreparedStatement =>
            reading(target.bind(...values));
        }
        if (name === "all" || name === "raw" || name === "first") {
          return async (...given: unknown[]): Promise<unknown> =>
            await after(Promise.resolve(Reflect.apply(member, target, given)));
        }
        return (...given: unknown[]): unknown =>
          Reflect.apply(member, target, given);
      },
    });
  return new Proxy(database, {
    get: (target, name): unknown => {
      const member: unknown = Reflect.get(target, name);
      if (typeof member !== "function") {
        return member;
      }
      if (name === "prepare") {
        return (query: string): D1PreparedStatement => {
          const statement = target.prepare(query);
          return query.startsWith(readStart) ? reading(statement) : statement;
        };
      }
      return (...given: unknown[]): unknown =>
        Reflect.apply(member, target, given);
    },
  });
};

/**
 * `database`, but every batch holding a statement whose query starts with
 * `writeStart` is refused, as a database out of reach for that write.
 */
export const refusingWrites = (
  database: D1Database,
  writeStart: string
): D1Database => {
  const refused = new WeakSet<D1PreparedStatement>();
  return new Proxy(database, {
    get: (target, name): unknown => {
      const member: unknown = Reflect.get(target, name);
      if (typeof member !== "function") {
        return member;
      }
      if (name === "prepare") {
        return (query: string): D1PreparedStatement => {
          const statement = target.prepare(query);
          if (!query.startsWith(writeStart)) {
            return statement;
          }
          refused.add(statement);
          return new Proxy(statement, {
            get: (prepared, member2): unknown => {
              const value: unknown = Reflect.get(prepared, member2);
              if (member2 === "bind") {
                return (...values: unknown[]): D1PreparedStatement => {
                  const bound = prepared.bind(...values);
                  refused.add(bound);
                  return bound;
                };
              }
              return typeof value === "function"
                ? (...given: unknown[]): unknown =>
                    Reflect.apply(value, prepared, given)
                : value;
            },
          });
        };
      }
      if (name === "batch") {
        return async (
          statements: D1PreparedStatement[]
        ): Promise<D1Result[]> => {
          if (statements.some((statement) => refused.has(statement))) {
            throw new Error("Refused, for the test");
          }
          return await target.batch(statements);
        };
      }
      return (...given: unknown[]): unknown =>
        Reflect.apply(member, target, given);
    },
  });
};
