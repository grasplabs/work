import { env } from "cloudflare:workers";

/**
 * Core's database, counting the values each statement binds: D1 binds at
 * most 100 a statement, which the local database doesn't hold code to, so
 * a list bound one value an item passes here and throws in production.
 * Pass `{ ...env, DB: db }` to the code under test, then read `bound`.
 */
export const countingBinds = () => {
  const bound: number[] = [];
  const db = new Proxy(env.DB, {
    get: (target, name): unknown => {
      const member: unknown = Reflect.get(target, name);
      if (name !== "prepare" || typeof member !== "function") {
        return typeof member === "function" ? member.bind(target) : member;
      }
      return (query: string) => {
        const statement = target.prepare(query);
        return new Proxy(statement, {
          get: (inner, key): unknown => {
            const value: unknown = Reflect.get(inner, key);
            if (key === "bind" && typeof value === "function") {
              return (...values: unknown[]) => {
                bound.push(values.length);
                return inner.bind(...values);
              };
            }
            return typeof value === "function" ? value.bind(inner) : value;
          },
        });
      };
    },
  });
  return { db, bound };
};
