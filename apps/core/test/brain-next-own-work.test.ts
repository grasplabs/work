import { defineWork, enqueueWork } from "@grasp-os/brain-next/work";
import type { WorkContext } from "@grasp-os/brain-next/work";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  addSource,
  brainStaffReport,
  eraseSource,
  erasePerson,
} from "../src/brain-next.ts";
import { keepOwnStoreHealth } from "../src/brain-own-stores.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { ageOwnErasure } from "./brain-next-own-store.ts";
import { answeringProvider } from "./model-provider.ts";

// A person's own store at work on its own alarm (GRA-1762, part 3): core's
// subclass of the store gives it core's model gateway and embedders, and
// keeps its health row, which staff read only as totals. The work is of a
// kind only this file defines, whose handler the tests control, put on
// the person's own queue as the store's own work would be. The threat
// model is on GRA-1762.

/** What the handler does for an item, by its key; nothing for one without. */
const behaviours = new Map<string, (context: WorkContext) => Promise<void>>();

/** Each run of an item, by its key, and each that ended. */
const started: string[] = [];
const finished: string[] = [];

const ownWork = defineWork({
  kind: `test.own_${crypto.randomUUID().replaceAll("-", "")}`,
  payload: z.strictObject({ key: z.string() }),
  run: async ({ key }, context) => {
    started.push(key);
    await behaviours.get(key)?.(context);
    finished.push(key);
  },
});

/** `person`'s own store, as core names it. */
const ownStore = (person: string) =>
  inJurisdiction(env, env.BRAIN_STORE).getByName(`person:${person}`);

/** A person of their own, whose store holds one source of theirs: its ref. */
const personWithSourceRef = async () => {
  const person = `person-${crypto.randomUUID()}`;
  const source = { producer: "upload", id: crypto.randomUUID() } as const;
  await addSource(env, {
    source,
    change: "1",
    text: `Their own note ${crypto.randomUUID()}`,
    readers: { kind: "owner", personId: person },
  });
  return { person, source };
};

/** A person of their own, whose store holds one source of theirs. */
const personWithSource = async (): Promise<string> => {
  const { person } = await personWithSourceRef();
  return person;
};

/** Runs `person`'s own store's alarm while it is set, at most `most` times. */
const workedOut = async (person: string, most = 10): Promise<void> => {
  for (let run = 0; run < most; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one tick after the other
    if (!(await runDurableObjectAlarm(ownStore(person)))) {
      return;
    }
  }
  throw new Error("The store kept waking");
};

/**
 * An item of this file's work on `person`'s own queue, put there as the
 * store's own work would be, and the store's alarm set as a change of it
 * leaves it.
 */
const enqueueOwn = async (person: string, key: string): Promise<void> => {
  await runInDurableObject(ownStore(person), (_store, state) => {
    enqueueWork(state.storage, ownWork, {
      key,
      payload: { key },
      priority: "recent",
    });
  });
  // Any call that can change the store sets its alarm from what it has to do.
  await ownStore(person).repackVectors();
};

/** When `person`'s own store's alarm is set for, if it is. */
const alarmOf = async (person: string): Promise<number | null> =>
  await runInDurableObject(
    ownStore(person),
    async (_store, state) => await state.storage.getAlarm()
  );

/** What waits in `person`'s own queue, as its overview counts it. */
const waitingIn = async (person: string): Promise<number> => {
  const { waiting } = await ownStore(person).workOverview();
  let count = 0;
  for (const each of waiting) {
    count += each.count;
  }
  return count;
};

/** Staff's totals of people's own stores. */
const totals = async () => {
  const { ownStores } = await brainStaffReport(env);
  return ownStores;
};

/** Waits until `done` holds, for at most `ms`. */
const until = async (done: () => boolean, ms = 10_000): Promise<void> => {
  const giveUpAt = Date.now() + ms;
  while (!done()) {
    if (Date.now() > giveUpAt) {
      throw new Error("It never happened");
    }
    // oxlint-disable-next-line no-await-in-loop -- until it holds
    await scheduler.wait(5);
  }
};

const answer = { text: "An answer.", inputTokens: 10, outputTokens: 5 };

describe("a person's own store at work on its own alarm", () => {
  it("works its own queue on its alarm, asking the model through core's gateway, and staff see it only in totals", async () => {
    const provider = await answeringProvider(() => answer);
    const before = await totals();
    const person = await personWithSource();
    // Its source embedded first, so this item is all its queue holds.
    await workedOut(person);
    const key = `asks-${crypto.randomUUID()}`;
    const answers: string[] = [];
    behaviours.set(key, async ({ ask }) => {
      answers.push(await ask({ system: "Say something.", input: key }));
    });
    await enqueueOwn(person, key);
    const armed = (await alarmOf(person)) !== null;

    const ran = await runDurableObjectAlarm(ownStore(person));
    const after = await totals();

    expect({
      armed,
      ran,
      answers,
      sent: provider.requests.length,
      waiting: await waitingIn(person),
      alarm: await alarmOf(person),
      stores: after.stores - before.stores,
    }).toStrictEqual({
      armed: true,
      ran: true,
      answers: ["An answer."],
      sent: 1,
      waiting: 0,
      // Nothing left: it sleeps until something changes it.
      alarm: null,
      stores: 1,
    });
  });

  it("finishes an item a kill cut off mid-tick, once the store starts again, and runs nothing twice on a tick delivered twice", async () => {
    const person = await personWithSource();
    const key = `killed-${crypto.randomUUID()}`;
    const gate = { open: false };
    behaviours.set(key, async () => {
      while (!gate.open) {
        // oxlint-disable-next-line no-await-in-loop -- until the test opens it
        await scheduler.wait(5);
      }
    });
    await enqueueOwn(person, key);

    // Settled as it is made: the kill rejects it.
    const first = Promise.allSettled([runDurableObjectAlarm(ownStore(person))]);
    await until(() => started.includes(key));
    try {
      await runInDurableObject(ownStore(person), (_store, state) => {
        state.abort("Killed by the test");
      });
    } catch {
      // The kill ends the call it was made in.
    }
    await first;
    gate.open = true;
    // The store starts again: the item cut off is put back, and the store
    // wakes itself for it.
    const armedAgain = (await alarmOf(person)) !== null;
    await runDurableObjectAlarm(ownStore(person));
    const twice = await runDurableObjectAlarm(ownStore(person));

    expect({
      armedAgain,
      runs: started.filter((each) => each === key).length,
      waiting: await waitingIn(person),
      twice,
    }).toStrictEqual({ armedAgain: true, runs: 2, waiting: 0, twice: false });
  });

  it("removes a person's row once their erasure has erased their store, which no recall of theirs wakes again", async () => {
    const person = await personWithSource();
    const key = `before-erasure-${crypto.randomUUID()}`;
    await enqueueOwn(person, key);
    await runDurableObjectAlarm(ownStore(person));
    const kept = await totals();

    const erasing = { personId: person, reason: "person_erased" } as const;
    const first = await erasePerson(env, erasing);
    const whileDeleting = await totals();
    await ageOwnErasure(person);
    const done = await erasePerson(env, erasing);
    const after = await totals();
    // A recall of theirs, as core's makes it of their own store.
    await ownStore(person).find({
      reader: { person, groups: [] },
      question: "Their own note",
      budget: { tokens: 1000 },
    });

    expect({
      first,
      done,
      keptWhileDeleting: whileDeleting.stores - kept.stores,
      removed: kept.stores - after.stores,
      alarm: await alarmOf(person),
      woken: await runDurableObjectAlarm(ownStore(person)),
    }).toStrictEqual({
      first: "still_deleting",
      done: "erased",
      keptWhileDeleting: 0,
      removed: 1,
      alarm: null,
      woken: false,
    });
  });

  it("keeps an erased person's row gone when their erasure lands while a tick of their store is under way", async () => {
    const person = await personWithSource();
    // A tick first, so the store has its row.
    await enqueueOwn(person, `first-${crypto.randomUUID()}`);
    await runDurableObjectAlarm(ownStore(person));
    const key = `held-open-${crypto.randomUUID()}`;
    const gate = { open: false };
    behaviours.set(key, async () => {
      while (!gate.open) {
        // oxlint-disable-next-line no-await-in-loop -- until the test opens it
        await scheduler.wait(5);
      }
    });
    await enqueueOwn(person, key);
    const withRow = await totals();

    // Settled as it is made: the erasure may end it.
    const tick = Promise.allSettled([runDurableObjectAlarm(ownStore(person))]);
    await until(() => started.includes(key));
    const erasing = { personId: person, reason: "person_erased" } as const;
    const first = await erasePerson(env, erasing);
    // Past the time an add has to write its file. The tick under way sent
    // no write (its item is held before any), and, the store erased, it
    // can send none and reports nothing: the erasure is done, and the row
    // stays gone however the tick ends.
    await ageOwnErasure(person);
    const whileTicking = await erasePerson(env, erasing);
    gate.open = true;
    await tick;
    const done = await erasePerson(env, erasing);
    const after = await totals();

    expect({
      first,
      whileTicking,
      done,
      removed: withRow.stores - after.stores,
    }).toStrictEqual({
      first: "still_deleting",
      whileTicking: "erased",
      done: "erased",
      removed: 1,
    });
  });

  it("removes a store's row once erasures took all it held, so staff count only stores that hold anything", async () => {
    const before = await totals();
    const { person, source } = await personWithSourceRef();
    await enqueueOwn(person, `kept-${crypto.randomUUID()}`);
    await workedOut(person);
    const holding = await totals();

    await eraseSource(env, {
      source,
      readers: { kind: "owner", personId: person },
      reason: "deleted",
    });
    // One tick deletes what the erasure hid; its files wait out their
    // grace for a later sweep, which holds nothing of the store's.
    await runDurableObjectAlarm(ownStore(person));
    const emptied = await totals();

    expect({
      holding: holding.stores - before.stores,
      emptied: emptied.stores - before.stores,
    }).toStrictEqual({ holding: 1, emptied: 0 });
  });

  it("ticks and reports a person's own store that holds memories alone", async () => {
    const before = await totals();
    const person = `person-${crypto.randomUUID()}`;
    await ownStore(person).addMemories({
      change: crypto.randomUUID(),
      access: { kind: "owner", person },
      entities: [{ key: "c", kind: "customer", names: ["Acme"] }],
      memories: [
        {
          about: "c",
          type: "fact",
          statement: "Acme renews on 1 March",
          speaker: { kind: "system" },
          basis: { kind: "writer", writer: person },
        },
      ],
    });
    const key = `with-memories-${crypto.randomUUID()}`;
    await enqueueOwn(person, key);
    await workedOut(person);
    const after = await totals();

    expect({
      ran: finished.includes(key),
      waiting: await waitingIn(person),
      stores: after.stores - before.stores,
    }).toStrictEqual({ ran: true, waiting: 0, stores: 1 });
  });

  it("keeps a store's newest report: a late write of an older one never replaces it", async () => {
    const person = `person-${crypto.randomUUID()}`;
    const health = {
      oldestWaitingAt: null,
      parked: 0,
      failing: false,
      notRebuilt: false,
      nearLimit: false,
    };
    const before = await totals();
    await keepOwnStoreHealth(env, person, {
      ...health,
      reportedAt: new Date(2_000_000),
      waiting: 7,
    });
    await keepOwnStoreHealth(env, person, {
      ...health,
      reportedAt: new Date(1_000_000),
      waiting: 3,
    });
    const after = await totals();
    await erasePerson(env, { personId: person, reason: "person_erased" });

    expect({
      stores: after.stores - before.stores,
      waiting: after.waiting - before.waiting,
    }).toStrictEqual({ stores: 1, waiting: 7 });
  });
});
