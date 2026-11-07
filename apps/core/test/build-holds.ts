import { buildCachePrefix } from "../src/build-cache.ts";

// Holding builds back, for tests of what waits on a build: a build reads
// its entry in the cache before anything else (build-cache.ts), so a
// bucket whose reads of the cache wait for the test holds every build at
// its start, as a slow build would.

/** Core's bucket with every read of the build cache waiting for `held`. */
export const holdingBuilds = (
  files: R2Bucket,
  held: Promise<unknown>
): R2Bucket =>
  new Proxy(files, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (property === "get") {
        return async (
          ...args: Parameters<R2Bucket["get"]>
        ): Promise<R2ObjectBody | null> => {
          if (args[0].startsWith(buildCachePrefix)) {
            await held;
          }
          return await target.get(...args);
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
