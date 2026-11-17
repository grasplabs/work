import { env } from "cloudflare:workers";

// Core's env with every erasure in the Brain's stores failing, as when the
// Brain is out of reach: what an inline erasure, or the clock's, leaves.

/** A store's stub whose every erasure fails. */
const failingErasuresOf = <T extends object>(stub: T): T =>
  new Proxy(stub, {
    get: (target, name): unknown => {
      const member: unknown = Reflect.get(target, name);
      if (typeof member !== "function") {
        return member;
      }
      if (name === "eraseSource") {
        return async (): Promise<never> => {
          await Promise.resolve();
          throw new Error("The Brain is out of reach.");
        };
      }
      return (...given: unknown[]): unknown =>
        Reflect.apply(member, target, given);
    },
  });

/** Core's env, but every erasure of a source in the Brain's stores fails. */
export const erasuresFailing = (): Env => {
  const namespaceOf = <T extends object>(namespace: T): T =>
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
            ? namespaceOf(made)
            : failingErasuresOf(made);
        };
      },
    });
  return { ...env, BRAIN_STORE: namespaceOf(env.BRAIN_STORE) };
};
