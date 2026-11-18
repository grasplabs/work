// Events (events.ts, GRA-1763), at the store's own boundary: kept in the
// shared store alone, once per key and team, and an item only as a hash,
// so nothing readable of it is kept; a tag an erasure closed takes no
// later event until none could still arrive; and a call under another of
// the host's keys drops everything made under the old one. An export holds
// neither events nor closed tags: events are short-lived activity, and
// restoring one could bring back an erased person's; and a restore of an
// export clears neither, so an erasure still holds through it. Their
// expiry on the host's clock is core's test
// (apps/core/test/brain-events.test.ts).
import { eventsKeptMs } from "@grasp-os/brain-next/contract";
import type { NewEvent } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { exportSettled, tick } from "./export-reads.ts";
import type { Store } from "./export-reads.ts";
import { copyOf, restore } from "./store-copy.ts";
import type { Copy } from "./store-copy.ts";

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

/**
 * A person's erasure in the shared store, of someone with no card, with
 * the events under `who` (their tag in one team), made under `under`.
 */
const erasedTags = async (who: string, under = keyId): Promise<void> => {
  await shared().erasePersonShared({
    person: `person-${crypto.randomUUID()}`,
    identifiers: [],
    reason: "person_erased",
    events: { keyId: under, who: [who] },
  });
};

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

/** Every file of the done export `id`, its manifest first, as text. */
const exportTextOf = async (id: string): Promise<string> => {
  const manifest =
    (await shared().exportFile({ id, file: "manifest.json" })) ?? "";
  const { parts } = z
    .object({ parts: z.array(z.object({ file: z.string() })) })
    .parse(JSON.parse(manifest));
  const texts = [manifest];
  for (const { file } of parts) {
    // oxlint-disable-next-line no-await-in-loop -- a part at a time
    texts.push((await shared().exportFile({ id, file })) ?? "");
  }
  return texts.join("\n");
};

/** Ticks the shared store until its restore of `id` no longer runs: its state. */
const restoredState = async (id: string): Promise<string | undefined> => {
  for (let ticks = 0; ticks < 20; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await tick(shared());
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    const status = await shared().restoreStatus(id);
    if (status?.state !== "running") {
      return status?.state;
    }
  }
  return "running";
};

describe("events", () => {
  /** The shared store before any test added to it: empty. */
  let empty: Copy = { tables: [], others: [] };

  beforeAll(async () => {
    empty = await copyOf(shared());
  });

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
    await erasedTags(erased);
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
    await erasedTags(erased);
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
    await erasedTags(closed);
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

  it("are never in an export, and a restore of one clears neither them nor the tags an erasure closed", async () => {
    const team = `team:${crypto.randomUUID()}`;
    const [kept, closed] = [aTag(), aTag()];
    const step = `marker.${crypto.randomUUID().slice(0, 8)}`;
    const source = `test:${crypto.randomUUID()}`;
    // An export of the company's content, taken before any event.
    await restore(shared(), empty);
    await shared().addSource({
      source,
      change: crypto.randomUUID(),
      text: "The company's handbook",
      access: { kind: "audience", group: "company" },
    });
    const { id: before } = await shared().startExport("test");
    await exportSettled(shared, before);
    // The store's storage lost, then events kept and a tag closed, then
    // that export restored.
    await restore(shared(), empty);
    await shared().addEvents({
      keyId,
      events: [eventOf(team, step, undefined, kept)],
    });
    await erasedTags(closed);
    await shared().startRestore(before, "test");
    const restored = await restoredState(before);
    await shared().addEvents({
      keyId,
      events: [eventOf(team, "deals.late", undefined, closed)],
    });
    // An export of the store now, events and a closed tag in it.
    const { id: after } = await shared().startExport("test");
    await exportSettled(shared, after);
    const exported = await exportTextOf(after);

    expect({
      restored,
      source: await shared().keyState(source),
      steps: await stepsFor(team),
      exported: [step, kept, closed].filter((part) => exported.includes(part)),
    }).toStrictEqual({
      restored: "done",
      source: "held",
      steps: [step],
      exported: [],
    });
  });

  it("stay erased through a restore of the store's storage to before the erasure: the replay takes the person's events again and closes their tag", async () => {
    const team = `team:${crypto.randomUUID()}`;
    const [erased, other] = [aTag(), aTag()];
    await shared().addEvents({
      keyId,
      events: [
        eventOf(team, "deals.update", undefined, erased),
        eventOf(team, "deals.read", undefined, other),
      ],
    });
    const before = await copyOf(shared());
    await erasedTags(erased);
    // An older copy of the storage comes back: the store replays the
    // ledger as it starts.
    await restore(shared(), before);
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

  it("leave nothing of an erased person after a restore to before a rotation of the host's key: the replay drops what the old key made", async () => {
    const team = `team:${crypto.randomUUID()}`;
    const [oldTag, newTag, other] = [aTag(), aTag(), aTag()];
    const rotated = "c".repeat(64);
    // The person's and a colleague's events under the key before.
    await shared().addEvents({
      keyId,
      events: [
        eventOf(team, "deals.update", undefined, oldTag),
        eventOf(team, "deals.read", undefined, other),
      ],
    });
    const before = await copyOf(shared());
    // The key rotated, then the person erased under the new one: their old
    // tag is one no erasure can compute any more.
    await shared().addEvents({
      keyId: rotated,
      events: [eventOf(team, "deals.new", undefined, other)],
    });
    await erasedTags(newTag, rotated);
    await restore(shared(), before);
    const replayed = await stepsFor(team);
    await shared().addEvents({
      keyId: rotated,
      events: [
        eventOf(team, "deals.late", undefined, newTag),
        eventOf(team, "deals.kept", undefined, other),
      ],
    });

    expect({ replayed, after: await stepsFor(team) }).toStrictEqual({
      replayed: [],
      after: ["deals.kept"],
    });
  });
});
