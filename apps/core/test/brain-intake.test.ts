import type { Workspace } from "@grasp-os/shared/brain";
import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import { answering } from "./interview-link.ts";
import {
  agree,
  fact,
  kept,
  mapped,
  othersTold,
  team,
  ticketsReply,
  told,
} from "./onboarding-team.ts";
import type { Ids } from "./onboarding-team.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// What the onboarding learned, in the brain (GRA-367,
// src/onboarding/brain-intake.ts): once a piece of work is drawn, its
// team, one source for its interviews, the facts its people agreed to and
// the drawing reach the brain's records, which every member reads.
// AI Gateway is the outside system, faked behind the AI binding. The ways
// it can fail, tried here:
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
// - What someone said, or a fact they didn't approve, in the transcript of
//   their team's interviews: its turns are the approved statements alone.

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

/** Whom the stored records point at: anyone's id or name, their own words, or the lead's facts. */
const namedIn = (records: { body: string }[], ids: Ids) => {
  const stored = records.map(({ body }) => body).join("\n");
  const names = ["Lea", "Lind", "Max", "Mol", "Mia", "Mo", "Noor", "Nijs"];
  return {
    ids: [ids.lea, ids.max, ids.mia, ids.mo, ids.noor].filter((id) =>
      stored.includes(id)
    ),
    names: names.filter((name) =>
      new RegExp(`\\b${name}\\b`, "u").test(stored)
    ),
    words: stored.includes("You said"),
    lead: stored.includes("rota sheet"),
  };
};

describe(
  "what the onboarding learned, in the brain",
  { timeout: 120_000 },
  () => {
    it("is the team, one source, its statements and the drawn workflow, read by every member, and no record names a person", async () => {
      const store = onboardingStore(env);
      const ids = await team();
      await mapped(ids);
      await told(ids);
      await answering([ticketsReply(ids)], async () => await store.drawNext());
      const gave = await store.intakeNext();
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
          how: "7 people",
          kind: "interview",
          who: null,
        },
        sources: 1,
        statements: [
          { kind: "tool", text: "Tickets arrive in Zendesk.", source: true },
          {
            kind: "handover",
            text: "Someone hands billing questions to someone.",
            source: true,
          },
          {
            kind: "wish",
            text: "Would like the customer number filled in for them.",
            source: true,
          },
          {
            kind: "blocker",
            text: "A ticket waits days for the customer's reply.",
            source: true,
          },
        ],
        workflow: {
          name: "handling new tickets",
          local: "nieuwe tickets afhandelen",
          status: "drawn",
          steps: [
            "Open the ticket.",
            "Ask someone when the customer number is missing.",
            "Send the answer.",
          ],
          minutes: { quickest: 1, normal: 2, longest: 5, basis: "estimated" },
          people: 6,
          volumes: [
            {
              of: "me",
              per: "week",
              low: 30,
              high: 50,
              people: 2,
              basis: "estimated",
            },
          ],
          takes: {
            unit: "minutes",
            quickest: 3,
            longest: 45,
            people: 2,
            basis: "estimated",
          },
          open: ["Why do some ask someone?"],
        },
        rota: false,
        named: { ids: [], names: [], words: false, lead: false },
      });
    });

    it("keeps a drawing drawn again as a new version, the first as it was, and knows whose interview each record rests on", async () => {
      const store = onboardingStore(env);
      const ids = await team();
      await mapped(ids);
      await told(ids);
      await answering([ticketsReply(ids)], async () => await store.drawNext());
      await store.intakeNext();
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
        [ticketsReply(ids, "Close the ticket.")],
        async () => await store.drawNext()
      );
      // Given again with nothing new, nothing is kept twice.
      const again = [await store.intakeNext(), await store.intakeNext()];
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
        // Nothing held before changed, or went.
        unchanged: before.every(({ id, body }) =>
          after.some((each) => each.id === id && each.body === body)
        ),
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
        added: ["workflowVersion"],
        drawings: ["Send the answer.", "Close the ticket."],
        baseline: "Close the ticket.",
        rests: {
          max: [
            "statement",
            "statement",
            "workflow",
            "workflowVersion",
            "workflowVersion",
          ],
          mia: [
            "statement",
            "statement",
            "workflow",
            "workflowVersion",
            "workflowVersion",
          ],
          lea: ["workflow", "workflowVersion", "workflowVersion"],
          // Noor told a step only: the drawings rest on her, no statement.
          noor: ["workflow", "workflowVersion", "workflowVersion"],
        },
      });
    });

    it("holds back a team until five who tell their own work agreed: its lead isn't counted", async () => {
      const store = onboardingStore(env);
      const ids = await team(["lea", "max", "mia", "mo", "noor", "pim"]);
      await mapped(ids);
      await agree(ids.max, [
        fact("m2", "system", "Tickets arrive in Zendesk."),
      ]);
      await agree(ids.mia, [
        fact(
          "i2",
          "wish",
          "Would like the customer number filled in for them."
        ),
      ]);
      await agree(ids.mo, [
        fact("o1", "wait", "A ticket waits days for the customer's reply."),
      ]);
      await agree(ids.noor, [fact("n1", "step", "Reads the ticket first.")]);
      await answering([ticketsReply(ids)], async () => await store.drawNext());
      // Lea and four: five people, but only four whose facts reach it.
      const early = await store.intakeNext();
      const waiting = await kept(ids);
      await agree(ids.pim, [fact("p1", "step", "Tags the ticket.")]);
      await answering([ticketsReply(ids)], async () => await store.drawNext());
      const late = await store.intakeNext();
      const given = await kept(ids);
      expect({
        early,
        waiting: waiting.length,
        late,
        types: [...new Set(given.map(({ type }) => type))].toSorted(),
      }).toStrictEqual({
        early: `brain:${ids.team}`,
        waiting: 0,
        late: `brain:${ids.team}`,
        types: ["statement", "team", "workflow", "workflowVersion"],
      });
    });

    it("carries as its interviews' transcript only the statements their people approved, never what they said, read or left unapproved", async () => {
      const store = onboardingStore(env);
      const ids = await team();
      await mapped(ids);
      await agree(ids.max, [
        fact("m1", "step", "Opens the ticket in Zendesk."),
        fact("m2", "system", "Tickets arrive in Zendesk."),
        fact("m3", "handoff", "Max hands billing questions to Noor."),
      ]);
      await agree(ids.mia, [
        fact("i1", "system", "Tickets arrive in Zendesk."),
        fact(
          "i2",
          "wish",
          "Would like the customer number filled in for them."
        ),
      ]);
      // Mo says more than he approves: a raw line, and a fact he left out
      // of what he agreed to.
      await agree(
        ids.mo,
        [
          fact("o1", "wait", "A ticket waits days for the customer's reply."),
          {
            id: "o2",
            tag: "rule",
            text: "You said: Mo skips the queue for his friends.",
            record: "Mo skips the queue for his friends.",
          },
        ],
        0,
        [
          { from: "stephen", text: "What starts one?" },
          { from: "person", text: "Honestly Lea never answers her mail." },
        ]
      );
      await othersTold(ids);
      await answering([ticketsReply(ids)], async () => await store.drawNext());
      await store.intakeNext();
      const member = await signedInApi(idp, "user");
      const brain = await member.api.brain.read();
      const teamId = `team-${ids.team}`;
      const source = brain.sources.find(
        ({ teamIds }) => teamIds?.includes(teamId) === true
      );
      const statements = brain.statements
        .filter(({ sourceId }) => sourceId === source?.id)
        .map(({ text }) => text);
      const shown = JSON.stringify(source?.transcript);
      expect({
        transcript: source?.transcript,
        sameAsStatements: source?.transcript?.turns
          .map(({ text }) => text)
          .toSorted(),
        unsaid: ["Lea never answers", "skips the queue", "You said"].filter(
          (words) => shown.includes(words)
        ),
      }).toStrictEqual({
        transcript: {
          unit: "passage",
          turns: [
            {
              at: "1",
              speaker: "Ops",
              text: "A ticket waits days for the customer's reply.",
            },
            {
              at: "2",
              speaker: "Ops",
              text: "Someone hands billing questions to someone.",
            },
            { at: "3", speaker: "Ops", text: "Tickets arrive in Zendesk." },
            {
              at: "4",
              speaker: "Ops",
              text: "Would like the customer number filled in for them.",
            },
          ],
          chapters: [],
        },
        sameAsStatements: statements.toSorted(),
        unsaid: [],
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
