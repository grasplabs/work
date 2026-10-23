// Holding builds back, for tests of what waits on a build: a build reads
// its receipt in core's database before anything else (build-cache.ts),
// so a database whose reads and writes of `build_receipts` wait for the
// test holds every build at its start, as a slow build would.

const statementCalls = new Set(["first", "all", "raw", "run"]);

/** `statement`, its calls waiting for `held` when `holds` its binds. */
const heldStatement = (
  statement: D1PreparedStatement,
  held: Promise<unknown>,
  holds: (binds: unknown[]) => boolean,
  binds: unknown[] = []
): D1PreparedStatement =>
  new Proxy(statement, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      if (property === "bind") {
        return (...args: unknown[]): D1PreparedStatement =>
          heldStatement(target.bind(...args), held, holds, args);
      }
      if (typeof property === "string" && statementCalls.has(property)) {
        return async (...args: unknown[]): Promise<unknown> => {
          if (holds(binds)) {
            await held;
          }
          return await Reflect.apply(value, target, args);
        };
      }
      return (...args: unknown[]): unknown =>
        Reflect.apply(value, target, args);
    },
  });

/**
 * Core's database with every statement on `build_receipts` waiting for
 * `held`, or only those whose binds name a key `holds` picks.
 */
export const holdingBuilds = (
  db: D1Database,
  held: Promise<unknown>,
  holds: (key: string) => boolean = () => true
): D1Database =>
  new Proxy(db, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (property === "prepare") {
        return (query: string): D1PreparedStatement => {
          const statement = target.prepare(query);
          return query.includes("build_receipts")
            ? heldStatement(statement, held, (binds) =>
                binds.some((bind) => typeof bind === "string" && holds(bind))
              )
            : statement;
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
