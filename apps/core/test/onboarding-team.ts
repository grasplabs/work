import type {
  InterviewFact,
  InterviewLine,
  InterviewProgress,
  InterviewSaved,
} from "@grasp-os/shared/interview-links";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import type { Roster } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { answering, approveAgreed } from "./interview-link.ts";
import { routed, unique } from "./sign-in.ts";

// A team on its way through the onboarding into the brain, as the tests
// of the brain's intake (brain-intake.test.ts) and of deleting an
// interview (interview-deletion.test.ts) share it: Lea leads Ops, with
// Max, Mia, Mo, Noor, Pim and Rik; her map, their agreements, and the drawing of
// their tickets, with AI Gateway faked behind the AI binding.

const dayMs = 24 * 60 * 60 * 1000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sessionKey = z.object({ key: z.string().optional() });

/** The people of a team, by key. */
export type Key = "lea" | "max" | "mia" | "mo" | "noor" | "pim" | "rik";

const names: Record<Key, [string, string]> = {
  lea: ["Lea Lind", "Team lead"],
  max: ["Max Mol", "Agent"],
  mia: ["Mia Moor", "Agent"],
  mo: ["Mo Mertens", "Agent"],
  noor: ["Noor Nijs", "Agent"],
  pim: ["Pim Peeters", "Agent"],
  rik: ["Rik Rooms", "Agent"],
};

/** Each person's and the team's id, by key. */
const idsOf = (id: string) => ({
  team: `ops-${id}`,
  lea: `lea-${id}`,
  max: `max-${id}`,
  mia: `mia-${id}`,
  mo: `mo-${id}`,
  noor: `noor-${id}`,
  pim: `pim-${id}`,
  rik: `rik-${id}`,
});

/** The staff list of Ops, led by Lea, with the people `keys`. */
export const rosterOf = (
  ids: ReturnType<typeof idsOf>,
  keys: readonly Key[]
): Roster => ({
  teams: [{ id: ids.team, name: "Ops", lead: ids.lea, does: "", off: false }],
  people: keys.map((key) => ({
    id: ids[key],
    name: names[key][0],
    team: ids.team,
    email: "",
    title: names[key][1],
    away: false,
  })),
});

/**
 * A team led by Lea, with Max, Mia, Mo and Noor (or only some of them), in
 * a fresh onboarding that started yesterday.
 */
export const team = async (
  keys: readonly Key[] = ["lea", "max", "mia", "mo", "noor", "pim", "rik"]
) => {
  const store = onboardingStore(env);
  const ids = idsOf(unique());
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(rosterOf(ids, keys), by);
  await store.savePlan({ start: isoDay(Date.now() - dayMs), days: 14 }, by);
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  return ids;
};

export type Ids = Awaited<ReturnType<typeof team>>;

/** The links opened so far, by person: a link opens for one device only. */
const opened = new Map<string, { secret: string; key: string }>();

/** Someone's link opened on a device: their secret and key. */
export const openLink = async (person: string) => {
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
export const fact = (
  id: string,
  tag: FactTag,
  record: string
): InterviewFact => ({
  id,
  tag,
  text: `You said: ${record}`,
  record,
  agreed: true,
});

/**
 * Saves someone's interview as agreed to, with `facts`, after `lines`, and
 * approves on their link those of them marked agreed, as they stand;
 * returns the new version.
 */
export const agree = async (
  person: string,
  facts: InterviewFact[],
  version = 0,
  lines: InterviewLine[] = [{ from: "stephen", text: "What starts one?" }]
): Promise<number> => {
  const link = await openLink(person);
  const progress: InterviewProgress = {
    person: "completed",
    told: true,
    mode: "type",
    lines,
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
  await approveAgreed(link, facts);
  return saved.version;
};

/** The map: tickets, by Max, Mia and Mo, and the rota, Lea's own. */
export const mapReply = (ids: Ids): GatewayReply => ({
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
export const ticketsReply = (
  ids: Ids,
  last = "Send the answer."
): GatewayReply => ({
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

/** Lea's map drawn, from `more` she said too, and everyone's links out. */
export const mapped = async (
  ids: Ids,
  more: { facts?: InterviewFact[]; lines?: InterviewLine[] } = {}
) => {
  const store = onboardingStore(env);
  await store.releaseDue();
  await agree(
    ids.lea,
    [
      fact("l1", "work", "Max, Mia and Mo handle new tickets."),
      fact(
        "l2",
        "system",
        "The team lives in Zendesk and the lead's own rota sheet."
      ),
      ...(more.facts ?? []),
    ],
    0,
    more.lines
  );
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

/**
 * Noor, Pim and Rik agree to a step each: with Max, Mia and Mo they make
 * six who tell their own work, one more than the five a team needs before
 * any of it reaches the brain (`minTeamShown`; the lead isn't counted), so
 * one interview going leaves the rest there.
 */
export const othersTold = async (ids: Ids) => {
  await agree(ids.noor, [fact("n1", "step", "Reads the ticket first.")]);
  await agree(ids.pim, [fact("p1", "step", "Tags the ticket.")]);
  await agree(ids.rik, [fact("r1", "step", "Checks the queue at noon.")]);
};

/** Max, Mia, Mo, Noor, Pim and Rik agree to what they told about tickets. */
export const told = async (ids: Ids) => {
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
  await othersTold(ids);
};

/** Every record the brain keeps whose id is the onboarding's, for a team: as stored. */
export const kept = async (ids: Ids) => {
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
