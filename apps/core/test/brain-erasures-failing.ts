import { env } from "cloudflare:workers";

// Core's env with a call of the Brain's stores failing, as when the Brain
// is out of reach: what an inline erasure, or the clock's, leaves; or a
// removal that fails once, and the retry after it.

/** A store's stub whose `method` fails while `fails` says so. */
const failingOf = <T extends object>(
  stub: T,
  method: string,
  fails: () => boolean
): T =>
  new Proxy(stub, {
    get: (target, name): unknown => {
      const member: unknown = Reflect.get(target, name);
      if (typeof member !== "function") {
        return member;
      }
      if (name === method) {
        return async (...given: unknown[]): Promise<unknown> => {
          if (fails()) {
            await Promise.resolve();
            throw new Error("The Brain is out of reach.");
          }
          return await Reflect.apply(member, target, given);
        };
      }
      return (...given: unknown[]): unknown =>
        Reflect.apply(member, target, given);
    },
  });

/** The Brain's stores' namespace, every stub of it failing `method` while `fails` says so. */
const namespaceFailing = <T extends object>(
  namespace: T,
  method: string,
  fails: () => boolean
): T =>
  new Proxy(namespace, {
    get: (target, name): unknown => {
      const member: unknown = Reflect.get(target, name);
      if (typeof member !== "function") {
        return member;
      }
      if (name !== "jurisdiction" && name !== "getByName") {
        return (...given: unknown[]): unknown =>
          Reflect.apply(member, target, given);
      }
      return (argument: unknown): unknown => {
        const made: unknown = Reflect.apply(member, target, [argument]);
        if (typeof made !== "object" || made === null) {
          return made;
        }
        return name === "jurisdiction"
          ? namespaceFailing(made, method, fails)
          : failingOf(made, method, fails);
      };
    },
  });

/** Core's env, but every erasure of a source in the Brain's stores fails. */
export const erasuresFailing = (): Env => ({
  ...env,
  BRAIN_STORE: namespaceFailing(env.BRAIN_STORE, "eraseSource", () => true),
});

/**
 * Core's env, but the first taking of sources out of use in the Brain's
 * stores (`removeSources`) fails; every one after it lands.
 */
export const removalsFailingOnce = (): Env => {
  let failed = false;
  return {
    ...env,
    BRAIN_STORE: namespaceFailing(env.BRAIN_STORE, "removeSources", () => {
      if (failed) {
        return false;
      }
      failed = true;
      return true;
    }),
  };
};
