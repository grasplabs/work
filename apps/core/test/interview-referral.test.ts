import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { referred } from "../src/onboarding/referral.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { answering } from "./interview-link.ts";
import { agree, fact, mapped, team } from "./onboarding-team.ts";

// When someone says the work they were asked about isn't theirs
// (GRA-1285, src/onboarding/referral.ts): once they agree to it, Grasp
// moves them onto the work they do, puts the colleague they named on the
// other and asks that colleague about it, without a word of what was
// said about them; the log says who named whom.
// AI Gateway is faked behind the AI binding.

/** The model's reading of who does what: by id, or "none". */
const referralReply = (does: string, person: string) => ({
  text: JSON.stringify({ does, person }),
  inputTokens: 100,
  outputTokens: 20,
});

describe("work someone says isn't theirs", () => {
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
    const { entries } = await store.staffLog({ what: "interview.referred" });
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
      logged: entries.map(({ person, named }) => [person?.id, named?.id]),
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
