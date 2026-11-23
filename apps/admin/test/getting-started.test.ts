import { describe, expect, it } from "vite-plus/test";

import { startItems, started } from "../src/admin/getting-started.ts";
import type { StartFacts } from "../src/admin/getting-started.ts";

// What it takes to get a company started (src/admin/getting-started.ts):
// pure. Each item's standing is what staff act on, so each is read here.

/** A company just added with the whole onboarding: closed, its admin named, nothing else yet. */
const added: StartFacts = {
  window: { open: false, live: false },
  gate: { open: false, openedAt: null },
  admins: ["ada@acme.test"],
  interviews: true,
  roster: false,
  plan: false,
  agreed: false,
  told: false,
  paused: false,
};

/** Each item's standing, by its id. */
const standing = (facts: StartFacts) =>
  Object.fromEntries(startItems(facts).map(({ id, state }) => [id, state]));

/** What the links' row says of what they wait for. */
const linksOf = (facts: StartFacts) =>
  startItems(facts).find(({ id }) => id === "links")?.detail;

describe("getting a company started", () => {
  it("leaves Grasp the staff window and the agreements for a company just added, and waits for its admin for the rest", () => {
    expect(standing(added)).toStrictEqual({
      window: "todo",
      closed: "done",
      admin: "done",
      roster: "waits",
      plan: "waits",
      agreements: "todo",
      links: "waits",
    });
  });

  it("counts a staff window as open only once the company's Grasp has it", () => {
    expect([
      standing({ ...added, window: { open: true, live: false } }).window,
      standing({ ...added, window: { open: true, live: true } }).window,
      standing({ ...added, window: null }).window,
    ]).toStrictEqual(["todo", "done", "todo"]);
  });

  it("asks Grasp to close a company that is open and never got its go, and to name an admin where there is none", () => {
    expect(
      standing({
        ...added,
        gate: { open: true, openedAt: null },
        admins: [],
      })
    ).toMatchObject({ closed: "todo", admin: "todo" });
  });

  it("says what the links still wait for, the first of it", () => {
    expect([
      linksOf(added),
      linksOf({ ...added, roster: true }),
      linksOf({ ...added, roster: true, plan: true }),
      linksOf({ ...added, roster: true, plan: true, agreed: true }),
      // Paused, nothing goes out, whatever else is in.
      linksOf({
        ...added,
        roster: true,
        plan: true,
        agreed: true,
        paused: true,
      }),
    ]).toStrictEqual([
      "Wait for the staff list.",
      "Wait for the plan.",
      "Wait for the agreements: they go out the moment those are in.",
      "Each goes out by email on its day.",
      "The interviews are paused: no link goes out until they run again.",
    ]);
  });

  it("is behind a company once its team is told; and where nobody is interviewed, once the three things every company needs are in place", () => {
    const quiet: StartFacts = { ...added, interviews: false };
    expect({
      told: started({ ...added, told: true }),
      notTold: started({ ...added, roster: true, plan: true, agreed: true }),
      quietItems: Object.keys(standing(quiet)),
      quietWaiting: started(quiet),
      quietReady: started({ ...quiet, window: { open: true, live: true } }),
      // Its flow opened it once its admin finished: nothing asks to close it.
      quietOpened: started({
        ...quiet,
        window: { open: true, live: true },
        gate: { open: true, openedAt: "2026-11-22T10:00:00.000Z" },
      }),
    }).toStrictEqual({
      told: true,
      notTold: false,
      quietItems: ["window", "closed", "admin"],
      quietWaiting: false,
      quietReady: true,
      quietOpened: true,
    });
  });
});
