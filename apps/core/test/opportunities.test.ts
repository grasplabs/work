import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { eraseOwedOnboardingSources } from "../src/onboarding/new-brain.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import { aloneInTheStore, answering, onLink } from "./interview-link.ts";
import {
  agree,
  fact,
  fiveToldReply,
  intake,
  mapped,
  openLink,
  team,
  told,
  zendeskClaim,
} from "./onboarding-team.ts";
import type { Ids, Key } from "./onboarding-team.ts";
import type { ProviderReply } from "./provider-streams.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// Opportunities (GRA-1750): each of a team's routines (GRA-1749) as an
// admin reads it, ranked by the hours a week it takes, with its evidence
// and what Grasp proposes for it. The ways it can fail, tried here:
//
// - Anyone but an admin reading the list or dismissing one.
// - A model's answer taken on trust: an App it wasn't given, a system the
//   routine never names, a step it hasn't.
// - The model asked again for what it answered at the same evidence.
// - A dismissal that outlives the evidence it was made at, or one that
//   lets go before.

const idp = mockIdp();

/** Seven who tell their own work besides Lea, the lead. */
const seven: readonly Key[] = [
  "lea",
  "max",
  "mia",
  "mo",
  "noor",
  "pim",
  "rik",
  "sam",
];

/** A drawing's answer as the fake model gives it: its numbers, and the rest as is. */
const drawnSchema = z.looseObject({
  numbers: z.array(z.record(z.string(), z.unknown())),
});

/**
 * The tickets as five told them (`fiveToldReply`), each count of how
 * many come in given as the whole team's: 30 to 34 in a quiet week and 50
 * to 54 in a busy one, so 32 and 52, and 42 in the middle; one takes 3 to
 * 45 minutes, 24 in the middle: 16.8 hours a week. With `last`, its last
 * step in other words: new evidence.
 */
const ticketsAsTheTeamCounts = (
  ids: Ids,
  last = "Send the answer."
): ProviderReply => {
  const reply = fiveToldReply(ids, last);
  const drawn = drawnSchema.parse(
    JSON.parse("text" in reply ? reply.text : "{}")
  );
  return {
    ...reply,
    text: JSON.stringify({
      ...drawn,
      numbers: drawn.numbers.map((each) => ({ ...each, of: "team" })),
    }),
  };
};

/** What the model proposes for the tickets: `answer`, as JSON. */
const proposing = (answer: unknown): ProviderReply => ({
  text: JSON.stringify(answer),
  inputTokens: 1000,
  outputTokens: 100,
});

/** The tickets drawn again, `last` their last step, and the team's intake given. */
const drawTickets = async (ids: Ids, last?: string) => {
  await answering(
    [ticketsAsTheTeamCounts(ids, last)],
    async () => await onboardingStore(env).drawNext()
  );
  const { gave } = await intake(ids, [zendeskClaim]);
  if (gave !== `brain:${ids.team}`) {
    throw new Error("The team's intake was never given.");
  }
};

/** A team through the onboarding, its tickets drawn and its intake given; and the version of Sam's interview. */
const drawnTeam = async () => {
  const ids = await team(seven);
  await mapped(ids);
  await told(ids);
  const sam = await agree(ids.sam, [fact("s1", "step", "Answers the phone.")]);
  await drawTickets(ids);
  return { ids, sam };
};

/** The tickets' opportunity, as `api` lists it while the model answers `replies`; and the requests it got. */
const ticketsOf = async (
  api: Awaited<ReturnType<typeof signedInApi>>["api"],
  ids: Ids,
  replies: ProviderReply[] = []
) => {
  const { requests, result } = await answering(
    replies,
    async () => await api.opportunities.list()
  );
  return {
    asked: requests.length,
    tickets: result.find(
      ({ team: of, name }) => of === ids.team && name === "handling new tickets"
    ),
  };
};

describe("opportunities", { timeout: 120_000 }, () => {
  beforeEach(aloneInTheStore);

  it("give an admin each routine, ranked by its hours a week, with its evidence and the form proposed, held to what the model was given, asked once", async () => {
    const { ids } = await drawnTeam();
    const { api } = await signedInApi(idp, "admin");
    const first = await ticketsOf(api, ids, [
      proposing({
        form: "workflow",
        // An App it was never given, a system the routine never names, and
        // a step it hasn't: all left out.
        covers: "app-it-was-never-given",
        systems: ["Zendesk", "Salesforce"],
        personApproves: [3, 9],
      }),
    ]);
    const again = await ticketsOf(api, ids);
    expect({
      first: first.tickets,
      asked: first.asked,
      againAsked: again.asked,
      same: again.tickets?.evidence === first.tickets?.evidence,
    }).toMatchObject({
      first: {
        casesPerWeek: 42,
        hoursPerWeek: 16.8,
        basis: "described",
        form: "workflow",
        covers: null,
        // Nothing is connected: Zendesk is a setup step.
        setup: ["Zendesk"],
        personApproves: [3],
        steps: [
          "Open the ticket.",
          "Ask someone when the customer number is missing.",
          "Send the answer.",
        ],
      },
      asked: 1,
      againAsked: 0,
      same: true,
    });
  });

  it("point a routine an existing App covers at that App, as a change to it", async () => {
    const { ids } = await drawnTeam();
    const { api } = await signedInApi(idp, "admin");
    const { id: app } = await api.apps.create({ name: "Ticket desk" });
    const { tickets } = await ticketsOf(api, ids, [
      proposing({ form: "app", covers: app, systems: [], personApproves: [] }),
    ]);
    expect({ form: tickets?.form, covers: tickets?.covers }).toStrictEqual({
      form: "change",
      covers: { app, name: "Ticket desk" },
    });
  });

  it("hide a dismissed opportunity from every admin until its evidence changes", async () => {
    const { ids, sam } = await drawnTeam();
    const { api } = await signedInApi(idp, "admin");
    const other = await signedInApi(idp, "admin");
    const answer = proposing({ form: "workflow", systems: [] });
    const { tickets } = await ticketsOf(api, ids, [answer]);
    if (tickets === undefined) {
      throw new Error("The tickets were never listed.");
    }
    await api.opportunities.dismiss({
      routine: tickets.routine,
      evidence: tickets.evidence,
    });
    const dismissed = await ticketsOf(other.api, ids);
    // Sam adds to his interview, and the tickets are drawn anew, their
    // last step told otherwise: new evidence.
    await agree(
      ids.sam,
      [
        fact("s1", "step", "Answers the phone."),
        fact("s2", "step", "Closes the ticket once answered."),
      ],
      sam
    );
    await drawTickets(ids, "Close the ticket once answered.");
    const redrawn = await ticketsOf(api, ids, [answer]);
    expect({
      dismissed: dismissed.tickets,
      back: redrawn.tickets !== undefined,
      newEvidence: redrawn.tickets?.evidence !== tickets.evidence,
    }).toStrictEqual({ dismissed: undefined, back: true, newEvidence: true });
  });

  it("drop a routine's opportunity as a withdrawal takes its drawing down, and keep nothing of it once the drawing is erased", async () => {
    const { ids } = await drawnTeam();
    const { api } = await signedInApi(idp, "admin");
    const { tickets } = await ticketsOf(api, ids, [
      proposing({ form: "workflow", systems: ["Zendesk"] }),
    ]);
    if (tickets === undefined) {
      throw new Error("The tickets were never listed.");
    }
    await onLink({ action: "withdraw", ...(await openLink(ids.pim)) });
    const withdrawn = await ticketsOf(api, ids);
    await eraseOwedOnboardingSources(env);
    const kept = await env.DB.prepare(
      "SELECT COUNT(*) AS kept FROM opportunity_proposals WHERE evidence = ?"
    )
      .bind(tickets.evidence)
      .first<{ kept: number }>();
    expect({ withdrawn: withdrawn.tickets, kept: kept?.kept }).toStrictEqual({
      withdrawn: undefined,
      kept: 0,
    });
  });

  it("refuse anyone but an admin, listing or dismissing", async () => {
    const { api } = await signedInApi(idp, "user");
    expect({
      list: await outcome(api.opportunities.list()),
      dismiss: await outcome(
        api.opportunities.dismiss({ routine: "a", evidence: "b" })
      ),
    }).toStrictEqual({
      list: "role.forbidden",
      dismiss: "role.forbidden",
    });
  });
});
