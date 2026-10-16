/**
 * Empties all storage between test files: `reset()`, after waking every
 * object it has to reach.
 *
 * `reset()` (workerd's `deleteAllDurableObjects()`) resets the SQLite
 * database of each object whose instance is in memory, and only those.
 * workerd drops an instance 10 seconds after its last request but keeps
 * its database on disk, so an object idle that long before the next
 * file's reset kept its rows, and its next instance read them again
 * (GRA-630: `packages.test.ts` ends with an agent chat that writes the
 * deployment's model ledger, and the next file still found that spend
 * whenever its reset came 10 seconds or more after the chat). Locally D1
 * databases and R2 buckets are Durable Objects too, and keep their data
 * the same way.
 *
 * So every object a test reached since the last reset gets one request
 * first, which brings its instance back. Core's objects all run in this
 * isolate, so its namespaces' `get` and `getByName` note each one as it
 * is reached. An object no file has reached since a reset is still empty
 * from it.
 */
import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

/**
 * Whether `value` is an instance of the class named `kind`. A service
 * binding answers to any method name, so a binding's methods don't tell.
 */
const ofClass = (value: unknown, kind: string): boolean =>
  value instanceof Object && value.constructor.name === kind;

const isNamespace = (value: unknown): value is DurableObjectNamespace =>
  ofClass(value, "DurableObjectNamespace");
const isDatabase = (value: unknown): value is D1Database =>
  ofClass(value, "D1Database");
const isBucket = (value: unknown): value is R2Bucket =>
  ofClass(value, "R2Bucket");

/** Core's namespaces, its databases and its buckets, connect's database included. */
const bindings = Object.values(env);
const namespaces = bindings.filter(isNamespace);
const databases = bindings.filter(isDatabase);
const buckets = bindings.filter(isBucket);

/** The objects reached since the last reset, by ID. */
const reached = new Map<
  string,
  { namespace: DurableObjectNamespace; id: DurableObjectId }
>();

/**
 * Notes an object of one of core's namespaces. The test runner's own
 * namespace shares their methods, and resetting runs in its object.
 */
const note = (namespace: DurableObjectNamespace, id: DurableObjectId) => {
  if (namespaces.includes(namespace)) {
    reached.set(id.toString(), { namespace, id });
  }
};

/**
 * Has `method` of every namespace note the object it reaches, by the ID
 * `idOf` gives for its arguments. Done once per runtime, as this module
 * is evaluated: each file's setup imports it again from the module cache.
 */
const noteOn = (
  method: "get" | "getByName",
  idOf: (namespace: DurableObjectNamespace, first: unknown) => DurableObjectId
): void => {
  const prototype = Reflect.getPrototypeOf(namespaces[0] ?? {});
  const original: unknown =
    prototype === null ? undefined : Reflect.get(prototype, method);
  if (prototype === null || typeof original !== "function") {
    throw new Error(`Expected core's namespaces in the env, with ${method}`);
  }
  Reflect.set(
    prototype,
    method,
    function noted(this: DurableObjectNamespace, ...args: unknown[]): unknown {
      note(this, idOf(this, args[0]));
      const stub: unknown = Reflect.apply(original, this, args);
      return stub;
    }
  );
};
noteOn("get", (namespace, id) => namespace.idFromString(String(id)));
noteOn("getByName", (namespace, name) => namespace.idFromName(String(name)));

/** Brings back the instance of every object reached since the last reset, and of every database and bucket. */
const wakeStorage = async (): Promise<void> => {
  await Promise.all([
    ...[...reached.values()].map(async ({ namespace, id }) => {
      await runInDurableObject(namespace.get(id), (_object, state) => state.id);
    }),
    ...databases.map(async (db) => {
      await db.prepare("SELECT 1").first();
    }),
    ...buckets.map(async (bucket) => {
      await bucket.head("wake");
    }),
  ]);
  // Those woken, and any reached meanwhile, are in memory: the reset
  // reaches them.
  reached.clear();
};

/**
 * Empties every Durable Object's storage, and with it every D1 database
 * and R2 bucket, connect's included.
 */
export const resetStorage = async (): Promise<void> => {
  await wakeStorage();
  await reset();
};
