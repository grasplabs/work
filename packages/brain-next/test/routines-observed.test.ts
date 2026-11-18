// Routines seen in activity (routines-observed.ts, GRA-1764), at the
// store's own boundary: which step follows which, held to five distinct
// people of a team inside the read, worked out again at every read.
import type { NewEvent, ObservedRoutine } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Store } from "./export-reads.ts";

const shared = (): Store => env.BRAIN_STORE.getByName("brain");

const hourMs = 60 * 60 * 1000;

/** Some hours ago, on the hour: inside the time events are kept. */
const base = Math.floor(Date.now() / hourMs) * hourMs - 200 * hourMs;

/** A tag of a person, as the host makes one: 64 hex characters. */
const personTag = (): string =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** A step of a trail: its system, its kind, whether it writes, and the hour it was taken at. */
interface Taken {
  system: string;
  step: string;
  writes?: boolean;
  hour: number;
}

/** `who`'s steps in `team`, as events. */
const trail = (
  team: string,
  who: string,
  steps: readonly Taken[]
): NewEvent[] =>
  steps.map(({ system, step, writes = false, hour }) => ({
    key: crypto.randomUUID(),
    team,
    step,
    system,
    writes,
    item: null,
    who,
    at: new Date(base + hour * hourMs).toISOString(),
  }));

/** The routines the shared store answers for `team` now. */
const routinesOf = async (team: string): Promise<ObservedRoutine[]> => {
  const routines = await shared().observedRoutines();
  return routines.filter((each) => each.team === team);
};

/** A deal read in the CRM, then a mail written about it an hour later. */
const dealThenMail = (start: number, gap = 1): Taken[] => [
  { system: "crm", step: "deals.read", hour: start },
  { system: "mail", step: "mail.send", writes: true, hour: start + gap },
];

/** `people` new people of `team`, each taking `steps(person)`. */
const peopleTake = async (
  team: string,
  people: number,
  steps: (person: number) => Taken[]
): Promise<string[]> => {
  const tags = Array.from({ length: people }, personTag);
  await shared().addEvents({
    events: tags.flatMap((who, person) => trail(team, who, steps(person))),
  });
  return tags;
};

describe("routines seen in activity", () => {
  it("show what five people of a team did, never what four did", async () => {
    const five = `team:${crypto.randomUUID()}`;
    const four = `team:${crypto.randomUUID()}`;
    await peopleTake(five, 5, () => dealThenMail(0));
    await peopleTake(four, 4, () => dealThenMail(0));

    expect({
      five: await routinesOf(five),
      four: await routinesOf(four),
    }).toStrictEqual({
      five: [
        {
          team: five,
          steps: [
            {
              system: "crm",
              step: "deals.read",
              writes: false,
              hoursAfter: null,
              copied: false,
            },
            {
              system: "mail",
              step: "mail.send",
              writes: true,
              hoursAfter: 1,
              // Read in one system, written into another: copied.
              copied: true,
            },
          ],
          variants: [],
        },
      ],
      four: [],
    });
  });

  it("count people, not events: five of one person's are one person", async () => {
    const team = `team:${crypto.randomUUID()}`;
    await peopleTake(team, 1, () =>
      Array.from({ length: 5 }, (_, at) => dealThenMail(at * 10)).flat()
    );

    await expect(routinesOf(team)).resolves.toStrictEqual([]);
  });

  it("show a variant five took, and a timing no one person sets", async () => {
    const team = `team:${crypto.randomUUID()}`;
    // Six read a deal and mail; one of them mails nine hours later, again
    // and again. Five others read a deal and update it in the CRM.
    await peopleTake(team, 6, (person) =>
      person === 0
        ? Array.from({ length: 20 }, (_, at) => dealThenMail(at * 20, 9)).flat()
        : dealThenMail(0)
    );
    await peopleTake(team, 5, () => [
      { system: "crm", step: "deals.read", hour: 0 },
      { system: "crm", step: "deals.update", writes: true, hour: 2 },
    ]);
    const [routine] = await routinesOf(team);

    expect({
      steps: routine?.steps.map(({ step, hoursAfter, copied }) => ({
        step,
        hoursAfter,
        copied,
      })),
      variants: routine?.variants,
    }).toStrictEqual({
      steps: [
        { step: "deals.read", hoursAfter: null, copied: false },
        { step: "mail.send", hoursAfter: 1, copied: true },
      ],
      // Written in the system it was read in: no copy.
      variants: [{ after: 0, system: "crm", step: "deals.update" }],
    });
  });

  it("fall at the next read once a person's erasure leaves four, and name no one", async () => {
    const team = `team:${crypto.randomUUID()}`;
    const tags = await peopleTake(team, 5, () => dealThenMail(0));
    const before = await routinesOf(team);
    await shared().eraseEvents({ who: [tags[0] ?? ""] });

    expect({
      shown: before.length,
      namesNoOne: tags.every((who) => !JSON.stringify(before).includes(who)),
      after: await routinesOf(team),
    }).toStrictEqual({ shown: 1, namesNoOne: true, after: [] });
  });
});
