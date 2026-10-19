/**
 * The reset each test file starts with (start-each-file.ts): whatever an
 * earlier file left behind, and in whatever state, the next file finds
 * none of it.
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { resetStorage, wakeTimeoutMs } from "./reset-storage.ts";

type Ledger = DurableObjectStub;

/** A model ledger named `name`, like the deployment's. */
const namedLedger = (name: string): Ledger => env.MODEL_LEDGER.getByName(name);

/** A model ledger reached by ID, as the workflow engine reaches its runs. */
const ledgerById = (id: DurableObjectId): Ledger => env.MODEL_LEDGER.get(id);

const leaveNote = async (ledger: Ledger): Promise<void> => {
  await runInDurableObject(ledger, (_object, state) => {
    state.storage.kv.put("note", "left behind");
  });
};

/** The note `ledger` keeps, if any. */
const noteOf = async (ledger: Ledger): Promise<unknown> =>
  await runInDurableObject(ledger, (_object, state) =>
    state.storage.kv.get("note")
  );

/**
 * Longer than workerd keeps an object's instance after its last request:
 * 10 seconds, after which only its storage stays, on disk.
 */
const quietMs = 11_000;

/** How long the busy object below goes on writing after it answered. */
const busyMs = 500;

describe("the reset between test files", () => {
  it("empties objects, databases and buckets that went quiet", async () => {
    const name = crypto.randomUUID();
    const id = env.MODEL_LEDGER.newUniqueId();
    await leaveNote(namedLedger(name));
    await leaveNote(ledgerById(id));
    await env.KNOWLEDGE.exec("CREATE TABLE left_behind (note TEXT)");
    await env.AUDIT_ARCHIVE.put("left-behind", "note");

    await scheduler.wait(quietMs);
    await resetStorage();

    // New stubs: the reset breaks those of the objects it reached.
    await expect(noteOf(namedLedger(name))).resolves.toBeUndefined();
    await expect(noteOf(ledgerById(id))).resolves.toBeUndefined();
    await expect(
      env.KNOWLEDGE.prepare(
        "SELECT name FROM sqlite_master WHERE name = 'left_behind'"
      ).first()
    ).resolves.toBeNull();
    await expect(env.AUDIT_ARCHIVE.head("left-behind")).resolves.toBeNull();
  });

  it("empties an object that is still writing", async () => {
    const name = crypto.randomUUID();
    await runInDurableObject(namedLedger(name), (_object, state) => {
      state.storage.kv.put("note", "first");
      // Work the object goes on with after answering, as an audit drain does.
      state.waitUntil(
        (async () => {
          await scheduler.wait(busyMs);
          state.storage.kv.put("note", "second");
        })()
      );
    });

    await resetStorage();
    await scheduler.wait(busyMs * 2);

    // A new stub: the reset breaks those of the objects it reached.
    await expect(noteOf(namedLedger(name))).resolves.toBeUndefined();
  });

  it("empties an object that never answers, without waiting for it", async () => {
    const name = crypto.randomUUID();
    await runInDurableObject(namedLedger(name), (_object, state) => {
      state.storage.kv.put("note", "left behind");
      // Then holds every later request, as a hung request can.
      state.waitUntil(
        (async () => {
          await scheduler.wait(busyMs);
          await state.blockConcurrencyWhile(
            async () => await Promise.withResolvers<never>().promise
          );
        })()
      );
    });
    await scheduler.wait(busyMs * 2);

    const started = Date.now();
    await resetStorage();

    expect(Date.now() - started).toBeLessThan(wakeTimeoutMs * 2);
    await expect(noteOf(namedLedger(name))).resolves.toBeUndefined();
  });
});
