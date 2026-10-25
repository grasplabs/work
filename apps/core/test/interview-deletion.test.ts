import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import type { Workspace } from "@grasp-os/shared/brain";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type {
  InterviewFact,
  InterviewLine,
  InterviewProgress,
} from "@grasp-os/shared/interview-links";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { speakerVoices, voiceModels } from "../src/onboarding/spoken-lines.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { keepLine, keptLine } from "../src/speech-cache.ts";
import type { SpokenKey } from "../src/speech-cache.ts";
import { answeringGateway } from "./ai-gateway.ts";
import type { GatewayReply, GatewayRequest } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import { answering, approve, gatewayConfig, onLink } from "./interview-link.ts";
import {
  agree,
  fact,
  kept,
  mapReply,
  mapped,
  othersTold,
  openLink,
  rosterOf,
  team,
  ticketsReply,
} from "./onboarding-team.ts";
import type { Ids } from "./onboarding-team.ts";
import {
  auditedDuring,
  openRpc,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Deleting an interview (GRA-368, the store's `#forget` and `purgeBrain`):
// from its link, by Grasp's staff on request, with a new start, or by
// taking someone off the staff list. Each person here says words nobody
// else does (a sentinel), and the tests look for them, and for who said
// them, everywhere they could be left: the store's tables, core's
// database, the brain, the audit log, the lines kept of Stephen's voice,
// and what the work is drawn again from. AI Gateway is the outside
// system, faked behind the AI binding. The threat model's delete cases
// (GRA-361), tried here:
//
// - D1: drawn work left behind, or drawn again with them in it.
// - D2: the brain's records, or any version of them, still holding them.
// - D3: a copy left open saving it back (also interview-links.test.ts).
// - D4: Stephen's lines from it, kept for their sound.
// - L7: someone taken off the list leaving what they said behind.
// - W5: a team falling under five people in the brain by a delete.
// - W7: the deletion in the audit log with who, or with their words, or
//   a delete from the link there at all: its moment would tell the admin
//   which lead it was.
// - A delete while the same work is drawn, the lead's map is drawn, or the
//   team given to the brain.
//
// Withdrawing and putting right what was approved, from the threat model
// of read-back approval (GRA-329), tried here too:
//
// - T5: withdrawing leaving the brain's records on them, or their part in
//   a drawing, in use.
// - T2: a line put right after it was approved and given to the brain
//   keeping its old words there, or its new words getting there before
//   they are approved.
// - T8: a line put right while the team is given to the brain leaving its
//   old words in what landed.

const idp = mockIdp();

/** Words only one person says, to look for where they must not be. */
const sentinelOf = (who: string) => `Quillwort ${who} ${unique()}`;

/** What Max, Mia and Mo said that nobody else did, in one test. */
const sentinels = () => ({
  lea: sentinelOf("rota"),
  max: sentinelOf("queue"),
  mia: sentinelOf("filler"),
  mo: sentinelOf("waiting"),
});

type Said = ReturnType<typeof sentinels>;

/** Stephen's line in someone's interview, saying back what they told him. */
const stephenSays = (words: string) => `So it goes into ${words}?`;

/** Lines of an interview where `words` were said, by them and by Stephen. */
const linesWith = (words: string): InterviewLine[] => [
  { from: "stephen", text: "What starts one?" },
  { from: "person", text: `It lands in ${words}.`, typed: true },
  { from: "stephen", text: stephenSays(words) },
];

/** Max, Mia and Mo agree to what they told about tickets: one fact each of their own, and one Max and Mia share; Noor and Pim agree to a step each. */
const toldWith = async (ids: Ids, said: Said) => {
  await agree(
    ids.max,
    [
      fact("m2", "system", "Tickets arrive in Zendesk."),
      fact("m9", "wait", `Tickets wait in ${said.max}.`),
    ],
    0,
    linesWith(said.max)
  );
  await agree(
    ids.mia,
    [
      fact("i1", "system", "Tickets arrive in Zendesk."),
      fact("i9", "wish", `Would like ${said.mia} filled in for them.`),
    ],
    0,
    linesWith(said.mia)
  );
  await agree(
    ids.mo,
    [fact("o9", "rule", `Every ticket gets ${said.mo}.`)],
    0,
    linesWith(said.mo)
  );
  await othersTold(ids);
};

/** Draws every piece of work due, each with the tickets' drawing, until none is. */
const drawAll = async (ids: Ids): Promise<GatewayRequest[]> => {
  const store = onboardingStore(env);
  const requests: GatewayRequest[] = [];
  for (let round = 0; round < 5; round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one drawing at a time, as the alarm draws
    const drew = await answering(
      [ticketsReply(ids)],
      async () => await store.drawNext()
    );
    requests.push(...drew.requests);
    if (drew.result === null) {
      break;
    }
  }
  return requests;
};

/**
 * Gives the brain what is due until it has given this team: a team an
 * earlier test left due goes first, as the alarm would give it.
 */
const givenToBrain = async (ids: Ids): Promise<void> => {
  for (let round = 0; round < 5; round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one team at a time, as the alarm gives them
    const gave = await onboardingStore(env).intakeNext();
    if (gave === null || gave === `brain:${ids.team}`) {
      return;
    }
  }
};

/**
 * Lea's map drawn, with words of her own in her interview, then the
 * tickets drawn from what the others agreed to, and the team given to
 * the brain.
 */
const inTheBrain = async (ids: Ids, said: Said) => {
  await mapped(ids, {
    facts: [fact("l9", "rule", `The rota lives in ${said.lea}.`)],
    lines: linesWith(said.lea),
  });
  await toldWith(ids, said);
  await drawAll(ids);
  await givenToBrain(ids);
};

/**
 * Holds the store's own alarm for the test: each test draws what is due
 * and gives the team to the brain itself, step by step, as the alarm would
 * (`drawAll`, `intakeNext`). A delete or a drawing sets the alarm half a
 * second on, and on a slow runner it got there first: its drawing's
 * `model.call` landed amid a delete's audit events, or it gave the team to
 * the brain before the test did. Deleting the alarm isn't enough: the next
 * delete or drawing sets it again, and one already going runs on.
 */
const holdAlarm = async (): Promise<void> => {
  await runInDurableObject(onboardingStore(env), (instance) => {
    vi.spyOn(instance, "alarm").mockResolvedValue();
  });
};

/** Every value in the store's tables, by table, as text. */
const storeTables = async (): Promise<Record<string, string>> =>
  await runInDurableObject(onboardingStore(env), (_instance, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'"
      )
      .toArray()
      .map(({ name }) => name);
    return Object.fromEntries(
      tables.map((table) => [
        table,
        JSON.stringify(
          state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray()
        ),
      ])
    );
  });

/** Every value in core's database, as text. */
const coreText = async (): Promise<string> => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'"
  ).all<{ name: string }>();
  const texts = await Promise.all(
    results.map(async ({ name }) => {
      const rows = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
      return JSON.stringify(rows.results);
    })
  );
  return texts.join("\n");
};

/** The store's tables that hold anything of an interview, or of what was drawn from one. */
const ofInterviews = [
  "interviews",
  "interview_states",
  "interview_texts",
  "interview_settings",
  "drawn_works",
  "brain_sent",
];

/** Where `words`, and who said them, are left, apart from the roster and its links. */
const leftOf = async (person: string, words: string) => {
  const tables = await storeTables();
  const core = await coreText();
  return {
    words: [
      ...Object.entries(tables).flatMap(([table, text]) =>
        text.includes(words) ? [table] : []
      ),
      ...(core.includes(words) ? ["core"] : []),
    ],
    person: [
      ...ofInterviews.filter(
        (table) => tables[table]?.includes(person) === true
      ),
      ...(core.includes(person) ? ["core"] : []),
    ],
  };
};

/** What a member's brain shows of a team: its statements, its source, and each drawing of its tickets. */
const brainOf = async (ids: Ids) => {
  const member = await signedInApi(idp, "user");
  const brain: Workspace = await member.api.brain.read();
  const teamId = `team-${ids.team}`;
  const tickets = brain.workflows.find(
    ({ teamId: of, name }) => of === teamId && name === "handling new tickets"
  );
  return {
    statements: brain.statements
      .filter(({ teamIds }) => teamIds.includes(teamId))
      .map(({ text }) => text)
      .toSorted(),
    sources: brain.sources
      .filter(({ teamIds }) => teamIds?.includes(teamId) === true)
      .map(({ how }) => how),
    drawings: tickets?.drawings?.map(({ people }) => people) ?? null,
  };
};

const asStaff = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return await core.authenticate();
};

/** Deletes Max's interview from his link, on the device it is on. */
const deleteOnLink = async (person: string): Promise<number> => {
  const { secret, key } = await openLink(person);
  const response = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "delete", secret, key }),
  });
  return response.status;
};

/** The ways someone's interview goes, each for Max, and what the audit log has of it. */
const ways: {
  way: string;
  remove: (ids: Ids) => Promise<unknown>;
  audited: string[];
}[] = [
  {
    way: "from their link",
    remove: async (ids) => await deleteOnLink(ids.max),
    // Never in the audit log: its moment would tell the admin whose it was.
    audited: ["brain.records.purged"],
  },
  {
    way: "by Grasp's staff, on their request",
    remove: async (ids) => {
      const staff = await asStaff();
      await staff.onboardingStaff.deleteInterview(ids.max);
    },
    audited: ["brain.records.purged", "onboarding.interview.deleted"],
  },
  {
    way: "with a new start",
    remove: async (ids) => {
      const staff = await asStaff();
      await staff.onboardingStaff.newStart(ids.max);
    },
    audited: ["brain.records.purged", "onboarding.interview.restarted"],
  },
  {
    way: "by taking them off the staff list (L7)",
    remove: async (ids) => {
      await onboardingStore(env).saveRoster(
        rosterOf(ids, ["lea", "mia", "mo", "noor", "pim"]),
        { type: "system" }
      );
    },
    audited: ["brain.records.purged", "onboarding.roster.saved"],
  },
  {
    way: "by Grasp's staff taking them off the list (L7)",
    remove: async (ids) => {
      const staff = await asStaff();
      await staff.onboardingStaff.changeOrganization({
        kind: "removePerson",
        person: ids.max,
      });
    },
    audited: ["brain.records.purged", "onboarding.person.removed"],
  },
];

/** A fake AI binding for the duration of `run`, answering as `respond` does. */
const answeringWith = async <T>(
  respond: (
    requests: readonly GatewayRequest[]
  ) => Promise<GatewayReply | undefined>,
  run: () => Promise<T>
) => {
  const before = env.MODEL_GATEWAY;
  const fake = answeringGateway(respond);
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(fake.binding.fetch);
  env.MODEL_GATEWAY = gatewayConfig;
  try {
    return await run();
  } finally {
    env.MODEL_GATEWAY = before;
    spy.mockRestore();
  }
};

/** Waits until someone's interview is gone from the store. */
const goneFromStore = async (person: string): Promise<void> => {
  for (let tries = 0; tries < 100; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- asked again until it is gone
    if ((await onboardingStore(env).drawInput(person)) === null) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- a moment between asks
    await scheduler.wait(10);
  }
  throw new Error("The interview was not deleted");
};

describe("deleting an interview", { timeout: 180_000 }, () => {
  beforeEach(holdAlarm);

  it.each(ways)(
    "$way takes out their words, their facts, their part in every drawing and the brain's records on them, and the work is drawn again without them (D1, D2, W7)",
    async ({ remove, audited }) => {
      const store = onboardingStore(env);
      const ids = await team();
      const said = sentinels();
      await inTheBrain(ids, said);
      const before = await brainOf(ids);
      const events = await auditedDuring(async () => {
        await remove(ids);
      });
      const redrawn = await drawAll(ids);
      await store.intakeNext();
      const works = await store.teamWorks(ids.team);
      const tickets = works.find(({ name }) => name === "handling new tickets");
      const audit = JSON.stringify(events);
      const others = await leftOf(ids.mia, said.mia);
      expect({
        before,
        after: await brainOf(ids),
        left: await leftOf(ids.max, said.max),
        // Mia's and Mo's words stay where they were.
        others: others.words.includes("interviews"),
        drawnFrom: tickets?.drawn?.from.toSorted(),
        redrawnWith: JSON.stringify(redrawn.map(({ body }) => body)).includes(
          said.max
        ),
        restsOn: await store.sentFor(ids.max),
        // Staff signing in to do it is theirs, apart.
        audited: events
          .map(({ action }) => action)
          .filter((action) => action !== "staff.session.started")
          .toSorted(),
        auditNames: [audit.includes(ids.max), audit.includes(said.max)],
      }).toStrictEqual({
        before: {
          statements: [
            `Every ticket gets ${said.mo}.`,
            "Tickets arrive in Zendesk.",
            `Tickets wait in ${said.max}.`,
            `Would like ${said.mia} filled in for them.`,
          ],
          sources: ["6 people"],
          drawings: [5],
        },
        after: {
          // What Mia agreed to as well stays: it rests on her.
          statements: [
            `Every ticket gets ${said.mo}.`,
            "Tickets arrive in Zendesk.",
            `Would like ${said.mia} filled in for them.`,
          ],
          sources: ["5 people"],
          // The drawing from five is gone; the one from who is left is there.
          drawings: [4],
        },
        left: { words: [], person: [] },
        others: true,
        drawnFrom: [ids.mia, ids.mo, ids.noor, ids.pim].toSorted(),
        redrawnWith: false,
        restsOn: [],
        audited,
        auditNames: [false, false],
      });
    }
  );

  it.each([
    {
      way: "from their link is only in staff's own log, never the audit log",
      remove: async (ids: Ids) => await deleteOnLink(ids.max),
      audited: [],
      by: "person",
    },
    {
      way: "by Grasp's staff is in the audit log as theirs, and in staff's own log",
      remove: async (ids: Ids) => {
        const staff = await asStaff();
        await staff.onboardingStaff.deleteInterview(ids.max);
      },
      audited: ["onboarding.interview.deleted"],
      by: "staff",
    },
  ])("$way (W7)", async ({ remove, audited, by }) => {
    const ids = await team();
    await inTheBrain(ids, sentinels());
    const events = await auditedDuring(async () => {
      await remove(ids);
    });
    // The team given to the brain again, so none of it waits for the next test.
    await drawAll(ids);
    await onboardingStore(env).intakeNext();
    const { entries } = await onboardingStore(env).staffLog({
      what: "interview.deleted",
    });
    expect({
      audited: events
        .map(({ action }) => action)
        .filter((action) => action.startsWith("onboarding.")),
      logged: entries
        .filter(({ person }) => person?.id === ids.max)
        .map(({ actor }) => actor),
    }).toStrictEqual({
      audited,
      logged: [by],
    });
  });

  it("of a team's lead draws all of its work again without their facts, and keeps none of their drawings", async () => {
    const store = onboardingStore(env);
    const ids = await team();
    const said = sentinels();
    await inTheBrain(ids, said);
    const staff = await asStaff();
    await staff.onboardingStaff.deleteInterview(ids.lea);
    const redrawn = await drawAll(ids);
    await store.intakeNext();
    const works = await store.teamWorks(ids.team);
    expect({
      left: await leftOf(ids.lea, said.lea),
      redrawnWith: JSON.stringify(redrawn.map(({ body }) => body)).includes(
        said.lea
      ),
      // The map they drew stays: everyone else was asked about its work.
      works: works.map(({ name, drawn }) => [
        name,
        drawn?.from.toSorted() ?? null,
      ]),
      after: await brainOf(ids),
      restsOn: await store.sentFor(ids.lea),
    }).toStrictEqual({
      left: { words: [], person: [] },
      redrawnWith: false,
      works: [
        [
          "handling new tickets",
          [ids.max, ids.mia, ids.mo, ids.noor, ids.pim].toSorted(),
        ],
        ["planning the rota", null],
      ],
      after: {
        statements: [
          `Every ticket gets ${said.mo}.`,
          "Tickets arrive in Zendesk.",
          `Tickets wait in ${said.max}.`,
          `Would like ${said.mia} filled in for them.`,
        ],
        sources: ["5 people"],
        // Drawn again from the same five, without the lead's facts.
        drawings: [5],
      },
      restsOn: [],
    });
  });

  it("that leaves a team under five people takes all of the team's interviews out of the brain until five agree again (W5)", async () => {
    const store = onboardingStore(env);
    const ids = await team(["lea", "max", "mia", "mo", "noor"]);
    const said = sentinels();
    await mapped(ids);
    await agree(ids.max, [fact("m9", "wait", `Tickets wait in ${said.max}.`)]);
    await agree(ids.mia, [
      fact("i9", "wish", `Would like ${said.mia} filled in for them.`),
    ]);
    await agree(ids.mo, [fact("o9", "rule", `Every ticket gets ${said.mo}.`)]);
    await agree(ids.noor, [fact("n1", "step", "Reads the ticket first.")]);
    await drawAll(ids);
    await store.intakeNext();
    const before = await kept(ids);
    await deleteOnLink(ids.mia);
    await drawAll(ids);
    await store.intakeNext();
    const after = await kept(ids);
    expect({
      before: [...new Set(before.map(({ type }) => type))].toSorted(),
      after: after.map(({ type }) => type),
      brain: await brainOf(ids),
      // Max's drawing waits for the team, here alone.
      restsOn: await store.sentFor(ids.max),
    }).toStrictEqual({
      before: ["statement", "team", "workflow", "workflowVersion"],
      after: ["team"],
      brain: { statements: [], sources: [], drawings: null },
      restsOn: [],
    });
  });

  it("while the same work is being drawn throws the drawing away, and draws it again without them", async () => {
    const store = onboardingStore(env);
    const ids = await team();
    const said = sentinels();
    await mapped(ids);
    await toldWith(ids, said);
    let deleted: number | undefined;
    const drew = await answeringWith(
      async () => {
        // Max deletes his interview while his work is drawn.
        deleted ??= await deleteOnLink(ids.max);
        return ticketsReply(ids);
      },
      async () => await store.drawNext()
    );
    const drawing = await store.teamWorks(ids.team);
    const thrown = drawing.find(
      ({ name }) => name === "handling new tickets"
    )?.drawn;
    await drawAll(ids);
    await store.intakeNext();
    const works = await store.teamWorks(ids.team);
    expect({
      drew: drew?.startsWith("work:"),
      deleted,
      thrown: thrown ?? null,
      drawnFrom: works
        .find(({ name }) => name === "handling new tickets")
        ?.drawn?.from.toSorted(),
      left: await leftOf(ids.max, said.max),
      restsOn: await store.sentFor(ids.max),
    }).toStrictEqual({
      drew: true,
      deleted: 200,
      thrown: null,
      drawnFrom: [ids.mia, ids.mo, ids.noor, ids.pim].toSorted(),
      left: { words: [], person: [] },
      restsOn: [],
    });
  });

  it("of a team's lead while their map is being drawn throws the map away", async () => {
    const store = onboardingStore(env);
    const ids = await team();
    const said = sentinels();
    await store.releaseDue();
    await agree(
      ids.lea,
      [
        fact("l1", "work", "Max, Mia and Mo handle new tickets."),
        fact("l9", "rule", `The rota lives in ${said.lea}.`),
      ],
      0,
      linesWith(said.lea)
    );
    let deleted: number | undefined;
    const drew = await answeringWith(
      async () => {
        // Lea deletes her interview while her team's map is drawn from it.
        deleted ??= await deleteOnLink(ids.lea);
        return mapReply(ids);
      },
      async () => await store.drawNext()
    );
    // The team her delete made due for the brain, so it waits for no later test.
    await store.intakeNext();
    expect({
      drew,
      deleted,
      works: await store.teamWorks(ids.team),
      // What the map would have said the team does, from her facts.
      does: await leftOf(ids.lea, "Answers customers' questions"),
      left: await leftOf(ids.lea, said.lea),
    }).toStrictEqual({
      drew: `team:${ids.team}`,
      deleted: 200,
      works: [],
      does: { words: [], person: [] },
      left: { words: [], person: [] },
    });
  });

  it("while the team is given to the brain takes what landed of it out again at once", async () => {
    const store = onboardingStore(env);
    const ids = await team();
    const said = sentinels();
    await mapped(ids);
    await toldWith(ids, said);
    await drawAll(ids);
    // Max deletes his interview as the brain is about to keep the team.
    let deleting: Promise<number> | undefined;
    const batch = env.DB.batch.bind(env.DB);
    const spy = vi
      .spyOn(env.DB, "batch")
      .mockImplementation(async (statements) => {
        if (deleting === undefined) {
          deleting = deleteOnLink(ids.max);
          await goneFromStore(ids.max);
        }
        return await batch(statements);
      });
    let gave: string | null;
    try {
      gave = await store.intakeNext();
    } finally {
      spy.mockRestore();
    }
    const deleted = await deleting;
    const landed = await brainOf(ids);
    await drawAll(ids);
    await store.intakeNext();
    expect({
      gave,
      deleted,
      landed: landed.statements.some((text) => text.includes(said.max)),
      left: await leftOf(ids.max, said.max),
      after: await brainOf(ids),
      restsOn: await store.sentFor(ids.max),
    }).toStrictEqual({
      gave: `brain:${ids.team}`,
      deleted: 200,
      landed: false,
      left: { words: [], person: [] },
      after: {
        statements: [
          `Every ticket gets ${said.mo}.`,
          "Tickets arrive in Zendesk.",
          `Would like ${said.mia} filled in for them.`,
        ],
        sources: ["5 people"],
        drawings: [4],
      },
      restsOn: [],
    });
  });

  it("takes Stephen's lines in it out of the voice's cache, and leaves everyone else's (D4)", async () => {
    const ids = await team();
    const said = sentinels();
    await mapped(ids);
    await toldWith(ids, said);
    const keyOf = (words: string): SpokenKey => ({
      spoken: `[warm] ${stephenSays(words)}`,
      voice: speakerVoices.stephen,
      model: voiceModels.said,
      language: "en",
    });
    const answer = JSON.stringify({
      audio: "AAAA",
      mime: "audio/mpeg",
      words: [],
    });
    await keepLine(env, keyOf(said.max), answer);
    await keepLine(env, keyOf(said.mia), answer);
    await deleteOnLink(ids.max);
    expect({
      max: await keptLine(env, keyOf(said.max)),
      mia: await keptLine(env, keyOf(said.mia)),
    }).toStrictEqual({ max: undefined, mia: answer });
  });
});

/** Max, back on his link, puts his queue right: kept by the page as agreed to still, not approved. */
const putRight = async (ids: Ids, said: Said, words: string) => {
  const facts: InterviewFact[] = [
    fact("m2", "system", "Tickets arrive in Zendesk."),
    fact("m9", "wait", `Tickets wait in ${words}.`),
  ];
  const progress: InterviewProgress = {
    person: "completed",
    told: true,
    mode: "type",
    lines: linesWith(said.max),
    facts,
    phase: "readback",
    wants: "end",
    startedAt: Date.now(),
    confirmed: facts.length,
    adding: false,
    addedAt: 0,
  };
  const link = await openLink(ids.max);
  const response = await onLink({
    action: "save",
    ...link,
    version: 1,
    progress,
  });
  return { status: response.status, link, facts };
};

describe(
  "withdrawing, and putting right what was approved",
  { timeout: 180_000 },
  () => {
    beforeEach(holdAlarm);

    it("withdrawing while the brain can't be reached leaves its records to the alarm, which takes them out once it can (T5)", async () => {
      const store = onboardingStore(env);
      const ids = await team();
      const said = sentinels();
      await inTheBrain(ids, said);
      const before = await brainOf(ids);
      const link = await openLink(ids.max);
      // The brain can't be written while Max withdraws.
      const batch = env.DB.batch.bind(env.DB);
      const spy = vi
        .spyOn(env.DB, "batch")
        .mockImplementation(async (statements) => {
          // What the brain is written by, not the audit log's drain.
          if (new Error("where").stack?.includes("drainBatch") !== true) {
            throw new Error("The brain can't be reached.");
          }
          return await batch(statements);
        });
      let withdrawn: number;
      try {
        const response = await onLink({ action: "withdraw", ...link });
        withdrawn = response.status;
      } finally {
        spy.mockRestore();
      }
      const stuck = await brainOf(ids);
      const alarm = await runInDurableObject(
        onboardingStore(env),
        async (_instance, state) => await state.storage.getAlarm()
      );
      // The alarm, once the brain answers again.
      await store.purgeBrain();
      const after = await brainOf(ids);
      expect({
        before: before.statements.includes(`Tickets wait in ${said.max}.`),
        withdrawn,
        stuck: stuck.statements.includes(`Tickets wait in ${said.max}.`),
        alarm: alarm !== null,
        after: after.statements.some((text) => text.includes(said.max)),
        restsOn: await store.sentFor(ids.max),
        gone: await store.sentFor(`gone:${ids.max}`),
      }).toStrictEqual({
        before: true,
        withdrawn: 200,
        stuck: true,
        alarm: true,
        after: false,
        restsOn: [],
        gone: [],
      });
    });

    it("withdrawing takes the interviewer's lines that read it back out of the voice's cache, and leaves everyone else's (T5)", async () => {
      const ids = await team();
      const said = sentinels();
      await mapped(ids);
      await toldWith(ids, said);
      const keyOf = (words: string): SpokenKey => ({
        spoken: `[warm] ${stephenSays(words)}`,
        voice: speakerVoices.stephen,
        model: voiceModels.said,
        language: "en",
      });
      const answer = JSON.stringify({
        audio: "AAAA",
        mime: "audio/mpeg",
        words: [],
      });
      await keepLine(env, keyOf(said.max), answer);
      await keepLine(env, keyOf(said.mia), answer);
      await onLink({ action: "withdraw", ...(await openLink(ids.max)) });
      expect({
        max: await keptLine(env, keyOf(said.max)),
        mia: await keptLine(env, keyOf(said.mia)),
      }).toStrictEqual({ max: undefined, mia: answer });
    });

    it("withdrawing from a lead's interview draws all of the team's work again without their facts, and nothing in the brain rests on them (T5)", async () => {
      const store = onboardingStore(env);
      const ids = await team();
      const said = sentinels();
      await inTheBrain(ids, said);
      await onLink({ action: "withdraw", ...(await openLink(ids.lea)) });
      const redrawn = await drawAll(ids);
      await store.intakeNext();
      const brain = await brainOf(ids);
      expect({
        redrawnWith: JSON.stringify(redrawn.map(({ body }) => body)).includes(
          said.lea
        ),
        redrawn: redrawn.length > 0,
        drawInput: await store.drawInput(ids.lea),
        restsOn: await store.sentFor(ids.lea),
        statements: brain.statements.length,
      }).toStrictEqual({
        redrawnWith: false,
        redrawn: true,
        drawInput: null,
        restsOn: [],
        statements: 4,
      });
    });

    it("withdrawing from the link takes the brain's records on them out, draws the work again without them, and leaves their words theirs (T5)", async () => {
      const store = onboardingStore(env);
      const ids = await team();
      const said = sentinels();
      await inTheBrain(ids, said);
      const link = await openLink(ids.max);
      const events = await auditedDuring(async () => {
        await onLink({ action: "withdraw", ...link });
      });
      const redrawn = await drawAll(ids);
      await store.intakeNext();
      const works = await store.teamWorks(ids.team);
      const tickets = works.find(({ name }) => name === "handling new tickets");
      const left = await leftOf(ids.max, said.max);
      expect({
        after: await brainOf(ids),
        // What they said stays theirs to read on their link, and nowhere else.
        words: left.words,
        drawnFrom: tickets?.drawn?.from.toSorted(),
        redrawnWith: JSON.stringify(redrawn.map(({ body }) => body)).includes(
          said.max
        ),
        restsOn: await store.sentFor(ids.max),
        drawInput: await store.drawInput(ids.max),
        // Withdrawing is never in the audit log: its moment would tell the
        // admin whose it was.
        audited: events
          .map(({ action }) => action)
          .filter((action) => action.startsWith("onboarding.")),
        auditNames: JSON.stringify(events).includes(ids.max),
      }).toStrictEqual({
        after: {
          statements: [
            `Every ticket gets ${said.mo}.`,
            "Tickets arrive in Zendesk.",
            `Would like ${said.mia} filled in for them.`,
          ],
          sources: ["5 people"],
          drawings: [4],
        },
        words: ["interviews"],
        drawnFrom: [ids.mia, ids.mo, ids.noor, ids.pim].toSorted(),
        redrawnWith: false,
        restsOn: [],
        drawInput: null,
        audited: [],
        auditNames: false,
      });
    });

    it("a line put right after it reached the brain takes its old words out, and its new words go in only once approved (T2)", async () => {
      const store = onboardingStore(env);
      const ids = await team();
      const said = sentinels();
      await inTheBrain(ids, said);
      const fixed = sentinelOf("inbox");

      const { status, link, facts } = await putRight(ids, said, fixed);
      await drawAll(ids);
      await store.intakeNext();
      const unapproved = await brainOf(ids);
      const drawnBefore = await store.drawInput(ids.max);

      await approve(link, facts);
      await drawAll(ids);
      await store.intakeNext();
      const approved = await brainOf(ids);

      expect({
        status,
        unapproved: unapproved.statements,
        drawnBefore: drawnBefore?.facts.map(({ record }) => record),
        approved: approved.statements,
      }).toStrictEqual({
        status: 200,
        unapproved: [
          `Every ticket gets ${said.mo}.`,
          "Tickets arrive in Zendesk.",
          `Would like ${said.mia} filled in for them.`,
        ],
        drawnBefore: ["Tickets arrive in Zendesk."],
        approved: [
          `Every ticket gets ${said.mo}.`,
          "Tickets arrive in Zendesk.",
          `Tickets wait in ${fixed}.`,
          `Would like ${said.mia} filled in for them.`,
        ],
      });
    });

    it("a line put right while the team is given to the brain takes what landed of its old words out again (T8)", async () => {
      const store = onboardingStore(env);
      const ids = await team();
      const said = sentinels();
      await mapped(ids);
      await toldWith(ids, said);
      await drawAll(ids);
      // Max puts his queue right as the brain is about to keep the team:
      // as its records are written, not as an audit event before it is.
      let fixing: Promise<{ status: number }> | undefined;
      const batch = env.DB.batch.bind(env.DB);
      const spy = vi
        .spyOn(env.DB, "batch")
        .mockImplementation(async (statements) => {
          if (
            fixing === undefined &&
            new Error("where").stack?.includes("writeRecords") === true
          ) {
            fixing = putRight(ids, said, sentinelOf("inbox"));
            await fixing;
          }
          return await batch(statements);
        });
      try {
        await store.intakeNext();
      } finally {
        spy.mockRestore();
      }
      const fixed = await fixing;
      // What landed of the old words goes as the alarm would take it out.
      await store.purgeBrain();
      const landed = await brainOf(ids);
      await drawAll(ids);
      await store.intakeNext();
      const after = await brainOf(ids);
      expect({
        fixed: fixed?.status,
        landed: landed.statements.some((text) => text.includes(said.max)),
        after: after.statements.some((text) => text.includes(said.max)),
      }).toStrictEqual({ fixed: 200, landed: false, after: false });
    });
  }
);
