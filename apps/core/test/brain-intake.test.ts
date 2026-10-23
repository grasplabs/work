import type { Workspace } from "@grasp-os/shared/brain";
import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type {
  InterviewFact,
  InterviewProgress,
  InterviewSaved,
} from "@grasp-os/shared/interview-links";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import type { Roster } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import { answering } from "./interview-link.ts";
import { outcome, routed, signedInApi, unique } from "./sign-in.ts";

// What the onboarding learned, in the brain (GRA-367,
// src/onboarding/brain-intake.ts): once a piece of work is drawn, its
// team, one source for its interviews, the facts its people agreed to and
// the drawing reach the Playbook's records, which every member reads.
// AI Gateway is the outside system, faked behind the AI binding. The ways
// it can fail, tried here:
//
// - A record pointing at a person: their id, their name, their own words
//   or quote, a source of their own, or the lead's facts, whose role alone
//   says who they are.
// - A small team in the brain before three of its people agreed.
// - A drawing written over when the work is drawn again.
// - What a record rests on lost, so deleting an interview can't find it.
// - Someone else adding, or squatting on, the onboarding's own records.

const idp = mockIdp();

const dayMs = 24 * 60 * 60 * 1000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sessionKey = z.object({ key: z.string().optional() });

/** The people of a team, by key. */
type Key = "lea" | "max" | "mia" | "mo" | "noor";

/**
 * A team led by Lea, with Max, Mia, Mo and Noor (or only some of them), in
 * a fresh onboarding that started yesterday.
 */
const team = async (
  keys: readonly Key[] = ["lea", "max", "mia", "mo", "noor"]
) => {
  const store = onboardingStore(env);
  const id = unique();
  const ids = {
    team: `ops-${id}`,
    lea: `lea-${id}`,
    max: `max-${id}`,
    mia: `mia-${id}`,
    mo: `mo-${id}`,
    noor: `noor-${id}`,
  };
  const names: Record<Key, [string, string]> = {
    lea: ["Lea Lind", "Team lead"],
    max: ["Max Mol", "Agent"],
    mia: ["Mia Moor", "Agent"],
    mo: ["Mo Mertens", "Agent"],
    noor: ["Noor Nijs", "Agent"],
  };
  const roster: Roster = {
    teams: [{ id: ids.team, name: "Ops", lead: ids.lea, does: "", off: false }],
    people: keys.map((key) => ({
      id: ids[key],
      name: names[key][0],
      team: ids.team,
      email: "",
      title: names[key][1],
      away: false,
    })),
  };
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  await store.savePlan({ start: isoDay(Date.now() - dayMs), days: 14 }, by);
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  return ids;
};

type Ids = Awaited<ReturnType<typeof team>>;

/** The links opened so far, by person: a link opens for one device only. */
const opened = new Map<string, { secret: string; key: string }>();

/** Someone's link opened on a device: their secret and key. */
const openLink = async (person: string) => {
  const open = opened.get(person);
  if (open !== undefined) {
    return open;
  }
  const link = await onboardingStore(env).linkOf(person);
  const secret = link?.split("#")[1] ?? "";
  const session = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "session", secret }),
  });
  const { key } = sessionKey.parse(await session.json());
  const device = { secret, key: key ?? "" };
  opened.set(person, device);
  return device;
};

/** A fact as agreed: what they said, as Stephen read it back to them (`text`), and the record. */
const fact = (id: string, tag: FactTag, record: string): InterviewFact => ({
  id,
  tag,
  text: `You said: ${record}`,
  record,
  agreed: true,
});

/** Saves someone's interview as agreed to, with `facts`; returns the new version. */
const agree = async (
  person: string,
  facts: InterviewFact[],
  version = 0
): Promise<number> => {
  const link = await openLink(person);
  const progress: InterviewProgress = {
    person: "completed",
    told: true,
    mode: "type",
    lines: [{ from: "stephen", text: "What starts one?" }],
    facts,
    phase: "readback",
    wants: "end",
    startedAt: Date.now(),
    confirmed: facts.length,
    adding: false,
    addedAt: 0,
  };
  const response = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "save", ...link, version, progress }),
  });
  const saved: InterviewSaved = await response.json();
  return saved.version;
};

/** The map: tickets, by Max, Mia and Mo, and the rota, Lea's own. */
const mapReply = (ids: Ids): GatewayReply => ({
  text: JSON.stringify({
    does: "Answers customers' questions",
    works: [
      {
        name: "handling new tickets",
        local: "nieuwe tickets afhandelen",
        one: "ticket",
        many: "tickets",
        doers: [ids.max, ids.mia, ids.mo],
        share: 0.8,
      },
      {
        name: "planning the rota",
        local: "het rooster plannen",
        one: "rota",
        many: "rotas",
        doers: [ids.lea],
        share: 0.2,
      },
    ],
  }),
  inputTokens: 2000,
  outputTokens: 300,
});

/** Tickets as drawn: a step that names Noor, as a model might slip. */
const ticketsReply = (ids: Ids, last = "Send the answer."): GatewayReply => ({
  text: JSON.stringify({
    starts: "A customer email arrives as a ticket in Zendesk.",
    starts_by: [ids.max],
    steps: [
      {
        text: "Open the ticket.",
        who: "Agent",
        tool: "Zendesk",
        by: [ids.max, ids.mia, ids.mo],
        minutes: [1, 2, 5],
      },
      {
        text: "Ask Noor when the customer number is missing.",
        who: "Agent",
        tool: "",
        by: [ids.max],
        minutes: [],
      },
      { text: last, who: "Agent", tool: "Zendesk", by: [ids.mia] },
    ],
    notes: [
      { kind: "wait", text: "Waits for the customer's reply.", by: [ids.mo] },
    ],
    numbers: [
      {
        person: ids.max,
        quiet: 30,
        busy: 50,
        of: "me",
        per: "week",
        minutes: [3, 10, 45],
        wrong: 2,
      },
      {
        person: ids.mia,
        quiet: -1,
        busy: 45,
        of: "me",
        per: "week",
        minutes: [-1, 12, -1],
        wrong: -1,
      },
    ],
    open: ["Why do some ask Noor?"],
  }),
  inputTokens: 4000,
  outputTokens: 900,
});

/** Lea's map drawn, and everyone's links out. */
const mapped = async (ids: Ids) => {
  const store = onboardingStore(env);
  await store.releaseDue();
  await agree(ids.lea, [
    fact("l1", "work", "Max, Mia and Mo handle new tickets."),
    fact(
      "l2",
      "system",
      "The team lives in Zendesk and the lead's own rota sheet."
    ),
  ]);
  await answering([mapReply(ids)], async () => await store.drawNext());
  await store.releaseDue();
  // The rota, Lea's own, is drawn from her alone, and out of the way.
  await answering(
    [
      {
        text: JSON.stringify({
          steps: [{ text: "Plan the rota.", by: [ids.lea] }],
        }),
        inputTokens: 1,
        outputTokens: 1,
      },
    ],
    async () => await store.drawNext()
  );
};

/** Max, Mia and Mo agree to what they told about tickets. */
const told = async (ids: Ids) => {
  await agree(ids.max, [
    fact("m1", "step", "Opens the ticket in Zendesk."),
    fact("m2", "system", "Tickets arrive in Zendesk."),
    fact("m3", "handoff", "Max hands billing questions to Noor."),
  ]);
  await agree(ids.mia, [
    fact("i1", "system", "Tickets arrive in Zendesk."),
    fact("i2", "wish", "Would like the customer number filled in for them."),
  ]);
  await agree(ids.mo, [
    fact("o1", "wait", "A ticket waits days for the customer's reply."),
  ]);
};

/** Every record the brain keeps whose id is the onboarding's, for a team: as stored. */
const kept = async (ids: Ids) => {
  const { results } = await env.DB.prepare(
    "SELECT type, id, body FROM brain_records WHERE id LIKE 'onb-%' OR id = ? ORDER BY position"
  )
    .bind(`team-${ids.team}`)
    .all<{ type: string; id: string; body: string }>();
  // Only this team's: its records name its team, or a workflow of it.
  const ours = new Set([`team-${ids.team}`]);
  return results.filter(({ id, body }) => {
    const mine =
      ours.has(id) || [...ours].some((each) => body.includes(`"${each}"`));
    if (mine) {
      ours.add(id);
    }
    return mine;
  });
};

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
          how: "4 people",
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
          people: 3,
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
          // The lead named the work, and was the drawing's context.
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
          max: ["statement", "statement", "workflowVersion", "workflowVersion"],
          mia: ["statement", "statement", "workflowVersion", "workflowVersion"],
          lea: ["workflow", "workflowVersion", "workflowVersion"],
          noor: [],
        },
      });
    });

    it("holds back a team under five until three of its people agreed", async () => {
      const store = onboardingStore(env);
      const ids = await team(["lea", "max", "mia", "mo"]);
      await mapped(ids);
      await agree(ids.max, [
        fact("m2", "system", "Tickets arrive in Zendesk."),
      ]);
      await answering([ticketsReply(ids)], async () => await store.drawNext());
      const early = await store.intakeNext();
      const waiting = await kept(ids);
      await agree(ids.mia, [
        fact(
          "i2",
          "wish",
          "Would like the customer number filled in for them."
        ),
      ]);
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
