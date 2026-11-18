// Events (events.ts, GRA-1763), at the store's own boundary: kept in the
// shared store alone, once per key and team, and an item only as a hash,
// so nothing readable of it is kept. Their expiry on the host's clock is
// core's test (apps/core/test/brain-events.test.ts).
import type { NewEvent } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Store } from "./export-reads.ts";

const shared = (): Store => env.BRAIN_STORE.getByName("brain");

/** The SHA-256 of `text`, in hex. */
const sha256 = async (text: string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** What `call` answered, or its error's message. */
const outcome = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    return await call();
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
};

/** The events the shared store keeps for `team`: team, step and item. */
const keptFor = async (team: string) =>
  await runInDurableObject(shared(), (_instance, state) =>
    state.storage.sql
      .exec(
        "SELECT team, step, item FROM events WHERE team = ? ORDER BY row",
        team
      )
      .toArray()
  );

const eventOf = (team: string, step: string, key = crypto.randomUUID()) =>
  ({
    key,
    team,
    step,
    system: "crm",
    writes: false,
    item: null,
    who: "0".repeat(64),
    at: new Date().toISOString(),
  }) satisfies NewEvent;

describe("events", () => {
  it("are kept once per key and team, and only by the shared store", async () => {
    const sales = `team:${crypto.randomUUID()}`;
    const finance = `team:${crypto.randomUUID()}`;
    const key = crypto.randomUUID();
    const twice = [eventOf(sales, "deals.update", key)];
    await shared().addEvents({ events: twice });
    await shared().addEvents({
      events: [...twice, eventOf(finance, "deals.update", key)],
    });
    const own = env.BRAIN_STORE.getByName(`person:${crypto.randomUUID()}`);
    const refused = {
      refused: "The Brain refused it: only the shared store takes this",
    };

    expect({
      sales: await keptFor(sales),
      finance: await keptFor(finance),
      ownAdd: await outcome(async () => {
        await own.addEvents({ events: twice });
      }),
      ownExpiry: await outcome(async () => {
        await own.expireEvents();
      }),
      ownRoutines: await outcome(async () => await own.observedRoutines()),
    }).toStrictEqual({
      sales: [{ team: sales, step: "deals.update", item: null }],
      finance: [{ team: finance, step: "deals.update", item: null }],
      ownAdd: refused,
      ownExpiry: refused,
      ownRoutines: refused,
    });
  });

  it("keep an item only by its hash: an ID as its system names it is refused, nothing kept", async () => {
    const team = `team:${crypto.randomUUID()}`;
    const hashed = await sha256("invoice-7");
    const readable = await outcome(async () => {
      await shared().addEvents({
        events: [{ ...eventOf(team, "invoice.read"), item: "invoice-7" }],
      });
    });
    await shared().addEvents({
      events: [{ ...eventOf(team, "invoice.read"), item: hashed }],
    });

    expect({
      readable: readable !== undefined,
      kept: await keptFor(team),
    }).toStrictEqual({
      readable: true,
      kept: [{ team, step: "invoice.read", item: hashed }],
    });
  });
});
