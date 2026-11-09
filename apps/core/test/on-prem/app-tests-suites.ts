import { suiteOf } from "./app-test-harness.ts";

// The suites app-tests*.test.ts run on-prem.

/** Passes on the refusal it gets while the App's calls have no place. */
export const catching = suiteOf(`
      await t.rejectsCode(owner.query(api.notes.list, page), "function.sandbox_busy");
`);

/** What a suite stopped past its CPU time fails with. */
export const stoppedOnCpu = /^tests\/notes\.test\.ts: it stopped: .*CPU time/u;

/** Three calls at once, and a live query read again as they write. */
export const parallel = suiteOf(`
      const live = await owner.subscribe(api.notes.list, page);
      const ids = await Promise.all([
        owner.mutation(api.notes.create, { title: "One" }),
        owner.mutation(api.notes.create, { title: "Two" }),
        owner.mutation(api.notes.create, { title: "Three" }),
      ]);
      const lists = await Promise.all([
        owner.query(api.notes.list, page),
        owner.query(api.notes.list, page),
        owner.query(api.notes.list, page),
      ]);
      t.equal(lists.map((list) => list.items.length), [3, 3, 3]);
      await live.next((found) => ids.every((id) => found.items.some((note) => note._id === id)));
      await live.close();
`);

/** Catches the refusal it gets while the App's calls have no place, then spins. */
export const refusedThenStopped = suiteOf(`
      await owner.query(api.notes.list, page).catch(() => null);
      for (;;) {}
`);

/** Spins in a test, past any CPU time. */
export const spinning = suiteOf("for (;;) {}");
