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
import type { GatewayReply, GatewayRequest } from "./ai-gateway.ts";
import { answering, answeringWith, approveAgreed } from "./interview-link.ts";
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

/**
 * Tickets as drawn, with what five who tell their own work told alike, as
 * the brain may take it (GRA-1084): how one starts, opening the ticket
 * (with the minutes of `minutesFrom` of them),
 * the last step, what they decide by and their numbers; besides, what
 * fewer told, which stays out of it: a step only Max told, naming Noor, a
 * wait only Mo told, Max's own list, and a question for the next
 * interviews.
 */
export const fiveToldReply = (
  ids: Ids,
  last = "Send the answer.",
  minutesFrom = 5,
  decides = "The priority of the ticket."
): GatewayReply => {
  const five = [ids.max, ids.mia, ids.mo, ids.noor, ids.pim];
  return {
    text: JSON.stringify({
      starts: "A customer email arrives as a ticket in Zendesk.",
      starts_by: five,
      steps: [
        {
          text: "Open the ticket.",
          who: "Agent",
          tool: "Zendesk",
          by: five,
          minutes: [1, 2, 6],
          // Each one's own normal minutes: 2 to 6, a median of 4.
          minutes_by: five.slice(0, minutesFrom).map((person, index) => ({
            person,
            minutes: [1, 2 + index, 6],
          })),
        },
        {
          text: "Ask Noor when the customer number is missing.",
          who: "Agent",
          tool: "",
          by: [ids.max],
        },
        { text: last, who: "Agent", tool: "Zendesk", by: five },
      ],
      notes: [
        { kind: "wait", text: "Waits for the customer's reply.", by: [ids.mo] },
        { kind: "decides", text: decides, by: five },
        { kind: "own", text: "A sheet of open tickets.", by: [ids.max] },
      ],
      numbers: five.map((person, index) => ({
        person,
        quiet: 30 + index,
        busy: 50 + index,
        of: "me",
        per: "week",
        minutes: [3, 10 + index, 45],
        wrong: 2,
      })),
      open: ["Why do some ask Noor?"],
    }),
    inputTokens: 4000,
    outputTokens: 900,
  };
};

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
 * Noor, Pim and Rik agree to a step each, and Noor and Pim that tickets
 * arrive in Zendesk and wait for the customer: with Max, Mia and Mo they
 * make six who tell their own work, one more than the five a team needs
 * before any of it reaches the brain (`minTeamShown`; the lead isn't
 * counted), so one interview going leaves the rest there.
 */
export const othersTold = async (ids: Ids) => {
  await agree(ids.noor, [
    fact("n1", "step", "Reads the ticket first."),
    fact("n2", "system", "Tickets arrive in Zendesk."),
    fact("n3", "wait", "Tickets wait for the customer."),
  ]);
  await agree(ids.pim, [
    fact("p1", "step", "Tags the ticket."),
    fact("p2", "system", "Tickets arrive in Zendesk."),
    fact("p3", "wait", "Tickets wait for the customer."),
  ]);
  await agree(ids.rik, [fact("r1", "step", "Checks the queue at noon.")]);
};

/**
 * Max, Mia, Mo, Noor, Pim and Rik agree to what they told about tickets:
 * five of them say tickets come in through Zendesk, each in their own
 * words; Max alone hands billing questions to Noor, Mia alone wishes for
 * the customer number and Mo alone waits for replies.
 */
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
    fact("o2", "system", "New tickets come in through Zendesk."),
  ]);
  await agree(ids.noor, [
    fact("n1", "step", "Reads the ticket first."),
    fact("n2", "system", "Zendesk is where the tickets land."),
  ]);
  await agree(ids.pim, [
    fact("p1", "step", "Tags the ticket."),
    fact("p2", "system", "Tickets arrive in Zendesk."),
  ]);
  await agree(ids.rik, [fact("r1", "step", "Checks the queue at noon.")]);
};

/** What the five who spoke of Zendesk said of it, in their own words. */
export const zendeskSaid = [
  "Tickets arrive in Zendesk.",
  "New tickets come in through Zendesk.",
  "Zendesk is where the tickets land.",
];

/** A claim as the fake model makes it: its kind, its words, and the words of the facts it cites. */
export interface FakeClaim {
  kind: string;
  text: string;
  /** Every fact shown with these words is cited; a label as is (`F99`) too. */
  cites: readonly string[];
  /** The words of the facts that say it, as the check answers: all it cites, unless given. */
  says?: readonly string[];
  /** Its words as the check is asked about them, once names are taken out: `text`, unless given. */
  checked?: string;
  /** Every check of it fails at the gateway. */
  fails?: true;
}

const shownSchema = z.array(
  z.object({
    facts: z.array(
      z.object({ id: z.string(), kind: z.string(), text: z.string() })
    ),
  })
);
const checkSchema = z.object({ claim: z.string(), fact: z.string() });
const partSchema = z.object({ part: z.string(), facts: z.array(z.string()) });
const numberSchema = z.object({
  work: z.string(),
  number: z.string(),
  facts: z.array(z.string()),
});

/**
 * Whether a person's facts say a part of a drawing, or give a number the
 * drawing says is theirs, as the fake checker answers: a plain one agrees.
 */
export type PartJudge = (
  part: string,
  facts: readonly string[],
  /** For a number: the piece of work it is said to be for. */
  work?: string
) => boolean;

/** The fake checker's answer for parts, unless a test gives one: yes. */
const agrees: PartJudge = () => true;

/** What a request gave the model as data between `<tag>` and `</tag>`, parsed; none when it gave none. */
const dataOf = (request: GatewayRequest | undefined, tag: string): unknown => {
  // The request as sent, read back to its text: the data is JSON in it.
  const sent: string = JSON.stringify(request?.body ?? null);
  const found = new RegExp(`<${tag}>\\\\n(?<data>.*?)\\\\n</${tag}>`, "u").exec(
    sent
  );
  const data = found?.groups?.data;
  if (data === undefined) {
    return undefined;
  }
  const text: unknown = JSON.parse(`"${data}"`);
  return typeof text === "string" ? JSON.parse(text) : undefined;
};

/** The facts a claims request showed the model, by label. */
const shownIn = (request: GatewayRequest | undefined) =>
  shownSchema
    .parse(dataOf(request, "facts") ?? [])
    .flatMap(({ facts }) => facts);

/**
 * The model, faked: a check of one fact against one claim answered by
 * `says`, one of a person's facts against a drawing's part by `part`;
 * anything else, the claims, by `claims`.
 */
const claimsOrCheck =
  (
    claims: (request: GatewayRequest | undefined) => unknown,
    says: (claim: string, fact: string) => boolean | "fails",
    part: PartJudge = agrees
  ) =>
  (requests: readonly GatewayRequest[]): GatewayReply => {
    const request = requests.at(-1);
    const data = dataOf(request, "data");
    const check = checkSchema.safeParse(data);
    const ofPart = partSchema.safeParse(data);
    const ofNumber = numberSchema.safeParse(data);
    let answer: boolean | "fails" | undefined;
    if (check.success) {
      answer = says(check.data.claim, check.data.fact);
    } else if (ofPart.success) {
      answer = part(ofPart.data.part, ofPart.data.facts);
    } else if (ofNumber.success) {
      answer = part(
        ofNumber.data.number,
        ofNumber.data.facts,
        ofNumber.data.work
      );
    }
    if (answer === "fails") {
      return { status: 400, errorType: "invalid_request_error" };
    }
    return {
      text: JSON.stringify(
        answer === undefined ? claims(request) : { says: answer }
      ),
      inputTokens: 1000,
      outputTokens: 200,
    };
  };

/**
 * The model putting a team's claims together, faked: `claims`, each citing
 * the labels the prompt gave the facts it names by their words; checked,
 * a fact says a claim when it is among those it `says`.
 */
export const claimsReply = (
  claims: readonly FakeClaim[],
  part: PartJudge = agrees
) =>
  claimsOrCheck(
    (request) => {
      const shown = shownIn(request);
      return {
        claims: claims.map(({ kind, text, cites }) => ({
          kind,
          text,
          facts: cites.flatMap((cited) => {
            const labels = shown
              .filter((each) => each.text === cited)
              .map(({ id }) => id);
            return labels.length === 0 ? [cited] : labels;
          }),
        })),
      };
    },
    (claim, said) => {
      const of = claims.filter(
        ({ text, checked }) => (checked ?? text) === claim
      );
      if (of.some(({ fails }) => fails === true)) {
        return "fails";
      }
      return of.some(({ cites, says }) => (says ?? cites).includes(said));
    },
    part
  );

/**
 * The model putting a team's claims together as a plain one would, faked:
 * a claim for each kind of fact shown, citing every fact of it, in the
 * words most of them used (the first, when as many used others); checked,
 * every fact says the claim of its kind.
 */
export const alikeReply = claimsOrCheck(
  (request) => {
    const byKind = new Map<string, { id: string; text: string }[]>();
    for (const { id, kind, text } of shownIn(request)) {
      byKind.set(kind, [...(byKind.get(kind) ?? []), { id, text }]);
    }
    return {
      claims: [...byKind].map(([kind, facts]) => {
        const counts = new Map<string, number>();
        let text = "";
        for (const shown of facts) {
          const count = (counts.get(shown.text) ?? 0) + 1;
          counts.set(shown.text, count);
          if (count > (counts.get(text) ?? 0)) {
            ({ text } = shown);
          }
        }
        return { kind, text, facts: facts.map(({ id }) => id) };
      }),
    };
  },
  () => true
);

/** The onboarding giving the brain its next team, with the model putting claims together as a plain one would. */
export const intakeAlike = async (): Promise<string | null> => {
  const { result } = await answeringWith(
    alikeReply,
    async () => await onboardingStore(env).intakeNext()
  );
  return result;
};

/** The team's claim that tickets come in through Zendesk, as the five said it. */
export const zendeskClaim: FakeClaim = {
  kind: "tool",
  text: "Tickets come in through Zendesk.",
  cites: zendeskSaid,
};

/**
 * The onboarding giving the brain `ids`' team, with the model putting
 * `claims` together: a team an earlier test left due goes first, as the
 * alarm would give it. What reached the gateway for that team alone.
 */
export const intake = async (
  ids: { team: string },
  claims: readonly FakeClaim[] = [zendeskClaim],
  part: PartJudge = agrees
) => {
  let given: Awaited<ReturnType<typeof answeringWith<string | null>>> = {
    requests: [],
    result: null,
  };
  for (let round = 0; round < 5; round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one team at a time, as the alarm gives them
    given = await answeringWith(
      claimsReply(claims, part),
      async () => await onboardingStore(env).intakeNext()
    );
    if (given.result === null || given.result === `brain:${ids.team}`) {
      break;
    }
  }
  return { gave: given.result, requests: given.requests };
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
