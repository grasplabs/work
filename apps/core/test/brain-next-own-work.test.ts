import { defineWork, enqueueWork } from "@grasp-os/brain-next/work";
import type { WorkContext } from "@grasp-os/brain-next/work";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { addSource, brainStaffReport, erasePerson } from "../src/brain-next.ts";
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

/** A person of their own, whose store holds one source of theirs. */
const personWithSource = async (): Promise<string> => {
  const person = `person-${crypto.randomUUID()}`;
  await addSource(env, {
    source: { producer: "upload", id: crypto.randomUUID() },
    change: "1",
    text: `Their own note ${crypto.randomUUID()}`,
    readers: { kind: "owner", personId: person },
  });
  return person;
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
    const person = await personWithSource();
    const key = `asks-${crypto.randomUUID()}`;
    const answers: string[] = [];
    behaviours.set(key, async ({ ask }) => {
      answers.push(await ask({ system: "Say something.", input: key }));
    });
    await enqueueOwn(person, key);
    const armed = (await alarmOf(person)) !== null;
    const before = await totals();

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
