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
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { platformAi } from "../src/platform-ai.ts";
import { keepLine, keptLine, sweepSpokenLines } from "../src/speech-cache.ts";
import type { SpokenKey } from "../src/speech-cache.ts";
import { adminCommands } from "./admin-command.ts";
import { mockIdp } from "./idp.ts";
import {
  answering,
  answeringWith,
  approve,
  holdAlarm,
  onLink,
  participate,
} from "./interview-link.ts";
import type { ProviderReply, SentRequest } from "./model-provider.ts";
import {
  agree,
  fact,
  intakeAlike,
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
import { auditedDuring, routed, signedInApi, unique } from "./sign-in.ts";

// Deleting an interview (GRA-368, the store's `#forget` and `purgeBrain`):
// from its link, by Grasp's staff on request, with a new start, or by
// taking someone off the staff list. Each person here says words nobody
// else does (a sentinel), and the tests look for them, and for who said
// them, everywhere they could be left: the store's tables, core's
// database, the brain, the audit log, the lines kept of Stephen's voice,
// and what the work is drawn again from. The model provider is the
// outside system, faked behind connect. The threat model's delete cases
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

/** The speech model lines are said in: the platform's default. */
const speechModel = `${platformAi.speech.provider}/${platformAi.speech.model}`;
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

/**
 * Max, Mia and Mo agree to what they told about tickets: one fact each of
 * their own, and with Noor and Pim that tickets arrive in Zendesk and wait
 * (Max in words of his own); Noor, Pim and Rik agree to a step each. The
 * team's claims are the two the five share; what one of them said alone
 * never reaches the brain.
 */
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
      fact("i8", "wait", "Tickets wait for the customer."),
      fact("i9", "wish", `Would like ${said.mia} filled in for them.`),
    ],
    0,
    linesWith(said.mia)
  );
  await agree(
    ids.mo,
    [
      fact("o2", "system", "Tickets arrive in Zendesk."),
      fact("o8", "wait", "Tickets wait for the customer."),
      fact("o9", "rule", `Every ticket gets ${said.mo}.`),
    ],
    0,
    linesWith(said.mo)
  );
  await othersTold(ids);
};

/** Draws every piece of work due, each with the tickets' drawing, until none is. */
const drawAll = async (ids: Ids): Promise<SentRequest[]> => {
  const store = onboardingStore(env);
  const requests: SentRequest[] = [];
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
    const gave = await intakeAlike();
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
    way: "with a new start Grasp's staff give from the admin",
    remove: async (ids) => await adminCommands().newStart(ids.max),
    audited: ["brain.records.purged", "onboarding.interview.restarted"],
  },
  {
    way: "by taking them off the staff list (L7)",
    remove: async (ids) => {
      await onboardingStore(env).saveRoster(
        rosterOf(ids, ["lea", "mia", "mo", "noor", "pim", "rik"]),
        { type: "system" }
      );
    },
    audited: ["brain.records.purged", "onboarding.roster.saved"],
  },
];

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

/** Lea's interview as she saves it at the read-back, with `facts`. */
const leaSaves = (facts: InterviewFact[]): InterviewProgress => ({
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
});

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
      await intakeAlike();
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
          // The two claims five of them made; what one said alone stays out.
          statements: [
            "Tickets arrive in Zendesk.",
            "Tickets wait for the customer.",
          ],
          sources: ["7 people"],
          drawings: [6],
        },
        after: {
          // Both rested on five, Max among them: under five now, they go.
          statements: [],
          sources: ["6 people"],
          // The drawing from five is gone; the one from who is left is there.
          drawings: [5],
        },
        left: { words: [], person: [] },
        others: true,
        drawnFrom: [ids.mia, ids.mo, ids.noor, ids.pim, ids.rik].toSorted(),
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
  ])("$way (W7)", async ({ remove, audited, by }) => {
    const ids = await team();
    await inTheBrain(ids, sentinels());
    const events = await auditedDuring(async () => {
      await remove(ids);
    });
    // The team given to the brain again, so none of it waits for the next test.
    await drawAll(ids);
    await intakeAlike();
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
    // From her own link, as only the person deletes their interview.
    await deleteOnLink(ids.lea);
    const redrawn = await drawAll(ids);
    await intakeAlike();
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
          [ids.max, ids.mia, ids.mo, ids.noor, ids.pim, ids.rik].toSorted(),
        ],
        ["planning the rota", null],
      ],
      after: {
        // The lead's facts are in no claim: the team's stay.
        statements: [
          "Tickets arrive in Zendesk.",
          "Tickets wait for the customer.",
        ],
        sources: ["6 people"],
        // The map was hers: its work leaves the brain with her facts (GRA-329).
        drawings: null,
      },
      restsOn: [],
    });
  });

  it("of a team's lead, begun anew, keeps the map of their old interview out of the brain until it is drawn again", async () => {
    const store = onboardingStore(env);
    const ids = await team();
    const said = sentinels();
    await inTheBrain(ids, said);
    await deleteOnLink(ids.lea);
    // Lea begins anew and agrees again: her new interview has taken
    // nothing back yet, as her old one hadn't when its map was drawn.
    const anew = await openLink(ids.lea);
    const facts = [fact("l1", "work", "Max, Mia and Mo handle new tickets.")];
    // A new start saves at the version the link's session gives now.
    const begun = await onLink({ action: "session", ...anew });
    const { version } = z
      .object({ version: z.number() })
      .parse(await begun.json());
    await participate(anew);
    await onLink({
      action: "save",
      ...anew,
      version,
      progress: leaSaves(facts),
    });
    await approve(anew, facts);
    // Her map can't be drawn again, until it is given up.
    const failing: ProviderReply = {
      status: 400,
      errorType: "invalid_request_error",
    };
    for (const later of [0, 2, 10, 40]) {
      // oxlint-disable-next-line no-await-in-loop -- one try at a time, each later, as the alarm tries
      await answering(
        [failing],
        async () => await store.drawNext(Date.now() + later * 60_000)
      );
    }
    await drawAll(ids);
    await givenToBrain(ids);
    await store.purgeBrain();
    const after = await brainOf(ids);
    expect(after.drawings).toBeNull();
  });

  it("that leaves a team under five people takes all of the team's interviews out of the brain until five agree again (W5)", async () => {
    const store = onboardingStore(env);
    // Five who tell their own work, and the lead, who isn't counted.
    const ids = await team(["lea", "max", "mia", "mo", "noor", "pim"]);
    const said = sentinels();
    await mapped(ids);
    await agree(ids.max, [fact("m9", "wait", `Tickets wait in ${said.max}.`)]);
    await agree(ids.mia, [
      fact("i9", "wish", `Would like ${said.mia} filled in for them.`),
    ]);
    await agree(ids.mo, [fact("o9", "rule", `Every ticket gets ${said.mo}.`)]);
    await agree(ids.noor, [fact("n1", "step", "Reads the ticket first.")]);
    await agree(ids.pim, [fact("p1", "step", "Tags the ticket.")]);
    await drawAll(ids);
    await intakeAlike();
    const before = await kept(ids);
    await deleteOnLink(ids.mia);
    await drawAll(ids);
    await intakeAlike();
    const after = await kept(ids);
    expect({
      before: [...new Set(before.map(({ type }) => type))].toSorted(),
      after: after.map(({ type }) => type),
      brain: await brainOf(ids),
      // Max's drawing waits for the team, here alone.
      restsOn: await store.sentFor(ids.max),
    }).toStrictEqual({
      // Nothing five of them said alike: no statement, before or after.
      before: ["team", "workflow", "workflowVersion"],
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
    const { result: drew } = await answeringWith(
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
    await intakeAlike();
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
      drawnFrom: [ids.mia, ids.mo, ids.noor, ids.pim, ids.rik].toSorted(),
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
    const { result: drew } = await answeringWith(
      async () => {
        // Lea deletes her interview while her team's map is drawn from it.
        deleted ??= await deleteOnLink(ids.lea);
        return mapReply(ids);
      },
      async () => await store.drawNext()
    );
    // The team her delete made due for the brain, so it waits for no later test.
    await intakeAlike();
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
      gave = await intakeAlike();
    } finally {
      spy.mockRestore();
    }
    const deleted = await deleting;
    const landed = await brainOf(ids);
    await drawAll(ids);
    await intakeAlike();
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
        // The claims rested on five, Max among them: under five, none.
        statements: [],
        sources: ["6 people"],
        drawings: [5],
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
      text: stephenSays(words),
      spoken: `[warm] ${stephenSays(words)}`,
      voice: platformAi.speech.voices.stephen,
      model: speechModel,
      language: "en",
    });
    const answer = JSON.stringify({
      audio: "AAAA",
      mime: "audio/mpeg",
      words: [],
    });
    await keepLine(env, keyOf(said.max), answer);
    await keepLine(env, keyOf(said.mia), answer);
    // Said before the speech settings changed: another model and voice,
    // another language, no tone. Erased all the same.
    const before: SpokenKey = {
      text: stephenSays(said.max),
      spoken: stephenSays(said.max),
      voice: "EXAVITQu4vr4xnSDxMaL",
      model: "elevenlabs/eleven_v3",
      language: "nl",
    };
    await keepLine(env, before, answer);
    await deleteOnLink(ids.max);
    expect({
      max: await keptLine(env, keyOf(said.max)),
      before: await keptLine(env, before),
      mia: await keptLine(env, keyOf(said.mia)),
    }).toStrictEqual({ max: undefined, before: undefined, mia: answer });
  });

  it("leaves no line kept the flat way, by model and voice, past the cache's next sweep, whatever its age", async () => {
    const flat = `spoken-lines/${"a".repeat(64)}.json`;
    const fresh: SpokenKey = {
      text: "Hello, I'm Stephen.",
      spoken: "Hello, I'm Stephen.",
      voice: platformAi.speech.voices.stephen,
      model: speechModel,
      language: "en",
    };
    const answer = JSON.stringify({ audio: "AAAA", mime: "audio/mpeg" });
    await env.FILES.put(flat, answer);
    await keepLine(env, fresh, answer);

    // Every page of the cache from its start, as the clock sweeps it a
    // page a run.
    await env.FILES.delete("spoken-lines-sweep.json");
    for (let run = 0; run < 20; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one page a run, in turn
      await sweepSpokenLines(env, new Date());
      // oxlint-disable-next-line no-await-in-loop -- until the sweep is round
      if ((await env.FILES.get("spoken-lines-sweep.json")) === null) {
        break;
      }
    }

    expect({
      flat: await env.FILES.head(flat),
      fresh: await keptLine(env, fresh),
    }).toStrictEqual({ flat: null, fresh: answer });
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
      // What is still to come out stays on record, resting on someone
      // gone, for the alarm to take out (`#armDrawing` sets it for that).
      const waiting = await store.sentFor(`gone:${ids.max}`);
      // The alarm, once the brain answers again.
      await store.purgeBrain();
      const after = await brainOf(ids);
      expect({
        // The claim Max was one of the five behind.
        before: before.statements.includes("Tickets wait for the customer."),
        withdrawn,
        stuck: stuck.statements.includes("Tickets wait for the customer."),
        waiting: waiting.length > 0,
        after: after.statements.includes("Tickets wait for the customer."),
        restsOn: await store.sentFor(ids.max),
        gone: await store.sentFor(`gone:${ids.max}`),
      }).toStrictEqual({
        before: true,
        withdrawn: 200,
        stuck: true,
        waiting: true,
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
        text: stephenSays(words),
        spoken: `[warm] ${stephenSays(words)}`,
        voice: platformAi.speech.voices.stephen,
        model: speechModel,
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
      await intakeAlike();
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
        statements: 2,
      });
    });

    it("a line put right whose work then can't be drawn again leaves no drawing of the old line, here or in the brain (T2)", async () => {
      const store = onboardingStore(env);
      const ids = await team();
      const said = sentinels();
      await inTheBrain(ids, said);
      const versionsOf = async () => {
        const records = await kept(ids);
        return records
          .filter(({ type }) => type === "workflowVersion")
          .map(({ id }) => id);
      };
      const before = await versionsOf();
      await putRight(ids, said, sentinelOf("inbox"));
      // Every drawing of the tickets fails, until it is given up.
      const failing: ProviderReply = {
        status: 400,
        errorType: "invalid_request_error",
      };
      for (const later of [0, 2, 10, 40, 90]) {
        // oxlint-disable-next-line no-await-in-loop -- one try at a time, each later, as the alarm tries
        await answering(
          [failing],
          async () => await store.drawNext(Date.now() + later * 60_000)
        );
      }
      await store.purgeBrain();
      const works = await store.teamWorks(ids.team);
      const after = await versionsOf();
      expect({
        tickets: works.find(({ name }) => name === "handling new tickets")
          ?.drawn,
        oldInBrain: after.filter((id) => before.includes(id)),
      }).toStrictEqual({ tickets: null, oldInBrain: [] });
    });

    it("a lead who withdraws takes the team's map out of the brain: its work stays out, and the statements of the rest stay in (T5, maps)", async () => {
      const ids = await team();
      const said = sentinels();
      await inTheBrain(ids, said);
      const before = await brainOf(ids);
      await onLink({ action: "withdraw", ...(await openLink(ids.lea)) });
      await drawAll(ids);
      await givenToBrain(ids);
      const after = await brainOf(ids);
      const records = await kept(ids);
      const types = new Set(records.map(({ type }) => type));
      expect({
        before: before.drawings,
        after: after.drawings,
        statements: after.statements.length,
        workflows: types.has("workflow") || types.has("workflowVersion"),
      }).toStrictEqual({
        before: [6],
        after: null,
        statements: 2,
        workflows: false,
      });
    });

    it("a lead who puts a line right keeps the team's work out of the brain until the map is drawn again from what they approved now (T2, maps)", async () => {
      const store = onboardingStore(env);
      const ids = await team();
      const said = sentinels();
      await inTheBrain(ids, said);
      const lea = await openLink(ids.lea);
      const facts = [
        fact("l1", "work", "Max, Mia and Mo handle new tickets."),
        fact("l2", "system", "The team lives in Zendesk and a shared rota."),
      ];
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
      await onLink({ action: "save", ...lea, version: 1, progress });
      await store.purgeBrain();
      const edited = await brainOf(ids);
      await approve(lea, facts);
      await answering([mapReply(ids)], async () => await store.drawNext());
      await drawAll(ids);
      await givenToBrain(ids);
      const redrawn = await brainOf(ids);
      expect({
        edited: edited.drawings,
        statements: edited.statements.length,
        redrawn: redrawn.drawings !== null,
      }).toStrictEqual({ edited: null, statements: 2, redrawn: true });
    });

    it("a lead's second take-back in the millisecond their map was drawn from makes it due again, and keeps the team's work out of the brain until then (T2, maps)", async () => {
      const store = onboardingStore(env);
      const ids = await team();
      const said = sentinels();
      await inTheBrain(ids, said);
      const lea = await openLink(ids.lea);
      const once = [
        fact("l1", "work", "Max, Mia and Mo handle new tickets."),
        fact("l2", "system", "The team lives in Zendesk and a shared rota."),
      ];
      // Every clock from here reads the same millisecond.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.parse("2026-10-26T09:00:00.000Z"));
      try {
        // Lea puts a line right and approves it: the map is drawn again
        // from that, in this millisecond.
        await onLink({
          action: "save",
          ...lea,
          version: 1,
          progress: leaSaves(once),
        });
        await approve(lea, once);
        await answering([mapReply(ids)], async () => await store.drawNext());
        // She puts the same line right again, in the same millisecond:
        // what the map was drawn from no longer counts.
        const twice = [
          once[0] ?? fact("l1", "work", ""),
          fact("l2", "system", "The team lives in Zendesk alone."),
        ];
        await onLink({
          action: "save",
          ...lea,
          version: 2,
          progress: leaSaves(twice),
        });
        await store.purgeBrain();
      } finally {
        vi.useRealTimers();
      }
      const records = await kept(ids);
      const due = await store.drawsDue();
      expect({
        // Drawn from what no longer counts: due to be drawn again, and
        // the team's work kept out of the brain until it is.
        due: due.includes(ids.lea),
        workflows: records.some(({ type }) => type === "workflow"),
      }).toStrictEqual({ due: true, workflows: false });
    });

    it("keeps the voice's lines of a withdrawn interview waiting while the cache can't be reached, and takes them out once it can (T5)", async () => {
      const store = onboardingStore(env);
      const ids = await team();
      const said = sentinels();
      await mapped(ids);
      await toldWith(ids, said);
      const key: SpokenKey = {
        text: stephenSays(said.max),
        spoken: `[warm] ${stephenSays(said.max)}`,
        voice: platformAi.speech.voices.stephen,
        model: speechModel,
        language: "en",
      };
      const answer = JSON.stringify({ audio: "AAAA", mime: "audio/mpeg" });
      await keepLine(env, key, answer);
      const files: R2Bucket = env.FILES;
      const spy = vi
        .spyOn(files, "delete")
        .mockRejectedValue(new Error("The cache can't be reached."));
      try {
        await onLink({ action: "withdraw", ...(await openLink(ids.max)) });
      } finally {
        spy.mockRestore();
      }
      const stuck = await keptLine(env, key);
      // The alarm, once the cache answers again.
      const gone = await store.forgetLinesNow();
      expect({
        stuck,
        gone: gone > 0,
        after: await keptLine(env, key),
        left: await store.forgetLinesNow(),
      }).toStrictEqual({
        stuck: answer,
        gone: true,
        after: undefined,
        left: 0,
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
      await intakeAlike();
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
          // The claims rested on five, Max among them: under five, none.
          statements: [],
          sources: ["6 people"],
          drawings: [5],
        },
        words: ["interviews"],
        drawnFrom: [ids.mia, ids.mo, ids.noor, ids.pim, ids.rik].toSorted(),
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
      await intakeAlike();
      const unapproved = await brainOf(ids);
      const drawnBefore = await store.drawInput(ids.max);

      await approve(link, facts);
      await drawAll(ids);
      await intakeAlike();
      const approved = await brainOf(ids);

      expect({
        status,
        unapproved: unapproved.statements,
        drawnBefore: drawnBefore?.facts.map(({ record }) => record),
        approved: approved.statements,
      }).toStrictEqual({
        status: 200,
        // Four still say tickets wait: the claim goes until his line,
        // put right, is approved, and comes back in the words most used.
        unapproved: ["Tickets arrive in Zendesk."],
        drawnBefore: ["Tickets arrive in Zendesk."],
        approved: [
          "Tickets arrive in Zendesk.",
          "Tickets wait for the customer.",
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
        await intakeAlike();
      } finally {
        spy.mockRestore();
      }
      const fixed = await fixing;
      // What landed of the old words goes as the alarm would take it out.
      await store.purgeBrain();
      const landed = await brainOf(ids);
      await drawAll(ids);
      await intakeAlike();
      const after = await brainOf(ids);
      expect({
        fixed: fixed?.status,
        landed: landed.statements.some((text) => text.includes(said.max)),
        after: after.statements.some((text) => text.includes(said.max)),
      }).toStrictEqual({ fixed: 200, landed: false, after: false });
    });
  }
);

describe("the alarm, while something else fails", { timeout: 180_000 }, () => {
  it("still takes what rests on a withdrawn interview out of the brain first, and sets itself again (T5)", async () => {
    const ids = await team();
    const said = sentinels();
    await inTheBrain(ids, said);
    // Max withdraws while the brain can't be written: it waits for the alarm.
    const batch = env.DB.batch.bind(env.DB);
    const blocked = vi
      .spyOn(env.DB, "batch")
      .mockImplementation(async (statements) => {
        if (new Error("where").stack?.includes("drainBatch") !== true) {
          throw new Error("The brain can't be reached.");
        }
        return await batch(statements);
      });
    try {
      await onLink({ action: "withdraw", ...(await openLink(ids.max)) });
    } finally {
      blocked.mockRestore();
    }
    const stuck = await brainOf(ids);
    // The alarm, with releasing the links failing on its way.
    const { failed, alarm } = await runInDurableObject(
      onboardingStore(env),
      async (instance, state) => {
        const release = vi
          .spyOn(instance, "releaseDue")
          .mockRejectedValue(new Error("Releasing failed."));
        let threw = false;
        try {
          await instance.alarm();
        } catch {
          threw = true;
        } finally {
          release.mockRestore();
        }
        return { failed: threw, alarm: await state.storage.getAlarm() };
      }
    );
    const after = await brainOf(ids);
    expect({
      stuck: stuck.statements.includes("Tickets wait for the customer."),
      failed,
      after: after.statements.includes("Tickets wait for the customer."),
      armed: alarm !== null,
    }).toStrictEqual({ stuck: true, failed: true, after: false, armed: true });
  });
});
