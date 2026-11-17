import { env } from "cloudflare:workers";

// Core's env with a call of the Brain's stores failing, as when the Brain
// is out of reach: what an inline erasure, or the clock's, leaves; or a
// removal that fails once, and the retry after it.

/**
 * A store's stub whose `method` first runs `before`, which may wait or
 * throw, then is called as it is.
 */
const beforeOf = <T extends object>(
  stub: T,
  method: string,
  before: () => Promise<void>
): T =>
  new Proxy(stub, {
    get: (target, name): unknown => {
      const member: unknown = Reflect.get(target, name);
      if (typeof member !== "function") {
        return member;
      }
      if (name === method) {
        return async (...given: unknown[]): Promise<unknown> => {
          await before();
          return await Reflect.apply(member, target, given);
        };
      }
      return (...given: unknown[]): unknown =>
        Reflect.apply(member, target, given);
    },
  });

/** A store's stub whose `method` fails while `fails` says so. */
const failingOf = <T extends object>(
  stub: T,
  method: string,
  fails: () => boolean
): T =>
  beforeOf(stub, method, async () => {
    if (fails()) {
      await Promise.resolve();
      throw new Error("The Brain is out of reach.");
    }
  });

/** The Brain's stores' namespace, every stub it makes wrapped by `wrap`. */
const namespaceWith = <T extends object>(
  namespace: T,
  wrap: <S extends object>(stub: S) => S
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
        return name === "jurisdiction" ? namespaceWith(made, wrap) : wrap(made);
      };
    },
  });

/** The Brain's stores' namespace, every stub of it failing `method` while `fails` says so. */
const namespaceFailing = <T extends object>(
  namespace: T,
  method: string,
  fails: () => boolean
): T => namespaceWith(namespace, (stub) => failingOf(stub, method, fails));

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

/**
 * Core's env, but every erasure of a source in the Brain's stores waits
 * until `release` is called once it has been asked for: `reached`
 * settles when the first is asked, so a test holds a step of work at that
 * await and runs other work meanwhile, with no sleeps.
 */
export const erasuresHeld = (): {
  env: Env;
  reached: Promise<true>;
  release: () => void;
} => {
  const { promise: reached, resolve: reach } = Promise.withResolvers<true>();
  const { promise: released, resolve: release } = Promise.withResolvers<true>();
  return {
    env: {
      ...env,
      BRAIN_STORE: namespaceWith(env.BRAIN_STORE, (stub) =>
        beforeOf(stub, "eraseSource", async () => {
          reach(true);
          await released;
        })
      ),
    },
    reached,
    release: () => {
      release(true);
    },
  };
};

/**
 * Core's env, and how many erasures of a source in the Brain's stores
 * were asked of it so far: what an invocation spends on erasing.
 */
export const erasuresCounted = (): { env: Env; count: () => number } => {
  let asked = 0;
  return {
    env: {
      ...env,
      BRAIN_STORE: namespaceWith(env.BRAIN_STORE, (stub) =>
        beforeOf(stub, "eraseSource", async () => {
          asked += 1;
          await Promise.resolve();
        })
      ),
    },
    count: () => asked,
  };
};
