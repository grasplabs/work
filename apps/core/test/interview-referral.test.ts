import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { referred } from "../src/onboarding/referral.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { aloneInTheStore, answering } from "./interview-link.ts";
import { onboardingLog } from "./onboarding-log.ts";
import { agree, anonymous, fact, mapped, team } from "./onboarding-team.ts";

// When someone says the work they were asked about isn't theirs
// (GRA-1285, src/onboarding/referral.ts): once they agree to it, Grasp
// moves them onto the work they do, puts the colleague they named on the
// other and asks that colleague about it, without a word of what was
// said about them; the log says who named whom.
// AI Gateway is faked behind the AI binding.

/** The words the team's map gave its pieces of work, in English and in the team's language. */
const mapWords = [
  "handling new tickets",
  "nieuwe tickets afhandelen",
  "planning the rota",
  "het rooster plannen",
];

/** The model's reading of who does what: by id, or "none". */
const referralReply = (does: string, person: string) => ({
  text: JSON.stringify({ does, person }),
  inputTokens: 100,
  outputTokens: 20,
});

describe("work someone says isn't theirs", () => {
  // The test draws itself, each with the model's answer it gives: the
  // store's own alarm, set whenever a team falls due, would try first.
  beforeEach(aloneInTheStore);

  it("moves them onto their own work, puts the colleague they named on it, and logs who named whom", async () => {
    const store = onboardingStore(env);
    const ids = await team(["lea", "max", "mia", "mo", "pim"]);
    await mapped(ids);
    const works = await store.teamWorks(ids.team);
    const tickets = works.find(({ name }) => name === "handling new tickets");
    const rota = works.find(({ name }) => name === "planning the rota");
    if (tickets === undefined || rota === undefined) {
      throw new Error("Expected the team's map");
    }

    await agree(ids.max, [
      fact("x1", "who", "Pim handles the new tickets, not Max."),
      fact("x2", "work", "Max plans the rota with Lea."),
    ]);
    const { requests } = await answering(
      [referralReply(rota.id, ids.pim)],
      async () => await store.drawNext()
    );

    const after = await store.teamWorks(ids.team);
    const [maxContext, pimContext] = await Promise.all([
      store.contextOf(ids.max),
      store.contextOf(ids.pim),
    ]);
    const entries = await onboardingLog("interview.referred", store);
    expect({
      read: requests.length,
      ticketsBy: after.find(({ id }) => id === tickets.id)?.doers.toSorted(),
      rotaBy: after.find(({ id }) => id === rota.id)?.doers.includes(ids.max),
      maxAsked: maxContext?.work,
      maxKnows: maxContext?.known.includes(
        "said the work they were asked about is not theirs"
      ),
      pimAsked: pimContext?.work,
      pimHearsMax: [
        "Pim handles the new tickets",
        "Max plans the rota",
        "not theirs",
      ].filter((words) => (pimContext?.known ?? "").includes(words)),
      logged: entries.map(({ about, named }) => [about, named]),
    }).toStrictEqual({
      read: 1,
      ticketsBy: [ids.mia, ids.mo, ids.pim].toSorted(),
      rotaBy: true,
      maxAsked: rota.local,
      maxKnows: true,
      pimAsked: tickets.local,
      pimHearsMax: [],
      logged: [[ids.max, ids.pim]],
    });
  });

  it("names no piece of a map that no longer stands to the model, and refers nobody by it (GRA-1987)", async () => {
    const store = onboardingStore(env);
    const ids = await team(["lea", "max", "mia", "mo", "pim"]);
    await mapped(ids);
    // Lea moves the line her map's tickets came from to only counted anonymously.
    await agree(
      ids.lea,
      [
        anonymous(fact("l1", "work", "Max, Mia and Mo handle new tickets.")),
        fact(
          "l2",
          "system",
          "The team lives in Zendesk and the lead's own rota sheet."
        ),
      ],
      1
    );
    await agree(ids.max, [
      fact("x1", "who", "Pim handles the new tickets, not Max."),
      fact("x2", "work", "Max plans the rota with Lea."),
    ]);
    const sent: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one thing due at a time, as the alarm takes them
      const { requests } = await answering(
        [],
        async () => await store.drawNext()
      );
      // What each request told the model from the store: its messages, not
      // the fixed instructions, whose examples use words like these.
      sent.push(
        ...requests.map(({ body }) =>
          JSON.stringify(
            z.object({ messages: z.unknown() }).safeParse(body).data?.messages
          )
        )
      );
    }
    const entries = await onboardingLog("interview.referred", store);
    expect({
      named: sent.some((said) => mapWords.some((word) => said.includes(word))),
      // The store is shared: only this test's Max counts.
      referred: entries.filter(({ about }) => about === ids.max).length,
    }).toStrictEqual({ named: false, referred: 0 });
  });

  it("names nobody outside the work's team, nobody away, and nobody who already talked", () => {
    const works = [
      { id: "tickets", team: "ops", doers: ["max", "mia"] },
      { id: "rota", team: "ops", doers: ["lea"] },
    ];
    const people = [
      { id: "max", team: "ops", away: false },
      { id: "mia", team: "ops", away: false },
      { id: "sam", team: "sales", away: false },
      { id: "ava", team: "ops", away: true },
    ];
    const by = (who: string | null) =>
      referred(
        works,
        { by: "max", asked: "tickets", does: "rota", who },
        people,
        (id) => id === "mia"
      );

    expect({
      otherTeam: by("sam").invite,
      away: by("ava").invite,
      talked: by("mia").invite,
      themselves: by("max").invite,
      moved: by(null).works,
    }).toStrictEqual({
      otherTeam: null,
      away: null,
      talked: null,
      themselves: null,
      moved: [
        { id: "tickets", doers: ["mia"] },
        { id: "rota", doers: ["lea", "max"] },
      ],
    });
  });
});
