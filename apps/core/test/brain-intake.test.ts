import type { Workspace } from "@grasp-os/shared/brain";
import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import type { SessionApi } from "@grasp-os/shared/rpc";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { namedIn } from "./brain-intakes.ts";
import { mockIdp } from "./idp.ts";
import { aloneInTheStore, answering, onLink } from "./interview-link.ts";
import {
  agree,
  eightTeam,
  fact,
  fiveToldReply,
  intake,
  kept,
  mapped,
  openLink,
  sevenTeam,
  sevenTold,
  ticketsReply,
  told,
} from "./onboarding-team.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// What the onboarding learned, in the brain (GRA-367,
// src/onboarding/brain-intake.ts): once a piece of work is drawn, its
// team, one source for its interviews, the facts its people agreed to and
// the drawing reach the brain's records, which every member reads.
// The model provider is the outside system, faked behind connect. The
// ways it can fail, tried here:
//
// - A record pointing at a person: their id, their name, their own words
//   or quote, a source of their own, or the lead's facts, whose role alone
//   says who they are.
// - A small team in the brain before five of its people agreed (GRA-329:
//   as many as the interview's notice promises), its lead counted among
//   them though none of their facts reach it.
// - A drawing written over when the work is drawn again.
// - What a record rests on lost, so deleting an interview can't find it.
// - Someone else adding, or squatting on, the onboarding's own records.
// - What someone said, approved or not, on their team's interviews'
//   source: it has no transcript, for members and admins alike, and
//   Grasp's staff read no brain at all.

const idp = mockIdp();

/** Records only the onboarding adds. */
const theOnboardings: { what: string; record: BrainRecordInput }[] = [
  {
    what: "a workflow",
    record: {
      type: "workflow",
      id: "wf-1",
      name: "Tickets",
      teamId: "team-x",
      sourceId: "src-roster",
      status: "drawn",
    },
  },
  {
    what: "an onb- id",
    record: { type: "candidate", id: "onb-st-1", name: "Tickets" },
  },
  {
    what: "a roster team's record",
    record: { type: "team", id: "team-x", name: "Ops", sourceId: "src-roster" },
  },
];

/** What a member's brain shows of a team: its record, its source, its statements and its workflows. */
const shownOf = (brain: Workspace, teamId: string) => {
  const workflow = brain.workflows.find(({ teamId: of }) => of === teamId);
  const [drawing] = workflow?.drawings ?? [];
  const sources = brain.sources.filter(
    ({ teamIds }) => teamIds?.includes(teamId) === true
  );
  const [source] = sources;
  return {
    team: brain.teams.find(({ id }) => id === teamId)?.name,
    source:
      source === undefined
        ? null
        : {
            title: source.title,
            how: source.how,
            kind: source.kind,
            who: source.who ?? null,
          },
    // One source a team, never one a person.
    sources: sources.length,
    statements: brain.statements
      .filter(({ teamIds }) => teamIds.includes(teamId))
      .map(({ kind, text, sourceId }) => ({
        kind,
        text,
        source: sourceId === source?.id,
      })),
    workflow: {
      name: workflow?.name,
      local: workflow?.local,
      status: workflow?.status,
      steps: workflow?.baseline.steps.map(({ text }) => text),
      minutes: workflow?.baseline.steps[0]?.minutes,
      people: drawing?.people,
      volumes: drawing?.volumes,
      takes: drawing?.takes,
      open: drawing?.open,
    },
    // The rota, drawn from the lead alone, stays out.
    rota: brain.workflows.some(({ name }) => name === "planning the rota"),
  };
};

/** The types of `records`, each once, in order. */
const typesOf = (records: readonly { type: string }[]): string[] =>
  [...new Set(records.map(({ type }) => type))].toSorted();

describe(
  "what the onboarding learned, in the brain",
  { timeout: 120_000 },
  () => {
    // The test draws and gives the brain each team itself, with a model
    // faked: the store's own alarm, which has none, would try first.
    beforeEach(aloneInTheStore);

    it("is the team, one source, its statements and the drawn workflow, read by every member, and no record names a person", async () => {
      const store = onboardingStore(env);
      // Seven tell their own work, as a team needs to have claims.
      const ids = await sevenTeam();
      await mapped(ids);
      await sevenTold(ids);
      await answering([fiveToldReply(ids)], async () => await store.drawNext());
      const { gave } = await intake(ids);
      const member = await signedInApi(idp, "user");
      const brain = await member.api.brain.read();
      const records = await kept(ids);
      const teamId = `team-${ids.team}`;
      expect({
        gave,
        ...shownOf(brain, teamId),
        named: namedIn(records, ids),
      }).toStrictEqual({
        gave: `brain:${ids.team}`,
        team: "Ops",
        source: {
          title: "Interviews with Ops",
          how: "8 people",
          kind: "interview",
          who: null,
        },
        sources: 1,
        // The five who said tickets come in through Zendesk, put together;
        // what one of them said alone stays out.
        statements: [
          {
            kind: "tool",
            text: "Tickets come in through Zendesk.",
            source: true,
          },
        ],
        workflow: {
          name: "handling new tickets",
          local: "nieuwe tickets afhandelen",
          status: "drawn",
          // What five told; the step only Max told stays out.
          steps: ["Open the ticket.", "Send the answer."],
          // The median of the five's own normal minutes, never one of theirs
          // as a lowest or highest.
          minutes: { quickest: 4, normal: 4, longest: 4, basis: "estimated" },
          people: 7,
          volumes: [
            {
              of: "me",
              per: "week",
              // Medians of the five's quiet and busy weeks.
              low: 32,
              high: 52,
              people: 5,
              basis: "estimated",
            },
          ],
          takes: {
            unit: "minutes",
            quickest: 3,
            longest: 45,
            people: 5,
            basis: "estimated",
          },
          // Written for the next interviews from what few said: never the brain's.
          open: [],
        },
        rota: false,
        named: { ids: [], names: [], words: false, lead: false },
      });
      // The interviews it learned from, counted by week, five or more a
      // week, on the week's Monday: never who gave them, or on which day.
      expect({
        mondays: brain.interviewWeeks.every(
          ({ week }) => new Date(`${week}T00:00:00Z`).getUTCDay() === 1
        ),
        fiveOrMore: brain.interviewWeeks.every(
          ({ interviews }) => interviews >= 5
        ),
        counted: brain.interviewWeeks.reduce(
          (sum, { interviews }) => sum + interviews,
          0
        ),
      }).toStrictEqual({ mondays: true, fiveOrMore: true, counted: 8 });
    });

    it("keeps only a drawing's newest checked version once it is drawn again, and knows whose interview each record rests on", async () => {
      const store = onboardingStore(env);
      // Seven tell their own work, as a team's drawings need.
      const ids = await sevenTeam();
      await mapped(ids);
      await sevenTold(ids);
      await answering([fiveToldReply(ids)], async () => await store.drawNext());
      await intake(ids);
      const before = await kept(ids);
      // Mia adds something and agrees again: tickets are drawn once more.
      await agree(
        ids.mia,
        [
          fact("i1", "system", "Tickets arrive in Zendesk."),
          fact(
            "i2",
            "wish",
            "Would like the customer number filled in for them."
          ),
          fact("i3", "step", "Closes the ticket once answered."),
        ],
        1
      );
      await answering(
        [fiveToldReply(ids, "Close the ticket.")],
        async () => await store.drawNext()
      );
      // Given again with nothing new, nothing is kept twice.
      const first = await intake(ids);
      const second = await intake(ids);
      const again = [first.gave, second.gave];
      const after = await kept(ids);
      const member = await signedInApi(idp, "user");
      const brain = await member.api.brain.read();
      const workflow = brain.workflows.find(
        ({ teamId }) => teamId === `team-${ids.team}`
      );
      const restsOn = async (person: string) => {
        const sent = await store.sentFor(person);
        return sent.map(({ type }) => type);
      };
      expect({
        again,
        // Nothing held before changed, or went, but the earlier drawing:
        // only the one checked now is the brain's (GRA-1084).
        unchanged: before
          .filter(({ type }) => type !== "workflowVersion")
          .every(({ id, body }) =>
            after.some((each) => each.id === id && each.body === body)
          ),
        earlier: before
          .filter(({ type }) => type === "workflowVersion")
          .some(({ id }) => after.some((each) => each.id === id)),
        added: after
          .filter(({ id }) => !before.some((each) => each.id === id))
          .map(({ type }) => type),
        drawings: workflow?.drawings?.map(({ steps }) => steps.at(-1)?.text),
        baseline: workflow?.baseline.steps.at(-1)?.text,
        rests: {
          max: await restsOn(ids.max),
          mia: await restsOn(ids.mia),
          // The lead named the work, and was the drawing's context; the
          // work rests on whom it was drawn from too.
          lea: await restsOn(ids.lea),
          noor: await restsOn(ids.noor),
        },
      }).toStrictEqual({
        again: [`brain:${ids.team}`, null],
        unchanged: true,
        earlier: false,
        added: ["workflowVersion"],
        drawings: ["Close the ticket."],
        baseline: "Close the ticket.",
        rests: {
          // The claim rests on the five who made it, the drawing on whom it
          // was drawn from.
          max: ["statement", "workflowVersion"],
          mia: ["statement", "workflowVersion"],
          // The lead was the drawing's context.
          lea: ["workflowVersion"],
          noor: ["statement", "workflowVersion"],
        },
      });
    });

    it("takes out a drawing the brain holds from before, with no note of whom it rests on, once the work is drawn and checked anew", async () => {
      const store = onboardingStore(env);
      // Seven tell their own work, as a team's drawings need.
      const ids = await sevenTeam();
      await mapped(ids);
      await sevenTold(ids);
      await answering([fiveToldReply(ids)], async () => await store.drawNext());
      await intake(ids);
      const first = await kept(ids);
      const earlier = first.filter(({ type }) => type === "workflowVersion");
      // As a drawing from before the checks: in the brain, its notes gone.
      await runInDurableObject(store, (_instance, state) => {
        for (const { id } of earlier) {
          state.storage.sql.exec("DELETE FROM brain_sent WHERE record = ?", id);
        }
      });
      await agree(
        ids.mia,
        [
          fact("i1", "system", "Tickets arrive in Zendesk."),
          fact("i3", "step", "Closes the ticket once answered."),
        ],
        1
      );
      await answering(
        [fiveToldReply(ids, "Close the ticket.")],
        async () => await store.drawNext()
      );
      await intake(ids);
      const member = await signedInApi(idp, "user");
      const brain = await member.api.brain.read();
      const workflow = brain.workflows.find(
        ({ teamId }) => teamId === `team-${ids.team}`
      );
      const after = await kept(ids);
      const now = after.filter(({ type }) => type === "workflowVersion");
      expect({
        earlier: earlier.length,
        still: now.some(({ id }) => earlier.some((each) => each.id === id)),
        drawings: workflow?.drawings?.map(({ steps }) => steps.at(-1)?.text),
      }).toStrictEqual({
        earlier: 1,
        still: false,
        drawings: ["Close the ticket."],
      });
    });

    it("counts a week's interviews only of people still taking part, and never moves a week a withdrawal took below five into another", async () => {
      const store = onboardingStore(env);
      // Eight tell their own work, and Lea leads: one of them and Lea
      // going still leaves seven who tell, so the team's interviews show.
      const ids = await eightTeam();
      await mapped(ids);
      await sevenTold(ids);
      await agree(ids.ada, [fact("a1", "step", "Answers the chat.")]);
      // Six finished in the week of 5 October, the other three the week
      // after.
      await runInDurableObject(store, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE interview_states SET completed_at = CASE WHEN person IN (?, ?, ?) THEN '2026-10-13T09:00:00.000Z' ELSE '2026-10-06T09:00:00.000Z' END WHERE completed_at IS NOT NULL",
          ids.rik,
          ids.sam,
          ids.ada
        );
      });
      const member = await signedInApi(idp, "user");
      const weeks = async () => {
        const brain = await member.api.brain.read();
        return brain.interviewWeeks;
      };
      const before = await weeks();
      await onLink({ action: "withdraw", ...(await openLink(ids.pim)) });
      const oneWithdrew = await weeks();
      await onLink({ action: "withdraw", ...(await openLink(ids.lea)) });
      const twoWithdrew = await weeks();
      expect({ before, oneWithdrew, twoWithdrew }).toStrictEqual({
        before: [{ week: "2026-10-05", interviews: 6 }],
        oneWithdrew: [{ week: "2026-10-05", interviews: 5 }],
        // The four left of that week stay out, and never join the three of
        // the week after, where the seven they would make would tell how
        // many were left.
        twoWithdrew: [],
      });
    });

    it("asks no model for a team that can't show its results: under seven who tell, switched off, or switched on again but waiting for the admin", async () => {
      const store = onboardingStore(env);
      const ids = await sevenTeam();
      await mapped(ids);
      /** The team's next intake, the model putting the five's claim together: what it asked of it, and what it noted. */
      const intakeNow = async () => {
        const { gave, requests } = await intake(ids);
        return {
          gave,
          asked: requests.length,
          noted: typesOf(await kept(ids)),
        };
      };
      /** Sam agrees to `facts`, and the work is drawn again: the team is due. */
      const samTold = async (facts: string[], version?: number) => {
        await agree(
          ids.sam,
          facts.map((text, at) => fact(`s${at}`, "step", text)),
          version
        );
        await answering(
          [ticketsReply(ids)],
          async () => await store.drawNext()
        );
      };
      // Six tell their own work (Lea leads: not counted), five of them of
      // Zendesk alike.
      await told(ids);
      await answering([ticketsReply(ids)], async () => await store.drawNext());
      const six = await intakeNow();
      // Sam too: seven, the team's results may show, and its intake asks.
      await samTold(["Answers the phone."]);
      const seven = await intakeNow();
      // Switched off, confirmed; then on again in a save not confirmed.
      const view = await store.view();
      const roster = view.roster ?? { teams: [], people: [] };
      const by = { type: "system" } as const;
      await store.saveRoster(
        {
          ...roster,
          teams: roster.teams.map((each) => ({ ...each, off: true })),
        },
        by
      );
      await samTold(["Answers the phone.", "Logs the call."], 1);
      const off = await intakeNow();
      await store.saveRoster(roster, by, { confirmed: false });
      await samTold(
        ["Answers the phone.", "Logs the call.", "Closes the call."],
        2
      );
      const waiting = await intakeNow();
      const due = `brain:${ids.team}`;
      expect({
        six,
        seven: { ...seven, asked: seven.asked > 0 },
        off,
        waiting,
      }).toStrictEqual({
        six: { gave: due, asked: 0, noted: [] },
        seven: {
          gave: due,
          asked: true,
          noted: ["statement", "workflow", "workflowVersion"],
        },
        off: { gave: due, asked: 0, noted: [] },
        waiting: { gave: due, asked: 0, noted: [] },
      });
    });

    it("shows a member a team's name, its interviews and their weeks only while its results may show: not at six who tell, nor once it is switched off or waiting for the admin", async () => {
      const store = onboardingStore(env);
      const ids = await sevenTeam();
      await mapped(ids);
      await told(ids);
      const member = await signedInApi(idp, "user");
      const teamId = `team-${ids.team}`;
      const shown = async () => {
        const brain = await member.api.brain.read();
        return {
          team: brain.teams.some(({ id }) => id === teamId),
          interviews:
            brain.sources.find(
              ({ teamIds }) => teamIds?.includes(teamId) === true
            )?.how ?? null,
          weeks: brain.interviewWeeks.reduce(
            (sum, { interviews }) => sum + interviews,
            0
          ),
        };
      };
      // Six tell their own work, and the team's intake runs.
      await answering([ticketsReply(ids)], async () => await store.drawNext());
      await intake(ids);
      const six = await shown();
      // Sam too: seven.
      await agree(ids.sam, [fact("s1", "step", "Answers the phone.")]);
      await answering([ticketsReply(ids)], async () => await store.drawNext());
      await intake(ids);
      const seven = await shown();
      // The admin switches the team off, then on again in a save not
      // confirmed, then confirms it.
      const view = await store.view();
      const roster = view.roster ?? { teams: [], people: [] };
      const by = { type: "system" } as const;
      await store.saveRoster(
        {
          ...roster,
          teams: roster.teams.map((each) => ({ ...each, off: true })),
        },
        by
      );
      const off = await shown();
      await store.saveRoster(roster, by, { confirmed: false });
      const waiting = await shown();
      await store.saveRoster(roster, by);
      const confirmed = await shown();
      await intake(ids);
      const again = await shown();
      expect({ six, seven, off, waiting, confirmed, again }).toStrictEqual({
        // The roster's team, as the admin confirmed it, without its
        // interviews.
        six: { team: true, interviews: null, weeks: 0 },
        seven: { team: true, interviews: "8 people", weeks: 8 },
        off: { team: false, interviews: null, weeks: 0 },
        waiting: { team: false, interviews: null, weeks: 0 },
        // A member reads the interviews as what its claims cite: back
        // once its next intake notes them again.
        confirmed: { team: true, interviews: null, weeks: 8 },
        again: { team: true, interviews: "8 people", weeks: 8 },
      });
    });

    it("gives its interviews' source no transcript and no statement, for members and admins alike, and nothing to staff or anyone outside", async () => {
      const store = onboardingStore(env);
      // Seven tell their own work, as a team needs to have claims.
      const ids = await sevenTeam();
      await mapped(ids);
      await sevenTold(ids);
      // Rik also says something he doesn’t approve.
      await agree(
        ids.rik,
        [
          fact("r1", "step", "Checks the queue at noon."),
          {
            id: "r2",
            tag: "rule",
            text: "You said: Rik skips the queue for his friends.",
            record: "Rik skips the queue for his friends.",
          },
        ],
        1,
        [{ from: "person", text: "Honestly Lea never answers her mail." }]
      );
      await answering([ticketsReply(ids)], async () => await store.drawNext());
      await intake(ids);
      // Nick (GRA-529): members and admins see only what five or more
      // people said, put together, and staff only numbers. Nothing core
      // holds is that yet, so the source has no turns for anyone: only how
      // many people it rests on.
      const member = await signedInApi(idp, "user");
      const admin = await signedInApi(idp, "admin");
      const { core: staffCore } = await openRpc(
        await signedIn(idp, "grasp-staff", staffPerson())
      );
      const staff = staffCore.authenticate();
      const { core: nobodyCore } = await openRpc();
      const teamId = `team-${ids.team}`;
      const records = await kept(ids);
      const said = [
        ...records.flatMap(({ type, body }) =>
          type === "statement"
            ? [z.object({ text: z.string() }).parse(JSON.parse(body)).text]
            : []
        ),
        "Lea never answers",
        "skips the queue",
      ];
      const shownTo = async (api: SessionApi) => {
        const brain = await api.brain.read();
        const source = brain.sources.find(
          ({ teamIds }) => teamIds?.includes(teamId) === true
        );
        const shown = JSON.stringify(source);
        return {
          listed: source === undefined ? null : { how: source.how },
          turns: source?.transcriptTurns,
          inListing: source?.transcript,
          statements: said.filter((words) => shown.includes(words)),
        };
      };
      const safe = {
        listed: { how: "8 people" },
        turns: undefined,
        inListing: undefined,
        statements: [],
      };
      expect({
        said: said.length > 2,
        // Staff read no brain at all (staff-scope.test.ts).
        staff: await outcome(staff.brain.read()),
        admin: await shownTo(admin.api),
        member: await shownTo(member.api),
        nobody: await outcome(nobodyCore.authenticate().brain.read()),
      }).toStrictEqual({
        said: true,
        staff: "role.forbidden",
        admin: safe,
        member: safe,
        nobody: "auth.unauthenticated",
      });
    });

    it.each(theOnboardings)(
      "is the onboarding's alone: an admin can't add $what",
      async ({ record }) => {
        const admin = await signedInApi(idp, "admin");
        const result = await outcome(admin.api.brain.addRecords([record]));
        expect(result).toBe("brain.record_invalid");
      }
    );
  }
);
