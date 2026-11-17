import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { intakeIds } from "../src/onboarding/brain-intake.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { holdAlarm } from "./interview-link.ts";
import { drawingHeld } from "./onboarding-drawings.ts";
import { mapped, rosterOf, team } from "./onboarding-team.ts";
import { signedInApi, unique } from "./sign-in.ts";

// Asking for more voices about a piece of work (brain-work.ts,
// `brain.askMorePeople`): whoever is asked about one of its team's work
// next is asked about it first, the request names the piece of work and
// never who asked (that is the audit log's), and asking twice is one ask.

const idp = mockIdp();

describe(
  "asking more people about a piece of work",
  { timeout: 120_000 },
  () => {
    beforeEach(holdAlarm);

    it("asks the next newcomer about the piece of work asked for, ahead of a larger one", async () => {
      const store = onboardingStore(env);
      // Rik isn't on the list yet.
      const ids = await team(["lea", "max", "mia", "mo", "noor", "pim"]);
      await mapped(ids);
      const works = await store.teamWorks(ids.team);
      // The smaller piece of work: without the ask, a newcomer gets the larger.
      const [smaller] = works.toSorted((one, other) => one.share - other.share);
      if (smaller === undefined) {
        throw new Error("The team's map names no work");
      }
      const brainId = await intakeIds.workflow(ids.team, smaller.id);
      // The Brain page shows the piece of work, as the onboarding holds a
      // drawing of it (GRA-1748).
      await drawingHeld({
        workflow: brainId,
        team: ids.team,
        name: smaller.name,
        drawing: {
          type: "workflowVersion",
          id: `onb-wfv-${unique().replaceAll("-", "")}`,
          workflowId: brainId,
          sourceId: "onb-src-0123456789abcdef0123456789abcdef",
          date: "2026-10-20",
          state: "mapping",
          // Fewer than five so far: more voices are wanted.
          people: 2,
          starts: "",
          steps: [],
          waits: [],
          differently: [],
          decides: "",
          own: "",
          ai: "",
          right: "",
          ask: "",
          next: "",
          term: null,
          differs: null,
          volumes: [],
          takes: null,
          wrong: null,
          open: [],
        },
      });
      const admin = await signedInApi(idp, "admin");
      const asked = await admin.api.brain.askMorePeople(brainId);
      await admin.api.brain.askMorePeople(brainId);
      expect({
        moreAsked: asked.moreAsked,
        wanted: await store.moreVoicesAsked(),
      }).toMatchObject({ moreAsked: true, wanted: [brainId] });

      // A newcomer whose title nobody else has, so no work is theirs alike.
      const newcomer = `new-${unique()}`;
      const roster = rosterOf(ids, ["lea", "max", "mia", "mo", "noor", "pim"]);
      await store.saveRoster(
        {
          ...roster,
          people: [
            ...roster.people,
            {
              id: newcomer,
              name: "Nina New",
              team: ids.team,
              email: "",
              title: "Planner",
              away: false,
            },
          ],
        },
        { type: "system" }
      );
      const after = await store.teamWorks(ids.team);
      const logged = await allEvents();
      const events = logged.filter(
        ({ action }) => action === "brain.work.more_voices_asked"
      );
      expect({
        askedAbout: after.find(({ asked: who }) => who.includes(newcomer))?.id,
        events: events.map(({ target, detail }) => ({ target, detail })),
      }).toStrictEqual({
        askedAbout: smaller.id,
        // Each ask is on record, naming the piece of work alone.
        events: [
          { target: { type: "brain", id: brainId }, detail: {} },
          { target: { type: "brain", id: brainId }, detail: {} },
        ],
      });
    });
  }
);
