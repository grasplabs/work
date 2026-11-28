import { CoreRpcTarget } from "../src/rpc-target.ts";

// What a browser can call on a connection, walked by tests that hold every
// method to something (staff-audit.test.ts, call-checks.test.ts).

/** How long the walk waits for one call before it goes on. */
export const callWaitMs = 3000;

/**
 * Every method of `target` and of every target its getters hand out, by
 * path, with how many parameters it declares: what a browser can call.
 */
export const targetMethods = (
  target: object,
  path: string,
  seen = new Set<object>()
): { name: string; call: (...args: unknown[]) => unknown; arity: number }[] => {
  if (seen.has(target)) {
    return [];
  }
  seen.add(target);
  const found: {
    name: string;
    call: (...args: unknown[]) => unknown;
    arity: number;
  }[] = [];
  for (
    let prototype: object | null = Reflect.getPrototypeOf(target);
    prototype !== null && prototype !== CoreRpcTarget.prototype;
    prototype = Reflect.getPrototypeOf(prototype)
  ) {
    for (const key of Reflect.ownKeys(prototype)) {
      const property = Reflect.getOwnPropertyDescriptor(prototype, key);
      if (typeof key !== "string" || key === "constructor" || !property) {
        continue;
      }
      const name = `${path}.${key}`;
      if (property.get !== undefined) {
        const inner: unknown = Reflect.apply(property.get, target, []);
        if (inner instanceof CoreRpcTarget) {
          found.push(...targetMethods(inner, name, seen));
        }
      } else if (typeof property.value === "function") {
        const method: unknown = property.value;
        found.push({
          name,
          arity: typeof method === "function" ? Math.max(method.length, 1) : 0,
          call: (...args: unknown[]): unknown => {
            if (typeof method !== "function") {
              return undefined;
            }
            const answer: unknown = Reflect.apply(method, target, args);
            return answer;
          },
        });
      }
    }
  }
  return found;
};
