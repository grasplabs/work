// The part of the host's Brain bucket one store keeps its objects in.
//
// Every store keeps its files, its vectors and its erasure ledger under
// keys of its own: a shared store at the bucket's root, as it always has,
// and a person's own store under `people/<SHA-256 of their id>/`
// (store.ts). So no file, count, sweep or ledger entry is ever shared
// between a person's store and another: the same text kept by a person
// and by the shared store is two objects, deleting one never touches the
// other, and erasing a person deletes what is under their prefix alone.
// No plain id is in a key.

/** An object of the bucket, as the store reads it. */
export interface BucketObject {
  /** Its size in bytes, as R2 has it, known before its body is read. */
  size: number;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

/** What the store calls of its part of the bucket: no more than R2's own. */
export interface BrainBucket {
  get: (key: string) => Promise<BucketObject | null>;
  head: (key: string) => Promise<unknown>;
  put: (
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: R2PutOptions
  ) => Promise<unknown>;
  delete: (keys: string | string[]) => Promise<void>;
  list: (options: {
    prefix: string;
    startAfter?: string;
    limit?: number;
  }) => Promise<{ objects: { key: string }[]; truncated: boolean }>;
}

/**
 * `bucket` with every key under `prefix`: each key given or listed is the
 * part below it. The empty prefix is the bucket as it is.
 */
export const bucketUnder = (bucket: R2Bucket, prefix: string): BrainBucket => {
  if (prefix === "") {
    return bucket;
  }
  const keyOf = (key: string): string => `${prefix}${key}`;
  return {
    get: async (key) => await bucket.get(keyOf(key)),
    head: async (key) => await bucket.head(keyOf(key)),
    put: async (key, value, options) =>
      await bucket.put(keyOf(key), value, options),
    delete: async (keys) => {
      await bucket.delete(
        typeof keys === "string" ? keyOf(keys) : keys.map(keyOf)
      );
    },
    list: async ({ prefix: under, startAfter, limit }) => {
      const page = await bucket.list({
        prefix: keyOf(under),
        ...(startAfter === undefined ? {} : { startAfter: keyOf(startAfter) }),
        ...(limit === undefined ? {} : { limit }),
      });
      return {
        objects: page.objects.map(({ key }) => ({
          key: key.slice(prefix.length),
        })),
        truncated: page.truncated,
      };
    },
  };
};

/**
 * `sent`, a write on its way, kept in `inFlight` until it settles, however
 * it does (its caller hears that): answered as it settles.
 */
export const keptUntilSettled = async <T>(
  sent: Promise<T>,
  inFlight: Set<Promise<unknown>>
): Promise<T> => {
  inFlight.add(sent);
  try {
    return await sent;
  } finally {
    inFlight.delete(sent);
  }
};

/**
 * `bucket`, each write it is sent (a put, a delete) kept in `inFlight`
 * from the moment it is sent until R2 answers or rejects it, whether or not
 * anyone still waits for it: what a caller that stopped waiting (a call's
 * deadline, a queue handler past its time) left on its way is still
 * counted, as the wait here is the write's own. The store's one count of
 * what it may still write (store.ts `#eraseWhole`).
 */
export const countingWrites = (
  bucket: BrainBucket,
  inFlight: Set<Promise<unknown>>
): BrainBucket => ({
  get: async (key) => await bucket.get(key),
  head: async (key) => await bucket.head(key),
  list: async (options) => await bucket.list(options),
  put: async (key, value, options) =>
    await keptUntilSettled(bucket.put(key, value, options), inFlight),
  delete: async (keys) => {
    await keptUntilSettled(bucket.delete(keys), inFlight);
  },
});
