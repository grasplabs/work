// Events (events.ts, GRA-1763), at the store's own boundary: kept in the
// shared store alone, once per key and team, and an item only as a hash,
// so nothing readable of it is kept; a tag an erasure closed takes no
// later event until none could still arrive; and a call under another of
// the host's keys drops everything made under the old one. Their expiry
// on the host's clock is core's test (apps/core/test/brain-events.test.ts).
import { eventsKeptMs } from "@grasp-os/brain-next/contract";
import type { NewEvent } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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

/** An id of the host's key, as it names one: 64 hex digits. */
const keyId = "a".repeat(64);

/** A tag of who took a step, as the host makes one: 64 hex digits. */
const aTag = (): string => crypto.randomUUID().replaceAll("-", "").repeat(2);

/** The steps of the events the shared store keeps for `team`, in order. */
const stepsFor = async (team: string): Promise<unknown[]> => {
  const rows = await keptFor(team);
  return rows.map(({ step }) => step);
};

const eventOf = (
  team: string,
  step: string,
  key = crypto.randomUUID(),
  who = "0".repeat(64)
) =>
  ({
    key,
    team,
    step,
    item: null,
    who,
    at: new Date().toISOString(),
  }) satisfies NewEvent;

describe("events", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("are kept once per key and team, and only by the shared store", async () => {
    const sales = `team:${crypto.randomUUID()}`;
    const finance = `team:${crypto.randomUUID()}`;
    const key = crypto.randomUUID();
    const twice = [eventOf(sales, "deals.update", key)];
    await shared().addEvents({ keyId, events: twice });
    await shared().addEvents({
      keyId,
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
        await own.addEvents({ keyId, events: twice });
      }),
      ownExpiry: await outcome(async () => {
        await own.expireEvents();
      }),
    }).toStrictEqual({
      sales: [{ team: sales, step: "deals.update", item: null }],
      finance: [{ team: finance, step: "deals.update", item: null }],
      ownAdd: refused,
      ownExpiry: refused,
    });
  });

  it("keep an item only by its hash: an ID as its system names it is refused, nothing kept", async () => {
    const team = `team:${crypto.randomUUID()}`;
    const hashed = await sha256("invoice-7");
    const readable = await outcome(async () => {
      await shared().addEvents({
        keyId,
        events: [{ ...eventOf(team, "invoice.read"), item: "invoice-7" }],
      });
    });
    await shared().addEvents({
      keyId,
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

  it("take no event under a tag an erasure closed, as a drain that read a person's teams before their erasure would add one after it", async () => {
    const team = `team:${crypto.randomUUID()}`;
    const [erased, other] = [aTag(), aTag()];
    await shared().addEvents({
      keyId,
      events: [
        eventOf(team, "deals.update", undefined, erased),
        eventOf(team, "deals.read", undefined, other),
      ],
    });
    await shared().eraseEvents({ keyId, who: [erased] });
    // The late write: the same person's step, made from teams read
    // before the erasure.
    await shared().addEvents({
      keyId,
      events: [
        eventOf(team, "deals.late", undefined, erased),
        eventOf(team, "deals.late", undefined, other),
      ],
    });

    await expect(stepsFor(team)).resolves.toStrictEqual([
      "deals.read",
      "deals.late",
    ]);
  });

  it("keep a closed tag only as long as an event under it could arrive", async () => {
    const team = `team:${crypto.randomUUID()}`;
    const erased = aTag();
    await shared().eraseEvents({ keyId, who: [erased] });
    const later = Date.now() + eventsKeptMs + 60_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(later);
    await shared().expireEvents();
    await shared().addEvents({
      keyId,
      events: [eventOf(team, "deals.update", undefined, erased)],
    });

    await expect(stepsFor(team)).resolves.toStrictEqual(["deals.update"]);
  });

  it("drop every event and closed tag made under another of the host's keys before a call under a new one", async () => {
    const team = `team:${crypto.randomUUID()}`;
    const [kept, closed] = [aTag(), aTag()];
    await shared().addEvents({
      keyId,
      events: [eventOf(team, "deals.old", undefined, kept)],
    });
    await shared().eraseEvents({ keyId, who: [closed] });
    const before = await keptFor(team);
    await shared().addEvents({
      keyId: "b".repeat(64),
      events: [eventOf(team, "deals.new", undefined, closed)],
    });

    expect({
      before: before.map(({ step }) => step),
      after: await stepsFor(team),
    }).toStrictEqual({ before: ["deals.old"], after: ["deals.new"] });
  });
});
